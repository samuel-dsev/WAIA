import { randomUUID } from "node:crypto";
import { withPlatformTransaction } from "../../infra/postgres/transaction.js";

const clone = (value) => value == null ? value : structuredClone(value);

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id, email: row.email, name: row.nome, passwordHash: row.password_hash,
    platformRole: row.papel_plataforma, status: row.status === "ativo" ? "active" : row.status,
  };
}

function mapMembership(row) {
  return {
    empresaId: row.empresa_id,
    role: row.papel,
    status: row.status === "ativo" ? "active" : row.status,
    permissions: row.permissoes || [],
  };
}

function mapSession(row) {
  return row && {
    id: row.id, userId: row.usuario_id, createdAt: row.created_at,
    expiresAt: row.expires_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at,
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
      await client.query("SELECT * FROM usuarios_empresas WHERE usuario_id = $1", [userId])
    ).rows.map(mapMembership));
  }
  createSession(input) {
    return withPlatformTransaction(this.pool, { usuarioId: input.userId }, async ({ client }) => mapSession((await client.query(
      `INSERT INTO auth_sessions (usuario_id, token_hash, ip, user_agent, expires_at, created_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
      [input.userId, input.tokenHash, input.ip, input.userAgent, input.expiresAt, input.createdAt],
    )).rows[0]));
  }
  findSessionByTokenHash(tokenHash, { now }) {
    return withPlatformTransaction(this.pool, {}, async ({ client }) => {
      const result = await client.query(
        `SELECT s.*, u.id user_id_value, u.email, u.nome, u.password_hash, u.papel_plataforma, u.status user_status
           FROM auth_sessions s JOIN usuarios u ON u.id = s.usuario_id
          WHERE s.token_hash = $1 AND s.audience = 'admin' AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.deleted_at IS NULL`,
        [tokenHash, now],
      );
      const row = result.rows[0];
      if (!row) return null;
      const memberships = (await client.query("SELECT * FROM usuarios_empresas WHERE usuario_id = $1", [row.usuario_id])).rows.map(mapMembership);
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
  changePassword({ userId, passwordHash, keepSessionId, changedAt }) {
    return withPlatformTransaction(this.pool, { usuarioId: userId }, async ({ client }) => {
      const updated = await client.query(
        "UPDATE usuarios SET password_hash = $2, updated_at = $3 WHERE id = $1 AND deleted_at IS NULL",
        [userId, passwordHash, changedAt],
      );
      if (!updated.rowCount) return false;
      await client.query(
        `UPDATE auth_sessions
            SET revoked_at = COALESCE(revoked_at, $3)
          WHERE usuario_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [userId, keepSessionId, changedAt],
      );
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
  }
  async findUserByEmail(email) { return clone(this.users.get(email.toLowerCase()) || null); }
  async findUserById(userId) { return clone([...this.users.values()].find((item) => item.id === userId) || null); }
  async listMemberships(userId) { return clone(this.memberships.filter((item) => item.userId === userId)); }
  async createSession(input) {
    const session = { id: randomUUID(), ...clone(input), lastSeenAt: input.createdAt, revokedAt: null };
    this.sessions.set(session.id, session);
    return clone(session);
  }
  async findSessionByTokenHash(hash, { now }) {
    const session = [...this.sessions.values()].find((item) => Buffer.from(item.tokenHash).equals(Buffer.from(hash)));
    if (!session || session.revokedAt || new Date(session.expiresAt) <= new Date(now)) return null;
    const user = [...this.users.values()].find((item) => item.id === session.userId);
    return { session: clone(session), user: clone(user), memberships: await this.listMemberships(user.id) };
  }
  async revokeSession(id, { userId, revokedAt }) { const item = this.sessions.get(id); if (item?.userId === userId) item.revokedAt = revokedAt; }
  async revokeByTokenHash(hash, { revokedAt }) { for (const item of this.sessions.values()) if (Buffer.from(item.tokenHash).equals(Buffer.from(hash))) item.revokedAt = revokedAt; }
  async touchSession(id, { seenAt }) { const item = this.sessions.get(id); if (item) item.lastSeenAt = seenAt; }
  async changePassword({ userId, passwordHash, keepSessionId, changedAt }) {
    const user = [...this.users.values()].find((item) => item.id === userId);
    if (!user) return false;
    user.passwordHash = passwordHash;
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.id !== keepSessionId && !session.revokedAt) session.revokedAt = changedAt;
    }
    return true;
  }
}
