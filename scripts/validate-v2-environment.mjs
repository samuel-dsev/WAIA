import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import pg from 'pg';
import Redis from 'ioredis';
import { createConnection } from 'node:net';
import { runMigrations } from '../src/infra/postgres/migrations.js';
import { readSqlDirectory } from '../src/infra/postgres/sql-runner.js';
import { fileURLToPath } from 'node:url';

// Only the synthetic M0 environment. Never starts an application or worker.
function target(value, database) {
  const url = new URL(value);
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(url.pathname, '/waia_v2_empty');
  assert.match(url.username, /^waia_v2_/);
  assert.equal(url.hostname, 'v2-postgres');
  assert.equal(url.port, '5432');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  url.pathname = `/${database}`;
  return url.href;
}
function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' });
  assert.equal(result.status, 0, 'Validation command failed');
}
let owner;
let app;
let redis;
const testsOnly=process.argv.includes('--tests-only');
async function assertNoBusinessData() {
  await owner.query('BEGIN');
  try {
    await owner.query("SELECT set_config('app.is_platform_admin','true',true)");
    const tables = (await owner.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows;
    for (const { tablename } of tables) {
      if (tablename === 'schema_migrations') continue;
      const identifier = `"${tablename.replaceAll('"', '""')}"`;
      assert.equal((await owner.query(`SELECT count(*)::int AS n FROM ${identifier}`)).rows[0].n,
        tablename === 'group_notifier_connection' ? 1 : 0);
    }
  } finally { await owner.query('ROLLBACK'); }
}
async function preflightDevelopmentDatabase() {
  for (const [pool, name] of [[owner, 'waia_v2_owner'], [app, 'waia_v2_app']]) {
    const role = (await pool.query(`SELECT current_database() AS database, current_user AS role,
      rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`)).rows[0];
    assert.deepEqual(role, { database: 'waia_v2_app', role: name,
      rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
  }
  assert.equal((await owner.query(`SELECT pg_get_userbyid(datdba)=current_user AS owned
    FROM pg_database WHERE datname=current_database()`)).rows[0].owned, true);
  const tables = (await owner.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')`)).rows[0].n;
  if (!tables) return;
  const files = await readSqlDirectory(fileURLToPath(new URL('../db/migrations/', import.meta.url)));
  const rows = (await owner.query('SELECT filename,checksum FROM schema_migrations ORDER BY filename')).rows;
  assert.ok(rows.length>=26 && rows.length<=files.length);
  rows.forEach((row,index)=>{assert.equal(row.filename,files[index].filename);assert.ok(files[index].acceptedChecksums.has(row.checksum.trim()));});
  await assertNoBusinessData();
}
try {
  const developmentUrl = target(process.env.DATABASE_MIGRATOR_URL, 'waia_v2_app');
  const upgradeOwner = target(process.env.DATABASE_MIGRATOR_URL, 'waia_v2_upgrade');
  const upgradeApp = target(process.env.DATABASE_URL, 'waia_v2_upgrade');
  const redisUrl = new URL(process.env.REDIS_URL);
  assert.equal(redisUrl.hostname, 'v2-redis');
  assert.equal(redisUrl.port, '6379');
  assert.equal(redisUrl.pathname, '/0');
  assert.equal(redisUrl.search, '');
  assert.equal(redisUrl.hash, '');
  owner = new pg.Pool({ connectionString: developmentUrl, max: 1 });
  app = new pg.Pool({ connectionString: target(process.env.DATABASE_URL, 'waia_v2_app'), max: 1 });
  // Validate this third target BEFORE any migration or functional fixture writes.
  if(!testsOnly)await preflightDevelopmentDatabase();
  run(['scripts/m0-schema-check.mjs']);
  run(['--test', 'test/accounts-postgres.test.js', 'test/team-postgres.test.js', 'test/access-admin-postgres.test.js',
    'test/accounts-redis.test.js', 'test/redis-integration.test.js', 'test/ai-reply-delay-redis.test.js'], {
    ...process.env, DATABASE_URL: upgradeApp, DATABASE_MIGRATOR_URL: upgradeOwner,
    RUN_POSTGRES_INTEGRATION: 'true', RUN_REDIS_INTEGRATION: 'true',
  });
  if(!testsOnly){await runMigrations(owner);await assertNoBusinessData();}
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  assert.equal(await redis.ping(), 'PONG');
  const filename = `/app/.data/media/m0-${randomUUID()}`;
  await writeFile(filename, 'synthetic-media-check', { flag: 'wx', mode: 0o600 });
  assert.equal(await readFile(filename, 'utf8'), 'synthetic-media-check');
  await unlink(filename);
  // Prove that the validation network cannot reach external message providers.
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = createConnection({ host: '1.1.1.1', port: 443 });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Egress blocked')); });
    socket.once('error', reject);
  }));
  console.log(JSON.stringify({ status: 'passed', developmentDatabase: testsOnly?'not-touched':'waia_v2_app',
    businessRows: testsOnly?'not-checked':0, redis: 'dedicated/PONG', media: 'dedicated/write-read-remove',
    egress: 'blocked', api: 'not-started-by-validator', worker: 'not-started-by-validator' }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code || 'CHECK_FAILED' }));
  process.exitCode = 1;
} finally {
  if (owner) await owner.end();
  if (app) await app.end();
  if (redis) redis.disconnect();
}
