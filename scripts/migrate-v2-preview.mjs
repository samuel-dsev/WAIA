import assert from 'node:assert/strict';
import pg from 'pg';
import { runMigrations } from '../src/infra/postgres/migrations.js';
import { readSqlDirectory } from '../src/infra/postgres/sql-runner.js';
import { fileURLToPath } from 'node:url';

// Explicit additive upgrade of the existing synthetic preview. Never resets data.
assert.equal(process.env.NODE_ENV, 'test');
const url = new URL(process.env.DATABASE_MIGRATOR_URL);
assert.equal(url.hostname, 'v2-postgres'); assert.equal(url.username, 'waia_v2_owner');
assert.equal(url.pathname, '/waia_v2_empty'); assert.equal(url.search, ''); assert.equal(url.hash, '');
url.pathname = '/waia_v2_app';
const pool = new pg.Pool({ connectionString: url.href, max: 1 });
try {
  const role = (await pool.query(`SELECT current_database() name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
  assert.deepEqual(role, { name: 'waia_v2_app', rolsuper: false, rolbypassrls: false });
  const files = await readSqlDirectory(fileURLToPath(new URL('../db/migrations/', import.meta.url)));
  assert.equal(files.length, 30);
  const rows = (await pool.query('SELECT filename,checksum FROM schema_migrations ORDER BY filename')).rows;
  assert.ok([29, 30].includes(rows.length));
  rows.forEach((row, index) => { assert.equal(row.filename, files[index].filename); assert.ok(files[index].acceptedChecksums.has(row.checksum.trim())); });
  const pending = files.slice(rows.length).map((file) => file.filename);
  assert.ok(pending.length === 0 || pending.length === 1 && pending[0] === '030_attendance_publications.sql');
  const result = await runMigrations(pool);
  console.log(JSON.stringify({ status: 'passed', database: 'waia_v2_app', applied: result.applied.length, migrations: 30, data: 'preserved' }));
} finally { await pool.end(); }
