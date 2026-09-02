const SHARED_APP_SECRET_REF = "internal:shared-meta-app-secret";
const SHARED_VERIFY_TOKEN_REF = "internal:shared-meta-verify-token";

function requiredMethod(target, method, name) {
  if (typeof target?.[method] !== "function") throw new TypeError(`${name}.${method} é obrigatório.`);
}

function configuredSecret(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class MetaWebhookConnectionResolver {
  constructor({ repository } = {}) {
    requiredMethod(repository, "resolveByWebhookPublicId", "repository");
    this.repository = repository;
  }

  async resolveByWebhookPublicId(webhookPublicId) {
    const connection = await this.repository.resolveByWebhookPublicId(webhookPublicId);
    if (!connection || connection.mode !== "shared") return connection;
    return Object.freeze({
      ...connection,
      appSecretCredentialId: SHARED_APP_SECRET_REF,
      previousAppSecretCredentialId: null,
      previousAppSecretValidUntil: null,
      verifyTokenCredentialId: SHARED_VERIFY_TOKEN_REF,
    });
  }
}

export class MetaWebhookCredentialResolver {
  constructor({ credentialVault, sharedAppSecret, sharedVerifyToken } = {}) {
    if (credentialVault != null) requiredMethod(credentialVault, "getCredentialForUse", "credentialVault");
    this.credentialVault = credentialVault;
    this.sharedAppSecret = configuredSecret(sharedAppSecret);
    this.sharedVerifyToken = configuredSecret(sharedVerifyToken);
  }

  async getCredentialForUse({ credentialId, ...context } = {}) {
    if (credentialId === SHARED_APP_SECRET_REF) {
      if (!this.sharedAppSecret) throw new Error("Credencial Meta compartilhada indisponível.");
      return this.sharedAppSecret;
    }
    if (credentialId === SHARED_VERIFY_TOKEN_REF) {
      if (!this.sharedVerifyToken) throw new Error("Credencial Meta compartilhada indisponível.");
      return this.sharedVerifyToken;
    }
    if (!this.credentialVault) throw new Error("Cofre de credenciais indisponível.");
    return this.credentialVault.getCredentialForUse({ credentialId, ...context });
  }
}

export { SHARED_APP_SECRET_REF, SHARED_VERIFY_TOKEN_REF };
