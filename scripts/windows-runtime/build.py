"""Version-pinned Windows build; reads database checksums and changes source bytes only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tomllib

HERE = Path(__file__).resolve().parent
VERSION = json.loads((HERE / 'version.json').read_text())
DATABASES = {
    'state_5.sqlite': 'migrations', 'logs_2.sqlite': 'logs_migrations',
    'goals_1.sqlite': 'goals_migrations', 'memories_1.sqlite': 'memory_migrations',
    'queue_1.sqlite': 'queue_migrations', 'thread_history_1.sqlite': 'thread_history_migrations',
}


def run(args, cwd, capture=True, env=None):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=capture,
                          env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).stdout


def lf(raw):
    return raw.replace(b'\r\n', b'\n')


def check_lock(original, current):
    """Cargo may rewrite local package versions, never third-party dependencies."""
    before, after = tomllib.loads(original.decode()), tomllib.loads(current.decode())
    for data in (before, after):
        for package in data['package']:
            if 'source' not in package and package['version'] in ('0.0.0', VERSION['cliVersion']):
                package['version'] = '<workspace-version>'
        data['package'].sort(key=lambda p: (p['name'], p['version'], p.get('source', '')))
    if before != after:
        raise ValueError('Cargo.lock changed beyond local workspace release versions')


def check_source(source):
    git = lambda *args: run(['git', *args], source)
    git('merge-base', '--is-ancestor', VERSION['fixCommit'], 'HEAD')
    changed = git('diff', '--name-only', VERSION['fixCommit'], '--', 'codex-rs').decode().splitlines()
    for name in changed:
        old = git('show', VERSION['fixCommit'] + ':' + name)
        new = (source / name).read_bytes()
        if name == 'codex-rs/Cargo.lock':
            check_lock(old, new)
        elif name.startswith('codex-rs/state/') and name.endswith('.sql') and lf(old) == lf(new):
            continue
        else:
            raise ValueError('Unexpected production source change: ' + name)
    untracked = git('ls-files', '--others', '--exclude-standard', '--', 'codex-rs').decode().splitlines()
    if untracked:
        raise ValueError('Untracked production inputs: ' + ', '.join(untracked))
    return git('rev-parse', 'HEAD').decode().strip()


def migration_plan(source, home):
    writes, proof = {}, []
    for database, directory in DATABASES.items():
        folder = source / 'codex-rs/state' / directory
        files = list(folder.glob('*.sql'))
        if not files:
            raise ValueError('Missing migration source directory: ' + directory)
        for file in files:
            writes[file] = lf(file.read_bytes()).replace(b'\n', b'\r\n')
        db = home / database
        if not db.exists():
            proof.append({'database': database, 'status': 'absent', 'verifiedMigrations': 0})
            continue
        connection = sqlite3.connect(db.as_uri() + '?mode=ro', uri=True)
        try:
            rows = list(connection.execute('SELECT version, checksum FROM _sqlx_migrations WHERE success = 1'))
            for number, checksum in rows:
                matches = [file for file in files if int(file.name.split('_')[0]) == number]
                if len(matches) != 1 or hashlib.sha384(writes[matches[0]]).digest() != checksum:
                    raise ValueError(f'Migration source mismatch: {database}, version {number}; database unchanged')
            proof.append({'database': database, 'status': 'verified', 'verifiedMigrations': len(rows)})
        finally:
            connection.close()
    return writes, proof


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=HERE.parents[1])
    parser.add_argument('--codex-home', type=Path, default=Path.home() / '.codex')
    parser.add_argument('--target-dir', type=Path, required=True, help='Reusable Cargo cache; outside the source checkout')
    parser.add_argument('--run-dir', type=Path, required=True, help='Prepared runtime.mjs run directory')
    parser.add_argument('--build', action='store_true', help='Without this flag, validate and print the build plan only')
    args = parser.parse_args()
    source, home, target, output = [p.resolve() for p in (args.source, args.codex_home, args.target_dir, args.run_dir)]
    if os.name != 'nt':
        raise ValueError('Native Windows is required')
    if target == source or source in target.parents:
        raise ValueError('Keep the Cargo cache outside the source checkout')
    state = json.loads((output / 'state.json').read_text())
    if state['version'] != VERSION or (args.build and state['state'] != 'prepared'):
        raise ValueError('Build requires a prepared run for this exact version')
    commit = check_source(source)
    writes, proof = migration_plan(source, home)
    rust = run(['rustc', '--version'], source / 'codex-rs').decode().strip()
    if not rust.startswith('rustc ' + VERSION['rustVersion'] + ' '):
        raise ValueError('Pinned Rust version mismatch: ' + rust)
    cargo = ['cargo', 'build', '--release', '--jobs', '2', '--config', 'profile.release.lto=false', '-p', 'codex-cli', '--bin', 'codex']
    plan = {'sourceCommit': commit, 'sourceTag': VERSION['sourceTag'], 'fixCommit': VERSION['fixCommit'], 'rust': rust, 'cargo': cargo, 'targetDirectory': str(target), 'migrations': proof}
    if not args.build:
        print(json.dumps(plan, indent=2))
        return
    receipt = output / 'build.json'
    if receipt.exists():
        raise ValueError('Build receipt already exists; use a fresh run')
    # All databases and production inputs were validated before any source edit.
    for file, content in writes.items():
        if file.read_bytes() != content:
            file.write_bytes(content)
    environment = {**os.environ, 'CARGO_TARGET_DIR': str(target), 'CARGO_BUILD_JOBS': '2', 'CARGO_NET_GIT_FETCH_WITH_CLI': 'true'}
    run(['cargo', 'test', '-p', 'codex-sandboxing', '--lib'], source / 'codex-rs', capture=False, env=environment)
    run(cargo, source / 'codex-rs', capture=False, env=environment)
    check_source(source)
    binary = target / 'release/codex.exe'
    if run([str(binary), '--version'], source).decode().strip() != 'codex-cli ' + VERSION['cliVersion']:
        raise ValueError('Built version mismatch')
    plan['binary'] = str(binary)
    plan['binarySha256'] = hashlib.sha256(binary.read_bytes()).hexdigest()
    with receipt.open('x', encoding='utf-8') as file:
        json.dump(plan, file, indent=2)
    print(json.dumps(plan, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, sqlite3.Error) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
