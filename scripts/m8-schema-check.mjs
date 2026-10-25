import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Fresh synthetic PostgreSQL in tmpfs, on the existing internal waia-test network.
// Never restores, resets or mounts a persistent database or production data.
const root = resolve('.'), network = 'waia-test_v2_internal';
const name = `waia-test-m8-schema-${randomUUID().slice(0, 8)}`;
const image = 'waia:v2-test-local';
const values = Object.fromEntries(readFileSync('.secrets/v2-test.env', 'utf8').split(/\r?\n/)
  .filter((line) => line && !line.startsWith('#')).map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
for (const key of ['V2_BOOTSTRAP_PASSWORD', 'V2_OWNER_PASSWORD', 'V2_APP_PASSWORD']) assert.ok(values[key]);
const run = (args, { env = {}, allowFailure = false } = {}) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000, maxBuffer: 5 * 1024 * 1024 });
  if (!allowFailure) assert.equal(result.status, 0, 'Operação sintética de schema falhou; saída privada omitida.');
  return result;
};
assert.equal(JSON.parse(run(['network', 'inspect', network]).stdout)[0].Internal, true);
let created = false;
try {
  run(['run', '-d', '--name', name, '--label', 'com.docker.compose.project=waia-test', '--label', 'waia.m8=schema-tmpfs',
    '--network', network, '--tmpfs', '/var/lib/postgresql/data:rw,mode=700',
    '--mount', `type=bind,source=${resolve(root, 'infra/postgres/init-v2-test.sh')},target=/docker-entrypoint-initdb.d/10-v2.sh,readonly`,
    '--env-file', resolve(root, '.secrets/v2-test.env'), '-e', 'POSTGRES_PASSWORD',
    '-e', 'POSTGRES_USER=waia_v2_bootstrap', '-e', 'POSTGRES_DB=postgres', 'postgres:16-alpine'],
  { env: { POSTGRES_PASSWORD: values.V2_BOOTSTRAP_PASSWORD } });
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = run(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'waia_v2_bootstrap', '-d', 'waia_v2_empty'], { allowFailure: true });
    if (result.status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(ready, 'PostgreSQL efêmero não ficou disponível.');
  const metadata = JSON.parse(run(['inspect', name]).stdout)[0];
  assert.equal(metadata.Config.Labels['waia.m8'], 'schema-tmpfs');
  assert.deepEqual(Object.keys(metadata.NetworkSettings.Networks), [network]);
  assert.equal(metadata.HostConfig.Tmpfs['/var/lib/postgresql/data'], 'rw,mode=700');
  assert.equal(metadata.HostConfig.PortBindings == null || Object.keys(metadata.HostConfig.PortBindings).length === 0, true);
  assert.equal(metadata.Mounts.some((mount) => mount.Type === 'volume' || (mount.Destination === '/var/lib/postgresql/data' && mount.Type !== 'tmpfs')), false);
  const database = (role, password) => `postgres://${role}:${encodeURIComponent(password)}@${name}:5432/waia_v2_empty`;
  const result = run(['run', '--rm', '--network', network, '--read-only', '--tmpfs', '/tmp:mode=1777',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-e', 'NODE_ENV=test',
    '-e', 'DATABASE_URL', '-e', 'DATABASE_MIGRATOR_URL', image, 'node', 'scripts/m0-schema-check.mjs'], {
    env: { DATABASE_URL: database('waia_v2_app', values.V2_APP_PASSWORD),
      DATABASE_MIGRATOR_URL: database('waia_v2_owner', values.V2_OWNER_PASSWORD) },
  });
  const proof = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(proof.status, 'passed'); assert.equal(proof.mode, 'fresh-and-upgrade');
  assert.equal(proof.businessRows, 0); assert.equal(proof.schemaEqual, true);
  console.log(JSON.stringify({ ...proof, environment: 'ephemeral-tmpfs/internal-waia-test', persistentTargetsTouched: false }));
} catch {
  console.error(JSON.stringify({ status: 'failed', stage: 'm8-fresh-schema', details: 'Saída operacional omitida para preservar credenciais.' }));
  process.exitCode = 1;
} finally {
  if (created) {
    // Verify ownership before removing only this exact, newly created container.
    const metadata = JSON.parse(run(['inspect', name]).stdout)[0];
    assert.equal(metadata.Name, `/${name}`); assert.equal(metadata.Config.Labels['waia.m8'], 'schema-tmpfs');
    run(['rm', '-f', name]);
  }
}
