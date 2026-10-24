import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withIdentityTransaction, withTenantTransaction, withCustomerTransaction } from '../src/infra/postgres/transaction.js';
import { PostgresAdminRepository } from '../src/modules/admin/postgres-admin-repository.js';
import { createM1Fixture, enabled, fixturePassword } from './support/m1-fixtures.js';

test('M1 PostgreSQL: acesso explícito, rotas fechadas e ciclo de segurança', { skip: !enabled }, async (t) => {
  const f = await createM1Fixture('accounts');
  let ana, bia, caio, empty, aurora, horizonte, vale;
  const denied = (error) => [401, 403, 404].includes(error?.status);
  try {
    ana = await f.makeUser('ana'); bia = await f.makeUser('bia');
    caio = await f.makeUser('caio'); empty = await f.makeUser('empty');
    aurora = await f.makeCompany('aurora'); horizonte = await f.makeCompany('horizonte'); vale = await f.makeCompany('vale');
    await f.link(ana, aurora, { role: 'administrador', permissions: ['attendance.read', 'attendance.edit', 'attendance.publish', '*', 'credentials.manage'] });
    await f.link(ana, horizonte); await f.link(bia, aurora); await f.link(caio, vale);
    await f.owner.query('INSERT INTO company_owners(empresa_id,usuario_id) VALUES($1,$2)', [aurora.id, ana.id]);

    await t.test('papel real sem bypass/DDL e vínculos N:N com lista vazia', async () => {
      assert.deepEqual((await f.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],
        { rolsuper: false, rolbypassrls: false });
      assert.equal((await f.service.companies(ana.auth)).length, 2);
      assert.equal((await f.service.companies(bia.auth)).length, 1);
      assert.deepEqual(await f.service.companies(empty.auth), []);
      const dto = await f.service.company(ana.auth, aurora.id);
      assert.deepEqual(dto.effectiveCapabilities, ['attendance.read', 'attendance.edit', 'attendance.publish']);
      for (const technical of ['owner', 'role', 'permissions', 'credentials', 'model', 'token']) assert.equal(dto[technical], undefined);
      assert.equal((await f.owner.query('SELECT * FROM company_owners WHERE empresa_id=$1', [horizonte.id])).rowCount, 0);
    });
    await t.test('IDs cruzados e payloads não concedem acesso nem autoprovisionamento', async () => {
      assert.equal((await f.request(`/app/companies/${vale.id}`, { issued: ana.issued })).status, 404);
      assert.equal((await f.request(`/app/companies/${aurora.id}`, { issued: caio.issued })).status, 404);
      for (const [path, body] of [
        ['/account/register', { email: `${randomUUID()}@waia.example`, password: fixturePassword, name: 'Injected', acceptedTerms: true, platformRole: 'platform_admin' }],
        ['/app/companies', { name: 'Injected', userId: ana.id, owner: true }],
        [`/app/companies/${aurora.id}/team/invitations`, { email: caio.email, role: 'administrador' }],
        ['/account/invitations/accept', { token: 'a'.repeat(43), audience: 'admin' }],
        ['/account/ownership/accept', { token: 'a'.repeat(43) }],
      ]) assert.equal((await f.request(path, { method: 'POST', body, issued: ana.issued })).status, 403, path);
      await assert.rejects(f.service.register({ name: 'Direct', email: `${randomUUID()}@waia.example`, password: fixturePassword, acceptedTerms: true }, 'direct'), { status: 403 });
      await assert.rejects(f.service.createCompany(ana.auth, { name: 'Direct' }, randomUUID()), { status: 403 });
      assert.equal((await f.owner.query("SELECT count(*)::int n FROM empresas WHERE slug::text LIKE $1", [`${f.prefix}%`])).rows[0].n, 3);
    });
    await t.test('origem, CSRF, perfil estrito e cookies privados permanecem', async () => {
      assert.equal((await f.request('/account/profile', { method: 'PATCH', body: { name: 'Outro' }, issued: ana.issued, origin: 'https://evil.invalid' })).status, 403);
      assert.equal((await f.request('/account/profile', { method: 'PATCH', body: { name: 'Outro' }, issued: ana.issued, csrf: 'wrong' })).status, 403);
      assert.equal((await f.request('/account/profile', { method: 'PATCH', body: { name: 'Outro', platformRole: 'platform_admin' }, issued: ana.issued })).status, 422);
      const login = await f.request('/account/login', { method: 'POST', body: { email: bia.email, password: fixturePassword } });
      assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly/); assert.match(login.headers.get('set-cookie'), /SameSite=Lax/);
      assert.equal(login.body.token, undefined); assert.ok(login.body.csrfToken);
    });
    await t.test('redução, remoção e suspensão afetam próxima operação de sessão existente', async () => {
      await f.owner.query("UPDATE usuarios_empresas SET permissoes='{}' WHERE empresa_id=$1 AND usuario_id=$2", [aurora.id, bia.id]);
      await assert.rejects(f.service.company(bia.auth, aurora.id), { status: 403 });
      await f.owner.query("UPDATE usuarios_empresas SET permissoes=ARRAY['attendance.read'] WHERE empresa_id=$1 AND usuario_id=$2", [aurora.id, bia.id]);
      assert.equal((await f.service.company(bia.auth, aurora.id)).id, aurora.id);
      await f.owner.query("UPDATE usuarios_empresas SET status='suspenso' WHERE empresa_id=$1 AND usuario_id=$2", [aurora.id, bia.id]);
      await assert.rejects(f.service.company(bia.auth, aurora.id), { status: 404 });
      await f.owner.query('DELETE FROM usuarios_empresas WHERE empresa_id=$1 AND usuario_id=$2', [aurora.id, bia.id]);
      assert.deepEqual(await f.service.companies(bia.auth), []);
      assert.equal((await f.service.company(ana.auth, horizonte.id)).id, horizonte.id);
    });
    await t.test('empresa suspensa mantém read/edit, perde publish/simulate e owner não supera suspensão', async () => {
      await f.owner.query("UPDATE empresas SET status='suspensa' WHERE id=$1", [aurora.id]);
      assert.deepEqual((await f.service.company(ana.auth, aurora.id)).effectiveCapabilities, ['attendance.read', 'attendance.edit']);
      await f.owner.query("UPDATE empresas SET status='ativa' WHERE id=$1", [aurora.id]);
    });
    await t.test('RLS por identidade/tenant e pool reutilizado não aceitam empresa alheia', async () => {
      await withIdentityTransaction(f.pool, { usuarioId: ana.id }, async ({ client }) => {
        const ids = (await client.query('SELECT id FROM empresas')).rows.map((row) => row.id).sort();
        assert.deepEqual(ids, [aurora.id, horizonte.id].sort());
        assert.equal((await client.query('SELECT id FROM usuarios')).rowCount, 1);
        assert.equal((await client.query('SELECT * FROM account_tokens')).rowCount, 0);
      });
      await withTenantTransaction(f.pool, { empresaId: vale.id, usuarioId: ana.id, audience: 'customer' }, async ({ client }) => {
        assert.equal((await client.query('SELECT id FROM empresas WHERE id=$1', [vale.id])).rowCount, 0);
      });
      await assert.rejects(withIdentityTransaction(f.pool, { usuarioId: ana.id }, async () => { throw new Error('synthetic rollback'); }));
      assert.equal((await f.pool.query('SELECT id FROM empresas')).rowCount, 0);
      const context = (await f.pool.query("SELECT current_setting('app.usuario_id',true) AS identity,current_setting('app.empresa_id',true) AS tenant")).rows[0];
      assert.ok(!context.identity); assert.ok(!context.tenant);
    });
    await t.test('transação customer autoriza antes do callback e nunca entrega bypass administrativo', async () => {
      const context = { usuarioId: ana.id, sessionId: ana.auth.sessionId, now: f.clock(), empresaId: aurora.id };
      await assert.rejects(withCustomerTransaction(f.pool, { ...context, empresaId: vale.id, permission: 'attendance.read' }, async () => {
        assert.fail('Empresa alheia nunca pode executar o callback');
      }), { status: 404 });
      await assert.rejects(withCustomerTransaction(f.pool, { ...context, permission: 'attendance.simulate' }, async () => {
        assert.fail('Capacidade ausente nunca pode executar o callback');
      }), { status: 403 });
      await withCustomerTransaction(f.pool, { ...context, permission: 'attendance.read' }, async (tx) => {
        assert.equal(tx.isPlatformAdmin, false); assert.equal(tx.tenantId, aurora.id); assert.equal(tx.userId, ana.id);
        assert.deepEqual((await tx.client.query("SELECT current_setting('app.audience') AS audience,current_setting('app.is_platform_admin') AS admin")).rows[0],
          { audience: 'customer', admin: 'false' });
        assert.equal((await tx.client.query('SELECT id FROM empresas WHERE id=$1', [aurora.id])).rowCount, 1);
        for (const table of ['credenciais_empresa', 'configuracoes_ia', 'account_tokens', 'team_invitations', 'ownership_transfers', 'company_owners', 'mfa_recovery_codes']) {
          assert.equal((await tx.client.query(`SELECT * FROM ${table}`)).rowCount, 0, table);
        }
      });
    });
    await t.test('contexto customer não altera campos de segurança, amplia sessão ou exclui a identidade', async () => {
      const before = (await f.owner.query('SELECT password_hash,papel_plataforma,mfa_habilitado,status FROM usuarios WHERE id=$1', [ana.id])).rows[0];
      for (const assignment of ["password_hash='injected'", "papel_plataforma='administrador'", 'mfa_habilitado=true', "status='bloqueado'"]) {
        await assert.rejects(withIdentityTransaction(f.pool, { usuarioId: ana.id }, async ({ client }) => {
          await client.query(`UPDATE usuarios SET ${assignment} WHERE id=$1`, [ana.id]);
        }), { code: '42501' });
      }
      await withIdentityTransaction(f.pool, { usuarioId: ana.id }, async ({ client }) => {
        assert.equal((await client.query('DELETE FROM usuarios WHERE id=$1', [ana.id])).rowCount, 0);
      });
      assert.deepEqual((await f.owner.query('SELECT password_hash,papel_plataforma,mfa_habilitado,status FROM usuarios WHERE id=$1', [ana.id])).rows[0], before);
      await assert.rejects(withIdentityTransaction(f.pool, { usuarioId: ana.id }, async ({ client }) => {
        await client.query("UPDATE auth_sessions SET expires_at=expires_at+interval '1 day' WHERE id=$1", [ana.auth.sessionId]);
      }), { code: '42501' });
      const additional = await f.service.login({ email: ana.email, password: fixturePassword }, 'additional-session');
      const additionalAuth = await f.service.authenticate(additional.token);
      await withIdentityTransaction(f.pool, { usuarioId: ana.id }, async ({ client }) => {
        assert.equal((await client.query('UPDATE auth_sessions SET revoked_at=$2 WHERE id=$1', [additionalAuth.sessionId, f.clock()])).rowCount, 1);
      });
      await assert.rejects(withIdentityTransaction(f.pool, { usuarioId: ana.id }, async ({ client }) => {
        await client.query('UPDATE auth_sessions SET revoked_at=NULL WHERE id=$1', [additionalAuth.sessionId]);
      }), { code: '42501' });
      await assert.rejects(f.service.authenticate(additional.token), { status: 401 });
      assert.ok(await f.service.authenticate(ana.issued.token));
    });
    await t.test('bloqueio e reativação administrativa não restauram sessão ou challenge', async () => {
      const repo = new PostgresAdminRepository(f.pool);
      const before = (await f.owner.query('SELECT security_version FROM usuarios WHERE id=$1', [caio.id])).rows[0].security_version;
      await repo.update({ resource: 'users', empresaId: vale.id, id: caio.id, changes: { status: 'blocked' } });
      await assert.rejects(f.service.authenticate(caio.issued.token), denied);
      await assert.rejects(f.service.companies(caio.auth), denied);
      await withIdentityTransaction(f.pool, { usuarioId: caio.id }, async ({ client }) => {
        assert.equal((await client.query('SELECT id FROM empresas')).rowCount, 0);
      });
      await repo.update({ resource: 'users', empresaId: vale.id, id: caio.id, changes: { status: 'active' } });
      await assert.rejects(f.service.authenticate(caio.issued.token), denied);
      assert.ok((await f.owner.query('SELECT security_version FROM usuarios WHERE id=$1', [caio.id])).rows[0].security_version > before);
      caio.issued = await f.service.login({ email: caio.email, password: fixturePassword }, 'caio-again'); caio.auth = await f.service.authenticate(caio.issued.token);
    });
    await t.test('tokens reset têm geração, expiração, uso único e GET não consome', async () => {
      await f.service.requestToken({ email: bia.email }, 'reset', 'old'); const old = await f.mailToken(bia.email);
      await f.service.requestToken({ email: bia.email }, 'reset', 'new'); const current = await f.mailToken(bia.email);
      assert.notEqual((await f.request(`/account/password/reset?token=${current}`)).status, 204);
      await assert.rejects(f.service.reset({ token: old, password: 'new-M1-synthetic-password-123' }, 'stale'), { code: 'TOKEN_INVALID' });
      await f.service.reset({ token: current, password: 'new-M1-synthetic-password-123' }, 'complete');
      await assert.rejects(f.service.authenticate(bia.issued.token), denied);
      await assert.rejects(f.service.reset({ token: current, password: 'other-M1-synthetic-password-123' }, 'replay'), { code: 'TOKEN_INVALID' });
      await f.service.requestToken({ email: empty.email }, 'reset', 'expire'); const expired = await f.mailToken(empty.email);
      f.advance(31 * 60_000);
      await assert.rejects(f.service.reset({ token: expired, password: 'new-M1-synthetic-password-123' }, 'expired'), { code: 'TOKEN_INVALID' });
    });
    await t.test('auditoria crítica falha reverte senha, versão e revogação', async () => {
      const functionName = `m1_audit_${randomUUID().replaceAll('-', '')}`;
      const before = (await f.owner.query('SELECT password_hash,security_version FROM usuarios WHERE id=$1', [ana.id])).rows[0];
      await f.owner.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`);
      try {
        await f.owner.query(`CREATE TRIGGER ${functionName} BEFORE INSERT ON account_audit FOR EACH ROW
          WHEN (NEW.usuario_id='${ana.id}'::uuid AND NEW.action='account.password.changed') EXECUTE FUNCTION ${functionName}()`);
        await assert.rejects(f.service.changePassword(ana.auth, { currentPassword: fixturePassword, password: 'new-M1-synthetic-password-123' }));
        assert.deepEqual((await f.owner.query('SELECT password_hash,security_version FROM usuarios WHERE id=$1', [ana.id])).rows[0], before);
        assert.ok(await f.service.authenticate(ana.issued.token));
      } finally {
        await f.owner.query(`DROP TRIGGER IF EXISTS ${functionName} ON account_audit`);
        await f.owner.query(`DROP FUNCTION ${functionName}()`);
      }
    });
    await t.test('troca própria revoga sessões e tokens pendentes sem modificar vizinho', async () => {
      await f.service.requestToken({ email: ana.email }, 'reset', 'pre-change'); const pending = await f.mailToken(ana.email);
      await f.service.changePassword(ana.auth, { currentPassword: fixturePassword, password: 'new-M1-synthetic-password-123' });
      await assert.rejects(f.service.authenticate(ana.issued.token), denied);
      await assert.rejects(f.service.reset({ token: pending, password: 'other-M1-synthetic-password-123' }, 'after-change'), { code: 'TOKEN_INVALID' });
      assert.ok(await f.service.authenticate(caio.issued.token));
    });
  } finally { await f.close(); }
});
