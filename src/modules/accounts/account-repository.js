import { randomUUID } from 'node:crypto';
import { withPlatformTransaction, withIdentityTransaction } from '../../infra/postgres/transaction.js';
import { AccountError, invalidSession, invalidToken } from './errors.js';
import { parseTenantRuntimeConfigV2Draft } from '../configuration/tenant-runtime-config-v2.js';

const publicUser = (r) => ({ id: r.id, name: r.nome, email: r.email, verified: Boolean(r.email_verified_at) });
const company = (r) => ({ id: r.id, name: r.nome, status: r.status, owner: r.owner === true, onboarding: 'pending' });

// Bootstrap somente por operacoes fechadas: nenhum controller recebe SQL/client.
export class AccountRepository {
  constructor(pool) { this.pool = pool; }
  async #audit(c, userId, action, empresaId = null) {
    await c.query('INSERT INTO account_audit(usuario_id,empresa_id,action) VALUES ($1,$2,$3)', [userId, empresaId, action]);
  }
  async #queue(c, userId, mail, token = null) {
    if (token) {
      await c.query('UPDATE account_tokens SET consumed_at=now() WHERE usuario_id=$1 AND purpose=$2 AND consumed_at IS NULL', [userId, token.purpose]);
      await c.query(`UPDATE account_email_outbox SET envelope=NULL,status='expired' WHERE usuario_id=$1 AND token_id IN
        (SELECT id FROM account_tokens WHERE usuario_id=$1 AND purpose=$2) AND status IN ('pending','sending')`, [userId, token.purpose]);
      await c.query('INSERT INTO account_tokens(id,usuario_id,purpose,digest,expires_at) VALUES($1,$2,$3,$4,$5)',
        [token.id, userId, token.purpose, token.digest, token.expiresAt]);
    }
    await c.query('INSERT INTO account_email_outbox(id,usuario_id,token_id,envelope,expires_at) VALUES($1,$2,$3,$4,$5)',
      [mail.id, userId, token?.id || null, mail.envelope, mail.expiresAt]);
  }
  register({ userId, name, email, passwordHash, mail, token }) {
    return withPlatformTransaction(this.pool, {}, async ({ client: c }) => {
      const r = await c.query(`INSERT INTO usuarios(id,nome,email,password_hash,papel_plataforma)
        VALUES($1,$2,$3,$4,'nenhum') ON CONFLICT(email) DO NOTHING RETURNING id`, [userId, name, email, passwordHash]);
      if (!r.rowCount) return;
      await this.#queue(c, userId, mail, token);
      await this.#audit(c, userId, 'account.register.accepted_terms');
    });
  }
  findCredentials(email) {
    return withPlatformTransaction(this.pool, {}, async ({ client }) => (await client.query(
      'SELECT id,email,nome,password_hash,status,email_verified_at,security_version,mfa_habilitado FROM usuarios WHERE email=$1 AND deleted_at IS NULL', [email],
    )).rows[0] || null);
  }
  requestToken({ userId, mail, token }) {
    return withPlatformTransaction(this.pool, {}, async ({ client: c }) => {
      const r = (await c.query('SELECT * FROM usuarios WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [userId])).rows[0];
      if (!r || r.status !== 'ativo' || (token.purpose === 'verify' && r.email_verified_at)) return;
      await this.#queue(c, userId, mail, token);
      await this.#audit(c, userId, `account.${token.purpose}.requested`);
    });
  }
  consumeToken({ digest, purpose, passwordHash, mail, now }) {
    return withPlatformTransaction(this.pool, {}, async ({ client: c }) => {
      // Sempre usuario antes do token: serializa reset, reenvio, login e troca de senha.
      const found = (await c.query('SELECT usuario_id FROM account_tokens WHERE digest=$1 AND purpose=$2', [digest, purpose])).rows[0];
      if (!found) throw invalidToken();
      const user = (await c.query('SELECT * FROM usuarios WHERE id=$1 FOR UPDATE', [found.usuario_id])).rows[0];
      if (!user || user.status !== 'ativo' || user.deleted_at) throw invalidToken();
      const token = (await c.query(`UPDATE account_tokens SET consumed_at=$3 WHERE digest=$1 AND purpose=$2
        AND consumed_at IS NULL AND expires_at>$3 RETURNING id`, [digest, purpose, now])).rows[0];
      if (!token) throw invalidToken();
      await c.query("UPDATE account_email_outbox SET envelope=NULL,status='expired' WHERE token_id=$1 AND status IN ('pending','sending')", [token.id]);
      if (purpose === 'verify') await c.query('UPDATE usuarios SET email_verified_at=$2 WHERE id=$1', [user.id, now]);
      else {
        await this.#password(c, user.id, passwordHash, now);
        await this.#queue(c, user.id, mail(user));
      }
      await this.#audit(c, user.id, `account.${purpose}.completed`);
    });
  }
  async #password(c, userId, hash, now) {
    await c.query('UPDATE usuarios SET password_hash=$2,security_version=security_version+1,updated_at=$3 WHERE id=$1', [userId, hash, now]);
    await c.query('UPDATE auth_sessions SET revoked_at=$2 WHERE usuario_id=$1 AND revoked_at IS NULL', [userId, now]);
    await c.query("UPDATE account_tokens SET consumed_at=$2 WHERE usuario_id=$1 AND purpose='reset' AND consumed_at IS NULL", [userId, now]);
    await c.query(`UPDATE account_email_outbox SET envelope=NULL,status='expired' WHERE usuario_id=$1 AND token_id IN
      (SELECT id FROM account_tokens WHERE usuario_id=$1 AND purpose='reset') AND status IN ('pending','sending')`, [userId]);
  }
  login({ userId, passwordHash, tokenHash, oldHash, now, expiresAt }) {
    return withPlatformTransaction(this.pool, {}, async ({ client: c }) => {
      const u = (await c.query('SELECT * FROM usuarios WHERE id=$1 FOR UPDATE', [userId])).rows[0];
      if (!u || u.status !== 'ativo' || u.deleted_at || u.password_hash !== passwordHash || u.mfa_habilitado) throw invalidSession();
      if (oldHash) await c.query("UPDATE auth_sessions SET revoked_at=$2 WHERE token_hash=$1 AND audience='customer'", [oldHash, now]);
      await c.query(`INSERT INTO auth_sessions(usuario_id,token_hash,audience,security_version,created_at,last_seen_at,expires_at)
        VALUES($1,$2,'customer',$3,$4,$4,$5)`, [u.id, tokenHash, u.security_version, now, expiresAt]);
      await this.#audit(c, u.id, 'account.login');
      return publicUser(u);
    });
  }
  authenticate({ tokenHash, now, idleMs }) {
    return withPlatformTransaction(this.pool, {}, async ({ client: c }) => {
      const r = (await c.query(`SELECT u.*,s.id session_id FROM auth_sessions s JOIN usuarios u ON u.id=s.usuario_id
        WHERE s.token_hash=$1 AND s.audience='customer' AND s.revoked_at IS NULL AND s.expires_at>$2
        AND s.last_seen_at>$3 AND s.security_version=u.security_version AND u.status='ativo'
        AND u.deleted_at IS NULL AND NOT u.mfa_habilitado`, [tokenHash, now, new Date(now.getTime() - idleMs)])).rows[0];
      if (!r) throw invalidSession();
      await c.query('UPDATE auth_sessions SET last_seen_at=$2 WHERE id=$1 AND revoked_at IS NULL', [r.session_id, now]);
      return { user: publicUser(r), sessionId: r.session_id, audience: 'customer' };
    });
  }
  logout({ userId, sessionId, now }) {
    return withIdentityTransaction(this.pool, { usuarioId: userId }, async ({ client }) => {
      await client.query(
      "UPDATE auth_sessions SET revoked_at=$3 WHERE id=$1 AND usuario_id=$2 AND audience='customer'", [sessionId, userId, now],
      );
      await this.#audit(client, userId, 'account.logout');
    });
  }
  updateProfile({ userId, name }) {
    return withIdentityTransaction(this.pool, { usuarioId: userId }, async ({ client: c }) => {
      const user = publicUser((await c.query('UPDATE usuarios SET nome=$2 WHERE id=$1 RETURNING *', [userId, name])).rows[0]);
      await this.#audit(c, userId, 'account.profile.changed');
      return user;
    });
  }
  changePassword({ userId, previousHash, passwordHash, mail, now }) {
    return withPlatformTransaction(this.pool, {}, async ({ client: c }) => {
      const user = (await c.query('SELECT * FROM usuarios WHERE id=$1 FOR UPDATE', [userId])).rows[0];
      if (!user || user.password_hash !== previousHash || user.status !== 'ativo' || user.deleted_at) throw invalidSession();
      await this.#password(c, userId, passwordHash, now);
      await this.#queue(c, userId, mail);
      await this.#audit(c, userId, 'account.password.changed');
    });
  }
  listCompanies(userId) {
    return withIdentityTransaction(this.pool, { usuarioId: userId }, async ({ client: c }) => (await c.query(`
      SELECT e.id,e.nome,e.status,(o.usuario_id=$1) owner FROM empresas e
      JOIN usuarios_empresas m ON m.empresa_id=e.id AND m.usuario_id=$1 AND m.status='ativo'
      LEFT JOIN company_owners o ON o.empresa_id=e.id AND o.usuario_id=$1
      WHERE e.deleted_at IS NULL ORDER BY e.created_at,e.id LIMIT 100`, [userId])).rows.map(company));
  }
  createCompany({ userId, name, key, payloadHash, limit, now }) {
    return withPlatformTransaction(this.pool, {}, async ({ client: c }) => {
      const u = (await c.query('SELECT * FROM usuarios WHERE id=$1 FOR UPDATE', [userId])).rows[0];
      if (!u || u.status !== 'ativo' || u.deleted_at || !u.email_verified_at) throw new AccountError('EMAIL_VERIFICATION_REQUIRED', 403, 'Confirme seu e-mail antes de criar a empresa.');
      const prior = (await c.query('SELECT * FROM company_provision_requests WHERE usuario_id=$1 AND request_key=$2', [userId, key])).rows[0];
      if (prior && new Date(prior.expires_at) > now) {
        if (prior.payload_hash !== payloadHash) throw new AccountError('IDEMPOTENCY_CONFLICT', 409, 'Esta solicitação já foi usada com outros dados.');
        const row = (await c.query(`SELECT e.* FROM empresas e JOIN usuarios_empresas m ON m.empresa_id=e.id
          WHERE e.id=$1 AND m.usuario_id=$2 AND m.status='ativo' AND e.deleted_at IS NULL`, [prior.empresa_id, userId])).rows[0];
        if (!row) throw new AccountError('COMPANY_NOT_FOUND', 404, 'Empresa não encontrada.');
        return company({ ...row, owner: true });
      }
      const count = (await c.query('SELECT count(*)::int count FROM company_owners WHERE usuario_id=$1', [userId])).rows[0].count;
      if (count >= limit) throw new AccountError('COMPANY_LIMIT', 409, 'Limite de empresas atingido.');
      const id = randomUUID();
      const row = (await c.query("INSERT INTO empresas(id,slug,nome,nome_exibicao,status) VALUES($1,$2,$3,$3,'rascunho') RETURNING *", [id, `empresa-${id}`, name])).rows[0];
      await c.query("INSERT INTO usuarios_empresas(empresa_id,usuario_id,papel) VALUES($1,$2,'administrador')", [id, userId]);
      await c.query('INSERT INTO company_owners(empresa_id,usuario_id) VALUES($1,$2)', [id, userId]);
      const draft = parseTenantRuntimeConfigV2Draft({ schemaVersion: 2,
        identity: { name, displayName: name, locale: 'pt-BR', timezone: 'America/Sao_Paulo' },
        modules: [], ai: { enabled: false }, integrations: [] });
      await c.query('INSERT INTO configuracoes_rascunho(empresa_id,created_by,updated_by,configuracao) VALUES($1,$2,$2,$3)', [id, userId, draft]);
      await c.query('INSERT INTO onboarding_progressos(empresa_id,updated_by) VALUES($1,$2)', [id, userId]);
      await c.query(`INSERT INTO company_provision_requests(usuario_id,request_key,payload_hash,empresa_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(usuario_id,request_key) DO UPDATE SET payload_hash=$3,empresa_id=$4,expires_at=now()+interval '24 hours'`, [userId, key, payloadHash, id]);
      await this.#audit(c, userId, 'company.created', id);
      return company({ ...row, owner: true });
    });
  }
  claimMail(now, userIds = null) {
    return withPlatformTransaction(this.pool, {}, async ({ client: c }) => {
      await c.query("UPDATE account_email_outbox SET envelope=NULL,status='expired' WHERE expires_at<=$1 AND envelope IS NOT NULL AND ($2::uuid[] IS NULL OR usuario_id=ANY($2))", [now, userIds]);
      const r = (await c.query(`SELECT * FROM account_email_outbox WHERE status IN ('pending','sending') AND available_at<=$1
        AND expires_at>$1 AND attempts<5 AND ($2::uuid[] IS NULL OR usuario_id=ANY($2)) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1`, [now, userIds])).rows[0];
      if (!r) return null;
      const lease = randomUUID();
      await c.query("UPDATE account_email_outbox SET status='sending',attempts=attempts+1,lease_id=$2,available_at=$3 WHERE id=$1", [r.id, lease, new Date(now.getTime() + 60_000)]);
      return { ...r, lease_id: lease, attempts: r.attempts + 1 };
    });
  }
  finishMail({ id, lease, success, attempts, now }) {
    return withPlatformTransaction(this.pool, {}, ({ client: c }) => c.query(`UPDATE account_email_outbox
      SET status=$3,envelope=CASE WHEN $4 THEN NULL ELSE envelope END,available_at=$5,lease_id=NULL
      WHERE id=$1 AND lease_id=$2 AND status='sending'`, [id, lease, success ? 'sent' : attempts >= 5 ? 'failed' : 'pending',
      success || attempts >= 5, new Date(now.getTime() + Math.min(3600_000, 1000 * 2 ** attempts))]));
  }
}
