import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AccountService } from '../src/modules/accounts/account-service.js';
import { AccountRateLimiter } from '../src/modules/accounts/rate-limiter.js';
import { FakeEmailTransport, HttpEmailTransport } from '../src/integrations/email/transport.js';
import { createSessionTokenCodec } from '../src/modules/auth/token-codec.js';
import { VersionedKeyring } from '../src/security/versioned-keyring.js';
import { createAccountsRuntime } from '../src/modules/accounts/runtime.js';

const setup = (extra = {}) => new AccountService({ repository: {}, codec: createSessionTokenCodec({ pepper: 'synthetic-account-pepper-'.repeat(3) }),
  keyring: VersionedKeyring.fromBase64({ activeVersion: '1', keys: { '1': randomBytes(32).toString('base64') } }),
  limiter: new AccountRateLimiter({ environment: 'test' }), origin: 'http://localhost:3001', ...extra });

test('conta pública rejeita mass assignment e exige aceite', () => {
  const service = setup();
  for (const field of ['platformRole','empresa_id','status','securityVersion','verified']) {
    assert.throws(() => service.parse('register', { name: 'Teste', email: 'user@example.invalid', password: 'synthetic-password', acceptedTerms: true, [field]: true }), { code: 'VALIDATION_ERROR' });
  }
  assert.throws(() => service.parse('register', { name: 'Teste', email: 'user@example.invalid', password: 'synthetic-password' }));
  assert.equal(service.parse('login', { email: 'USER@example.invalid', password: 'x'.repeat(256) }).email, 'user@example.invalid');
  assert.throws(() => service.parse('reset', { token: 'a'.repeat(43), password: 'x'.repeat(129) }));
});
test('limites de conta isolam operações e expiram sem bloqueio permanente', async () => {
  let now = 0;
  const limiter = new AccountRateLimiter({ environment: 'test', clock: () => now, windowMs: 100 });
  assert.equal((await limiter.consume({ key: 'a', max: 1 })).allowed, true);
  assert.equal((await limiter.consume({ key: 'a', max: 1 })).allowed, false);
  assert.equal((await limiter.consume({ key: 'b', max: 1 })).allowed, true);
  now = 101;
  assert.equal((await limiter.consume({ key: 'a', max: 1 })).allowed, true);
  assert.throws(() => new AccountRateLimiter({ environment: 'production' }));
});
test('contas ficam desligadas por padrão e fake nunca entra em produção', () => {
  assert.equal(createAccountsRuntime({ config: { accounts: { enabled: false } } }), null);
  assert.throws(() => new FakeEmailTransport({ environment: 'production' }));
  assert.throws(() => new HttpEmailTransport({ endpoint: 'http://localhost', token: 'test', from: 'test' }));
});
test('tokens e credenciais nunca aparecem no resultado público ou outbox em claro', async () => {
  let saved;
  const service = setup({ repository: { async register(data) { saved = data; } } });
  const result = await service.register({ name: 'Cliente', email: 'user@example.invalid', password: 'synthetic-password', acceptedTerms: true }, '127.0.0.1');
  assert.deepEqual(Object.keys(result), ['message']);
  assert.equal(saved.token.digest.length, 32);
  assert.equal(JSON.stringify(saved.mail).includes('user@example.invalid'), false);
  assert.equal(JSON.stringify(saved.mail).includes('synthetic-password'), false);
  assert.equal(saved.token.token, undefined);
});
test('entrega usa chave idempotente e falha do provedor só persiste estado', async () => {
  let stored, finish;
  const service = setup({ repository: { async register(input) { stored = input; },
    async claimMail() { return { id: stored.mail.id, envelope: stored.mail.envelope, lease_id: 'lease', attempts: 1 }; },
    async finishMail(input) { finish = input; } } });
  await service.register({ name: 'Cliente', email: 'user@example.invalid', password: 'synthetic-password', acceptedTerms: true }, '127.0.0.1');
  const fake = new FakeEmailTransport({ environment: 'test' });
  await service.deliverNext(fake);
  assert.equal(finish.success, true);
  const message = [...fake.messages.values()][0];
  assert.ok(message.url.startsWith('http://localhost:3001/portal/#verify='));
  assert.equal(message.idempotencyKey, stored.mail.id);
  await service.deliverNext({ async send() { throw new Error('secret_provider_payload'); } });
  assert.equal(finish.success, false);
  assert.equal(JSON.stringify(finish).includes('secret_provider_payload'), false);
});
