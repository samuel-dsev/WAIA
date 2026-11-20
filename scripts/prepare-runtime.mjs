import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATIC_ASSETS } from '../src/operations/static-assets.js';

export const RUNTIME_SCRIPTS = Object.freeze([
  'migrate.js', 'create-admin.js', 'check-whatsapp.js',
  'backup-postgres.sh', 'backup-offsite.sh', 'restore-postgres.sh',
]);
const localSources = new Set(['src/server.js', 'src/operations/local-test-access.js']);

export async function runtimeFilePaths(root) {
  const files = ['package.json', 'package-lock.json'];
  async function visit(directory, extension) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Link simbólico não permitido na fonte de release.');
      if (entry.isDirectory()) await visit(path, extension);
      else if (entry.isFile() && entry.name.endsWith(extension) && !localSources.has(path)) files.push(path);
    }
  }
  await visit('src', '.js');
  await visit('db/migrations', '.sql');
  files.push(...RUNTIME_SCRIPTS.map(file => `scripts/${file}`));
  for (const [surface, assets] of Object.entries(STATIC_ASSETS)) files.push(...assets.map(file => `${surface}/${file}`));
  files.push('public/privacy.html', 'public/data-deletion.html');
  return files.sort();
}

export async function prepareRuntime({ root, destination }) {
  root = resolve(root); destination = resolve(destination);
  // Never replace an existing directory, checkout or historical artifact.
  await mkdir(destination);
  const files = await runtimeFilePaths(root);
  for (const file of files) {
    const source = join(root, file), target = join(destination, file);
    if (!(await lstat(source)).isFile()) throw new Error('Arquivo regular obrigatório na release.');
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Informe o diretório novo do pacote de runtime.');
  const files = await prepareRuntime({ root: fileURLToPath(new URL('../', import.meta.url)), destination: process.argv[2] });
  console.log(JSON.stringify({ runtimeFiles: files.length, localFixturesIncluded: false }));
}
