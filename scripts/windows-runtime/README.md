# Windows runtime maintenance

This personal fork carries a small, version-specific Windows repair on top of
official Codex. Upstream remains the source of new features and releases. The
branch `zjr/windows-runtime-alpha17.2` starts at `rust-v0.162.0-alpha.17.2` and adds
the elevated writable-descendant repair, followed by this reusable toolkit. The
profile fix also initializes a missing sandbox account profile before launching tools.
The unelevated sandbox guard is unchanged.

The tools require native Windows, Node.js, Git, Python 3.11+, and the source's pinned
Rust toolchain. They do not register an agent tool, change user configuration, stop
an extension host, or automatically update anything. Keep local evidence, database
files, runtime binaries, and credentials out of Git.

## Start with the official build

Use `version.json` to match extension, CLI, source tag, fix commit, Rust toolchain,
and official helper hashes. It currently supports **only** extension `26.1007.21434`
with CLI `0.162.0-alpha.17.2`. A different version requires a new audited manifest
and patch port; changing the version string alone is not sufficient.

From this fork's root in PowerShell, set paths for your machine:

```powershell
$tools = Join-Path (Get-Location) 'scripts/windows-runtime'
$installed = '<selected VS Code extension>/bin/windows-x86_64'
$run = '<new absolute evidence directory outside the installed runtime>'
$target = '<reusable absolute Cargo target directory outside this checkout>'
$binary = Join-Path $installed 'codex.exe'
node "$tools/runtime.mjs" diagnose "$binary"
node "$tools/probe.mjs" "$binary" "$run-official" reopened
node "$tools/startup.mjs" "$binary" "$run-official/startup.json"
```

The official alpha.17.2 build fails the reopened-root case. On a future release,
test the official build first: if ordinary/base, reopened, offline, linked, startup,
and fresh-session checks all pass, use that official release and retire the patch.
For the profile repair, also validate newly provisioned sandbox accounts in a
disposable Windows environment: existing profiles can hide the first-launch bug.
Do not disable updates or pin a stale global PATH to preserve a repair.

## Build and validate a candidate

First establish a complete backup and separate candidate from an **untouched**
matching official runtime. `prepare` checks the pinned official hashes before
copying. It intentionally refuses an already-patched installation. An existing
repair needs its verified same-version official backup; never label repaired
bytes as official or install into a backup directory.

```powershell
node "$tools/runtime.mjs" prepare "$installed" "$run"
python "$tools/build.py" --target-dir "$target" --run-dir "$run"
# Inspect the plan, then opt in to source normalization, tests, and compilation:
python "$tools/build.py" --target-dir "$target" --run-dir "$run" --build
node "$tools/runtime.mjs" stage "$run" "$target/release/codex.exe"
foreach ($variant in @('base', 'reopened', 'offline', 'linked')) {
    node "$tools/probe.mjs" "$run/candidate/codex.exe" "$run/candidate-evidence" $variant
    if ($LASTEXITCODE -ne 0) { throw "Acceptance failed: $variant" }
}
node "$tools/startup.mjs" "$run/candidate/codex.exe" "$run/candidate-evidence/startup.json"
if ($LASTEXITCODE -ne 0) { throw 'Normal-home startup failed' }
node "$tools/runtime.mjs" validate "$run" "$run/candidate-evidence"
```

Check each command's exit status; never proceed from a failed command. The build
planner verifies production inputs against the pinned fix commit, permits only
local workspace package-version changes in Cargo.lock, and reads existing SQLite
migration checksums without modifying databases. All applicable checksums must
match CRLF SQL bytes before it normalizes source files. It uses two Cargo jobs,
the reusable target cache, and `profile.release.lto=false` consistently. It builds
only `codex.exe`; official matching helpers remain in the candidate. Do not move
older executables into a new extension or modify database checksums to force startup.

`probe.mjs` uses a loopback synthetic Responses server; no model inference or
repository source upload is involved. Both `--ignore-user-config` and
`--ignore-rules` are required: saved approval rules can otherwise run shell
commands outside the sandbox and give a false pass. Each of four variants checks
28 operations, including native Node account/profile lookup under the expected
sandbox account, normal reads/writes/deletes, native patches and readbacks,
and denied protected/outside/traversal/junction operations. Startup uses the normal
Codex home and live account catalog; it does not prove model inference.

Staging requires `build.json` from this run, checks its pinned source/toolchain
identity, and matches the artifact path and SHA256 before copying. The receipt
remains bound to the staged candidate through validation and installation.
Every result binds the executable path, SHA256, and toolkit digest. Validation
rejects evidence for changed binaries/tools, incomplete matrices, altered policy,
or a startup run with a CODEX_HOME override. Every named case and its allowed/denied
expectation must be present; an arbitrary count of successes is insufficient.
Output paths are never overwritten.
Fixture directories are retained under the evidence directory for inspection.
They contain only synthetic data. Cleanup is an explicit, bounded operator action;
unlink the test junction before recursive deletion and retain Git worktree fixtures
until their disposable repository/worktree lifecycle is intentionally closed.

