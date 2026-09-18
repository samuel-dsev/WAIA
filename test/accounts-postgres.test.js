import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import pg from 'pg';
import { AccountRepository } from '../src/modules/accounts/account-repository.js';
import { AccountService } from '../src/modules/accounts/account-service.js';
import { AccountRateLimiter } from '../src/modules/accounts/rate-limiter.js';
import { createAccountRouter, createCustomerRouter } from '../src/modules/accounts/http.js';
import { createSessionTokenCodec } from '../src/modules/auth/token-codec.js';
import { PostgresAuthRepository } from '../src/modules/auth/repositories.js';
import { VersionedKeyring } from '../src/security/versioned-keyring.js';
import { FakeEmailTransport } from '../src/integrations/email/transport.js';
import { withIdentityTransaction } from '../src/infra/postgres/transaction.js';

test('F1 PostgreSQL real: contas, tokens, HTTP, concorrência e isolamento', { skip: process.env.RUN_POSTGRES_INTEGRATION !== 'true' }, async (t) => {
  assert.ok(process.env.DATABASE_URL); assert.ok(process.env.DATABASE_MIGRATOR_URL);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, options: '-c app.is_platform_admin=true' });
  const prefix = `f1-${randomUUID()}`;
  const userIds = [], companies = [];
  const codec = createSessionTokenCodec({ pepper: `synthetic-account-test-${prefix}` });
  const fake = new FakeEmailTransport({ environment: 'test' });
  const repo = new AccountRepository(pool);
  const claimMail = repo.claimMail.bind(repo);
  repo.claimMail = (time) => claimMail(time, userIds);
  let now = new Date();
  const service = new AccountService({ repository: repo, codec,
    keyring: VersionedKeyring.fromBase64({ activeVersion: '1', keys: { '1': randomBytes(32).toString('base64') } }),
    limiter: new AccountRateLimiter({ environment: 'test' }), origin: 'http://localhost', clock: () => now });
  const app = express(); app.use(express.json());
  app.use('/account', createAccountRouter({ service, secure: false }));
  app.use('/app', createCustomerRouter({ service }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', body, auth, origin = service.origin, key, csrf = auth?.csrfToken } = {}) => {
    const r = await fetch(base + path, { method, headers: { origin, ...(body ? { 'content-type': 'application/json' } : {}),
      ...(auth ? { cookie: `waia_customer_session=${auth.token}` } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(key ? { 'idempotency-key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text(); return { status: r.status, headers: r.headers, body: text && text !== 'No Content' ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
  };
  const reg = (suffix) => ({ name: `Cliente ${suffix}`, email: `${prefix}-${suffix}@example.invalid`, password: 'test-password-12345', acceptedTerms: true });
  const a = reg('a'), b = reg('b'); let authA, authB, tenantA, tenantB;
  const mailToken = async (to, purpose) => {
    now = new Date(Math.max(now.getTime(), Date.now() + 100));
    while (await service.deliverNext(fake)) { /* drena somente outbox de teste no ambiente sintético */ }
    const message = [...fake.messages.values()].filter((m) => m.to === to && m.purpose === purpose).at(-1);
    assert.ok(message); return new URLSearchParams(new URL(message.url).hash.slice(1)).get(purpose);
  };
  try {
    await t.test('role real restrita e migrações F1 aplicadas', async () => {
      const r = (await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
      assert.deepEqual(r, { rolsuper: false, rolbypassrls: false });
      assert.ok((await pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n >= 22);
    });
    await t.test('cadastros concorrentes e duplicados não trocam senha ou papel', async () => {
      const results = await Promise.all([a,a,b].map((body) => request('/account/register', { method: 'POST', body })));
      assert.ok(results.every((r) => r.status === 202));
      const ua = await repo.findCredentials(a.email), ub = await repo.findCredentials(b.email);
      userIds.push(ua.id,ub.id);
      assert.notEqual(ua.id,ub.id);
      const roles = await owner.query('SELECT papel_plataforma FROM usuarios WHERE id=ANY($1::uuid[])', [userIds]);
      assert.ok(roles.rows.every((r) => r.papel_plataforma === 'nenhum'));
      await request('/account/register', { method: 'POST', body: { ...a, password: 'attacker-password-12345' } });
    });
    // Login DTO intentionally contains only login fields.
    authA = await service.login({ email: a.email, password: a.password }, 'a');
    authB = await service.login({ email: b.email, password: b.password }, 'b');
    await t.test('não verificado, origem, CSRF e mass assignment são bloqueados', async () => {
      assert.equal((await request('/app/companies', { method: 'POST', auth: authA, key: randomUUID(), body: { name: 'Empresa A' } })).status, 403);
      assert.equal((await request('/account/login', { method: 'POST', origin: 'https://evil.invalid', body: { email: a.email, password: a.password } })).status, 403);
      assert.equal((await request('/account/profile', { method: 'PATCH', auth: authA, csrf: 'wrong', body: { name: 'Outro' } })).status, 403);
      assert.equal((await request('/account/register', { method: 'POST', body: { ...b, platformRole: 'platform_admin' } })).status, 422);
    });
    await t.test('GET não consome token; POST consome uma única vez', async () => {
      const tokenA = await mailToken(a.email, 'verify'), tokenB = await mailToken(b.email, 'verify');
      assert.notEqual((await request(`/account/email/verify?token=${tokenA}`)).status, 204);
      assert.equal((await request('/account/email/verify', { method: 'POST', body: { token: tokenA } })).status, 204);
      assert.equal((await request('/account/email/verify', { method: 'POST', body: { token: tokenA } })).status, 422);
      await service.verify({ token: tokenB }, 'verify-b');
    });
    await t.test('falha de auditoria reverte empresa, vínculo e rascunho', async () => {
      const fn = `f1_audit_${randomUUID().replaceAll('-','')}`;
      await owner.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`);
      try {
        await owner.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON account_audit FOR EACH ROW
          WHEN (NEW.usuario_id='${userIds[0]}'::uuid AND NEW.action='company.created') EXECUTE FUNCTION ${fn}()`);
        const r = await request('/app/companies', { method: 'POST', auth: authA, key: randomUUID(), body: { name: 'Rollback company' } });
        assert.equal(r.status,503);
        assert.equal(JSON.stringify(r.body).includes('synthetic'), false);
        assert.equal((await owner.query('SELECT * FROM company_owners WHERE usuario_id=$1',[userIds[0]])).rowCount,0);
        assert.equal((await owner.query('SELECT * FROM configuracoes_rascunho WHERE created_by=$1',[userIds[0]])).rowCount,0);
        assert.equal((await owner.query('SELECT * FROM usuarios_empresas WHERE usuario_id=$1',[userIds[0]])).rowCount,0);
      } finally {
        await owner.query(`DROP TRIGGER IF EXISTS ${fn} ON account_audit`);
        await owner.query(`DROP FUNCTION ${fn}()`);
      }
    });
    await t.test('provisionamento idempotente concorrente e isolamento por API', async () => {
      const key = randomUUID();
      const results = await Promise.all([1,2].map(() => request('/app/companies', { method: 'POST', auth: authA, key, body: { name: 'Empresa A' } })));
      assert.ok(results.every((r) => r.status === 201));
      tenantA = results[0].body.id; companies.push(tenantA);
      assert.equal(results[1].body.id, tenantA);
      const draft = (await owner.query('SELECT configuracao FROM configuracoes_rascunho WHERE empresa_id=$1',[tenantA])).rows[0].configuracao;
      assert.equal(draft.schemaVersion,2);
      assert.equal(draft.identity.name,'Empresa A');
      assert.equal(draft.ai.enabled,false);
      assert.equal((await request('/app/companies', { method: 'POST', auth: authA, key, body: { name: 'Outro nome' } })).status, 409);
      const r = await request('/app/companies', { method: 'POST', auth: authB, key, body: { name: 'Empresa B' } });
      assert.equal(r.status, 201); tenantB = r.body.id; companies.push(tenantB); assert.notEqual(tenantA,tenantB);
      assert.equal((await request(`/app/companies/${tenantB}`, { auth: authA })).status, 404);
      assert.equal((await request(`/app/companies/${tenantA}`, { auth: authB })).status, 404);
      assert.deepEqual((await request('/app/companies', { auth: authA })).body.companies.map((c) => c.id), [tenantA]);
    });
    await t.test('RLS por identidade e pool reutilizado não expõem outras empresas', async () => {
      await withIdentityTransaction(pool, { usuarioId: userIds[0] }, async ({ client }) => {
        assert.deepEqual((await client.query('SELECT id FROM empresas')).rows.map((r) => r.id), [tenantA]);
        assert.deepEqual((await client.query('SELECT id FROM usuarios')).rows.map((r) => r.id), [userIds[0]]);
        assert.equal((await client.query('SELECT * FROM account_tokens')).rowCount, 0);
        assert.equal((await client.query('SELECT * FROM account_email_outbox')).rowCount, 0);
      });
      assert.equal((await pool.query('SELECT id FROM empresas')).rowCount, 0);
    });
    await t.test('perfil é limitado ao titular e retomada preserva empresa', async () => {
      assert.equal((await request('/account/profile',{method:'PATCH',auth:authA,body:{name:'Nome atualizado'}})).status,200);
      assert.equal((await request('/account/session',{auth:authA})).body.user.name,'Nome atualizado');
      const fresh = await service.login({email:a.email,password:a.password},'fresh');
      assert.equal((await request('/app/companies',{auth:fresh})).body.companies[0].id,tenantA);
      assert.equal((await request('/app/companies',{method:'POST',auth:authA,key:randomUUID(),body:{name:'Excede limite'}})).status,409);
    });
    await t.test('login HTTP retorna cookie privado e sessão com CSRF', async () => {
      const r = await request('/account/login',{method:'POST',body:{email:b.email,password:b.password}});
      assert.equal(r.status,200);
      const cookie = r.headers.get('set-cookie');
      assert.match(cookie,/waia_customer_session=/);
      assert.match(cookie,/HttpOnly/);
      assert.match(cookie,/SameSite=Lax/);
      assert.ok(r.body.csrfToken);
      assert.equal(r.body.token,undefined);
      assert.equal(r.body.user.email,b.email);
    });
    await t.test('papel global não concede bypass usando sessão customer', async () => {
      await owner.query("UPDATE usuarios SET papel_plataforma='administrador' WHERE id=$1", [userIds[0]]);
      assert.equal((await request(`/app/companies/${tenantB}`, { auth: authA })).status, 404);
      const legacy = new PostgresAuthRepository(pool);
      assert.equal(await legacy.findSessionByTokenHash(codec.hash(authA.token), { now }), null);
      const issued = codec.issue();
      await legacy.createSession({ userId: userIds[0], tokenHash: issued.tokenHash, ip: null, userAgent: null, createdAt: now, expiresAt: new Date(now.getTime()+3600_000) });
      assert.equal((await request('/account/session', { auth: { token: issued.token } })).status, 401);
    });
    await t.test('reset invalida gerações anteriores, expira e revoga admin/customer', async () => {
      await service.requestToken({ email: a.email }, 'reset', 'r1'); const old = await mailToken(a.email,'reset');
      await service.requestToken({ email: a.email }, 'reset', 'r2'); const current = await mailToken(a.email,'reset');
      await assert.rejects(service.reset({ token: old, password: 'new-password-12345' }, 'r3'), { code: 'TOKEN_INVALID' });
      await service.reset({ token: current, password: 'new-password-12345' }, 'r4');
      assert.equal((await request('/account/session', { auth: authA })).status, 401);
      assert.equal((await owner.query('SELECT count(*)::int n FROM auth_sessions WHERE usuario_id=$1 AND revoked_at IS NULL',[userIds[0]])).rows[0].n,0);
      await assert.rejects(service.reset({ token: current, password: 'other-password-12345' }, 'r5'), { code: 'TOKEN_INVALID' });
      authA = await service.login({ email: a.email, password: 'new-password-12345' }, 'a2');
      await service.requestToken({ email: b.email }, 'reset', 'rb'); const expired = await mailToken(b.email,'reset');
      now = new Date(now.getTime()+31*60_000);
      await assert.rejects(service.reset({ token: expired, password: 'new-password-12345' }, 'rb2'), { code: 'TOKEN_INVALID' });
    });
    await t.test('revogação de vínculo é efetiva na próxima operação', async () => {
      await owner.query("UPDATE usuarios_empresas SET status='suspenso' WHERE empresa_id=$1 AND usuario_id=$2",[tenantB,userIds[1]]);
      assert.equal((await request(`/app/companies/${tenantB}`, { auth: authB })).status,404);
    });
    await t.test('logout e inatividade invalidam sessão; MFA existente nunca é removido', async () => {
      await service.logout(await service.authenticate(authA.token));
      assert.equal((await request('/account/session',{auth:authA})).status,401);
      now = new Date(now.getTime()+61*60_000);
      assert.equal((await request('/account/session',{auth:authB})).status,401);
      await owner.query('UPDATE usuarios SET mfa_habilitado=true WHERE id=$1',[userIds[1]]);
      await assert.rejects(service.login({ email:b.email,password:b.password },'mfa'),{code:'MFA_REQUIRED'});
    });
  } finally {
    server.close(); await once(server,'close');
    // Limpeza estritamente limitada aos UUIDs deste teste; nenhum reset de banco.
    const c = await owner.connect();
    try {
      await c.query('BEGIN'); await c.query("SELECT set_config('app.is_platform_admin','true',true)");
      const ids = (await c.query('SELECT id FROM usuarios WHERE email LIKE $1',[`${prefix}-%@example.invalid`])).rows.map((r)=>r.id);
      const tenants = (await c.query('SELECT empresa_id FROM company_owners WHERE usuario_id=ANY($1::uuid[])',[ids])).rows.map((r)=>r.empresa_id);
      for (const table of ['account_audit','company_provision_requests','company_owners']) await c.query(`DELETE FROM ${table} WHERE usuario_id=ANY($1::uuid[])`,[ids]);
      for (const table of ['configuracoes_rascunho','onboarding_progressos','usuarios_empresas']) await c.query(`DELETE FROM ${table} WHERE empresa_id=ANY($1::uuid[])`,[tenants]);
      await c.query('DELETE FROM empresas WHERE id=ANY($1::uuid[])',[tenants]);
      await c.query('DELETE FROM usuarios WHERE id=ANY($1::uuid[])',[ids]);
      await c.query('COMMIT');
    } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); await pool.end(); await owner.end(); }
  }
});
