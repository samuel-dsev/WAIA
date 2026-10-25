import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Host orchestrator: no existing database/volume is a permissible restore target.
// An operator must explicitly authorize this temporary synthetic drill.
assert.ok(process.argv.includes('--authorize-tmpfs'), 'Explicit temporary-target authorization is required.');
const image = process.argv[2], rollbackImage = process.argv[3];
for (const id of [image, rollbackImage]) assert.match(id || '', /^sha256:[a-f0-9]{64}$/);
const root = resolve('.'), network = 'waia-test_v2_internal';
const id = randomUUID().slice(0, 8), label = `waia.m9.recovery=${id}`;
const names = { source: `waia-test-m9-source-${id}`, restore: `waia-test-m9-restore-${id}`, redis: `waia-test-m9-redis-${id}` };
const destination = resolve('.tmp', 'm9', `recovery-${id}`);
const source = join(destination, 'source'), restored = join(destination, 'restored'), bundle = join(destination, 'bundle');
for (const dir of [source, restored, bundle]) mkdirSync(dir, { recursive: true });
const secret = () => randomBytes(32).toString('hex');
const passwords = { POSTGRES_PASSWORD: secret(), V2_OWNER_PASSWORD: secret(), V2_APP_PASSWORD: secret() };
const keys = { M9_ADMIN_PASSWORD: secret(), M9_CREDENTIAL_CANARY: secret(), M9_SESSION_PEPPER: secret(),
  M9_KEYRING: JSON.stringify({ activeVersion: '1', keys: { '1': randomBytes(32).toString('base64') } }) };
mkdirSync(resolve('.secrets'), { recursive: true });
// Key custody is deliberately outside the backup bundle; never print this file.
writeFileSync(resolve('.secrets', `m9-${id}.env`), Object.entries({ ...passwords, ...keys }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
function run(args, { env = {}, failure = false, timeout = 120000 } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, ...env }, timeout, maxBuffer: 8 * 1024 * 1024 });
  if (!failure && result.status !== 0) {
    let diagnostic = (result.stdout || '') + '\n' + (result.stderr || '') + '\n' + (result.error?.code || '');
    for (const value of [...Object.values(passwords), ...Object.values(keys)]) diagnostic = diagnostic.replaceAll(value, '[REDACTED]');
    writeFileSync(join(destination, 'operation-failure.log'), diagnostic, { mode: 0o600 });
  }
  if (!failure) assert.equal(result.status, 0, 'Synthetic recovery operation failed; private output omitted.');
  return result;
}
const inspect = (name) => JSON.parse(run(['inspect', name]).stdout)[0];
function guard(name) {
  assert.ok(Object.values(names).includes(name));
  const value = inspect(name);
  assert.equal(value.Name, `/${name}`);
  assert.equal(value.Config.Labels?.['com.docker.compose.project'], 'waia-test');
  assert.equal(value.Config.Labels?.['waia.m9.recovery'], id);
  assert.deepEqual(Object.keys(value.NetworkSettings.Networks), [network]);
  assert.equal(Object.keys(value.HostConfig.PortBindings || {}).length, 0);
  assert.equal(value.Mounts.some((mount) => mount.Type === 'volume'), false);
  const location = name === names.redis ? '/data' : '/var/lib/postgresql/data';
  assert.ok(value.HostConfig.Tmpfs[location]);
  assert.equal(value.Mounts.some((m) => m.Destination === location && m.Type !== 'tmpfs'), false);
}
const proof = { status: 'running', startedAt: new Date().toISOString(), imageId: image, rollbackImageId: rollbackImage,
  target: 'temporary-tmpfs-only', persistentTargetsTouched: false, externalCalls: 0, steps: [] };
