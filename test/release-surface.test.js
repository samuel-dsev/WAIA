import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createStaticAssetRouter, STATIC_ASSETS } from '../src/operations/static-assets.js';
import { prepareRuntime, RUNTIME_SCRIPTS } from '../scripts/prepare-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'waia-release-surface-'));
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(join(resolve(tmpdir()), 'waia-release-surface-')));
    await rm(dir, { recursive: true });
  });
  return dir;
}
async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
const hash = data => createHash('sha256').update(data).digest('hex');

test('interfaces mantêm todos os assets e bytes originais com cabeçalhos de segurança', async t => {
  const app = express();
  for (const surface of Object.keys(STATIC_ASSETS)) app.use(`/${surface}`, createStaticAssetRouter({ surface, directory: join(root, surface) }));
  const origin = await serve(t, app);
  for (const [surface, assets] of Object.entries(STATIC_ASSETS)) {
    for (const file of assets) {
      const response = await fetch(`${origin}/${surface}/${file}?v=release`);
      assert.equal(response.status, 200, `${surface}/${file}`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(join(root, surface, file))));
    }
    assert.equal((await fetch(`${origin}/${surface}/`)).status, 200);
    assert.equal((await fetch(`${origin}/${surface}/app.js`, { method: 'HEAD' })).status, 200);
  }
});

test('arquivos locais, pilotos, cópias e caminhos codificados não são entregues', async t => {
  const dir = await temporary(t);
  for (const file of ['app.js', 'security-team.js', '.env', 'index.html.bak', 'debug.js', 'app.js.map']) await writeFile(join(dir, file), 'local-canary');
  await mkdir(join(dir, 'group-notifier-pilot'));
  await writeFile(join(dir, 'group-notifier-pilot', 'index.html'), 'local-canary');
  const app = express();
  for (const surface of Object.keys(STATIC_ASSETS)) app.use(`/${surface}`, createStaticAssetRouter({ surface, directory: dir }));
  const origin = await serve(t, app);
  for (const surface of Object.keys(STATIC_ASSETS)) {
    for (const path of ['security-team.js', '.env', 'index.html.bak', 'debug.js', 'app.js.map', 'group-notifier-pilot/', '%61pp.js', 'app.js/extra', 'APP.js']) {
      const response = await fetch(`${origin}/${surface}/${path}`);
      assert.equal(response.status, 404, path);
      assert.doesNotMatch(await response.text(), /local-canary/);
    }
    assert.equal((await fetch(`${origin}/${surface}/app.js`, { method: 'POST' })).status, 404);
  }
});

test('inventário cobre imports e referências HTML sem incluir módulos órfãos', async () => {
  const declared = new Set(Object.entries(STATIC_ASSETS).flatMap(([surface, files]) => files.map(file => `/${surface}/${file}`)));
  const visited = new Set();
  async function visit(path) {
    if (visited.has(path)) return;
    assert.ok(declared.has(path), `Dependência ausente: ${path}`); visited.add(path);
    const source = await readFile(join(root, path.slice(1)), 'utf8');
    const refs = path.endsWith('.html') ? [...source.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)].map(m => m[1])
      : [...source.matchAll(/^import[^\r\n]*?\bfrom\s*["']([^"']+)["']/gm)].map(m => m[1]);
    for (const ref of refs) await visit(new URL(ref, `https://assets.invalid${path}`).pathname);
  }
  await visit('/panel/index.html'); await visit('/portal/index.html');
  assert.deepEqual([...visited].sort(), [...declared].sort());
});

test('pacote de produção exclui testes, seeds, preview e servidor legado sem modificar assets', async t => {
  const dir = await temporary(t), destination = join(dir, 'runtime');
  const files = await prepareRuntime({ root, destination });
  assert.deepEqual(await readdir(join(destination, 'scripts')).then(files => files.sort()), [...RUNTIME_SCRIPTS].sort());
  for (const file of ['src/server.js', 'src/operations/local-test-access.js', 'db/seeds', 'test', '.tmp', '.env', 'panel/group-notifier-pilot', 'portal/security-team.js']) {
    await assert.rejects(readFile(join(destination, file)), { code: 'ENOENT' });
  }
  for (const file of files.filter(file => /^(?:panel|portal|public)\//.test(file))) assert.equal(hash(await readFile(join(root, file))), hash(await readFile(join(destination, file))));
  await assert.rejects(prepareRuntime({ root, destination }), { code: 'EEXIST' });
});
