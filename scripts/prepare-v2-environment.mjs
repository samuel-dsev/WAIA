import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw new Error(`${command} falhou; preparação interrompida, sem limpar volumes.`);
  return result.stdout?.trim();
}

try {
  if (run('git', ['branch', '--show-current'], true) !== 'new') throw new Error('Preparação autorizada somente na branch new.');
  const secretFile = path.join(root, '.secrets', 'v2-test.env');
  mkdirSync(path.dirname(secretFile), { recursive: true });
  if (!existsSync(secretFile)) {
    const value = () => randomBytes(32).toString('hex');
    writeFileSync(secretFile, `V2_BOOTSTRAP_PASSWORD=${value()}\nV2_OWNER_PASSWORD=${value()}\nV2_APP_PASSWORD=${value()}\nV2_SESSION_PEPPER=${value()}\nV2_MASTER_KEY=${value()}\n`, { flag: 'wx', mode: 0o600 });
  }
  const compose = ['compose', '--project-name', 'waia-test', '--env-file', secretFile, '--file', 'infra/compose.v2-test.yml'];
  run('docker', [...compose, 'config', '--quiet']);
  run('docker', ['build', '--target', 'validation', '--tag', 'waia:v2-test-local', '.']);
  run('docker', [...compose, 'up', '-d', '--wait', 'v2-postgres', 'v2-redis']);
  run('docker', [...compose, 'run', '--rm', '--no-deps', 'v2-media-init']);
  const network = JSON.parse(run('docker', ['network', 'inspect', 'waia-test_v2_internal'], true))[0];
  if (!network.Internal) throw new Error('A rede v2 precisa bloquear egress.');
  for (const service of ['v2-postgres', 'v2-redis']) {
    const metadata = JSON.parse(run('docker', ['inspect', `waia-test-${service}-1`], true))[0];
    if (metadata.Config.Labels['com.docker.compose.project'] !== 'waia-test'
      || Object.keys(metadata.NetworkSettings.Networks).join() !== 'waia-test_v2_internal'
      || Object.keys(metadata.HostConfig.PortBindings || {}).length) throw new Error('Isolamento de serviço v2 inválido.');
    if (metadata.Mounts.some((mount) => mount.Type === 'volume' && !mount.Name.startsWith('waia-test_v2_'))) {
      throw new Error('Serviço v2 está usando volume anterior.');
    }
  }
  console.log('Infraestrutura v2 pronta: projeto waia-test, rede interna, volumes v2; API/worker ausentes. Execute o gate M0 conforme docs/M0_AMBIENTE.md.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
