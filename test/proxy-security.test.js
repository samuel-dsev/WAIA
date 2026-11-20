import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiApp } from '../src/bootstrap/app-runtime.js';
import { AuthenticationRequiredError } from '../src/modules/auth/errors.js';

test('admin não confia em XFF sem peer explícito, e peer confiável ainda exige autenticação', async () => {
  for (const [trustProxy, expected] of [[undefined, 403], [false, 403], ['192.0.2.12/32', 403], ['127.0.0.1/32', 401]]) {
    const runtime = { pool: { connect() {} }, logger: { info() {}, warn() {}, error() {} },
      health: { live: () => ({ status: 'ok' }), ready: async () => ({ status: 'ready' }) },
      authService: { async authenticate() { throw new AuthenticationRequiredError(); }, verifyCsrf() { return false; } }, adminService: {} };
    const config = { environment: 'test', whatsapp: { verifyToken: 'synthetic', appSecret: '' },
      security: { cookieSecure: false, sessionTtlHours: 12, trustProxy, adminNetworkAllowlist: '203.0.113.5/32' } };
    const server = createApiApp({ runtime, config }).listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/tenants`, { headers: { 'x-forwarded-for': '203.0.113.5' } });
      assert.equal(response.status, expected); await response.arrayBuffer();
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});
