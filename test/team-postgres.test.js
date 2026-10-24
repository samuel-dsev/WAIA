import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { TeamService } from '../src/modules/accounts/team-service.js';
import { PostgresAdminRepository } from '../src/modules/admin/postgres-admin-repository.js';
import { withIdentityTransaction } from '../src/infra/postgres/transaction.js';
import { createM1Fixture, decodeBase32, enabled, fixturePassword } from './support/m1-fixtures.js';

test('M1 PostgreSQL: MFA, fronteira administrativa e revogação', { skip: !enabled }, async (t) => {
  const f = await createM1Fixture('identity');
  let a, b, admin, backup, customerCompany, adminCompany, secretA, secretAdmin, codesA, adminIssued, adminPrincipal, customerAdmin;
  const unauthorized = (error) => error?.status === 401;
  try {
    a = await f.makeUser('a'); b = await f.makeUser('b');
    admin = await f.makeUser('admin', { platform: true, login: false });
    backup = await f.makeUser('backup', { platform: true, login: false });
    customerCompany = await f.makeCompany('customer'); adminCompany = await f.makeCompany('admin-company');
    await f.link(a, customerCompany, { role: 'administrador', permissions: ['attendance.read', '*', 'credentials.manage'] });
    await f.link(admin, adminCompany, { role: 'administrador' });
    await f.owner.query('INSERT INTO company_owners(empresa_id,usuario_id) VALUES($1,$2)', [customerCompany.id, a.id]);

    await t.test('cliente owner/tenant_admin não obtém audience admin por serviço, HTTP ou repositório', async () => {
      await assert.rejects(f.authService.login({ email: a.email, password: fixturePassword, ip: 'client-admin' }), unauthorized);
      const spoofed = await f.request('/admin/login', { method: 'POST', body: { email: a.email, password: fixturePassword, audience: 'admin', platformRole: 'platform_admin' } });
      assert.equal(spoofed.status, 403); assert.equal(spoofed.headers.get('set-cookie'), null);
      const ordinary = await f.request('/admin/login', { method: 'POST', body: { email: a.email, password: fixturePassword } });
      assert.equal(ordinary.status, 401); assert.equal(ordinary.headers.get('set-cookie'), null);
      const issued = f.adminCodec.issue();
      assert.equal(await f.authRepository.createSession({ userId: a.id, tokenHash: issued.tokenHash,
        createdAt: f.clock(), expiresAt: new Date(f.clock().getTime() + 3_600_000),
        expectedPasswordHash: a.passwordHash, mfaVerifiedAt: f.clock(), ip: null, userAgent: null }), null);
      await assert.rejects(f.authService.authenticate(a.issued.token), unauthorized);
    });
    await t.test('equipe/convites/ownership permanecem negados no HTTP e serviço', async () => {
      const team = new TeamService({ pool: f.pool, keyring: f.keyring, security: f.security, origin: 'http://localhost', clock: f.clock });
      for (const call of [
        () => team.list(a.auth, customerCompany.id),
        () => team.invite(a.auth, customerCompany.id, { email: b.email, role: 'operador' }),
        () => team.revokeInvite(a.auth, customerCompany.id, randomUUID()),
        () => team.member(a.auth, customerCompany.id, b.id, { role: 'operador', status: 'ativo' }),
        () => team.accept(a.auth, { token: 'a'.repeat(43) }),
        () => team.transfer(a.auth, customerCompany.id, { userId: b.id }),
        () => team.revokeTransfer(a.auth, customerCompany.id, randomUUID()),
        () => team.acceptTransfer(a.auth, { token: 'a'.repeat(43) }),
      ]) await assert.rejects(async () => call(), { status: 403 });
      assert.equal((await f.request(`/app/companies/${customerCompany.id}/team`, { issued: a.issued })).status, 403);
      assert.equal((await f.owner.query('SELECT * FROM team_invitations WHERE empresa_id=$1', [customerCompany.id])).rowCount, 0);
      assert.equal((await f.owner.query('SELECT * FROM ownership_transfers WHERE empresa_id=$1', [customerCompany.id])).rowCount, 0);
      await assert.rejects(f.owner.query("UPDATE usuarios_empresas SET status='suspenso' WHERE empresa_id=$1 AND usuario_id=$2", [customerCompany.id, a.id]), { code: '23514' });
    });
    await t.test('MFA pessoal exige sessão/origem/CSRF e confirma antes de ativar', async () => {
      assert.equal((await f.request('/account/mfa/setup', { method: 'POST', issued: a.issued, body: { password: fixturePassword }, origin: 'https://evil.invalid' })).status, 403);
      assert.equal((await f.request('/account/mfa/setup', { method: 'POST', issued: a.issued, body: { password: fixturePassword }, csrf: 'wrong' })).status, 403);
      const challenge = await f.security.setup(a.auth, fixturePassword, 'setup-a');
      secretA = decodeBase32(challenge.enrollment.secret);
      assert.equal((await f.repository.findCredentials(a.email)).mfa_habilitado, false);
      await assert.rejects(f.security.complete({ challenge: challenge.challenge, code: 'bad', audience: 'customer', purpose: 'enroll', auth: a.auth, ip: 'bad' }), unauthorized);
      await assert.rejects(f.security.complete({ challenge: challenge.challenge, code: f.code(secretA), audience: 'admin', purpose: 'enroll', auth: a.auth, ip: 'wrong-audience' }), unauthorized);
      const result = await f.security.complete({ challenge: challenge.challenge, code: f.code(secretA), audience: 'customer', purpose: 'enroll', auth: a.auth, ip: 'setup-good' });
      codesA = result.recoveryCodes; assert.equal(new Set(codesA).size, 10);
      assert.equal((await f.service.authenticate(a.issued.token)).user.mfaEnabled, true);
      const envelope = (await f.owner.query('SELECT mfa_envelope FROM usuarios WHERE id=$1', [a.id])).rows[0].mfa_envelope;
      assert.equal(JSON.stringify(envelope).includes(challenge.enrollment.secret), false);
      await assert.rejects(f.security.setup({ ...a.auth, audience: 'admin' }, fixturePassword, 'forged-session'), unauthorized);
    });
    await t.test('challenge customer não atravessa endpoint admin nem aceita audience no body', async () => {
      const challenge = await f.service.login({ email: a.email, password: fixturePassword }, 'customer-ch');
      const response = await f.request('/admin/mfa/login', { method: 'POST', body: { challenge: challenge.challenge, code: f.code(secretA), audience: 'customer' } });
      assert.equal(response.status, 403); assert.equal(response.headers.get('set-cookie'), null);
      const ordinary = await f.request('/admin/mfa/login', { method: 'POST', body: { challenge: challenge.challenge, code: f.code(secretA) } });
      assert.equal(ordinary.status, 401); assert.equal(ordinary.headers.get('set-cookie'), null);
      const result = await f.service.completeMfa({ challenge: challenge.challenge, code: f.code(secretA), audience: 'admin' }, 'customer-good');
      assert.ok(result.token);
      await assert.rejects(f.authService.authenticate(result.token), unauthorized);
      await assert.rejects(f.authService.login({ email: a.email, password: fixturePassword, ip: 'client-mfa-admin' }), unauthorized);
      await assert.rejects(f.owner.query(`INSERT INTO auth_sessions(usuario_id,token_hash,audience,security_version,created_at,last_seen_at,expires_at,mfa_verified_at)
        SELECT id,$2,'admin',security_version,$3,$3,$4,$3 FROM usuarios WHERE id=$1`,
      [a.id, randomBytes(32), f.clock(), new Date(f.clock().getTime() + 3_600_000)]), { code: '23514' });
    });
    await t.test('TOTP/recovery/concorrência são de uso único e challenge expira', async () => {
      const challenge = await f.service.login({ email: a.email, password: fixturePassword }, 'recovery');
      const results = await Promise.allSettled([1, 2].map(() => f.service.completeMfa({ challenge: challenge.challenge, code: codesA[0] }, 'race')));
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      const replay = await f.service.login({ email: a.email, password: fixturePassword }, 'recovery-replay');
      await assert.rejects(f.service.completeMfa({ challenge: replay.challenge, code: codesA[0] }, 'replay'), unauthorized);
      const code = f.code(secretA); await f.service.completeMfa({ challenge: replay.challenge, code }, 'totp');
      const next = await f.service.login({ email: a.email, password: fixturePassword }, 'totp-replay');
      await assert.rejects(f.service.completeMfa({ challenge: next.challenge, code }, 'totp-replay'), unauthorized);
      f.advance(16 * 60_000);
      const expired = await f.service.login({ email: a.email, password: fixturePassword }, 'expired');
      f.advance(301_000);
      await assert.rejects(f.service.completeMfa({ challenge: expired.challenge, code: f.code(secretA) }, 'expired'), unauthorized);
    });
    await t.test('administrador global recebe challenge de matrícula antes de qualquer cookie', async () => {
      const response = await f.request('/admin/login', { method: 'POST', body: { email: admin.email, password: fixturePassword } });
      assert.equal(response.status, 202); assert.equal(response.headers.get('set-cookie'), null);
      const challenge = response.body; assert.ok(challenge.enrollment); secretAdmin = decodeBase32(challenge.enrollment.secret);
      assert.equal((await f.request('/account/mfa/login', { method: 'POST', body: { challenge: challenge.challenge, code: f.code(secretAdmin), audience: 'admin' } })).status, 401);
      const done = await f.authService.completeMfa({ challenge: challenge.challenge, code: f.code(secretAdmin), ip: 'admin-enroll' });
      adminIssued = done.credentials; adminPrincipal = done.principal;
      assert.equal(adminPrincipal.audience, 'admin'); assert.equal(done.recoveryCodes.length, 10);
      assert.equal((await f.authService.authenticate(adminIssued.sessionToken)).user.id, admin.id);
      await assert.rejects(f.service.authenticate(adminIssued.sessionToken), unauthorized);
      await assert.rejects(f.security.manage(adminPrincipal, 'disable'), { code: 'MFA_REQUIRED' });
    });
    await t.test('customer de administrador global continua limitado aos vínculos explícitos', async () => {
      const challenge = await f.service.login({ email: admin.email, password: fixturePassword }, 'admin-customer');
      customerAdmin = await f.service.completeMfa({ challenge: challenge.challenge, code: f.code(secretAdmin) }, 'admin-customer');
      const auth = await f.service.authenticate(customerAdmin.token);
      assert.deepEqual((await f.service.companies(auth)).map((company) => company.id), [adminCompany.id]);
      await assert.rejects(f.service.company(auth, customerCompany.id), { status: 404 });
      assert.equal((await f.service.company(auth, adminCompany.id)).id, adminCompany.id);
    });
    await t.test('rebaixamento entre emissão e conclusão não conserva challenge administrativo', async () => {
      const challenge = await f.authService.login({ email: admin.email, password: fixturePassword, ip: 'pre-demotion' });
      await f.owner.query("UPDATE usuarios SET papel_plataforma='nenhum' WHERE id=$1", [admin.id]);
      await assert.rejects(f.authService.completeMfa({ challenge: challenge.challenge, code: f.code(secretAdmin), ip: 'demoted' }), unauthorized);
      await assert.rejects(f.authService.authenticate(adminIssued.sessionToken), unauthorized);
      await f.owner.query("UPDATE usuarios SET papel_plataforma='administrador' WHERE id=$1", [admin.id]);
    });
    await t.test('bloqueio administrativo invalida sessões, challenges e envelopes antes da reativação', async () => {
      const repository = new PostgresAdminRepository(f.pool);
      const challenge = await f.authService.login({ email: admin.email, password: fixturePassword, ip: 'pre-block' });
      await f.service.requestToken({ email: admin.email }, 'reset', 'pre-block-token');
      await repository.update({ resource: 'users', empresaId: adminCompany.id, id: admin.id, changes: { status: 'blocked' } });
      await repository.update({ resource: 'users', empresaId: adminCompany.id, id: admin.id, changes: { status: 'active' } });
      await assert.rejects(f.authService.authenticate(adminIssued.sessionToken), unauthorized);
      await assert.rejects(f.service.authenticate(customerAdmin.token), unauthorized);
      await assert.rejects(f.authService.completeMfa({ challenge: challenge.challenge, code: f.code(secretAdmin), ip: 'unblocked-old' }), unauthorized);
      assert.equal((await f.owner.query("SELECT * FROM account_email_outbox WHERE usuario_id=$1 AND token_id IS NOT NULL AND status IN ('pending','sending') AND envelope IS NOT NULL", [admin.id])).rowCount, 0);
      assert.equal((await f.owner.query('SELECT * FROM identity_challenges WHERE usuario_id=$1 AND consumed_at IS NULL', [admin.id])).rowCount, 0);
    });
    await t.test('reset mantém MFA e revoga admin/customer/challenges anteriores', async () => {
      const challenge = await f.authService.login({ email: admin.email, password: fixturePassword, ip: 'admin-new' });
      const done = await f.authService.completeMfa({ challenge: challenge.challenge, code: f.code(secretAdmin), ip: 'admin-new' });
      adminIssued = done.credentials; adminPrincipal = done.principal;
      const customerChallenge = await f.service.login({ email: admin.email, password: fixturePassword }, 'customer-new');
      customerAdmin = await f.service.completeMfa({ challenge: customerChallenge.challenge, code: f.code(secretAdmin) }, 'customer-new');
      const pending = await f.authService.login({ email: admin.email, password: fixturePassword, ip: 'pre-reset' });
      await f.service.requestToken({ email: admin.email }, 'reset', 'reset');
      await f.service.reset({ token: await f.mailToken(admin.email), password: 'M1-reset-admin-password-12345' }, 'reset');
      await assert.rejects(f.authService.authenticate(adminIssued.sessionToken), unauthorized);
      await assert.rejects(f.service.authenticate(customerAdmin.token), unauthorized);
      await assert.rejects(f.authService.completeMfa({ challenge: pending.challenge, code: f.code(secretAdmin), ip: 'post-reset' }), unauthorized);
      assert.equal((await f.repository.findCredentials(admin.email)).mfa_habilitado, true);
      assert.equal((await f.authService.login({ email: admin.email, password: 'M1-reset-admin-password-12345', ip: 'after-reset' })).mfaRequired, true);
    });
    await t.test('troca de senha admin é transacional com auditoria e preserva só a sessão atual', async () => {
      const password = 'M1-reset-admin-password-12345';
      const challenge = await f.authService.login({ email: admin.email, password, ip: 'password-admin' });
      const result = await f.authService.completeMfa({ challenge: challenge.challenge, code: f.code(secretAdmin), ip: 'password-admin' });
      adminIssued = result.credentials; adminPrincipal = result.principal;
      const customerChallenge = await f.service.login({ email: admin.email, password }, 'password-customer');
      customerAdmin = await f.service.completeMfa({ challenge: customerChallenge.challenge, code: f.code(secretAdmin) }, 'password-customer');
      const functionName = `m1_password_audit_${randomUUID().replaceAll('-', '')}`;
      const before = (await f.owner.query('SELECT password_hash,security_version FROM usuarios WHERE id=$1', [admin.id])).rows[0];
      await f.owner.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`);
      try {
        await f.owner.query(`CREATE TRIGGER ${functionName} BEFORE INSERT ON account_audit FOR EACH ROW WHEN (NEW.usuario_id='${admin.id}'::uuid AND NEW.action='auth.password_changed') EXECUTE FUNCTION ${functionName}()`);
        await assert.rejects(f.authService.changePassword({ sessionId: adminPrincipal.sessionId, userId: admin.id, currentPassword: password, newPassword: 'M1-changed-admin-password-12345' }));
        assert.deepEqual((await f.owner.query('SELECT password_hash,security_version FROM usuarios WHERE id=$1', [admin.id])).rows[0], before);
        assert.ok(await f.authService.authenticate(adminIssued.sessionToken));
        assert.ok(await f.service.authenticate(customerAdmin.token));
      } finally {
        await f.owner.query(`DROP TRIGGER IF EXISTS ${functionName} ON account_audit`);
        await f.owner.query(`DROP FUNCTION ${functionName}()`);
      }
      await f.authService.changePassword({ sessionId: adminPrincipal.sessionId, userId: admin.id, currentPassword: password, newPassword: 'M1-changed-admin-password-12345' });
      assert.ok(await f.authService.authenticate(adminIssued.sessionToken));
      await assert.rejects(f.service.authenticate(customerAdmin.token), unauthorized);
      await withIdentityTransaction(f.pool, { usuarioId: b.id }, async ({ client }) => {
        for (const table of ['identity_challenges', 'mfa_recovery_codes', 'team_invitations', 'ownership_transfers']) {
          assert.equal((await client.query(`SELECT * FROM ${table}`)).rowCount, 0);
        }
      });
    });
  } finally { await f.close(); }
});
