import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createV2Ingress, canonicalIngressPath } from '../src/operations/v2-ingress.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
const close = server => new Promise(resolve => server.close(resolve));
async function fixture(options = {}) {
  const hits = [];
  let responseCookies;
  const marker = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    hits.push({ url: req.url, headers: req.headers, body });
    if (responseCookies) res.setHeader('Set-Cookie', responseCookies);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ marker: true }));
  });
  const upstreamPort = await listen(marker);
  const gateway = createV2Ingress({ surface: 'public', origin: 'http://portal.example',
    upstream: `http://127.0.0.1:${upstreamPort}`, allowInsecure: true, ...options });
  const port = await listen(gateway);
  return { hits, cookie(value) { responseCookies = value; },
    async stop() { await close(gateway); await close(marker); },
    send(path, { method = 'GET', headers = {}, body } = {}) {
      return new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path, method,
          headers: { host: 'portal.example', ...headers } }, res => {
          let output = '';
          res.on('data', chunk => { output += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: output }));
        });
        req.on('error', reject);
        req.end(body);
      });
    },
  };
}

test('gateway exige origem/upstream explícitos e peer administrativo exato', () => {
  const config = { surface: 'public', origin: 'https://portal.example', upstream: 'http://api:3001' };
  for (const options of [ {}, { ...config, surface: 'arbitrary' }, { ...config, origin: 'http://portal.example' },
    { ...config, origin: 'https://portal.example/' }, { ...config, origin: 'https://portal.example/path' },
    { ...config, origin: 'https://name:password@portal.example' },
    { ...config, upstream: 'http://name:password@api:3001' }, { ...config, upstream: 'http://api:3001/path' },
    { ...config, surface: 'admin' }, { ...config, surface: 'admin', adminPeerAllowlist: '172.18.0.0/16' },
    { ...config, trustedProxyPeers: '172.18.0.0/16' },
    { ...config, surface: 'admin', adminPeerAllowlist: '0.0.0.0/0' } ]) {
    assert.throws(() => createV2Ingress(options), undefined, JSON.stringify(options));
  }
  const valid = createV2Ingress({ ...config, surface: 'admin', adminPeerAllowlist: '127.0.0.1/32,::1' });
  valid.close();
});

test('público permite somente portal, APIs cliente e módulo compartilhado preciso', async () => {
  const f = await fixture();
  try {
    for (const path of ['/', '/portal', '/portal/', '/portal/index.html', '/portal/app.js',
      '/portal/navigation.js', '/portal/security.js', '/portal/attendance.js', '/portal/styles.css',
      '/panel/attendance-script.js', '/privacy', '/data-deletion',
      '/api/account/v1/session', '/api/app/v1/companies']) {
      assert.equal((await f.send(path)).status, 200, path);
    }
    const reply = await f.send('/api/account/v1/activate?token=synthetic%3D', { method: 'POST',
      headers: { origin: 'http://portal.example', 'content-type': 'application/json' }, body: '{"token":"synthetic"}' });
    assert.equal(reply.status, 200);
    assert.equal(f.hits.at(-1).url, '/api/account/v1/activate?token=synthetic%3D');
    assert.equal(f.hits.at(-1).body, '{"token":"synthetic"}');
  } finally { await f.stop(); }
});

