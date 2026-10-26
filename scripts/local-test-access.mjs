import { spawnSync } from 'node:child_process';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLocalTestPreview, localAccessDocument, localMailDocument, localMfaCode,
  LOCAL_TEST_CONTAINER, LOCAL_TEST_NETWORK } from '../src/operations/local-test-access.js';

// Host helper only: no HTTP route, SQL, reset, state mutation or credential logs.
const root = fileURLToPath(new URL('../', import.meta.url));
const secretDir = join(root, '.secrets');
function docker(args) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Preview local indisponível.');
  return result.stdout;
}
async function noSymlink(path, optional = false) {
  try {
    const value = await lstat(path);
    if (value.isSymbolicLink() || (!value.isFile() && !value.isDirectory())) throw new Error('Caminho privado inválido.');
    return value;
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
async function privateRead(name) {
  const path = join(secretDir, name);
  if (!(await noSymlink(path)).isFile()) throw new Error('Fonte privada inválida.');
  return readFile(path, 'utf8');
}
async function writePrivate(name, content) {
  const destination = join(secretDir, name);
  const previous = await noSymlink(destination, true);
  if (previous && !previous.isFile()) throw new Error('Destino privado inválido.');
  const temporary = join(secretDir, `.local-access-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    if (process.platform === 'win32') {
      const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 10_000 });
      const sid = identity.status === 0 ? identity.stdout.match(/"(S-\d(?:-\d+)+)"\s*$/mu)?.[1] : null;
      if (!sid) throw new Error('Não foi possível proteger o arquivo.');
      const acl = spawnSync('icacls.exe', [temporary, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'],
        { encoding: 'utf8', timeout: 10_000 });
      if (acl.status !== 0) throw new Error('Não foi possível proteger o arquivo.');
    }
    await handle.writeFile(content);
    await handle.close();
    await rename(temporary, destination);
    console.log(destination);
  } finally { await handle.close().catch(() => {}); await rm(temporary, { force: true }); }
}
try {
  const mode = process.argv[2];
  if (!['access', 'mail', 'code'].includes(mode) || process.argv.slice(3).some(arg => arg !== '--qr')
    || (process.argv.includes('--qr') && mode !== 'access')) throw new Error('Modo inválido.');
  // Inspect may contain infrastructure secrets: keep it entirely in memory and
  // validate the synthetic boundary before reading any saved user credential.
  const containers = JSON.parse(docker(['inspect', LOCAL_TEST_CONTAINER]));
  const networks = JSON.parse(docker(['network', 'inspect', LOCAL_TEST_NETWORK]));
  if (containers.length !== 1 || networks.length !== 1) throw new Error('Preview inválido.');
  assertLocalTestPreview(containers[0], networks[0]);
  await mkdir(secretDir, { recursive: true, mode: 0o700 });
  if (!(await noSymlink(secretDir)).isDirectory()) throw new Error('Diretório privado inválido.');
  if (mode === 'mail') {
    const messages = JSON.parse(docker(['exec', LOCAL_TEST_CONTAINER, 'node', '-e',
      "const fs=require('fs'),p='/tmp/waia-v2-fake-inbox.json';process.stdout.write(fs.existsSync(p)?fs.readFileSync(p,'utf8'):'[]');"]));
    await writePrivate('EMAILS_TESTE_LOCAL.md', localMailDocument(messages));
  } else {
    const mfa = JSON.parse(await privateRead('v2-preview-admin-mfa.json'));
    if (mode === 'code') {
      const value = localMfaCode(mfa.secret);
      await writePrivate('CODIGO_MFA_LOCAL.txt', `Código MFA sintético local: ${value.code}\nVálido até ${value.expiresAt}\nSe já utilizou este código, aguarde o próximo período e gere novamente.\n`);
    } else {
      const access = localAccessDocument({ bootstrap: await privateRead('v2-preview-bootstrap.env'),
        users: JSON.parse(await privateRead('v2-m3-users.json')), mfa });
      await writePrivate('ACESSOS_TESTE_LOCAL.md', access.text);
      if (process.argv.includes('--qr')) {
        const { default: QRCode } = await import('qrcode');
        await writePrivate('MFA_ADMIN_LOCAL.png', await QRCode.toBuffer(access.otpUri, { type: 'png', errorCorrectionLevel: 'M' }));
      }
    }
  }
} catch {
  console.error('Não foi possível gerar o acesso local. Confira o preview fictício isolado e os arquivos privados; nenhum valor foi exibido.');
  process.exitCode = 1;
}
