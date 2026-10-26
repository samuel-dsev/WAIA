import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Resume the delivered local artifact and the existing v2 infrastructure only.
// No build, migration, seed, volume creation, VPS or external connection.
const root = fileURLToPath(new URL('../', import.meta.url));
function docker(args) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, 'Docker local indisponível; nenhum dado foi removido.');
  return result.stdout.trim();
}
try {
  const release = JSON.parse(readFileSync(join(root, '.secrets/v2-local-release.json'), 'utf8'));
  assert.match(release.imageId, /^sha256:[a-f0-9]{64}$/); assert.match(release.commit, /^[a-f0-9]{40}$/);
  assert.match(release.version, /^2\.0\.0(?:-rc\.[1-9][0-9]*)?$/);
  const image = JSON.parse(docker(['image', 'inspect', release.imageId]))[0];
  assert.equal(image.Id, release.imageId);
  assert.equal(image.Config.Labels['org.opencontainers.image.revision'], release.commit);
  assert.equal(image.Config.Labels['org.opencontainers.image.version'], release.version);
  const network = JSON.parse(docker(['network', 'inspect', 'waia-test_v2_internal']))[0];
  assert.equal(network.Internal, true);
  const media = JSON.parse(docker(['volume', 'inspect', 'waia-test_v2_media_data']))[0];
  assert.equal(media.Name, 'waia-test_v2_media_data');
  assert.equal(media.Labels?.['com.docker.compose.project'], 'waia-test');
  assert.equal(media.Labels?.['com.docker.compose.volume'], 'v2_media_data');
  const targets = ['postgres', 'redis'].map((kind) => {
    const name = `waia-test-v2-${kind}-1`, item = JSON.parse(docker(['inspect', name]))[0];
    assert.equal(item.Name, '/' + name); assert.equal(item.Config.Labels['com.docker.compose.project'], 'waia-test');
    assert.equal(item.Config.Labels['com.docker.compose.service'], `v2-${kind}`);
    assert.deepEqual(Object.keys(item.NetworkSettings.Networks), ['waia-test_v2_internal']);
    assert.equal(Object.keys(item.HostConfig.PortBindings || {}).length, 0);
    assert.equal(item.Mounts.filter((mount) => mount.Type === 'volume').length, 1);
    assert.equal(item.Mounts.find((mount) => mount.Type === 'volume').Name, `waia-test_v2_${kind}_data`);
    return { name, item };
  });
  // Both targets are checked before starting either; absence is not permission
  // to provision another cluster or choose another existing database.
  for (const { name, item } of targets) if (!item.State.Running) docker(['start', name]);
  for (const { name } of targets) {
    let healthy = false;
    for (let n = 0; n < 45; n++) {
      const item = JSON.parse(docker(['inspect', name]))[0];
      if (item.State.Health?.Status === 'healthy') { healthy = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(healthy, 'Infraestrutura v2 ainda não está saudável.');
  }
  const result = spawnSync(process.execPath, [join(root, 'scripts/prepare-v2-preview.mjs'), release.imageId],
    { cwd: root, stdio: 'inherit', timeout: 180000 });
  assert.equal(result.status, 0);
  const access = spawnSync(process.execPath, [join(root, 'scripts/local-test-access.mjs'), 'access'],
    { cwd: root, stdio: 'inherit', timeout: 60000 });
  assert.equal(access.status, 0);
} catch {
  console.error('Não foi possível retomar a entrega local. Confira Docker Desktop, artefato e infraestrutura v2 existentes; nenhum volume foi removido.');
  process.exitCode = 1;
}
