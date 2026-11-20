import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('parser sobrevive a corpos comprimidos com bytes finais inválidos (GHSA-27r3-jxmh-p828)', async () => {
  // Run the crash regression in a separate local process, never against a tenant
  // or deployed API. An uncaught decoder error must fail the child, not this test host.
  const script = `
    import express from 'express';
    import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
    import { once } from 'node:events';
    const app = express(); app.use(express.json({ limit: '1mb' }));
    app.post('/probe', (_req, res) => res.sendStatus(204));
    app.get('/alive', (_req, res) => res.sendStatus(204));
    app.use((_error, _req, res, _next) => res.sendStatus(400));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
      for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
        const body = Buffer.concat([compress(Buffer.from('{}')), Buffer.from('invalid-trailing-bytes')]);
        const response = await fetch(origin + '/probe', { method: 'POST', body,
          headers: { 'content-type': 'application/json', 'content-encoding': encoding } });
        await response.arrayBuffer();
        await new Promise(resolve => setTimeout(resolve, 100));
        if ((await fetch(origin + '/alive')).status !== 204) throw Error('Parser process unavailable');
      }
      console.log('compressed-body-regression: passed');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 15_000 });
  assert.match(stdout, /compressed-body-regression: passed/);
});
