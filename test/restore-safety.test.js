import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const script = fileURLToPath(new URL('../scripts/restore-postgres.sh', import.meta.url));
const hasShell = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v tar >/dev/null && command -v sha256sum >/dev/null']).status === 0;

async function runRestore(failure) {
  const root = await mkdtemp(path.join(tmpdir(), 'waia-restore-safety-'));
  try {
    const bundle = path.join(root, 'bundle');
    const log = path.join(root, 'docker.log');
    await mkdir(bundle);
    await writeFile(path.join(bundle, 'postgres.dump'), 'synthetic test dump');
    await writeFile(path.join(bundle, 'media.txt'), 'synthetic test media');
    const archive = spawnSync('tar', ['-czf', path.join(bundle, 'media.tar.gz'), '-C', bundle, 'media.txt']);
    assert.equal(archive.status, 0);
    const checksums = [];
    for (const name of ['postgres.dump', 'media.tar.gz']) {
      const digest = createHash('sha256').update(await readFile(path.join(bundle, name))).digest('hex');
      checksums.push(`${digest}  ${name}`);
    }
    await writeFile(path.join(bundle, 'checksums.sha256'), `${checksums.join('\n')}\n`);
    // PostgreSQL/Docker is mocked; checksums and archive validation are real.
    const mockShell = `docker() {
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$RESTORE_FAILURE:$*" in
  restore:*--section=data*) return 42 ;;
  migrate:*"run --rm --no-deps -T migrate"*) return 42 ;;
  stop:*"stop api worker"*) return 42 ;;
esac
return 0
}
set -- "$RESTORE_BUNDLE"
. "$RESTORE_SCRIPT"
`;
    const result = spawnSync('sh', ['-c', mockShell], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        RESTORE_SCRIPT: script,
        RESTORE_BUNDLE: bundle,
        DOCKER_LOG: log,
        RESTORE_FAILURE: failure,
        WAIA_COMPOSE_PROJECT: 'waia-synthetic-restore-test',
        POSTGRES_DB: 'waia_synthetic_restore',
        POSTGRES_USER: 'waia_synthetic_owner',
        RESTORE_ISOLATED: 'true',
        RESTORE_CONFIRM: 'RESTORE:waia-synthetic-restore-test:waia_synthetic_restore',
      },
    });
    assert.equal(result.error, undefined);
    const output = await readFile(log, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    return { ...result, commands: output.trim().split('\n').filter(Boolean) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const failure of ['restore', 'migrate', 'stop']) {
  test(`restore keeps services stopped when ${failure} fails`, { skip: !hasShell }, async () => {
    const result = await runRestore(failure);
    assert.equal(result.status, 42, result.stderr);
    assert.equal(result.commands.filter((line) => line.endsWith('stop api worker')).length, 1);
    assert.equal(result.commands.filter((line) => line.endsWith('start api worker')).length, 0);
    assert.match(result.stderr, /Reinicio automatico desabilitado; mantenha API e worker parados/u);
    assert.doesNotMatch(result.stdout, /Restore concluido/u);
    if (failure === 'restore') {
      assert.ok(result.commands.some((line) => line.includes('DROP SCHEMA public CASCADE')));
      assert.ok(result.commands.some((line) => line.includes('--section=data')));
      assert.ok(!result.commands.some((line) => line.endsWith('-T migrate')));
    }
    if (failure === 'migrate') {
      assert.ok(result.commands.some((line) => line.includes('--section=post-data')));
      assert.ok(result.commands.some((line) => line.endsWith('-T migrate')));
    }
  });
}

test('restore starts services once, after successful restore and migration', { skip: !hasShell }, async () => {
  const result = await runRestore('none');
  assert.equal(result.status, 0, result.stderr);
  const start = result.commands.findIndex((line) => line.endsWith('start api worker'));
  const migration = result.commands.findIndex((line) => line.endsWith('-T migrate'));
  assert.ok(migration >= 0 && start > migration);
  assert.equal(result.commands.filter((line) => line.endsWith('start api worker')).length, 1);
  assert.match(result.stdout, /Restore concluido/u);
  assert.doesNotMatch(result.stderr, /Restore interrompido/u);
});
