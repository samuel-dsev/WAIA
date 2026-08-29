import { withTenantTransaction } from "../../infra/postgres/transaction.js";

const STATUS_FROM_DB = Object.freeze({ ativa: "active", revogada: "revoked" });
const STATUS_TO_DB = Object.freeze({ active: "ativa", revoked: "revogada" });

function envelope(row) {
  if (!row?.secret_ciphertext) return null;
  return Object.freeze({
    version: 1,
    algorithm: "aes-256-gcm",
    kdf: "hkdf-sha256",
    keyVersion: row.key_version,
    kdfSalt: Buffer.from(row.secret_kdf_salt).toString("base64url"),
    iv: Buffer.from(row.secret_nonce).toString("base64url"),
    authTag: Buffer.from(row.secret_tag).toString("base64url"),
    ciphertext: Buffer.from(row.secret_ciphertext).toString("base64url"),
  });
}

function record(row) {
  if (!row) return null;
  return {
    id: row.id,
    empresaId: row.empresa_id,
    provider: row.provedor,
    purpose: row.finalidade,
    status: STATUS_FROM_DB[row.status] || row.status,
    encryptedSecret: envelope(row),
    maskedSecret: row.valor_mascarado,
    keyVersion: row.key_version,
    secretVersion: Number(row.secret_version),
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
  };
}

function decodePart(value, field) {
  const normalized = String(value || "");
  const buffer = Buffer.from(normalized, "base64url");
  if (!buffer.length || buffer.toString("base64url") !== normalized) {
    throw new TypeError(`${field} criptografado invalido.`);
  }
  return buffer;
}

export class PostgresCredentialRepository {
  constructor(pool) {
    if (!pool?.connect) throw new TypeError("Pool PostgreSQL invalido.");
    this.pool = pool;
  }

  withAuditedMutation({ empresaId, actorId } = {}, callback) {
    if (typeof callback !== "function") throw new TypeError("Callback transacional de credencial é obrigatório.");
    return withTenantTransaction(this.pool, { empresaId, usuarioId: actorId || undefined }, callback);
  }

  findById({ empresaId, credentialId, transaction }) {
    if (transaction) return this.#findById(transaction, { empresaId, credentialId });
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => record((await client.query(
      "SELECT * FROM credenciais_empresa WHERE empresa_id = $1 AND id = $2",
      [empresaId, credentialId],
    )).rows[0]));
  }

  async #findById({ client }, { empresaId, credentialId }) {
    return record((await client.query(
      "SELECT * FROM credenciais_empresa WHERE empresa_id = $1 AND id = $2",
      [empresaId, credentialId],
    )).rows[0]);
  }

  save(input, { expectedRevision = 0, transaction } = {}) {
    const persist = async ({ client }) => {
      if (expectedRevision === 0) {
        const encrypted = input.encryptedSecret;
        const row = (await client.query(
          `INSERT INTO credenciais_empresa (
             id, empresa_id, provedor, finalidade, secret_ciphertext, secret_kdf_salt,
             secret_nonce, secret_tag, key_version, valor_mascarado, secret_version,
             revision, status, rotated_at, revoked_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING *`,
          [input.id, input.empresaId, input.provider, input.purpose,
            decodePart(encrypted.ciphertext, "ciphertext"), decodePart(encrypted.kdfSalt, "kdfSalt"),
            decodePart(encrypted.iv, "nonce"), decodePart(encrypted.authTag, "tag"), String(input.keyVersion),
            input.maskedSecret, input.secretVersion, input.revision, STATUS_TO_DB[input.status],
            input.rotatedAt, input.revokedAt],
        )).rows[0];
        return record(row);
      }

      const encrypted = input.encryptedSecret;
      const row = (await client.query(
        `UPDATE credenciais_empresa SET
           secret_ciphertext = $4, secret_kdf_salt = $5, secret_nonce = $6, secret_tag = $7,
           key_version = $8, valor_mascarado = $9, secret_version = $10,
           revision = $11, status = $12, rotated_at = $13, revoked_at = $14
         WHERE empresa_id = $1 AND id = $2 AND revision = $3
         RETURNING *`,
        [input.empresaId, input.id, expectedRevision,
          encrypted ? decodePart(encrypted.ciphertext, "ciphertext") : null,
          encrypted ? decodePart(encrypted.kdfSalt, "kdfSalt") : null,
          encrypted ? decodePart(encrypted.iv, "nonce") : null,
          encrypted ? decodePart(encrypted.authTag, "tag") : null,
          String(input.keyVersion), input.maskedSecret, input.secretVersion, input.revision,
          STATUS_TO_DB[input.status], input.rotatedAt, input.revokedAt],
      )).rows[0];
      if (!row) {
        const error = new Error("Credencial foi alterada concorrentemente.");
        error.code = "CREDENTIAL_CONFLICT";
        throw error;
      }
      return record(row);
    };
    if (transaction) return persist(transaction);
    return withTenantTransaction(this.pool, { empresaId: input.empresaId }, persist);
  }
}
