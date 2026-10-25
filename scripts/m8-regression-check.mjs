import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

// Opt-in integrations from the entire repository, serialized to keep legacy
// database fixtures and shared Redis checks independent of each other.
assert.equal(process.env.NODE_ENV, 'test');
const urls = {};
for (const [key, role] of [['DATABASE_URL', 'waia_v2_app'], ['DATABASE_MIGRATOR_URL', 'waia_v2_owner']]) {
  const value = new URL(process.env[key]);
  assert.equal(value.hostname, 'v2-postgres'); assert.equal(value.pathname, '/waia_v2_empty');
  assert.equal(value.username, role); assert.equal(value.search, ''); assert.equal(value.hash, '');
  value.pathname = '/waia_v2_upgrade'; urls[key] = value.href;
}
const redis = new URL(process.env.REDIS_URL);
assert.equal(redis.hostname, 'v2-redis'); assert.equal(redis.pathname, '/0');
assert.equal(redis.search, ''); assert.equal(redis.hash, '');
for (const [key, role] of [['DATABASE_URL', 'waia_v2_app'], ['DATABASE_MIGRATOR_URL', 'waia_v2_owner']]) {
  const pool = new pg.Pool({ connectionString: urls[key], max: 1, connectionTimeoutMillis: 5000 });
  try {
    const actual = (await pool.query(`SELECT current_database() AS database,current_user AS role,rolsuper,rolbypassrls
      FROM pg_roles WHERE rolname=current_user`)).rows[0];
    assert.deepEqual(actual, { database: 'waia_v2_upgrade', role, rolsuper: false, rolbypassrls: false });
  } finally { await pool.end(); }
}
const tests = [];
const excluded = new Map([
  ['capitao-mor-phase8-postgres.test.js', 'Requer seed histórico da instalação anterior.'],
  ['fase10-beta-postgres-panel.test.js', 'Requer seed histórico e contrato administrativo anterior.'],
  ['group-notifier-postgres.test.js', 'Requer RUN_GROUP_NOTIFIER_POSTGRES e banco descartável próprio; não habilitado nesta rodada.'],
]);
for (const file of (await readdir('test')).filter((file) => file.endsWith('.test.js')).sort()) {
  const source = await readFile(`test/${file}`, 'utf8');
  if (!excluded.has(file) && /RUN_POSTGRES_INTEGRATION|RUN_REDIS_INTEGRATION|\.\/support\/m1-fixtures\.js/.test(source)) tests.push(`test/${file}`);
}
assert.ok(tests.length >= 20);
console.log(JSON.stringify({ stage: 'full-integration-regressions', files: tests.length, database: 'waia_v2_upgrade', serialized: true,
  excluded: [...excluded].map(([file, reason]) => ({ file, reason })), historicalSeedExecuted: false }));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
  stdio: 'inherit', env: { ...process.env, ...urls, MEDIA_STORAGE_ROOT: '/app/.data/media',
    RUN_POSTGRES_INTEGRATION: 'true', RUN_REDIS_INTEGRATION: 'true' },
});
if (result.status !== 0) process.exitCode = 1;
