const MASTER_KEY_BYTES = 32;

export class KeyringConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "KeyringConfigurationError";
    this.code = "KEYRING_CONFIGURATION_ERROR";
  }
}

function normalizeVersion(value) {
  const version = String(value || "").trim();
  if (!version || version.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(version)) {
    throw new KeyringConfigurationError("Versão de chave mestra inválida.");
  }
  return version;
}

function normalizeMasterKey(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new KeyringConfigurationError("A chave mestra deve ser fornecida como bytes.");
  }
  const key = Buffer.from(value);
  if (key.length !== MASTER_KEY_BYTES) {
    key.fill(0);
    throw new KeyringConfigurationError(`A chave mestra deve possuir ${MASTER_KEY_BYTES} bytes.`);
  }
  return key;
}

function decodeBase64MasterKey(value) {
  const encoded = String(value || "").trim();
  if (!encoded) throw new KeyringConfigurationError("Chave mestra codificada ausente.");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== MASTER_KEY_BYTES || key.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")) {
    key.fill(0);
    throw new KeyringConfigurationError("Chave mestra Base64 inválida.");
  }
  return key;
}

/**
 * Keyring imutável em memória. A origem externa (variável segura, Docker secret
 * ou secret manager) é responsabilidade do bootstrap, evitando acoplamento com
 * process.env e permitindo testes sem credenciais reais.
 */
export class VersionedKeyring {
  #keys;

  constructor({ activeVersion, keys }) {
    this.activeVersion = normalizeVersion(activeVersion);
    const entries = keys instanceof Map ? [...keys.entries()] : Object.entries(keys || {});
    if (!entries.length) throw new KeyringConfigurationError("Nenhuma chave mestra foi configurada.");

    this.#keys = new Map(entries.map(([version, key]) => [normalizeVersion(version), normalizeMasterKey(key)]));
    if (!this.#keys.has(this.activeVersion)) {
      this.destroy();
      throw new KeyringConfigurationError("A versão ativa não existe no keyring.");
    }
  }

  static fromBase64({ activeVersion, keys }) {
    const decoded = new Map();
    try {
      for (const [version, value] of Object.entries(keys || {})) {
        decoded.set(version, decodeBase64MasterKey(value));
      }
      return new VersionedKeyring({ activeVersion, keys: decoded });
    } finally {
      for (const key of decoded.values()) key.fill(0);
    }
  }

  has(version) {
    return this.#keys.has(String(version || "").trim());
  }

  getKey(version = this.activeVersion) {
    const normalizedVersion = normalizeVersion(version);
    const key = this.#keys.get(normalizedVersion);
    if (!key) throw new KeyringConfigurationError("Versão de chave mestra indisponível.");
    return Buffer.from(key);
  }

  versions() {
    return [...this.#keys.keys()];
  }

  destroy() {
    for (const key of this.#keys?.values() || []) key.fill(0);
    this.#keys?.clear();
  }
}

export { MASTER_KEY_BYTES };
