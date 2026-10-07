const PUBLIC_MESSAGES = Object.freeze({
  META_APP_NOT_FOUND: "Aplicativo Meta não encontrado.",
  META_APP_INCOMPLETE: "Complete a configuração do aplicativo Meta.",
  META_APP_INACTIVE: "O aplicativo Meta está inativo.",
  META_NUMBER_NOT_FOUND: "Número do WhatsApp não encontrado.",
  META_NUMBER_INCOMPLETE: "Complete WABA, número e credencial de acesso.",
  META_NUMBER_INACTIVE: "O número do WhatsApp está inativo.",
  META_APP_NUMBER_MISMATCH: "O número não pertence ao aplicativo Meta selecionado.",
  META_CREDENTIAL_UNAVAILABLE: "Uma credencial Meta está ausente, revogada ou indisponível.",
  META_EXTERNAL_UNAVAILABLE: "Não foi possível validar a conexão com a Meta.",
  META_EXTERNAL_MISMATCH: "A Meta retornou identificadores diferentes dos configurados.",
  META_PREFLIGHT_OK: "Conexão Meta validada com sucesso.",
});

const INACTIVE_APP_STATES = new Set(["inactive", "inativo", "revoked", "revogado", "suspended", "suspenso"]);
const INACTIVE_NUMBER_STATES = new Set(["inactive", "inativo", "revoked", "revogado", "failed", "falha"]);

export class MetaHealthCheckError extends Error {
  constructor(message, code = "META_HEALTH_ERROR") {
    super(message);
    this.name = "MetaHealthCheckError";
    this.code = code;
  }
}

function requireMethod(target, method, name) {
  if (typeof target?.[method] !== "function") {
    throw new MetaHealthCheckError(`${name}.${method} é obrigatório.`, "META_HEALTH_DEPENDENCY_ERROR");
  }
}

function requiredText(value, field, max = 300) {
  const text = String(value || "").trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new MetaHealthCheckError(`${field} inválido.`, "META_HEALTH_INPUT_ERROR");
  }
  return text;
}

function optionalText(value, max = 300) {
  const text = String(value || "").trim();
  return text && text.length <= max && !/[\u0000-\u001f\u007f]/u.test(text) ? text : null;
}

function safeProviderCode(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{1,63}$/u.test(code) ? code : null;
}

function sanitizedFailure(code, error) {
  const status = Number(error?.status);
  return Object.freeze({
    code,
    message: PUBLIC_MESSAGES[code],
    ...(safeProviderCode(error) ? { providerCode: safeProviderCode(error) } : {}),
    ...(Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}),
  });
}

function publicResult({ success, code, testedAt, applicationId, numberId, error }) {
  return Object.freeze({
    state: success ? "healthy" : code.endsWith("NOT_FOUND") || code.endsWith("INCOMPLETE")
      ? "not_configured"
      : "unavailable",
    success,
    code,
    message: PUBLIC_MESSAGES[code],
    testedAt,
    applicationId,
    numberId,
    ...(error?.providerCode ? { providerCode: error.providerCode } : {}),
  });
}

function localFailure(code) {
  const error = new MetaHealthCheckError(PUBLIC_MESSAGES[code], code);
  error.isExpectedMetaHealthFailure = true;
  throw error;
}

function assertLocalConfiguration(app, number) {
  const mode = String(app.mode || "").trim().toLowerCase();
  const shared = mode === "shared" || mode === "compartilhado";
  const ycloud = mode === "ycloud";
  if (!optionalText(app.id) || !optionalText(app.empresaId) || !optionalText(app.state) || !mode
      || !optionalText(app.appId) || !optionalText(app.webhookPublicId)
      || (!shared && (!optionalText(app.appSecretCredentialId) || (!ycloud && !optionalText(app.verifyTokenCredentialId))))) {
    localFailure("META_APP_INCOMPLETE");
  }
  if (INACTIVE_APP_STATES.has(String(app.state || "").trim().toLowerCase())) {
    localFailure("META_APP_INACTIVE");
  }
  if (!optionalText(number.id) || !optionalText(number.empresaId) || !optionalText(number.status)
      || !optionalText(number.phoneNumberId) || !optionalText(number.wabaId)
      || !optionalText(number.accessTokenCredentialId)) {
    localFailure("META_NUMBER_INCOMPLETE");
  }
  if (INACTIVE_NUMBER_STATES.has(String(number.status || "").trim().toLowerCase())) {
    localFailure("META_NUMBER_INACTIVE");
  }
  if (String(number.metaAppId) !== String(app.id)) {
    localFailure("META_APP_NUMBER_MISMATCH");
  }
}

function assertCredentialMetadata(metadata) {
  if (!metadata || metadata.status !== "active" || metadata.configured !== true) {
    localFailure("META_CREDENTIAL_UNAVAILABLE");
  }
}

function assertExternalIdentity(external, app, number) {
  if (!external || external.tokenValid === false
      || String(external.appId || "") !== String(app.appId)
      || String(external.wabaId || "") !== String(number.wabaId)
      || String(external.phoneNumberId || "") !== String(number.phoneNumberId)) {
    localFailure("META_EXTERNAL_MISMATCH");
  }
}

