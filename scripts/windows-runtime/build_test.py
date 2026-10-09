import importlib.util
from pathlib import Path
import sqlite3
import hashlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('runtime_build', Path(__file__).with_name('build.py'))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class BuildGuards(unittest.TestCase):
    def test_external_dependency_drift_is_rejected(self):
        old = b'[[package]]\nname="dep"\nversion="1.0"\nsource="registry+example"\n'
        with self.assertRaises(ValueError):
            build.check_lock(old, old.replace(b'1.0', b'2.0'))

    def test_only_local_release_version_change_is_allowed(self):
        old = b'[[package]]\nname="codex-test"\nversion="0.0.0"\n'
        build.check_lock(old, old.replace(b'0.0.0', build.VERSION['cliVersion'].encode()))
        with self.assertRaises(ValueError):
            build.check_lock(old, old.replace(b'codex-test', b'another-package'))

    def test_migration_audit_is_read_only_and_checks_exact_bytes(self):
        with tempfile.TemporaryDirectory(prefix='codex-migration-test-') as root:
            source, home = Path(root) / 'source', Path(root) / 'home'
            home.mkdir()
            for folder in build.DATABASES.values():
                target = source / 'codex-rs/state' / folder
                target.mkdir(parents=True)
                (target / '0001_test.sql').write_bytes(b'SELECT 1;\n')
            db = home / 'state_5.sqlite'
            connection = sqlite3.connect(db)
            connection.execute('CREATE TABLE _sqlx_migrations (version INTEGER, checksum BLOB, success INTEGER)')
            connection.execute('INSERT INTO _sqlx_migrations VALUES (1, ?, 1)', (hashlib.sha384(b'SELECT 1;\r\n').digest(),))
            connection.commit()
            connection.close()
            original = db.read_bytes()
            writes, proof = build.migration_plan(source, home)
            self.assertEqual(proof[0]['verifiedMigrations'], 1)
            self.assertTrue(all(content.endswith(b'\r\n') for content in writes.values()))
            self.assertEqual(db.read_bytes(), original)
            (source / 'codex-rs/state/migrations/0001_test.sql').write_bytes(b'SELECT 2;\n')
            with self.assertRaisesRegex(ValueError, 'Migration source mismatch'):
                build.migration_plan(source, home)
            self.assertEqual(db.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