const created = [];
let stage = 'preflight';
async function ready(name, args) {
  for (let i = 0; i < 60; i++) {
    if (run(['exec', name, ...args], { failure: true }).status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Temporary service unavailable.');
}
function fixture(target, dir, mode, selectedImage = image) {
  guard(target); guard(names.redis);
  const owner = `postgres://waia_v2_owner:${passwords.V2_OWNER_PASSWORD}@${target}:5432/waia_v2_empty`;
  const app = `postgres://waia_v2_app:${passwords.V2_APP_PASSWORD}@${target}:5432/waia_v2_empty`;
  const env = { ...keys, DATABASE_MIGRATOR_URL: owner, DATABASE_URL: app, REDIS_URL: `redis://${names.redis}:6379/0` };
  const args = ['run', '--rm', '--label', 'com.docker.compose.project=waia-test', '--label', label,
    '--network', network, '--read-only', '--tmpfs', '/tmp:mode=1777', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--mount', `type=bind,source=${dir},target=/drill`, '-e', 'NODE_ENV=test', '-e', 'M9_SYNTHETIC_CONFIRM=tmpfs-only'];
  for (const key of Object.keys(env)) args.push('-e', key);
  // The rollback image runs the exact same probe against its own application
  // modules. Only the synthetic harness is mounted; product code is never replaced.
  if (selectedImage !== image) args.push('--mount', `type=bind,source=${resolve('scripts/m9-recovery-fixture.mjs')},target=/app/scripts/m9-recovery-fixture.mjs,readonly`);
  args.push(selectedImage, 'node', 'scripts/m9-recovery-fixture.mjs', mode);
  const result = run(args, { env, failure: true });
  if (result.status !== 0) {
    writeFileSync(join(destination, 'fixture-failure.log'), result.stdout + '\n' + result.stderr, { mode: 0o600 });
  }
  assert.equal(result.status, 0, 'Synthetic fixture failed; private diagnostic preserved.');
  const step = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); assert.equal(step.status, 'passed');
  proof.steps.push({ ...step, image: selectedImage === image ? 'rc' : 'm8' });
  console.log(JSON.stringify({ stage, status: 'passed' }));
}
async function bootstrapAdmin() {
  guard(names.source);
  const env = { ...process.env, DATABASE_URL: `postgres://waia_v2_owner:${passwords.V2_OWNER_PASSWORD}@${names.source}:5432/waia_v2_empty` };
  const args = ['run', '--rm', '-i', '--network', network, '--read-only', '--tmpfs', '/tmp:mode=1777',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-e', 'DATABASE_URL', '-e', 'NODE_ENV=test',
    '-e', 'ADMIN_EMAIL=admin.drill@waia.example', '-e', 'ADMIN_NAME=Administrador sintetico M9', image, 'node', 'scripts/create-admin.js'];
  await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', sent = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Bootstrap timed out.')); }, 60000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (sent === 0 && output.includes('Senha (12 a 256 caracteres):')) { sent = 1; child.stdin.write(keys.M9_ADMIN_PASSWORD + '\n'); }
      if (sent === 1 && output.includes('Confirme a senha:')) { sent = 2; child.stdin.end(keys.M9_ADMIN_PASSWORD + '\n'); }
    });
    child.stderr.resume();
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer);
      if (code !== 0 || sent !== 2 || output.includes(keys.M9_ADMIN_PASSWORD)) return reject(new Error('Bootstrap failed.'));
      resolve();
    });
  });
  proof.steps.push({ status: 'passed', stage: 'operational-admin-cli', passwordEchoed: false, image: 'rc' });
}
try {
  assert.equal(JSON.parse(run(['network', 'inspect', network]).stdout)[0].Internal, true);
  stage = 'rollback-source-verification';
  const git = spawnSync('git', ['rev-parse', 'be548d5^{commit}'], { encoding: 'utf8' });
  assert.equal(git.status, 0); proof.rollbackCommit = git.stdout.trim();
  const listing = spawnSync('git', ['ls-tree', '-r', proof.rollbackCommit, '--', 'src', 'scripts', 'db', 'panel', 'portal', 'public', 'package.json', 'package-lock.json'], { encoding: 'utf8' });
  assert.equal(listing.status, 0);
  const blobs = Object.fromEntries(listing.stdout.trim().split('\n').map(line => {
    const [metadata, path] = line.split('\t'); return [path, metadata.split(' ')[2]];
  }));
  const verifier = `const fs=require('fs'),crypto=require('crypto');let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{for(const[p,h]of Object.entries(JSON.parse(b))){const data=fs.readFileSync('/app/'+p);if(crypto.createHash('sha1').update(Buffer.from('blob '+data.length+'\\0')).update(data).digest('hex')!==h)throw Error('M8 runtime mismatch: '+p);}});`;
  const match = spawnSync('docker', ['run', '--rm', '-i', '--network', 'none', '--read-only', rollbackImage, 'node', '-e', verifier],
    { input: JSON.stringify(blobs), encoding: 'utf8', timeout: 120000 });
  if (match.status !== 0) writeFileSync(join(destination, 'rollback-source-check.log'), match.stderr);
  assert.equal(match.status, 0, 'Rollback runtime must match the actual M8 commit.');
  proof.rollbackRuntimeFilesMatched = Object.keys(blobs).length;
  for (const [selected, expected] of [[image, /^2\.0\.0-rc\.[1-9][0-9]*$/], [rollbackImage, /^1\.30\.1$/]]) {
    const metadata = JSON.parse(run(['image', 'inspect', selected]).stdout)[0]; assert.equal(metadata.Id, selected);
    const version = run(['run', '--rm', '--network', 'none', selected, 'node', '-p', "require('./package.json').version"]).stdout.trim();
    assert.match(version, expected);
  }
  for (const target of [names.source, names.restore]) {
    stage = 'create-temporary-postgres';
    run(['run', '-d', '--name', target, '--label', 'com.docker.compose.project=waia-test', '--label', label,
      '--network', network, '--tmpfs', '/var/lib/postgresql/data:rw,mode=700', '--tmpfs', '/tmp:mode=1777',
      '--mount', `type=bind,source=${resolve('infra/postgres/init-v2-test.sh')},target=/docker-entrypoint-initdb.d/10-v2.sh,readonly`,
      ...Object.keys(passwords).flatMap((key) => ['-e', key]), '-e', 'POSTGRES_USER=waia_v2_bootstrap', '-e', 'POSTGRES_DB=postgres', 'postgres:16-alpine'], { env: passwords });
    created.push(target); guard(target);
    await ready(target, ['pg_isready', '-h', '127.0.0.1', '-U', 'waia_v2_bootstrap', '-d', 'waia_v2_empty']);
  }
  run(['run', '-d', '--name', names.redis, '--label', 'com.docker.compose.project=waia-test', '--label', label,
    '--network', network, '--tmpfs', '/data:mode=1777', 'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no']);
  created.push(names.redis); guard(names.redis); await ready(names.redis, ['redis-cli', 'ping']);
  stage = 'fresh-install'; fixture(names.source, source, 'install');
  stage = 'bootstrap-admin-cli'; await bootstrapAdmin();
  stage = 'technical-canaries'; fixture(names.source, source, 'prepare');
  stage = 'source-verification'; fixture(names.source, source, 'verify');
  stage = 'source-api'; fixture(names.source, source, 'api');
  // No writers or workers remain at this point. DB/media represent the same
  // quiescent fixture; this is essential for a consistent bundle.
  stage = 'backup-pgdump'; guard(names.source);
  const backupStart = performance.now();
  run(['exec', names.source, 'pg_dump', '-U', 'waia_v2_bootstrap', '-d', 'waia_v2_empty', '--format=custom', '-f', '/tmp/m9.dump']);
  stage = 'backup-copy';
  // Docker archive/cp cannot reliably read tmpfs on Desktop. Stream raw bytes
  // directly, without PowerShell redirection or UTF-8 conversion of the dump.
  const dump = spawnSync('docker', ['exec', names.source, 'cat', '/tmp/m9.dump'], { timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(dump.status, 0); assert.ok(dump.stdout.length > 0);
  writeFileSync(join(bundle, 'postgres.dump'), dump.stdout, { mode: 0o600 });
  stage = 'backup-media';
  const tar = spawnSync('tar', ['-czf', join(bundle, 'media.tar.gz'), '-C', source, 'media', 'state.json'], { encoding: 'utf8', timeout: 120000 });
  if (tar.status !== 0) writeFileSync(join(destination, 'tar-failure.log'), (tar.stdout || '') + '\n' + (tar.stderr || ''));
  assert.equal(tar.status, 0);
  const hashes = Object.fromEntries(['postgres.dump', 'media.tar.gz'].map((file) => [file, createHash('sha256').update(readFileSync(join(bundle, file))).digest('hex')]));
  writeFileSync(join(bundle, 'checksums.json'), JSON.stringify(hashes, null, 2) + '\n');
  proof.backupMs = Math.round(performance.now() - backupStart);
  stage = 'restore'; guard(names.restore);
  // Both content hashes are checked before any target mutation.
  for (const [file, checksum] of Object.entries(hashes)) assert.equal(createHash('sha256').update(readFileSync(join(bundle, file))).digest('hex'), checksum);
  const empty = run(['exec', names.restore, 'psql', '-X', '-At', '-U', 'waia_v2_bootstrap', '-d', 'waia_v2_empty', '-c', "SELECT count(*) FROM pg_tables WHERE schemaname='public'"]).stdout.trim();
  assert.equal(empty, '0', 'Restore refuses a nonempty target.');
  const restoreStart = performance.now();
  const transfer = spawnSync('docker', ['exec', '-i', names.restore, 'sh', '-c', 'cat > /tmp/m9.dump'],
    { input: readFileSync(join(bundle, 'postgres.dump')), timeout: 120000 });
  assert.equal(transfer.status, 0);
  run(['exec', names.restore, 'pg_restore', '-U', 'waia_v2_bootstrap', '--role=waia_v2_owner', '-d', 'waia_v2_empty',
    '--no-owner', '--no-acl', '--single-transaction', '--exit-on-error', '/tmp/m9.dump']);
  assert.equal(spawnSync('tar', ['-xzf', join(bundle, 'media.tar.gz'), '-C', restored], { timeout: 120000 }).status, 0);
  proof.restoreMs = Math.round(performance.now() - restoreStart);
  stage = 'restored-verification'; fixture(names.restore, restored, 'verify');
  proof.restoreAndVerifyMs = Math.round(performance.now() - restoreStart);
  stage = 'restored-api'; fixture(names.restore, restored, 'api');
  stage = 'rollback-schema-data'; fixture(names.restore, restored, 'verify', rollbackImage);
  stage = 'rollback-api'; fixture(names.restore, restored, 'api', rollbackImage);
  stage = 'rollback-jobs'; fixture(names.restore, restored, 'jobs', rollbackImage);
  stage = 'return-rc-api'; fixture(names.restore, restored, 'api');
  stage = 'return-rc-jobs'; fixture(names.restore, restored, 'jobs-verify');
  stage = 'rc-gateway-real-api'; fixture(names.restore, restored, 'gateway');
  proof.status = 'passed'; proof.finishedAt = new Date().toISOString();
} catch {
  proof.status = 'failed'; proof.failedStage = stage; process.exitCode = 1;
} finally {
  for (const name of created.reverse()) { guard(name); run(['rm', '-f', name]); }
  proof.temporaryContainersRemoved = created.length;
  writeFileSync(join(destination, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify({ status: proof.status, stage, backupMs: proof.backupMs, restoreMs: proof.restoreMs,
    restoreAndVerifyMs: proof.restoreAndVerifyMs, proof: join(destination, 'proof.json'), persistentTargetsTouched: false }));
}