test('variantes privadas e ambiguidades são negadas antes de atingir upstream', async () => {
  const f = await fixture();
  try {
    for (const path of ['/api/admin', '/api/admin/auth/login', '/API/admin/auth/login', '/api/Admin/auth/login',
      '/panel/', '/panel/app.js', '/panel/index.html', '/metrics', '/metrics/', '/health/ready', '/webhook',
      '/.env', '/api/account/v1evil/session', '/portal/app.js/other', '//api/admin',
      '/api/account/v1/../admin', '/portal/./app.js', '/portal/../../api/admin',
      '/portal/%2e%2e/api/admin', '/api%2fadmin', '/api%252fadmin', '/api/account/v1/%5c..%5cadmin',
      '/api/account/v1//admin', '/api/account/v1/\\admin', '/portal%3f/../api/admin',
      '/api/account/v1;/admin', '/portal/app.js#fragment']) {
      const result = await f.send(path, { headers: { 'x-forwarded-for': '127.0.0.1',
        'x-original-url': '/api/admin', 'x-rewrite-url': '/api/admin', cookie: 'waia_customer_session=synthetic' } });
      assert.equal(result.status, 404, path);
      assert.equal(result.headers['cache-control'], 'no-store');
    }
    assert.equal(f.hits.length, 0);
    for (const target of ['http://api/admin', '/portal/\u0000', '/portal/\n', '/portal/ app.js', '/pórtal']) {
      assert.equal(canonicalIngressPath(target), null, target);
    }
  } finally { await f.stop(); }
});

test('host/origem exatos e métodos de mutação sem origem são recusados', async () => {
  const f = await fixture();
  try {
    for (const headers of [{ host: 'attacker.example', 'x-forwarded-host': 'portal.example' },
      { host: 'portal.example.attacker' }, { origin: 'http://attacker.example' }]) {
      assert.ok([403, 404].includes((await f.send('/api/account/v1/session', { headers })).status));
    }
    assert.equal((await f.send('/api/account/v1/login', { method: 'POST' })).status, 403);
    assert.equal((await f.send('/api/account/v1/login', { method: 'POST', headers: { origin: 'http://portal.example.attacker' } })).status, 403);
    assert.equal(f.hits.length, 0);
  } finally { await f.stop(); }
});

test('headers de autoridade são substituídos pelo peer; entrada não seleciona upstream', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send('/api/account/v1/session', { headers: {
      forwarded: 'for=203.0.113.4;host=attacker;proto=https', 'x-forwarded-for': '203.0.113.4',
      'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.example', 'x-real-ip': '203.0.113.4',
      'x-original-url': '/api/admin', 'x-rewrite-url': '/api/admin', 'x-forwarded-server': 'attacker',
    } })).status, 200);
    const headers = f.hits[0].headers;
    assert.equal(headers.host, 'portal.example');
    assert.equal(headers['x-forwarded-for'], '127.0.0.1');
    assert.equal(headers['x-real-ip'], '127.0.0.1');
    assert.equal(headers['x-forwarded-proto'], 'http');
    assert.equal(headers['x-forwarded-host'], 'portal.example');
    for (const key of ['forwarded', 'x-original-url', 'x-rewrite-url', 'x-forwarded-server']) assert.equal(headers[key], undefined);
  } finally { await f.stop(); }
});

test('superfície privada exige peer real, sem aceitar XFF/headers/cookie customer como autorização', async () => {
  const denied = await fixture({ surface: 'admin', adminPeerAllowlist: '203.0.113.4/32' });
  try {
    for (const path of ['/api/admin/auth/session', '/panel/', '/metrics']) {
      assert.equal((await denied.send(path, { headers: { 'x-forwarded-for': '203.0.113.4',
        forwarded: 'for=203.0.113.4', cookie: 'waia_customer_session=synthetic' } })).status, 403);
    }
    assert.equal(denied.hits.length, 0);
  } finally { await denied.stop(); }
  const allowed = await fixture({ surface: 'admin', adminPeerAllowlist: '127.0.0.1/32' });
  try {
    for (const path of ['/api/admin/auth/session', '/panel/', '/panel/app.js', '/metrics', '/health/live']) {
      assert.equal((await allowed.send(path)).status, 200, path);
    }
    const hits = allowed.hits.length;
    for (const path of ['/portal/', '/api/account/v1/session', '/api/app/v1/companies', '/api/Admin', '/panel/../api/admin']) {
      assert.equal((await allowed.send(path)).status, 404, path);
    }
    assert.equal(allowed.hits.length, hits);
  } finally { await allowed.stop(); }
});

