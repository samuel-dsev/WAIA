import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createCustomerRouter } from '../src/modules/accounts/http.js';
import { AccountError } from '../src/modules/accounts/errors.js';

test('M4 HTTP mantém sessão, origem, CSRF, no-store e erros sanitizados no editor', async () => {
  const calls = [], auth = { audience: 'customer', user: { id: 'synthetic-user' }, sessionId: 'synthetic-session' };
  const service = { origin: 'http://portal.example', codec: { verifyCsrf: (_token, value) => value === 'csrf-synthetic' },
    authenticate: async (token) => { if (token !== 'session-synthetic') throw new AccountError('SESSION_REQUIRED', 401, 'Entre novamente.'); return auth; },
    attendance: {
      read: async (principal, id) => { calls.push({ principal, id }); return { draftVersion: 3, fields: { greeting: 'Olá' } }; },
      save: async (principal, id, body) => { calls.push({ principal, id, body });
        if (body?.draftVersion === 1) throw new AccountError('DRAFT_VERSION_CONFLICT', 409, 'Recarregue e revise.');
        if (body?.draftVersion === 2) throw new Error('credential:synthetic-private-reference');
        return { draftVersion: 4, fields: body.changes };
      },
    } };
  const app = express(); app.use(express.json()); app.use('/app', createCustomerRouter({ service }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/app/companies/00000000-0000-4000-8000-000000000001/attendance`;
  const headers = { cookie: 'waia_customer_session=session-synthetic', origin: service.origin, 'x-csrf-token': 'csrf-synthetic', 'content-type': 'application/json' };
  const body = JSON.stringify({ draftVersion: 3, changes: { greeting: 'Nova saudação' } });
  try {
    assert.equal((await fetch(base)).status, 401); assert.equal(calls.length, 0);
    const read = await fetch(base, { headers }); assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await read.json(), { draftVersion: 3, fields: { greeting: 'Olá' } });
    const url = `${base}/draft`;
    assert.equal((await fetch(url, { method: 'PATCH', headers: { ...headers, origin: 'https://foreign.example' }, body })).status, 403);
    assert.equal((await fetch(url, { method: 'PATCH', headers: { ...headers, 'x-csrf-token': 'wrong' }, body })).status, 403);
    assert.equal(calls.length, 1);
    assert.equal((await fetch(url, { method: 'PATCH', headers, body })).status, 200); assert.equal(calls[1].principal, auth);
    const conflict = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ draftVersion: 1 }) });
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, 'DRAFT_VERSION_CONFLICT');
    const failure = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ draftVersion: 2 }) });
    assert.equal(failure.status, 503); assert.equal((await failure.text()).includes('synthetic-private-reference'), false);
    assert.equal((await fetch(`${base}/publish`, { method: 'POST', headers, body: '{}' })).status, 404);
  } finally { server.close(); await once(server, 'close'); }
});
