import { randomUUID } from "node:crypto";
import { withPlatformTransaction } from "../../infra/postgres/transaction.js";
import { invalidateIdentitySecurity } from './identity-lifecycle.js';

const clone = (value) => value == null ? value : structuredClone(value);

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id, email: row.email, name: row.nome, passwordHash: row.password_hash,
    platformRole: row.papel_plataforma, status: row.status === "ativo" ? "active" : row.status,
    mfaEnabled: row.mfa_habilitado === true, securityVersion: row.security_version,
  };
}

function mapMembership(row) {
  return {
    empresaId: row.empresa_id,
    role: row.papel,
    status: row.status === "ativo" ? "active" : row.status,
    permissions: row.permissoes || [],
    companyStatus: row.company_status || null,
  };
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id, userId: row.usuario_id, createdAt: row.created_at,
    expiresAt: row.expires_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at,
    audience: row.audience, mfaVerifiedAt: row.mfa_verified_at, securityVersion: row.security_version,
  };
}

export class PostgresAuthRepository {
  constructor(pool) { this.pool = pool; }
  findUserByEmail(email) {
    return withPlatformTransaction(this.pool, {}, async ({ client }) => mapUser((await client.query(
      "SELECT * FROM usuarios WHERE email = $1 AND deleted_at IS NULL LIMIT 1", [email],
    )).rows[0]));
  }
  findUserById(userId) {
    return withPlatformTransaction(this.pool, { usuarioId: userId }, async ({ client }) => mapUser((await client.query(
      "SELECT * FROM usuarios WHERE id = $1 AND deleted_at IS NULL LIMIT 1", [userId],
    )).rows[0]));
  }
  listMemberships(userId) {
    return withPlatformTransaction(this.pool, { usuarioId: userId }, async ({ client }) => (
      await client.query("SELECT m.*,e.status company_status FROM usuarios_empresas m JOIN empresas e ON e.id=m.empresa_id WHERE m.usuario_id=$1 AND e.deleted_at IS NULL", [userId])
    ).rows.map(mapMembership));
  }
  createSession(input) {
    return withPlatformTransaction(this.pool, { usuarioId: input.userId }, async ({ client }) => {
      const locked=(await client.query('SELECT password_hash FROM usuarios WHERE id=$1 FOR UPDATE',[input.userId])).rows[0];
      if(!locked || !input.mfaVerifiedAt || !input.expectedPasswordHash || locked.password_hash!==input.expectedPasswordHash) return null;
      return mapSession((await client.query(
      `INSERT INTO auth_sessions (usuario_id, token_hash, ip, user_agent, expires_at, created_at, last_seen_at,security_version,audience,mfa_verified_at,reauthenticated_at)
       SELECT id,$2,$3,$4,$5,$6,$6,security_version,'admin',$7,$7 FROM usuarios
       WHERE id=$1 AND status='ativo' AND deleted_at IS NULL AND mfa_habilitado
         AND papel_plataforma='administrador' AND NOT activation_required RETURNING *`,
      [input.userId, input.tokenHash, input.ip, input.userAgent, input.expiresAt, input.createdAt,input.mfaVerifiedAt],
    )).rows[0]);});
  }
  findSessionByTokenHash(tokenHash, { now }) {
    return withPlatformTransaction(this.pool, {}, async ({ client }) => {
      const result = await client.query(
        `SELECT s.*, u.id user_id_value, u.email, u.nome, u.password_hash, u.papel_plataforma, u.status user_status,u.mfa_habilitado
           FROM auth_sessions s JOIN usuarios u ON u.id = s.usuario_id
          WHERE s.token_hash = $1 AND s.audience = 'admin' AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.deleted_at IS NULL
            AND s.security_version=u.security_version AND u.mfa_habilitado AND s.mfa_verified_at IS NOT NULL
            AND u.papel_plataforma='administrador' AND u.status='ativo' AND NOT u.activation_required`,
        [tokenHash, now],
      );
      const row = result.rows[0];
      if (!row) return null;
      const memberships = (await client.query("SELECT m.*,e.status company_status FROM usuarios_empresas m JOIN empresas e ON e.id=m.empresa_id WHERE m.usuario_id=$1 AND e.deleted_at IS NULL", [row.usuario_id])).rows.map(mapMembership);
      return {
        session: mapSession(row),
        user: mapUser({ ...row, id: row.user_id_value, status: row.user_status }),
        memberships,
      };
    });
  }
  revokeSession(id, { userId, revokedAt }) {
    return withPlatformTransaction(this.pool, { usuarioId: userId }, ({ client }) => client.query(
      "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $3) WHERE id = $1 AND usuario_id = $2",
      [id, userId, revokedAt],
    ));
  }
  revokeByTokenHash(tokenHash, { revokedAt }) {
    return withPlatformTransaction(this.pool, {}, ({ client }) => client.query(
      "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE token_hash = $1", [tokenHash, revokedAt],
    ));
  }
  touchSession(id, { seenAt }) {
    return withPlatformTransaction(this.pool, {}, ({ client }) => client.query(
      "UPDATE auth_sessions SET last_seen_at = $2 WHERE id = $1 AND revoked_at IS NULL", [id, seenAt],
    ));
  }
  changePassword({ userId, expectedPasswordHash, passwordHash, keepSessionId, changedAt }) {
    return withPlatformTransaction(this.pool, { usuarioId: userId }, async ({ client }) => {
      const user=(await client.query(`SELECT * FROM usuarios WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,[userId])).rows[0];
      if (!user || user.status!=='ativo' || user.papel_plataforma!=='administrador' || !user.mfa_habilitado
        || !expectedPasswordHash || user.password_hash!==expectedPasswordHash) return false;
      const session=(await client.query(`SELECT id FROM auth_sessions WHERE id=$1 AND usuario_id=$2
        AND audience='admin' AND revoked_at IS NULL AND expires_at>$3 AND mfa_verified_at IS NOT NULL
        AND security_version=$4 FOR UPDATE`,[keepSessionId,userId,changedAt,user.security_version])).rows[0];
      if (!session) return false;
      await client.query('UPDATE usuarios SET password_hash=$2 WHERE id=$1',[userId,passwordHash]);
      await invalidateIdentitySecurity(client,{userId,now:changedAt,keepSessionId});
      await client.query("INSERT INTO account_audit(usuario_id,action) VALUES($1,'auth.password_changed')",[userId]);
      return true;
    });
  }
}

export class MemoryAuthRepository {
  constructor({ users = [], memberships = [], environment = process.env.NODE_ENV || "development" } = {}) {
    if (!['development', 'test'].includes(environment)) throw new Error("Auth em memória permitido somente em desenvolvimento/teste.");
    this.users = new Map(users.map((item) => [item.email.toLowerCase(), clone(item)]));
    this.memberships = memberships.map(clone);
    this.sessions = new Map();
    this.audit = [];
  }
  async findUserByEmail(email) { return clone(this.users.get(email.toLowerCase()) || null); }
  async findUserById(userId) { return clone([...this.users.values()].find((item) => item.id === userId) || null); }
  async listMemberships(userId) { return clone(this.memberships.filter((item) => item.userId === userId)); }
  async createSession(input) {
    const user=[...this.users.values()].find(item=>item.id===input.userId);
    if(!user || user.status!=='active' || !['platform_admin','administrador'].includes(user.platformRole) || !user.mfaEnabled
      || !input.mfaVerifiedAt || !input.expectedPasswordHash || input.expectedPasswordHash!==user.passwordHash) return null;
    const session = { id: randomUUID(), ...clone(input), audience:'admin',securityVersion:user.securityVersion||0,lastSeenAt: input.createdAt, revokedAt: null };
    this.sessions.set(session.id, session);
    return clone(session);
  }
  async findSessionByTokenHash(hash, { now }) {
    const session = [...this.sessions.values()].find((item) => Buffer.from(item.tokenHash).equals(Buffer.from(hash)));
    if (!session || session.revokedAt || new Date(session.expiresAt) <= new Date(now) || session.audience!=='admin' || !session.mfaVerifiedAt) return null;
    const user = [...this.users.values()].find((item) => item.id === session.userId);
    if(!user || user.status!=='active' || !['platform_admin','administrador'].includes(user.platformRole)
      || !user.mfaEnabled || session.securityVersion!==(user.securityVersion||0)) return null;
    return { session: clone(session), user: clone(user), memberships: await this.listMemberships(user.id) };
  }
  async revokeSession(id, { userId, revokedAt }) { const item = this.sessions.get(id); if (item?.userId === userId) item.revokedAt = revokedAt; }
  async revokeByTokenHash(hash, { revokedAt }) { for (const item of this.sessions.values()) if (Buffer.from(item.tokenHash).equals(Buffer.from(hash))) item.revokedAt = revokedAt; }
  async touchSession(id, { seenAt }) { const item = this.sessions.get(id); if (item) item.lastSeenAt = seenAt; }
  async changePassword({ userId, expectedPasswordHash, passwordHash, keepSessionId, changedAt }) {
    const user = [...this.users.values()].find((item) => item.id === userId);
    const current=this.sessions.get(keepSessionId);
    if (!user || user.status!=='active' || !['platform_admin','administrador'].includes(user.platformRole) || !user.mfaEnabled
      || user.passwordHash!==expectedPasswordHash || !current || current.userId!==userId || current.revokedAt
      || current.audience!=='admin' || !current.mfaVerifiedAt || new Date(current.expiresAt)<=changedAt
      || current.securityVersion!==(user.securityVersion||0)) return false;
    user.passwordHash = passwordHash;
    user.securityVersion=(user.securityVersion||0)+1;
    current.securityVersion=user.securityVersion;
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.id !== keepSessionId && !session.revokedAt) session.revokedAt = changedAt;
    }
    this.audit.push({action:'auth.password_changed',actorUserId:userId});
    return true;
  }
}
