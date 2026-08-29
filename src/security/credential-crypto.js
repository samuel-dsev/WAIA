import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { KeyringConfigurationError } from "./versioned-keyring.js";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KDF_SALT_BYTES = 16;
const MAX_SECRET_BYTES = 64 * 1024;

export class SecretCryptoError extends Error {
  constructor(message, code = "SECRET_CRYPTO_ERROR") {
    super(message);
    this.name = "SecretCryptoError";
    this.code = code;
  }
}

export class SecretIntegrityError extends SecretCryptoError {
  constructor() {
    super("Não foi possível validar a credencial criptografada.", "SECRET_INTEGRITY_ERROR");
    this.name = "SecretIntegrityError";
  }
}

function bindingPart(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new SecretCryptoError("Vínculo criptográfico inválido.", "SECRET_BINDING_ERROR");
  }
  return normalized;
}

function normalizeBinding(binding) {
  return Object.freeze({
    empresaId: bindingPart(binding?.empresaId),
    credentialId: bindingPart(binding?.credentialId),
    provider: bindingPart(binding?.provider),
    purpose: bindingPart(binding?.purpose),
  });
}

function authenticatedData(binding) {
  const normalized = normalizeBinding(binding);
  return Buffer.from(JSON.stringify([
    "waia-credential-v1",
    normalized.empresaId,
    normalized.credentialId,
    normalized.provider,
    normalized.purpose,
  ]), "utf8");
}

function decodeEnvelopePart(value, expectedBytes) {
  if (typeof value !== "string" || !value) throw new SecretIntegrityError();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedBytes || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw new SecretIntegrityError();
  }
  return decoded;
}

function normalizePlaintext(secret) {
  if (typeof secret === "string") {
    const bytes = Buffer.from(secret, "utf8");
    if (!bytes.length || bytes.length > MAX_SECRET_BYTES) {
      bytes.fill(0);
      throw new SecretCryptoError("Credencial vazia ou acima do limite permitido.", "SECRET_VALUE_ERROR");
    }
    return bytes;
  }
  if (Buffer.isBuffer(secret) || secret instanceof Uint8Array) {
    const bytes = Buffer.from(secret);
    if (!bytes.length || bytes.length > MAX_SECRET_BYTES) {
      bytes.fill(0);
      throw new SecretCryptoError("Credencial vazia ou acima do limite permitido.", "SECRET_VALUE_ERROR");
    }
    return bytes;
  }
  throw new SecretCryptoError("Credencial inválida.", "SECRET_VALUE_ERROR");
}

function deriveDataKey(masterKey, salt, purpose) {
  const info = Buffer.from(`waia:credential:${bindingPart(purpose)}:v1`, "utf8");
  return Buffer.from(hkdfSync("sha256", masterKey, salt, info, 32));
}

export function encryptCredentialSecret({ secret, keyring, binding, keyVersion = keyring?.activeVersion }) {
  if (!keyring?.getKey) throw new KeyringConfigurationError("Keyring não configurado.");
  const normalizedBinding = normalizeBinding(binding);
  const plaintext = normalizePlaintext(secret);
  const masterKey = keyring.getKey(keyVersion);
  const salt = randomBytes(KDF_SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const dataKey = deriveDataKey(masterKey, salt, normalizedBinding.purpose);

  try {
    const cipher = createCipheriv(ALGORITHM, dataKey, iv, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(authenticatedData(normalizedBinding));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    try {
      return Object.freeze({
        version: ENVELOPE_VERSION,
        algorithm: ALGORITHM,
        kdf: "hkdf-sha256",
        keyVersion: String(keyVersion),
        kdfSalt: salt.toString("base64url"),
        iv: iv.toString("base64url"),
        authTag: authTag.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      });
    } finally {
      ciphertext.fill(0);
      authTag.fill(0);
    }
  } finally {
    plaintext.fill(0);
    masterKey.fill(0);
    dataKey.fill(0);
    salt.fill(0);
    iv.fill(0);
  }
}

export function decryptCredentialSecretBuffer({ envelope, keyring, binding }) {
  if (!keyring?.getKey) throw new KeyringConfigurationError("Keyring não configurado.");
  if (
    envelope?.version !== ENVELOPE_VERSION
    || envelope?.algorithm !== ALGORITHM
    || envelope?.kdf !== "hkdf-sha256"
    || typeof envelope?.keyVersion !== "string"
  ) {
    throw new SecretIntegrityError();
  }

  const normalizedBinding = normalizeBinding(binding);
  const masterKey = keyring.getKey(envelope.keyVersion);
  let salt;
  let iv;
  let authTag;
  let ciphertext;
  let dataKey;
  try {
    salt = decodeEnvelopePart(envelope.kdfSalt, KDF_SALT_BYTES);
    iv = decodeEnvelopePart(envelope.iv, IV_BYTES);
    authTag = decodeEnvelopePart(envelope.authTag, AUTH_TAG_BYTES);
    ciphertext = decodeEnvelopePart(envelope.ciphertext, Buffer.from(envelope.ciphertext, "base64url").length);
    if (!ciphertext.length || ciphertext.length > MAX_SECRET_BYTES + AUTH_TAG_BYTES) throw new SecretIntegrityError();
    dataKey = deriveDataKey(masterKey, salt, normalizedBinding.purpose);
    const decipher = createDecipheriv(ALGORITHM, dataKey, iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(authenticatedData(normalizedBinding));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    if (error instanceof KeyringConfigurationError || error instanceof SecretCryptoError) throw error;
    throw new SecretIntegrityError();
  } finally {
    masterKey.fill(0);
    salt?.fill(0);
    iv?.fill(0);
    authTag?.fill(0);
    ciphertext?.fill(0);
    dataKey?.fill(0);
  }
}

export function decryptCredentialSecret(input) {
  const plaintext = decryptCredentialSecretBuffer(input);
  try {
    return plaintext.toString("utf8");
  } finally {
    plaintext.fill(0);
  }
}

export function maskSecret(value, { visibleSuffix = 4 } = {}) {
  const secret = String(value ?? "");
  const suffixLength = Number.isInteger(visibleSuffix) && visibleSuffix >= 0 && visibleSuffix <= 8
    ? visibleSuffix
    : 4;
  if (!secret || secret.length <= suffixLength) return "••••";
  return `••••${secret.slice(-suffixLength)}`;
}

export const CREDENTIAL_CRYPTO = Object.freeze({
  algorithm: ALGORITHM,
  envelopeVersion: ENVELOPE_VERSION,
  ivBytes: IV_BYTES,
  authTagBytes: AUTH_TAG_BYTES,
  kdf: "hkdf-sha256",
});
