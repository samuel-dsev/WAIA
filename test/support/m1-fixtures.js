import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import pg from 'pg';
import { AccountRepository } from '../../src/modules/accounts/account-repository.js';
import { AccountService } from '../../src/modules/accounts/account-service.js';
import { AccountRateLimiter } from '../../src/modules/accounts/rate-limiter.js';
import { createAccountRouter, createCustomerRouter } from '../../src/modules/accounts/http.js';
import { AuthService } from '../../src/modules/auth/auth-service.js';
import { createAuthRouter, authErrorMiddleware } from '../../src/modules/auth/http.js';
import { IdentitySecurity } from '../../src/modules/auth/identity-security.js';
import { PostgresAuthRepository } from '../../src/modules/auth/repositories.js';
import { MemoryAuthRateLimiter } from '../../src/modules/auth/rate-limiter.js';
import { createSessionTokenCodec } from '../../src/modules/auth/token-codec.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { VersionedKeyring } from '../../src/security/versioned-keyring.js';
import { FakeEmailTransport } from '../../src/integrations/email/transport.js';
import { totp } from '../../src/modules/auth/totp.js';

export const enabled = process.env.RUN_POSTGRES_INTEGRATION === 'true';
export const fixturePassword = 'M1-synthetic-password-12345';
export const denied = (error) => error?.status === 403;

export async function createM1Fixture(label) {
  assert.ok(process.env.DATABASE_URL); assert.ok(process.env.DATABASE_MIGRATOR_URL);
  for (const value of [process.env.DATABASE_URL, process.env.DATABASE_MIGRATOR_URL]) {
    assert.match(new URL(value).pathname, /^\/waia_v2_/);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL,
    options: '-c app.is_platform_admin=true', max: 4 });
  const prefix = `m1-${label}-${randomUUID()}`;
  const ids = [], companies = [];
  let now = new Date();
  const clock = () => now;
  const codec = createSessionTokenCodec({ pepper: `${prefix}:customer:synthetic` });
  const adminCodec = createSessionTokenCodec({ pepper: `${prefix}:admin:synthetic` });
  const keyring = VersionedKeyring.fromBase64({ activeVersion: '1', keys: { '1': randomBytes(32).toString('base64') } });
  const limiter = new AccountRateLimiter({ environment: 'test', clock: () => now.getTime() });
  const security = new IdentitySecurity({ pool, keyring, codecs: { customer: codec, admin: adminCodec }, limiter, clock });
  const repository = new AccountRepository(pool);
  const fake = new FakeEmailTransport({ environment: 'test' });
  const claim = repository.claimMail.bind(repository);
  repository.claimMail = (time) => claim(time, ids);
  const service = new AccountService({ repository, codec, keyring, limiter, origin: 'http://localhost', clock, security });
  const authRepository = new PostgresAuthRepository(pool);
  const authService = new AuthService({ repository: authRepository, tokenCodec: adminCodec,
    rateLimiter: new MemoryAuthRateLimiter({ environment: 'test' }), audit: { write: async () => {} }, security, clock });
  const app = express(); app.use(express.json());
  app.use('/account', createAccountRouter({ service, secure: false }));
  app.use('/app', createCustomerRouter({ service }));
  app.use('/admin', createAuthRouter({ authService })); app.use(authErrorMiddleware);
  app.use((error, _request, response, _next) => response.status(503).json({ code: 'UNAVAILABLE' }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const advance = (ms) => { now = new Date(now.getTime() + ms); };
  const request = async (url, { method = 'GET', body, issued, origin, csrf, headers = {} } = {}) => {
    const response = await fetch(base + url, { method, headers: {
      origin: origin || (url.startsWith('/admin') ? base : service.origin),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(issued ? { cookie: `waia_customer_session=${issued.token}`, 'x-csrf-token': csrf || issued.csrfToken } : {}),
      ...headers,
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, headers: response.headers,
      body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
  };
  const passwordHash = await hashPassword(fixturePassword);
  const makeUser = async (suffix, { platform = false, verified = true, login = true } = {}) => {
    const id = randomUUID(), email = `${prefix}-${suffix}@waia.example`; ids.push(id);
    await owner.query(`INSERT INTO usuarios(id,email,nome,password_hash,papel_plataforma,email_verified_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [id, email, `M1 ${suffix}`, passwordHash, platform ? 'administrador' : 'nenhum', verified ? now : null]);
    const user = { id, email, passwordHash };
    if (login) {
      user.issued = await service.login({ email, password: fixturePassword }, suffix);
      if (user.issued.token) user.auth = await service.authenticate(user.issued.token);
    }
    return user;
  };
  const makeCompany = async (suffix, { status = 'ativa' } = {}) => {
    const id = randomUUID(); companies.push(id);
    await owner.query('INSERT INTO empresas(id,slug,nome,nome_exibicao,status) VALUES($1,$2,$3,$3,$4)',
      [id, `${prefix}-${suffix}`, `M1 ${suffix}`, status]);
    return { id, name: `M1 ${suffix}`, status };
  };
  const link = (user, company, { permissions = ['attendance.read'], role = 'operador', status = 'ativo' } = {}) =>
    owner.query(`INSERT INTO usuarios_empresas(empresa_id,usuario_id,papel,status,permissoes) VALUES($1,$2,$3,$4,$5)`,
      [company.id, user.id, role, status, permissions]);
  const mailToken = async (email, purpose = 'reset') => {
    now = new Date(Math.max(now.getTime(), Date.now() + 100));
    while (await service.deliverNext(fake)) { /* Only this fixture's IDs are claimed. */ }
    const message = [...fake.messages.values()].filter((entry) => entry.to === email && entry.purpose === purpose).at(-1);
    assert.ok(message, 'Synthetic token mail must exist');
    return new URLSearchParams(new URL(message.url).hash.slice(1)).get(purpose);
  };
  const code = (secret) => { advance(30_000); return totp(secret, Math.floor(now.getTime() / 30_000)); };
  const close = async () => {
    server.close(); await once(server, 'close');
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      for (const table of ['team_invitations', 'ownership_transfers']) {
        await client.query(`DELETE FROM ${table} WHERE empresa_id=ANY($1::uuid[])`, [companies]);
      }
      for (const table of ['account_audit', 'company_provision_requests', 'company_owners']) {
        await client.query(`DELETE FROM ${table} WHERE usuario_id=ANY($1::uuid[])`, [ids]);
      }
      await client.query('DELETE FROM usuarios_empresas WHERE empresa_id=ANY($1::uuid[])', [companies]);
      await client.query('DELETE FROM empresas WHERE id=ANY($1::uuid[])', [companies]);
      await client.query('DELETE FROM usuarios WHERE id=ANY($1::uuid[])', [ids]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); await pool.end(); await owner.end(); }
  };
  return { pool, owner, ids, companies, prefix, codec, adminCodec, keyring, limiter, security,
    repository, authRepository, service, authService, request, makeUser, makeCompany, link,
    mailToken, clock, advance, code, close };
}

export function decodeBase32(value) {
  let bits = 0, number = 0; const result = [];
  for (const ch of value) {
    number = (number << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch); bits += 5;
    if (bits >= 8) { bits -= 8; result.push((number >>> bits) & 255); }
  }
  return Buffer.from(result);
}