Before installing a newly changed patch, obtain independent review and run the
source regression tests. The original two-file repair already has a clean review
and elevated-account integration result; unchanged-source rebuilds do not need an
invented new review cycle. Run the opt-in integration regression only with explicitly
provisioned test CODEX_HOME and matching sandbox helpers, as its test annotation
requires. A signed-in-user restricted-token test is not equivalent.

### Node/tsx reports `uv_os_get_passwd` / `ENOMEM`

First try `node -p "require('node:os').userInfo()"` inside the actual sandbox.
If that built-in call fails, reinstalling npm packages cannot repair the missing
native profile. `USERPROFILE` being set is not proof that the account has a profile:
Node queries Windows directly. Newly provisioned sandbox accounts can lack a
`ProfileList` entry; `GetUserProfileDirectoryW` then returns a zero-sized buffer
with `ERROR_INSUFFICIENT_BUFFER`, surfaced by Node/libuv as `ENOMEM`.

The source fix checks the sandbox account's `ProfileImagePath` registration. If it
is absent or empty, the runner uses `LOGON_WITH_PROFILE` to initialize the profile.
Later ordinary launches keep the existing profile-free path to avoid repeated hive
loads and [User Profile Service contention](https://github.com/openai/codex/issues/34062).
Registered execution-alias launches continue to load their profile every time.
The sandbox account, token restrictions, filesystem grants, and network policy
remain unchanged. Initialization persists, so older binaries may also pass afterward.
See Microsoft's [CreateProcessWithLogonW documentation](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw)
for the profile-loading flag.
Do not delete an existing account/profile to manufacture a failing test. Validate
first-launch behavior on newly provisioned accounts in a disposable Windows VM.

For the opt-in native regression, provide matching helpers and a provisioned
`CODEX_HOME`, set `CODEX_TEST_NODE` to an absolute `node.exe` path, and run from
`codex-rs`:

```powershell
cargo test -p codex-windows-sandbox --lib elevated_node_user_info_resolves_sandbox_account_profile -- --ignored --nocapture
```

The test checks both online and offline accounts. The toolkit's `node-user-info`
case likewise verifies the actual account identity and an absolute home directory;
host execution cannot satisfy it. Where the project already has `tsx` installed,
also run `node --import=tsx -e "console.log('tsx-ready')"` and its affected local
tests. No provider credentials or container are needed for a loader-only check.

## Install, activate, and roll back

```powershell
node "$tools/runtime.mjs" install "$run"
foreach ($variant in @('reopened', 'offline')) {
    node "$tools/probe.mjs" "$binary" "$run/installed-evidence" $variant
    if ($LASTEXITCODE -ne 0) { throw "Installed acceptance failed: $variant" }
}
node "$tools/startup.mjs" "$binary" "$run/installed-evidence/startup.json"
node "$tools/runtime.mjs" verify-installed "$run" "$run/installed-evidence"
```

Installation rechecks VS Code's selected extension, all original/helper hashes,
candidate bytes, and recorded acceptance before replacing only `codex.exe`.
The original remains beside it under a unique backup name, and the full backup
remains in the run directory. `install.json` records individual replacement steps
and a recoverable automatic rollback on failure. Keep this directory.

Then run **Developer: Reload Window** and start a fresh Codex session. Confirm the
new app-server process started after installation and uses the selected runtime.
Have that session use its own default-permission `exec_command` to read a README,
run the Node account/profile lookup above, then use native `apply_patch` to create,
edit, remove a line, and delete a disposable file in both the workspace and the
explicitly writable descendant. Verify exact
contents and absence through independent sandboxed readback. Escalated reads,
saved unsandboxed approvals, and separate child processes are not host activation
proof. For model acceptance, perform a harmless synthetic review through your
normal review harness using the intended model; do not disclose private source.

Rollback after stopping the affected extension host:

```powershell
node "$tools/runtime.mjs" rollback "$run"
```

Rollback refuses a changed extension, changed installed binary, or changed backup.
It retains the repaired binary under a retired name. Reload after rollback. If an
unexpected power loss interrupts the operation, inspect `install.json` and the
recorded hashes before manually restoring the verified original; do not blindly
rerun installation or delete recovery files.

## Maintain the fork

Keep upstream `main` unmodified. For each affected official release, create a new
release branch from its tag and carry only still-needed fix commits. Keep source
fixes separate from tooling. Search upstream issues before reporting a regression;
provide a minimal synthetic reproduction, exact versions, failing official control,
and passing positive/negative checks. Upstream's current contribution policy accepts
issues and analysis rather than external PRs. Never publish personal paths, Codex
home contents, credential-bearing config, or private project diffs.

Validate toolkit edits with:

```powershell
node --test scripts/windows-runtime/runtime.test.mjs
python scripts/windows-runtime/build_test.py
```

This is repeatable local build tooling, not an unattended updater. Build caches
reduce repeated compilation; source review, version matching, test evidence, and
the post-reload check remain explicit. No GitHub-hosted release job or automatic
installation is enabled.
