import { randomUUID } from "node:crypto";
import {
  decryptCredentialSecret,
  decryptCredentialSecretBuffer,
  encryptCredentialSecret,
  maskSecret,
} from "../../security/credential-crypto.js";
import { redactSensitive } from "../../security/redaction.js";

export class CredentialVaultError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CredentialVaultError";
    this.code = code;
  }
}

function requiredText(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new CredentialVaultError(`${field} inválido.`, "CREDENTIAL_INPUT_ERROR");
  }
  return normalized;
}

function bindingFor(record) {
  return {
    empresaId: record.empresaId,
    credentialId: record.id,
    provider: record.provider,
    purpose: record.purpose,
  };
}

function credentialView(record) {
  return Object.freeze({
    id: record.id,
    empresaId: record.empresaId,
    provider: record.provider,
    purpose: record.purpose,
    status: record.status,
    configured: record.status === "active" && Boolean(record.encryptedSecret),
    maskedSecret: record.maskedSecret,
    keyVersion: record.keyVersion,
    secretVersion: record.secretVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    rotatedAt: record.rotatedAt,
    revokedAt: record.revokedAt,
  });
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function assertRepository(repository) {
  if (!repository || typeof repository.findById !== "function" || typeof repository.save !== "function" || typeof repository.withAuditedMutation !== "function") {
    throw new CredentialVaultError("Repositório de credenciais inválido.", "CREDENTIAL_REPOSITORY_ERROR");
  }
}

function normalizeAuditWriter(auditWriter) {
  const write = typeof auditWriter === "function"
    ? auditWriter
    : auditWriter?.write?.bind(auditWriter) || auditWriter?.record?.bind(auditWriter);
  if (!write) throw new CredentialVaultError("Auditoria de credenciais obrigatória.", "CREDENTIAL_AUDIT_ERROR");
  return write;
}

export class CredentialVaultService {
  constructor({ repository, keyring, auditWriter, clock = () => new Date(), idGenerator = randomUUID }) {
    assertRepository(repository);
    if (!keyring?.getKey || !keyring?.activeVersion) {
      throw new CredentialVaultError("Keyring de credenciais inválido.", "CREDENTIAL_KEYRING_ERROR");
    }
    this.repository = repository;
    this.keyring = keyring;
    this.writeAudit = normalizeAuditWriter(auditWriter);
    this.clock = clock;
    this.idGenerator = idGenerator;
  }

  async #find(empresaId, credentialId, transaction = null) {
    const record = await this.repository.findById({
      empresaId: requiredText(empresaId, "empresaId"),
      credentialId: requiredText(credentialId, "credentialId"),
      transaction,
    });
    if (!record) throw new CredentialVaultError("Credencial não encontrada.", "CREDENTIAL_NOT_FOUND");
    return record;
  }

  async #audit(action, record, { actorId, correlationId, details = {}, transaction = null } = {}) {
    const event = redactSensitive({
      action,
      empresaId: record.empresaId,
      credentialId: record.id,
      provider: record.provider,
      purpose: record.purpose,
      actorId: actorId || "system",
      correlationId: correlationId || null,
      occurredAt: this.clock().toISOString(),
      details,
    });
    await this.writeAudit(event, { transaction });
  }

  async createCredential({ empresaId, credentialId = this.idGenerator(), provider, purpose, secret, actorId, correlationId }) {
    const identity = {
      empresaId: requiredText(empresaId, "empresaId"),
      id: requiredText(credentialId, "credentialId"),
      provider: requiredText(provider, "provider"),
      purpose: requiredText(purpose, "purpose"),
    };
    return this.repository.withAuditedMutation({ empresaId: identity.empresaId, actorId }, async (transaction) => {
      const existing = await this.repository.findById({ empresaId: identity.empresaId, credentialId: identity.id, transaction });
      if (existing) throw new CredentialVaultError("Credencial já cadastrada.", "CREDENTIAL_ALREADY_EXISTS");

      const encryptedSecret = encryptCredentialSecret({ secret, keyring: this.keyring, binding: bindingFor(identity) });
      const timestamp = this.clock().toISOString();
      const record = {
        ...identity,
        status: "active",
        encryptedSecret,
        maskedSecret: maskSecret(secret),
        keyVersion: encryptedSecret.keyVersion,
        secretVersion: 1,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        rotatedAt: null,
        revokedAt: null,
      };
      const saved = await this.repository.save(record, { expectedRevision: 0, transaction });
      await this.#audit("credential.created", saved || record, {
        actorId,
        correlationId,
        transaction,
        details: { keyVersion: record.keyVersion, credentialVersion: record.secretVersion },
      });
      return credentialView(saved || record);
    });
  }

  async getCredentialMetadata({ empresaId, credentialId }) {
    return credentialView(await this.#find(empresaId, credentialId));
  }

  async getCredentialForUse({ empresaId, credentialId }) {
    const record = await this.#find(empresaId, credentialId);
    if (record.status !== "active" || !record.encryptedSecret) {
      throw new CredentialVaultError("Credencial revogada ou indisponível.", "CREDENTIAL_REVOKED");
    }
    return decryptCredentialSecret({
      envelope: record.encryptedSecret,
      keyring: this.keyring,
      binding: bindingFor(record),
    });
  }

  async rotateCredential({ empresaId, credentialId, newSecret, actorId, correlationId }) {
    return this.repository.withAuditedMutation({ empresaId, actorId }, async (transaction) => {
      const current = await this.#find(empresaId, credentialId, transaction);
      if (current.status !== "active" || !current.encryptedSecret) {
        throw new CredentialVaultError("Credencial revogada não pode ser rotacionada.", "CREDENTIAL_REVOKED");
      }
      const encryptedSecret = encryptCredentialSecret({
        secret: newSecret,
        keyring: this.keyring,
        binding: bindingFor(current),
      });
      const timestamp = this.clock().toISOString();
      const updated = {
        ...current,
        encryptedSecret,
        maskedSecret: maskSecret(newSecret),
        keyVersion: encryptedSecret.keyVersion,
        secretVersion: Number(current.secretVersion || 1) + 1,
        revision: Number(current.revision || 1) + 1,
        updatedAt: timestamp,
        rotatedAt: timestamp,
      };
      const saved = await this.repository.save(updated, { expectedRevision: current.revision, transaction });
      await this.#audit("credential.rotated", saved || updated, {
        actorId,
        correlationId,
        transaction,
        details: {
          previousKeyVersion: current.keyVersion,
          keyVersion: updated.keyVersion,
          previousCredentialVersion: current.secretVersion,
          credentialVersion: updated.secretVersion,
        },
      });
      return credentialView(saved || updated);
    });
  }

  async reencryptCredential({ empresaId, credentialId, targetKeyVersion = this.keyring.activeVersion, actorId, correlationId }) {
    return this.repository.withAuditedMutation({ empresaId, actorId }, async (transaction) => {
      const current = await this.#find(empresaId, credentialId, transaction);
      if (current.status !== "active" || !current.encryptedSecret) {
        throw new CredentialVaultError("Credencial revogada não pode ser recriptografada.", "CREDENTIAL_REVOKED");
      }
      const plaintext = decryptCredentialSecretBuffer({
        envelope: current.encryptedSecret,
        keyring: this.keyring,
        binding: bindingFor(current),
      });
      let encryptedSecret;
      try {
        encryptedSecret = encryptCredentialSecret({
          secret: plaintext,
          keyring: this.keyring,
          binding: bindingFor(current),
          keyVersion: targetKeyVersion,
        });
      } finally {
        plaintext.fill(0);
      }
      const timestamp = this.clock().toISOString();
      const updated = {
        ...current,
        encryptedSecret,
        keyVersion: encryptedSecret.keyVersion,
        revision: Number(current.revision || 1) + 1,
        updatedAt: timestamp,
        rotatedAt: timestamp,
      };
      const saved = await this.repository.save(updated, { expectedRevision: current.revision, transaction });
      await this.#audit("credential.reencrypted", saved || updated, {
        actorId,
        correlationId,
        transaction,
        details: { previousKeyVersion: current.keyVersion, keyVersion: updated.keyVersion },
      });
      return credentialView(saved || updated);
    });
  }

  async revokeCredential({ empresaId, credentialId, actorId, correlationId }) {
    return this.repository.withAuditedMutation({ empresaId, actorId }, async (transaction) => {
      const current = await this.#find(empresaId, credentialId, transaction);
      if (current.status === "revoked") return credentialView(current);
      const timestamp = this.clock().toISOString();
      const revoked = {
        ...current,
        status: "revoked",
        encryptedSecret: null,
        revision: Number(current.revision || 1) + 1,
        updatedAt: timestamp,
        revokedAt: timestamp,
      };
      const saved = await this.repository.save(revoked, { expectedRevision: current.revision, transaction });
      await this.#audit("credential.revoked", saved || revoked, {
        actorId,
        correlationId,
        transaction,
        details: { keyVersion: current.keyVersion, credentialVersion: current.secretVersion },
      });
      return credentialView(saved || revoked);
    });
  }
}

/** Adaptador não durável, restrito a desenvolvimento e testes. */
export class InMemoryCredentialRepository {
  #records = new Map();

  #key(empresaId, credentialId) {
    return `${empresaId}\u0000${credentialId}`;
  }

  async withAuditedMutation(_context, callback) {
    if (typeof callback !== "function") throw new TypeError("Callback transacional de credencial é obrigatório.");
    const snapshot = clone(this.#records);
    try {
      return await callback(Object.freeze({ kind: "memory-credential-transaction" }));
    } catch (error) {
      this.#records = snapshot;
      throw error;
    }
  }

  async findById({ empresaId, credentialId }) {
    return clone(this.#records.get(this.#key(empresaId, credentialId)) || null);
  }

  async save(record, { expectedRevision, transaction: _transaction } = {}) {
    const key = this.#key(record.empresaId, record.id);
    const current = this.#records.get(key);
    const currentRevision = current?.revision || 0;
    if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
      throw new CredentialVaultError("Credencial foi alterada concorrentemente.", "CREDENTIAL_CONFLICT");
    }
    this.#records.set(key, clone(record));
    return clone(record);
  }
}

export { PostgresCredentialRepository } from "./postgres-credential-repository.js";
