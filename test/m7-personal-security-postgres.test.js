import test from 'node:test';
import assert from 'node:assert/strict';
import { createM1Fixture, decodeBase32, enabled, fixturePassword } from './support/m1-fixtures.js';

test('M7 PostgreSQL: perfil pessoal, sessões próprias e revogação de segurança', { skip: !enabled }, async (t) => {
  const f = await createM1Fixture('m7-personal-security');
  let user, other, second, secondAuth, pendingEnrollment, enrollmentSecret;
  const row = async (id) => (await f.owner.query(
    'SELECT nome,email,status,papel_plataforma,password_hash,security_version,mfa_habilitado FROM usuarios WHERE id=$1', [id])).rows[0];
  try {
    user = await f.makeUser('user'); other = await f.makeUser('other');
    second = await f.service.login({ email: user.email, password: fixturePassword }, 'm7-second-session');
    secondAuth = await f.service.authenticate(second.token);

    await t.test('perfil HTTP rejeita e-mail, estado e identidade de terceiros sem alterar qualquer usuário', async () => {
      const before = await row(user.id), neighbor = await row(other.id);
      for (const injected of [{ email: other.email }, { status: 'bloqueado' }, { userId: other.id },
        { usuarioId: other.id }, { platformRole: 'platform_admin' }, { permissions: ['*'] }]) {
        const result = await f.request('/account/profile', { method: 'PATCH', issued: user.issued,
          body: { name: 'Nome que não deve ser salvo', ...injected } });
        assert.equal(result.status, 422);
        assert.equal(result.body.user, undefined);
      }
      assert.deepEqual(await row(user.id), before); assert.deepEqual(await row(other.id), neighbor);
    });
    await t.test('nome com marcação é texto literal da própria identidade; DTO não devolve dados de segurança', async () => {
      const name = '<img src=x onerror=alert(1)> Nome fictício';
      const neighbor = await row(other.id);
      const response = await f.request('/account/profile', { method: 'PATCH', issued: user.issued, body: { name } });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.equal(response.body.user.name, name); assert.equal(response.body.user.id, user.id);
      assert.deepEqual(Object.keys(response.body.user).sort(), ['id', 'name', 'email', 'verified', 'mfaEnabled'].sort());
      assert.equal((await row(user.id)).nome, name); assert.deepEqual(await row(other.id), neighbor);
      const session = await f.request('/account/session', { issued: second });
      assert.equal(session.status, 200); assert.equal(session.body.user.name, name);
      // Rendering as text is verified by the browser gate; this proves JSON and
      // persistence preserve the literal name rather than executing HTML.
    });
    await t.test('listagem e encerramento de sessões ficam limitados à própria identidade', async () => {
      const response = await f.request('/account/sessions', { issued: user.issued });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const sessions = response.body.sessions;
      assert.deepEqual(sessions.map(({ id }) => id).sort(), [user.auth.sessionId, secondAuth.sessionId].sort());
      assert.equal(sessions.filter(({ current }) => current).length, 1);
      assert.equal(sessions.find(({ current }) => current).id, user.auth.sessionId);
      assert.equal(JSON.stringify(sessions).includes(other.auth.sessionId), false);
      for (const session of sessions) assert.deepEqual(Object.keys(session).sort(),
        ['id', 'audience', 'createdAt', 'lastSeenAt', 'expiresAt', 'current'].sort());
      const beforeOther = (await f.owner.query('SELECT revoked_at FROM auth_sessions WHERE id=$1', [other.auth.sessionId])).rows[0];
      assert.equal((await f.request(`/account/sessions/${other.auth.sessionId}`, { method: 'DELETE', issued: user.issued })).status, 204);
      assert.deepEqual((await f.owner.query('SELECT revoked_at FROM auth_sessions WHERE id=$1', [other.auth.sessionId])).rows[0], beforeOther);
      assert.ok(await f.service.authenticate(other.issued.token));
      assert.equal((await f.request(`/account/sessions/${secondAuth.sessionId}`, { method: 'DELETE', issued: user.issued })).status, 204);
      await assert.rejects(f.service.authenticate(second.token), { status: 401 });
      assert.ok(await f.service.authenticate(user.issued.token));
    });
    await t.test('troca de senha encerra todas as sessões e invalida matrícula MFA pendente sem afetar vizinho', async () => {
      const beforeOther = await row(other.id);
      second = await f.service.login({ email: user.email, password: fixturePassword }, 'm7-second-before-password');
      secondAuth = await f.service.authenticate(second.token);
      const setup = await f.request('/account/mfa/setup', { method: 'POST', issued: user.issued,
        body: { password: fixturePassword } });
      assert.equal(setup.status, 200); pendingEnrollment = setup.body;
      enrollmentSecret = decodeBase32(pendingEnrollment.enrollment.secret);
      const response = await f.request('/account/password/change', { method: 'POST', issued: user.issued,
        body: { currentPassword: fixturePassword, password: 'M7-replaced-synthetic-password-12345' } });
      assert.equal(response.status, 204); assert.match(response.headers.get('set-cookie'), /waia_customer_session=;/);
      await assert.rejects(f.service.authenticate(user.issued.token), { status: 401 });
      await assert.rejects(f.service.authenticate(second.token), { status: 401 });
      assert.equal((await f.owner.query('SELECT 1 FROM auth_sessions WHERE usuario_id=$1 AND revoked_at IS NULL', [user.id])).rowCount, 0);
      assert.equal((await f.owner.query('SELECT 1 FROM identity_challenges WHERE usuario_id=$1 AND (consumed_at IS NULL OR envelope IS NOT NULL)', [user.id])).rowCount, 0);
      assert.equal((await row(user.id)).mfa_habilitado, false);
      assert.deepEqual(await row(other.id), beforeOther); assert.ok(await f.service.authenticate(other.issued.token));
      const fresh = await f.service.login({ email: user.email, password: 'M7-replaced-synthetic-password-12345' }, 'm7-fresh-password');
      const freshAuth = await f.service.authenticate(fresh.token);
      await assert.rejects(f.security.complete({ auth: freshAuth, audience: 'customer', purpose: 'enroll',
        challenge: pendingEnrollment.challenge, code: f.code(enrollmentSecret), ip: 'm7-stale-enrollment' }), { status: 401 });
      assert.ok(await f.service.authenticate(fresh.token));
    });
    await t.test('contexto e cookie revogados não alteram perfil nem encerram sessão alheia', async () => {
      const before = await row(user.id), beforeOther = await row(other.id);
      const request = await f.request('/account/profile', { method: 'PATCH', issued: user.issued, body: { name: 'Nome após revogação' } });
      assert.equal(request.status, 401); assert.equal(request.body.user, undefined);
      assert.equal((await f.request('/account/sessions', { issued: user.issued })).status, 401);
      assert.equal((await f.request(`/account/sessions/${other.auth.sessionId}`, { method: 'DELETE', issued: user.issued })).status, 401);
      await assert.rejects(f.service.profile(user.auth, { name: 'Tentativa pelo serviço' }), { status: 401 });
      await assert.rejects(f.security.sessions(user.auth), { status: 401 });
      await assert.rejects(f.security.revoke(user.auth, other.auth.sessionId), { status: 401 });
      assert.deepEqual(await row(user.id), before); assert.deepEqual(await row(other.id), beforeOther);
      assert.ok(await f.service.authenticate(other.issued.token));
    });
  } finally { await f.close(); }
});