/**
 * Runs an auditable Meta preflight without exposing credential material.
 *
 * Repository contract:
 * - findAppById({ empresaId, appId })
 * - findNumberBinding({ empresaId, numberId })
 * - recordHealthCheck({ empresaId, appId, expectedRevision, testedAt,
 *   success, errorSanitized })
 *
 * External client contract:
 * - checkConnection({ appId, wabaId, phoneNumberId, accessToken })
 *   returning { appId, wabaId, phoneNumberId, tokenValid? }.
 */
export class MetaHealthService {
  constructor({ repository, credentialVault, client, ycloudClient, clock = () => new Date() } = {}) {
    requireMethod(repository, "findAppById", "repository");
    requireMethod(repository, "findNumberBinding", "repository");
    requireMethod(repository, "recordHealthCheck", "repository");
    requireMethod(credentialVault, "getCredentialMetadata", "credentialVault");
    requireMethod(credentialVault, "getCredentialForUse", "credentialVault");
    requireMethod(client, "checkConnection", "client");
    if (typeof clock !== "function") throw new MetaHealthCheckError("clock inválido.", "META_HEALTH_DEPENDENCY_ERROR");
    this.repository = repository;
    this.credentialVault = credentialVault;
    this.client = client;
    this.ycloudClient = ycloudClient;
    this.clock = clock;
  }

  async run({ empresaId, appId, numberId, actorId = null, correlationId = null, signal = null } = {}) {
    const tenantId = requiredText(empresaId, "empresaId");
    const applicationId = requiredText(appId, "appId");
    const whatsappNumberId = requiredText(numberId, "numberId");
    const testedAt = this.clock().toISOString();

    const app = await this.repository.findAppById({ empresaId: tenantId, appId: applicationId });
    if (!app) {
      return publicResult({
        success: false,
        code: "META_APP_NOT_FOUND",
        testedAt,
        applicationId,
        numberId: whatsappNumberId,
      });
    }

    let code = "META_PREFLIGHT_OK";
    let failure = null;
    try {
      const number = await this.repository.findNumberBinding({ empresaId: tenantId, numberId: whatsappNumberId });
      if (!number) localFailure("META_NUMBER_NOT_FOUND");
      if (String(app.id) !== applicationId || String(app.empresaId) !== tenantId
          || String(number.id) !== whatsappNumberId || String(number.empresaId) !== tenantId) {
        localFailure("META_APP_NUMBER_MISMATCH");
      }
      assertLocalConfiguration(app, number);

      const sharedApplication = new Set(["shared", "compartilhado"]).has(String(app.mode).trim().toLowerCase());
      if (!sharedApplication) {
        const [appSecret, verifyToken] = await Promise.all([
          this.credentialVault.getCredentialMetadata({ empresaId: tenantId, credentialId: app.appSecretCredentialId }),
          app.mode === "ycloud" ? null : this.credentialVault.getCredentialMetadata({ empresaId: tenantId, credentialId: app.verifyTokenCredentialId }),
        ]);
        assertCredentialMetadata(appSecret);
        if (app.mode !== "ycloud") assertCredentialMetadata(verifyToken);
      }

      let accessToken;
      try {
        accessToken = await this.credentialVault.getCredentialForUse({
          empresaId: tenantId,
          credentialId: number.accessTokenCredentialId,
        });
      } catch (error) {
        throw Object.assign(new MetaHealthCheckError(PUBLIC_MESSAGES.META_CREDENTIAL_UNAVAILABLE, "META_CREDENTIAL_UNAVAILABLE"), {
          isExpectedMetaHealthFailure: true,
          status: error?.status,
        });
      }
      if (!optionalText(accessToken, 16_384)) localFailure("META_CREDENTIAL_UNAVAILABLE");

      let external;
      try {
        if (signal?.aborted) localFailure("META_EXTERNAL_UNAVAILABLE");
        const client = app.mode === "ycloud" ? this.ycloudClient : this.client;
        external = await client.checkConnection({
          appId: app.appId,
          wabaId: number.wabaId,
          phoneNumberId: number.phoneNumberId,
          phoneNumber: number.numeroE164,
          accessToken,
          signal,
        });
      } catch (error) {
        code = "META_EXTERNAL_UNAVAILABLE";
        failure = sanitizedFailure(code, error);
      } finally {
        accessToken = null;
      }
      if (!failure) assertExternalIdentity(external, app, number);
    } catch (error) {
      code = error?.isExpectedMetaHealthFailure ? error.code : "META_CREDENTIAL_UNAVAILABLE";
      failure = sanitizedFailure(code, error);
    }

    const success = !failure;
    await this.repository.recordHealthCheck({
      empresaId: tenantId,
      appId: applicationId,
      expectedRevision: app.revision,
      testedAt,
      success,
      state: success ? "active" : "failed",
      actorId,
      correlationId,
      errorSanitized: failure,
    });
    return publicResult({
      success,
      code,
      testedAt,
      applicationId,
      numberId: whatsappNumberId,
      error: failure,
    });
  }
}
