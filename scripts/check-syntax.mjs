import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
function visit(directory) {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(filename);
    else if (/\.m?js$/.test(entry.name)) files.push(filename);
  }
}
for (const directory of ['src', 'scripts', 'test', 'panel', 'portal']) visit(directory);
for (const filename of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, filename)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Sintaxe aprovada: ${files.length} arquivos (src/scripts/test/panel/portal).`);