test('proxy confiável exato propaga somente o último IP acrescentado, sem cadeia anterior ou Forwarded', async () => {
  const f = await fixture({ trustedProxyPeers: '127.0.0.1/32' });
  try {
    for (const client of ['203.0.113.5', '2001:db8::5', '::ffff:203.0.113.5']) {
      const result = await f.send('/api/account/v1/session', { headers: {
        'x-forwarded-for': `forged-invalid, 192.0.2.1, ${client}`,
        forwarded: 'for=192.0.2.200;proto=https', 'x-real-ip': '192.0.2.200',
      } });
      assert.equal(result.status, 200);
      assert.equal(f.hits.at(-1).headers['x-forwarded-for'], client);
      assert.equal(f.hits.at(-1).headers['x-real-ip'], client);
      assert.equal(f.hits.at(-1).headers.forwarded, undefined);
    }
  } finally { await f.stop(); }
});

test('proxy configurado confiável sem último XFF válido falha antes upstream', async () => {
  const f = await fixture({ trustedProxyPeers: '127.0.0.1/32' });
  try {
    for (const headers of [{}, { 'x-forwarded-for': '' }, { 'x-forwarded-for': '203.0.113.5,' },
      { 'x-forwarded-for': '203.0.113.5,unknown' }, { 'x-forwarded-for': '203.0.113.5:1234' },
      { 'x-forwarded-for': '203.0.113.5,192.0.2.1/32' }, { forwarded: 'for=203.0.113.5' }]) {
      assert.equal((await f.send('/api/account/v1/session', { headers })).status, 400);
    }
    assert.equal(f.hits.length, 0);
  } finally { await f.stop(); }
});

test('socket fora dos peers confiáveis ignora XFF válido ou malformado mesmo com trust configurado', async () => {
  const f = await fixture({ trustedProxyPeers: '203.0.113.9/32' });
  try {
    for (const value of ['203.0.113.5', '203.0.113.5,unknown']) {
      assert.equal((await f.send('/api/account/v1/session', { headers: { 'x-forwarded-for': value } })).status, 200);
      assert.equal(f.hits.at(-1).headers['x-forwarded-for'], '127.0.0.1');
      assert.equal(f.hits.at(-1).headers['x-real-ip'], '127.0.0.1');
    }
  } finally { await f.stop(); }
});

test('trust explícito de proxy não concede acesso administrativo por XFF', async () => {
  const f = await fixture({ surface: 'admin', adminPeerAllowlist: '192.0.2.1/32', trustedProxyPeers: '127.0.0.1/32' });
  try {
    assert.equal((await f.send('/api/admin/auth/session', { headers: { 'x-forwarded-for': '192.0.2.1' } })).status, 403);
    assert.equal(f.hits.length, 0);
  } finally { await f.stop(); }
});

test('cookies de produção precisam ser host-only/Secure; falha de upstream não expõe diagnóstico', async () => {
  const f = await fixture({ origin: 'https://portal.example', allowInsecure: false });
  try {
    for (const cookie of ['waia_customer_session=synthetic; Path=/; HttpOnly',
      'waia_customer_session=synthetic; Path=/; Secure; Domain=.example']) {
      f.cookie([cookie]);
      const reply = await f.send('/api/account/v1/session');
      assert.equal(reply.status, 502);
      assert.equal(reply.headers['set-cookie'], undefined);
      assert.doesNotMatch(reply.body, /synthetic|127\.0\.0\.1|stack/u);
    }
    f.cookie(['waia_customer_session=synthetic; Path=/; HttpOnly; Secure; SameSite=Lax']);
    const reply = await f.send('/api/account/v1/session');
    assert.equal(reply.status, 200);
    assert.match(reply.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Lax/u);
  } finally { await f.stop(); }
});
