import { randomUUID } from 'node:crypto';
import { withPlatformTransaction } from '../../infra/postgres/transaction.js';
import { invalidateIdentitySecurity } from '../auth/identity-lifecycle.js';
import { CUSTOMER_CAPABILITIES } from '../auth/permissions.js';
import { accessConflict, accessDenied, accessMissing, safeAccessError } from './errors.js';

const capabilities = CUSTOMER_CAPABILITIES.filter((value) => value.startsWith('attendance.'));
const coreCapabilities = (values) => capabilities.filter((value) => Array.isArray(values) && values.includes(value));
const safeVersion = (value) => {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw accessConflict();
  return version;
};

export class AccessRepository {
  constructor({ pool, security, clock = () => new Date() }) {
    if (!pool?.connect || typeof security?.fresh !== 'function') throw new TypeError('Gestão de acessos exige banco e segurança de identidade.');
    Object.assign(this, { pool, security, clock });
  }
  async #actor(client, auth, fresh) {
    if (auth?.audience !== 'admin' || auth.platformRole !== 'platform_admin' || !auth.sessionId || !auth.user?.id) throw accessDenied();
    if (fresh) {
      const user = await this.security.fresh(client, auth);
      if (user.papel_plataforma !== 'administrador') throw accessDenied();
      return;
    }
    const result = await client.query(`SELECT u.id FROM usuarios u JOIN auth_sessions s ON s.usuario_id=u.id
      WHERE u.id=$1 AND s.id=$2 AND u.papel_plataforma='administrador' AND u.status='ativo'
      AND u.deleted_at IS NULL AND NOT u.activation_required AND u.mfa_habilitado AND s.audience='admin' AND s.mfa_verified_at IS NOT NULL
      AND s.revoked_at IS NULL AND s.expires_at>$3 AND s.last_seen_at>$4 AND s.security_version=u.security_version`,
    [auth.user.id, auth.sessionId, this.clock(), new Date(this.clock().getTime() - 3600000)]);
    if (!result.rowCount) throw accessDenied();
  }
  async #run(auth, fn, mutation = false) {
    try {
      return await withPlatformTransaction(this.pool, { usuarioId: auth?.user?.id }, async ({ client }) => {
        if (mutation) await client.query('SELECT pg_advisory_xact_lock(810420267)');
        await this.#actor(client, auth, mutation);
        return fn(client);
      });
    } catch (error) { throw safeAccessError(error); }
  }
  async #delivery(client, userId) {
    const row = (await client.query(`SELECT t.purpose,o.status,o.attempts,o.available_at,o.expires_at
      FROM account_email_outbox o JOIN account_tokens t ON t.id=o.token_id
      WHERE o.usuario_id=$1 AND t.purpose IN ('activate','reset') ORDER BY o.created_at DESC,o.id DESC LIMIT 1`, [userId])).rows[0];
    return row ? { purpose: row.purpose, status: row.status === 'sent' ? 'accepted' : row.status,
      attempts: row.attempts, availableAt: row.available_at, expiresAt: row.expires_at } : { purpose: null, status: 'none', attempts: 0 };
  }
  async #user(client, userId, includeCompanies = true) {
    const row = (await client.query(`SELECT id,nome,email,status,mfa_habilitado,activation_required,access_version,created_at,updated_at
      FROM usuarios WHERE id=$1 AND deleted_at IS NULL`, [userId])).rows[0];
    if (!row) throw accessMissing();
    const companies = includeCompanies ? (await client.query(`SELECT m.empresa_id,e.nome,m.status,m.permissoes,e.status company_status
      FROM usuarios_empresas m JOIN empresas e ON e.id=m.empresa_id
      WHERE m.usuario_id=$1 AND e.deleted_at IS NULL ORDER BY e.nome,m.empresa_id`, [userId])).rows.map((item) => ({
      empresaId: item.empresa_id, name: item.nome, status: item.status, companyStatus: item.company_status,
      capabilities: coreCapabilities(item.permissoes),
    })) : undefined;
    return { id: row.id, name: row.nome, email: row.email, status: row.status,
      activationStatus: row.activation_required ? 'pending' : 'active', mfaEnabled: row.mfa_habilitado,
      version: safeVersion(row.access_version), createdAt: row.created_at, updatedAt: row.updated_at,
      ...(companies ? { companies } : {}), delivery: await this.#delivery(client, userId) };
  }
  async #audit(client, auth, userId, action, fields, meta, empresaId = null) {
    await client.query(`INSERT INTO logs_auditoria(id,empresa_id,ator_usuario_id,acao,recurso_tipo,recurso_id,resultado,
      campos_alterados_redigidos,correlation_id,occurred_at) VALUES($1,$2,$3,$4,'access-user',$5,'sucesso',$6::jsonb,$7,$8)`,
    [randomUUID(), empresaId, auth.user.id, action, userId, JSON.stringify({ fields }), meta.correlationId, this.clock()]);
    await client.query('INSERT INTO account_audit(usuario_id,empresa_id,action) VALUES($1,$2,$3)', [userId, empresaId, action]);
  }
  async #target(client, userId, expectedVersion) {
    const row = (await client.query('SELECT * FROM usuarios WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [userId])).rows[0];
    if (!row) throw accessMissing();
    if (safeVersion(row.access_version) !== expectedVersion) throw accessConflict();
    return row;
  }
  async #increment(client, userId) {
    await client.query('UPDATE usuarios SET access_version=access_version+1,updated_at=$2 WHERE id=$1', [userId, this.clock()]);
  }
  async #company(client, empresaId) {
    const row = (await client.query("SELECT id FROM empresas WHERE id=$1 AND deleted_at IS NULL AND status<>'arquivada' FOR UPDATE", [empresaId])).rows[0];
    if (!row) throw accessMissing();
  }
  async #owner(client, userId, empresaId) {
    return (await client.query('SELECT 1 FROM company_owners WHERE usuario_id=$1 AND empresa_id=$2', [userId, empresaId])).rowCount > 0;
  }
  async #queue(client, userId, material) {
    const now = this.clock();
    await client.query(`UPDATE account_tokens SET consumed_at=$3 WHERE usuario_id=$1 AND purpose=$2 AND consumed_at IS NULL`, [userId, material.token.purpose, now]);
    await client.query(`UPDATE account_email_outbox SET envelope=NULL,status='expired',lease_id=NULL WHERE usuario_id=$1
      AND token_id IN (SELECT id FROM account_tokens WHERE usuario_id=$1 AND purpose=$2) AND status IN ('pending','sending')`, [userId, material.token.purpose]);
    await client.query('INSERT INTO account_tokens(id,usuario_id,purpose,digest,expires_at) VALUES($1,$2,$3,$4,$5)',
      [material.token.id, userId, material.token.purpose, material.token.digest, material.token.expiresAt]);
    await client.query('INSERT INTO account_email_outbox(id,usuario_id,token_id,envelope,expires_at) VALUES($1,$2,$3,$4,$5)',
      [material.mail.id, userId, material.token.id, material.mail.envelope, material.mail.expiresAt]);
  }
  #mutate(options, fn) {
    return this.#run(options.auth, async (client) => {
      const now = this.clock();
      const prior = (await client.query(`SELECT payload_hash,response,expires_at FROM access_admin_requests
        WHERE actor_id=$1 AND request_key=$2 AND operation=$3`, [options.auth.user.id, options.key, options.operation])).rows[0];
      if (prior && new Date(prior.expires_at) > now) {
        if (prior.payload_hash.trim() !== options.payloadHash) throw accessConflict('IDEMPOTENCY_CONFLICT', 'A chave já foi usada com outros dados.');
        return prior.response;
      }
      const result = await fn(client);
      await client.query(`INSERT INTO access_admin_requests(actor_id,request_key,operation,payload_hash,response,expires_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(actor_id,request_key,operation) DO UPDATE
        SET payload_hash=EXCLUDED.payload_hash,response=EXCLUDED.response,expires_at=EXCLUDED.expires_at,created_at=$7`,
      [options.auth.user.id, options.key, options.operation, options.payloadHash, JSON.stringify(result), new Date(now.getTime() + 86400000), now]);
      return result;
    }, true);
  }
  list({ auth, input }) {
    return this.#run(auth, async (client) => {
      const escaped = input.search.replace(/[\\%_]/g, '\\$&');
      const parameters = [`%${escaped}%`, input.empresaId || null, input.status || null];
      const condition = `u.deleted_at IS NULL AND (u.nome ILIKE $1 OR u.email::text ILIKE $1)
        AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM usuarios_empresas m WHERE m.usuario_id=u.id AND m.empresa_id=$2))
        AND ($3::text IS NULL OR u.status=$3)`;
      const total = (await client.query(`SELECT count(*)::int n FROM usuarios u WHERE ${condition}`, parameters)).rows[0].n;
      const rows = (await client.query(`SELECT u.id FROM usuarios u WHERE ${condition} ORDER BY u.nome,u.id LIMIT $4 OFFSET $5`,
        [...parameters, input.pageSize, (input.page - 1) * input.pageSize])).rows;
      const items = [];
      for (const row of rows) items.push(await this.#user(client, row.id));
      return { items, pagination: { page: input.page, pageSize: input.pageSize, total, pages: Math.ceil(total / input.pageSize) } };
    });
  }
  get({ auth, userId }) { return this.#run(auth, (client) => this.#user(client, userId)); }
  create(options) {
    return this.#mutate(options, async (client) => {
      let user = (await client.query('SELECT * FROM usuarios WHERE email=$1 FOR UPDATE', [options.input.email])).rows[0];
      const existing = Boolean(user);
      if (user?.deleted_at) throw accessConflict('ACCESS_UNAVAILABLE', 'Este e-mail exige revisão administrativa.');
      if (!user) user = (await client.query(`INSERT INTO usuarios(id,nome,email,password_hash,papel_plataforma,status,activation_required)
        VALUES($1,$2,$3,$4,'nenhum','ativo',true) RETURNING *`, [options.newUserId, options.input.name, options.input.email, options.passwordHash])).rows[0];
      let changed = false;
      for (const company of options.input.companies) {
        await this.#company(client, company.empresaId);
        const current = (await client.query('SELECT status,permissoes FROM usuarios_empresas WHERE usuario_id=$1 AND empresa_id=$2 FOR UPDATE', [user.id, company.empresaId])).rows[0];
        if (current) {
          if (current.status !== company.status || JSON.stringify(coreCapabilities(current.permissoes)) !== JSON.stringify(company.capabilities)) {
            throw accessConflict('MEMBERSHIP_EXISTS', 'O acesso já possui este vínculo. Abra-o para revisar as capacidades atuais.');
          }
          continue;
        }
        await client.query(`INSERT INTO usuarios_empresas(usuario_id,empresa_id,papel,status,permissoes) VALUES($1,$2,'operador',$3,$4)`, [user.id, company.empresaId, company.status, company.capabilities]);
        changed = true;
      }
      if (!existing) await this.#queue(client, user.id, options.material);
      if (existing && changed) await this.#increment(client, user.id);
      await this.#audit(client, options.auth, user.id, existing ? 'access.reused' : 'access.created', ['identity', 'companies'], options.meta);
      return { user: await this.#user(client, user.id), existing };
    });
  }
  setStatus(options) {
    return this.#mutate(options, async (client) => {
      const target = await this.#target(client, options.userId, options.input.expectedVersion);
      if (target.status !== options.input.status) {
        await client.query('UPDATE usuarios SET status=$2 WHERE id=$1', [target.id, options.input.status]);
        await invalidateIdentitySecurity(client, { userId: target.id, now: this.clock() });
      }
      await this.#increment(client, target.id);
      await this.#audit(client, options.auth, target.id, 'access.status.changed', ['status'], options.meta);
      return { user: await this.#user(client, target.id) };
    });
  }
  putCompany(options) {
    return this.#mutate(options, async (client) => {
      const target = await this.#target(client, options.userId, options.input.expectedVersion);
      await this.#company(client, options.input.empresaId);
      if (options.input.status !== 'ativo' && await this.#owner(client, target.id, options.input.empresaId)) {
        throw accessConflict('OWNER_PROTECTED', 'Resolva explicitamente a propriedade legada antes de suspender este vínculo.');
      }
      const current = (await client.query('SELECT permissoes FROM usuarios_empresas WHERE usuario_id=$1 AND empresa_id=$2 FOR UPDATE',
        [target.id, options.input.empresaId])).rows[0];
      // The access panel edits only the customer catalog. Preserve unrelated
      // legacy permissions, which remain unavailable in every customer DTO.
      const permissions = [...new Set([...(current?.permissoes || []).filter((value) => !capabilities.includes(value)), ...options.input.capabilities])];
      await client.query(`INSERT INTO usuarios_empresas(usuario_id,empresa_id,papel,status,permissoes) VALUES($1,$2,'operador',$3,$4)
        ON CONFLICT(empresa_id,usuario_id) DO UPDATE SET status=$3,permissoes=$4,updated_at=$5`,
      [target.id, options.input.empresaId, options.input.status, permissions, this.clock()]);
      await this.#increment(client, target.id);
      await this.#audit(client, options.auth, target.id, 'access.company.changed', ['companies', 'capabilities'], options.meta, options.input.empresaId);
      return { user: await this.#user(client, target.id) };
    });
  }
  removeCompany(options) {
    return this.#mutate(options, async (client) => {
      const target = await this.#target(client, options.userId, options.input.expectedVersion);
      if (await this.#owner(client, target.id, options.input.empresaId)) throw accessConflict('OWNER_PROTECTED', 'Resolva explicitamente a propriedade legada antes de remover este vínculo.');
      const removed = await client.query('DELETE FROM usuarios_empresas WHERE usuario_id=$1 AND empresa_id=$2 RETURNING empresa_id', [target.id, options.input.empresaId]);
      if (!removed.rowCount) throw accessMissing();
      await this.#increment(client, target.id);
      await this.#audit(client, options.auth, target.id, 'access.company.removed', ['companies'], options.meta, options.input.empresaId);
      return { user: await this.#user(client, target.id) };
    });
  }
  issue(options) {
    return this.#mutate(options, async (client) => {
      const target = await this.#target(client, options.userId, options.input.expectedVersion);
      if (target.status !== 'ativo' || (options.operation === 'activation' ? !target.activation_required : target.activation_required)) {
        throw accessConflict('ACCESS_STATE_CONFLICT', 'O estado do acesso não permite emitir este link.');
      }
      await options.rate();
      await this.#queue(client, target.id, options.materialForEmail(target.email));
      await this.#increment(client, target.id);
      await this.#audit(client, options.auth, target.id, options.operation === 'activation' ? 'access.activation.queued' : 'access.reset.queued',
        options.operation === 'reset' ? ['recovery', 'identityConfirmed'] : ['activation'], options.meta);
      return { user: await this.#user(client, target.id) };
    });
  }
  revokeSessions(options) {
    return this.#mutate(options, async (client) => {
      const target = await this.#target(client, options.userId, options.input.expectedVersion);
      await invalidateIdentitySecurity(client, { userId: target.id, now: this.clock() });
      await this.#increment(client, target.id);
      await this.#audit(client, options.auth, target.id, 'access.sessions.revoked', ['sessions'], options.meta);
      return { user: await this.#user(client, target.id) };
    });
  }
}
