import { randomUUID } from "node:crypto";
import {
  AdminConflictError,
  AdminForbiddenError,
  AdminNotFoundError,
  AdminValidationError,
} from "./errors.js";
import {
  normalizedAdminAuth,
  requirePlatformAdmin,
  requireTenantAccess,
} from "./authorization.js";
import { ADMIN_RESOURCES, adminResource } from "./resources.js";
import { isSensitiveKey, redactSensitive } from "../../security/redaction.js";
import { normalizePixKey } from "../secrets/payment-secret.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const SENSITIVE_FIELD = /secret|token|password|senha|credential|cipher|nonce|tag|authorization/iu;
const OPERATOR_ASSIGNABLE_PERMISSIONS = new Set([
  "contacts.read", "contacts.update", "conversations.read", "conversations.update",
  "orders.read", "orders.update", "appointments.read", "appointments.update",
]);
const TENANT_MODULES = Object.freeze([
  "catalog", "orders", "events", "appointments", "payments", "human_handoff", "ai_freeform", "external_integrations", "flows",
]);
const ONBOARDING_RESOURCE = Object.freeze({ read: "admin", write: "admin" });
const META_RESOURCE = Object.freeze({ read: "admin", write: "admin" });
const META_PUBLIC_FIELDS = new Set([
  "id", "empresaId", "name", "appId", "mode", "webhookPublicId", "state",
  "appSecretCredentialId", "previousAppSecretCredentialId", "appSecretRotatedAt",
  "previousAppSecretValidUntil", "verifyTokenCredentialId", "revision", "lastTestAt",
  "lastWebhookValidAt", "lastErrorSanitized", "lastErrorExpiresAt", "createdAt", "updatedAt",
  "phoneNumberId", "wabaId", "metaAppId", "accessTokenCredentialId", "bindingRevision",
  "status", "primary", "success", "code", "message", "testedAt", "applicationId",
  "numberId", "providerCode",
]);

function slugFromName(value) {
  const slug = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80);
  return slug || `empresa-${randomUUID().slice(0, 8)}`;
}

function assertNoSensitiveConfiguration(value, path = "configuration", depth = 0) {
  if (depth > 12) throw new AdminValidationError(`${path} excede a profundidade permitida.`, { field: path });
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      throw new AdminValidationError(`Segredos devem ser cadastrados no cofre, não em ${path}.`, { field: path });
    }
    assertNoSensitiveConfiguration(item, `${path}.${key}`, depth + 1);
  }
}

function requiredText(value, field, max = 200) {
  const text = String(value || "").trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new AdminValidationError(`${field} inválido.`, { field });
  }
  return text;
}

function requiredSecret(value, max = 20_000) {
  const secret = String(value || "").trim();
  if (!secret || secret.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(secret)) {
    throw new AdminValidationError("secret inválido.", { field: "secret" });
  }
  return secret;
}

function requiredHumanMessage(value) {
  const text = String(value || "").replace(/\r\n?/gu, "\n").trim();
  if (!text || text.length > 4_096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new AdminValidationError("A mensagem deve ter entre 1 e 4096 caracteres.", { field: "text" });
  }
  return text;
}

function requiredResolutionReason(value) {
  const reason = String(value || "").replace(/\r\n?/gu, "\n").trim();
  if (!reason || reason.length > 1_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reason)) {
    throw new AdminValidationError("O motivo deve ter entre 1 e 1000 caracteres.", { field: "reason" });
  }
  return reason;
}

function requiredIdempotencyKey(value) {
  const key = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(key)) {
    throw new AdminValidationError("idempotencyKey deve ser um UUID v4 válido.", { field: "idempotencyKey" });
  }
  return key;
}

function safeCorrelationId(value, fallback) {
  const id = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id) ? id : fallback();
}

function optionalText(value, field, max = 5_000) {
  if (value === null) return null;
  return requiredText(value, field, max);
}

function validateField(type, value, field) {
  const optional = type.endsWith("?");
  const baseType = optional ? type.slice(0, -1) : type;
  if (value == null && optional) return null;
  if (value == null) throw new AdminValidationError(`${field} é obrigatório.`, { field });
  if (baseType === "script") {
    if (typeof value !== "string") throw new AdminValidationError(`${field} deve ser texto.`, { field });
    const script = value.replace(/\r\n?/gu, "\n").trim();
    if (!script || script.length > 20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(script)) {
      throw new AdminValidationError("O roteiro deve ter entre 1 e 20000 caracteres.", { field });
    }
    return script;
  }
  if (baseType === "string") return requiredText(value, field, 10_000);
  if (baseType === "email") {
    const email = requiredText(value, field, 320).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new AdminValidationError(`${field} inválido.`, { field });
    return email;
  }
  if (baseType === "boolean") {
    if (typeof value !== "boolean") throw new AdminValidationError(`${field} deve ser booleano.`, { field });
    return value;
  }
  if (baseType === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new AdminValidationError(`${field} deve ser numérico.`, { field });
    return number;
  }
  if (baseType === "object") {
    if (typeof value !== "object" || Array.isArray(value)) throw new AdminValidationError(`${field} deve ser objeto.`, { field });
    assertNoSensitiveConfiguration(value, field);
    return structuredClone(value);
  }
  if (baseType === "array") {
    if (!Array.isArray(value) || value.length > 100) throw new AdminValidationError(`${field} deve ser array.`, { field });
    const values = value.map((item) => requiredText(item, field));
    if (field === "permissions" && values.some((permission) => !OPERATOR_ASSIGNABLE_PERMISSIONS.has(permission))) {
      throw new AdminValidationError("Permissão customizada não permitida.", { field });
    }
    return values;
  }
  if (baseType === "date") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new AdminValidationError(`${field} deve ser uma data válida.`, { field });
    return date.toISOString();
  }
  if (baseType === "role") {
    if (!["tenant_admin", "tenant_operator"].includes(value)) throw new AdminValidationError(`${field} inválido.`, { field });
    return value;
  }
  throw new AdminValidationError(`${field} possui tipo não suportado.`, { field });
}

function validatedPayload(resource, body, { partial = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AdminValidationError("Corpo JSON inválido.");
  const definition = adminResource(resource);
  const output = {};
  for (const key of Object.keys(body)) {
    if (key === "empresaId") continue;
    if (!Object.hasOwn(definition.fields, key)) throw new AdminValidationError(`Campo não permitido: ${key}.`, { field: key });
    output[key] = validateField(definition.fields[key], body[key], key);
  }
  if (!partial) {
    for (const [field, type] of Object.entries(definition.fields)) {
      if (!type.endsWith("?") && !Object.hasOwn(output, field)) {
        throw new AdminValidationError(`${field} é obrigatório.`, { field });
      }
    }
  }
  if (Object.keys(output).length === 0) throw new AdminValidationError("Nenhum campo válido foi informado.");
  return output;
}

function normalizedResourcePayload(resource, payload) {
  if (resource !== "numbers") return payload;
  const normalized = { ...payload };
  if (Object.hasOwn(normalized, "status") && !["pendente", "ativo", "inativo", "falha", "revogado"].includes(normalized.status)) {
    throw new AdminValidationError("Estado do número WhatsApp inválido.", { field: "status" });
  }
  if (Object.hasOwn(normalized, "numeroE164")) {
    if (normalized.numeroE164 !== null && !/^\+[1-9][0-9]{7,14}$/u.test(normalized.numeroE164)) {
      throw new AdminValidationError("O número deve usar o formato internacional, como +5511999999999.", { field: "numeroE164" });
    }
    normalized.numeroMascarado = normalized.numeroE164 ? `••••${normalized.numeroE164.slice(-4)}` : null;
  }
  if (normalized.principal === true && Object.hasOwn(normalized, "status") && normalized.status !== "ativo") {
    throw new AdminValidationError("Somente um número ativo pode ser definido como principal.", { field: "principal" });
  }
  return normalized;
}

function pagination(definition, query = {}) {
  const limit = query.limit == null ? DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new AdminValidationError(`limit deve estar entre 1 e ${MAX_LIMIT}.`);
  }
  const sort = String(query.sort || definition.sorts[0]);
  if (!definition.sorts.includes(sort)) throw new AdminValidationError("Ordenação não permitida.");
  const direction = String(query.direction || "desc").toLowerCase();
  if (!["asc", "desc"].includes(direction)) throw new AdminValidationError("Direção de ordenação inválida.");
  const cursor = query.cursor == null ? null : requiredText(query.cursor, "cursor", 1_000);
  const page = query.page == null ? 1 : Number(query.page);
  if (!Number.isInteger(page) || page < 1 || page > 10_000) {
    throw new AdminValidationError("page deve estar entre 1 e 10000.");
  }
  const filters = {};
  for (const key of definition.filters) {
    if (query[key] == null || query[key] === "") continue;
    const value = String(query[key]);
    if (value.length > 500) throw new AdminValidationError(`Filtro ${key} excede o limite.`);
    filters[key] = value;
  }
  return { limit, page, sort, direction, cursor, filters };
}

function assertTenantBody(empresaId, body) {
  if (body?.empresaId != null && String(body.empresaId) !== String(empresaId)) {
    throw new AdminForbiddenError();
  }
}

function assertRepository(repository) {
  for (const method of [
    "listTenants", "getTenant", "createTenant", "updateTenant", "tenantDashboard", "globalDashboard",
    "list", "get", "create", "update", "remove", "diagnostics", "writeAudit", "withAuditedMutation",
  ]) {
    if (typeof repository?.[method] !== "function") throw new TypeError(`adminRepository.${method} é obrigatório.`);
  }
}

function sanitizedCredentialView(value) {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SENSITIVE_FIELD.test(key) || ["maskedSecret", "credentialId"].includes(key)));
}

function sanitizedAdminView(value) {
  return redactSensitive(value);
}

function credentialSecret({ provider, purpose, secret }) {
  const normalized = requiredSecret(secret);
  if (provider === "payment" && purpose.toLowerCase() === "pix") {
    const pixKey = normalizePixKey(normalized);
    if (!pixKey) {
      throw new AdminValidationError("Informe somente uma chave PIX válida, sem rótulos, instruções ou estrutura JSON.", { field: "secret" });
    }
    return pixKey;
  }
  return normalized;
}

function assertOnlyFields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AdminValidationError("Corpo JSON inválido.");
  }
  const unknown = Object.keys(body).find((field) => !allowed.has(field));
  if (unknown) throw new AdminValidationError(`Campo não permitido: ${unknown}.`, { field: unknown });
}

function sanitizedMetaView(value) {
  if (Array.isArray(value)) return value.map(sanitizedMetaView);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => META_PUBLIC_FIELDS.has(key))
    .map(([key, item]) => [key, key === "lastErrorSanitized" ? redactSensitive(item) : sanitizedAdminView(item)]));
}

function rethrowMetaError(error) {
  const code = String(error?.code || "");
  if (code.endsWith("_NOT_FOUND")) throw new AdminNotFoundError();
  if (code.endsWith("_CONFLICT")) throw new AdminConflictError();
  if (code.startsWith("META_") || error instanceof TypeError) {
    throw new AdminValidationError("Os dados da conexão Meta são inválidos.");
  }
  throw error;
}

export class AdminService {
  constructor({ repository, onboardingService = null, credentialVault, conversationService, healthService, mediaStore, googleSheetsIntegration, metaAppRepository, metaHealthService, clock = () => new Date(), idGenerator = randomUUID } = {}) {
    assertRepository(repository);
    this.repository = repository;
    this.onboardingService = onboardingService;
    this.credentialVault = credentialVault;
    this.conversationService = conversationService;
    this.healthService = healthService;
    this.mediaStore = mediaStore;
    this.googleSheetsIntegration = googleSheetsIntegration;
    this.metaAppRepository = metaAppRepository;
    this.metaHealthService = metaHealthService;
    this.clock = clock;
    this.idGenerator = idGenerator;
  }

  session(auth) {
    const identity = normalizedAdminAuth(auth);
    return {
      user: { ...identity.user, role: identity.platformRole, memberships: identity.memberships },
    };
  }

  async #audit({ auth, empresaId = null, action, resource, resourceId = null, result = "success", fields = [], correlationId = null }, transaction = null) {
    const identity = normalizedAdminAuth(auth);
    await this.repository.writeAudit({
      id: this.idGenerator(),
      empresaId,
      actorId: identity.actorId,
      action,
      resource,
      resourceId,
      result,
      changedFields: fields.filter((field) => !SENSITIVE_FIELD.test(field)),
      correlationId,
      occurredAt: this.clock().toISOString(),
    }, { transaction });
  }

  async #auditedMutation({ auth, empresaId, platform = false, mutate, audit }) {
    const identity = normalizedAdminAuth(auth);
    return this.repository.withAuditedMutation({
      empresaId,
      actorId: identity.actorId,
      platform,
    }, async (transaction) => {
      const result = await mutate(transaction);
      const auditInput = typeof audit === "function" ? audit(result) : audit;
      await this.#audit({ auth, empresaId, ...auditInput }, transaction);
      return result;
    });
  }

  async #platform(auth, action, resource) {
    try {
      return requirePlatformAdmin(auth);
    } catch (error) {
      if (error instanceof AdminForbiddenError) {
        await this.#audit({ auth, action, resource, result: "denied" });
      }
      throw error;
    }
  }

  async #tenant(auth, empresaId, definition, { write = false, operatorAllowed = false, action, resource } = {}) {
    try {
      const adminOnly = definition.read === "admin" || (write && (!operatorAllowed || ["admin", "credential"].includes(definition.write)));
      return requireTenantAccess(auth, empresaId, {
        adminOnly,
        write: adminOnly,
      });
    } catch (error) {
      if (error instanceof AdminForbiddenError) {
        await this.#audit({ auth, empresaId, action, resource, result: "denied" });
      }
      throw error;
    }
  }

  async listTenants({ auth, query = {} }) {
    const identity = normalizedAdminAuth(auth);
    const options = pagination({ sorts: ["createdAt", "name", "status"], filters: ["status", "search"] }, query);
    const allowedIds = identity.platformRole === "platform_admin"
      ? null
      : identity.memberships.map(({ empresaId }) => empresaId);
    return this.repository.listTenants({ ...options, allowedIds });
  }

  async lookupGlobalUser({ auth, email }) {
    await this.#platform(auth, "user.global.lookup", "users");
    if (typeof this.repository.lookupGlobalUser !== "function") {
      throw new AdminValidationError("A consulta de usuário global não está configurada.");
    }
    const normalizedEmail = String(email || "").trim().toLocaleLowerCase("en-US");
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalizedEmail)) {
      throw new AdminValidationError("Informe o e-mail exato de um usuário existente.", { field: "email" });
    }
    const user = await this.repository.lookupGlobalUser({ email: normalizedEmail });
    if (!user) throw new AdminNotFoundError();
    return user;
  }

  async getTenant({ auth, empresaId }) {
    await this.#tenant(auth, empresaId, { write: "admin" }, { action: "tenant.read", resource: "tenants" });
    const tenant = await this.repository.getTenant({ empresaId });
    if (!tenant) throw new AdminNotFoundError();
    return tenant;
  }

  async createTenant({ auth, body }) {
    await this.#platform(auth, "tenant.create", "tenants");
    const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    if (Object.hasOwn(input, "status")) {
      throw new AdminValidationError("O status é controlado pelo fluxo de onboarding.", { field: "status" });
    }
    const payload = validatedPayload("tenants", {
      slug: input.slug || slugFromName(input.name),
      name: input.name,
      displayName: input.displayName || input.name,
      identity: input.identity == null || input.identity === "" ? null : input.identity,
      timezone: input.timezone || "America/Sao_Paulo",
      locale: input.locale || "pt-BR",
      status: "draft",
      messageRetentionDays: input.messageRetentionDays ?? 365,
      logRetentionDays: input.logRetentionDays ?? 90,
    });
    const empresaId = this.idGenerator();
    return this.#auditedMutation({
      auth,
      empresaId,
      platform: true,
      mutate: (transaction) => this.repository.createTenant({ id: empresaId, ...payload, transaction }),
      audit: { action: "tenant.create", resource: "tenants", resourceId: empresaId, fields: Object.keys(payload) },
    });
  }

  async updateTenant({ auth, empresaId, body }) {
    await this.#platform(auth, "tenant.update", "tenants");
    assertTenantBody(empresaId, body);
    if (body && typeof body === "object" && Object.hasOwn(body, "status")) {
      throw new AdminValidationError("O status é controlado pelo fluxo de onboarding.", { field: "status" });
    }
    const payload = validatedPayload("tenants", body, { partial: true });
    return this.#auditedMutation({
      auth,
      empresaId,
      platform: true,
      mutate: async (transaction) => {
        const tenant = await this.repository.updateTenant({ empresaId, changes: payload, transaction });
        if (!tenant) throw new AdminNotFoundError();
        return tenant;
      },
      audit: { action: "tenant.update", resource: "tenants", resourceId: empresaId, fields: Object.keys(payload) },
    });
  }

  async suspendTenant({ auth, empresaId }) {
    await this.#platform(auth, "tenant.suspend", "tenants");
    return this.#auditedMutation({
      auth,
      empresaId,
      platform: true,
      mutate: async (transaction) => {
        const tenant = await this.repository.updateTenant({ empresaId, changes: { status: "suspended" }, transaction });
        if (!tenant) throw new AdminNotFoundError();
        return tenant;
      },
      audit: { action: "tenant.suspend", resource: "tenants", resourceId: empresaId, fields: ["status"] },
    });
  }

  #requiredOnboardingService() {
    if (!this.onboardingService) throw new TypeError("onboardingService não está configurado.");
    return this.onboardingService;
  }

  async getOnboarding({ auth, empresaId }) {
    await this.#tenant(auth, empresaId, ONBOARDING_RESOURCE, {
      action: "onboarding.read",
      resource: "onboarding",
    });
    return this.#requiredOnboardingService().getProgress({ empresaId });
  }

  async saveOnboardingStep({ auth, empresaId, step, body, correlationId = null }) {
    const identity = await this.#tenant(auth, empresaId, ONBOARDING_RESOURCE, {
      write: true,
      action: "onboarding.step.update",
      resource: "onboarding",
    });
    return this.#requiredOnboardingService().saveProgressStep({
      empresaId,
      expectedRevision: body?.revision,
      currentStep: Number(step),
      completedSteps: body?.completedSteps,
      actorId: identity.actorId,
      correlationId,
    });
  }

  async getActionCatalog({ auth, empresaId }) {
    await this.#tenant(auth, empresaId, ONBOARDING_RESOURCE, {
      action: "onboarding.action_catalog.read",
      resource: "onboarding",
    });
    return this.#requiredOnboardingService().getActionCatalog();
  }

  async readConfigurationDraft({ auth, empresaId }) {
    await this.#tenant(auth, empresaId, ONBOARDING_RESOURCE, {
      action: "configuration.draft.read",
      resource: "configuration_draft",
    });
    return this.#requiredOnboardingService().readDraft({ empresaId });
  }

  async saveConfigurationDraft({ auth, empresaId, body, correlationId = null }) {
    const identity = await this.#tenant(auth, empresaId, ONBOARDING_RESOURCE, {
      write: true,
      action: "configuration.draft.update",
      resource: "configuration_draft",
    });
    return this.#requiredOnboardingService().saveDraft({
      empresaId,
      configuration: body?.configuration,
      expectedDraftVersion: body?.draftVersion,
      actorId: identity.actorId,
      correlationId,
    });
  }

  async validateConfiguration({ auth, empresaId }) {
    await this.#tenant(auth, empresaId, ONBOARDING_RESOURCE, {
      action: "configuration.validate",
      resource: "configuration_draft",
    });
    return this.#requiredOnboardingService().validate({ empresaId });
  }

  async configurationReadiness({ auth, empresaId }) {
    await this.#tenant(auth, empresaId, ONBOARDING_RESOURCE, {
      action: "onboarding.readiness.read",
      resource: "onboarding",
    });
    return this.#requiredOnboardingService().readiness({ empresaId });
  }

  async simulateConfigurationMessage({ auth, empresaId, body, correlationId = null }) {
    assertTenantBody(empresaId, body);
    assertOnlyFields(body, new Set(["draftVersion", "sessionId", "sessionRevision", "message"]));
    const identity = await this.#tenant(auth, empresaId, ONBOARDING_RESOURCE, {
      write: true,
      action: "onboarding.simulator.message",
      resource: "onboarding_simulation",
    });
    const result = await this.#requiredOnboardingService().simulateMessage({
      empresaId,
      expectedDraftVersion: body.draftVersion,
      sessionId: body.sessionId,
      expectedSessionRevision: body.sessionRevision ?? 0,
      message: body.message,
      actorId: identity.actorId,
    });
    await this.#audit({
      auth,
      empresaId,
      action: "onboarding.simulator.message",
      resource: "onboarding_simulation",
      resourceId: result.sessionId,
      fields: ["draft_version", "session_revision", "message_type"],
      correlationId,
    });
    return result;
  }

  async preflightConfiguration({ auth, empresaId, body, correlationId = null }) {
    assertTenantBody(empresaId, body);
    assertOnlyFields(body, new Set(["draftVersion"]));
    const identity = await this.#tenant(auth, empresaId, ONBOARDING_RESOURCE, {
      write: true,
      action: "onboarding.preflight",
      resource: "onboarding",
    });
    return this.#requiredOnboardingService().preflight({
      empresaId,
      expectedDraftVersion: body.draftVersion,
      actorId: identity.actorId,
      correlationId,
    });
  }

  async publishConfiguration({ auth, empresaId, body, correlationId = null }) {
    const identity = await this.#tenant(auth, empresaId, ONBOARDING_RESOURCE, {
      write: true,
      action: "configuration.publish",
      resource: "configuration_revision",
    });
    return this.#requiredOnboardingService().publish({
      empresaId,
      expectedDraftVersion: body?.draftVersion,
      actorId: identity.actorId,
      correlationId,
    });
  }

  async activateTenant({ auth, empresaId, body, correlationId = null }) {
    const identity = await this.#platform(auth, "tenant.activate", "tenants");
    return this.#requiredOnboardingService().activate({
      empresaId,
      expectedDraftVersion: body?.draftVersion,
      actorId: identity.actorId,
      correlationId,
    });
  }

  async globalDashboard({ auth, query = {} }) {
    await this.#platform(auth, "dashboard.global.read", "dashboard");
    return this.repository.globalDashboard({ filters: query });
  }

  async tenantDashboard({ auth, empresaId, query = {} }) {
    await this.#tenant(auth, empresaId, { write: "none" }, { action: "dashboard.tenant.read", resource: "dashboard" });
    return this.repository.tenantDashboard({ empresaId, filters: query });
  }

  async list({ auth, empresaId, resource, query = {} }) {
    const definition = adminResource(resource);
    if (!definition) throw new AdminNotFoundError();
    await this.#tenant(auth, empresaId, definition, { action: `${resource}.list`, resource });
    const result = await this.repository.list({ resource, empresaId, ...pagination(definition, query) });
    if (definition.pii) await this.#audit({ auth, empresaId, action: `${resource}.list`, resource });
    return sanitizedAdminView(result);
  }

  async replaceModules({ auth, empresaId, body }) {
    const definition = ADMIN_RESOURCES.modules;
    assertTenantBody(empresaId, body);
    await this.#tenant(auth, empresaId, definition, { write: true, action: "modules.replace", resource: "modules" });
    if (!Array.isArray(body?.enabledModules)) throw new AdminValidationError("enabledModules deve ser um array.", { field: "enabledModules" });
    const enabledModules = [...new Set(body.enabledModules.map((item) => requiredText(item, "enabledModules", 80)))];
    if (enabledModules.some((item) => !TENANT_MODULES.includes(item))) {
      throw new AdminValidationError("Módulo não suportado.", { field: "enabledModules" });
    }
    if (typeof this.repository.replaceModules !== "function") throw new TypeError("adminRepository.replaceModules é obrigatório.");
    const result = await this.#auditedMutation({
      auth,
      empresaId,
      mutate: (transaction) => this.repository.replaceModules({ empresaId, enabledModules, transaction }),
      audit: { action: "modules.replace", resource: "modules", fields: ["enabledModules"] },
    });
    return sanitizedAdminView(result);
  }

  async get({ auth, empresaId, resource, id }) {
    const definition = adminResource(resource);
    if (!definition) throw new AdminNotFoundError();
    await this.#tenant(auth, empresaId, definition, { action: `${resource}.read`, resource });
    const record = await this.repository.get({ resource, empresaId, id: requiredText(id, "id") });
    if (!record) throw new AdminNotFoundError();
    if (definition.pii) await this.#audit({ auth, empresaId, action: `${resource}.read`, resource, resourceId: id });
    if (resource === "conversations") {
      const messages = await this.repository.list({
        resource: "messages", empresaId, limit: 100, page: 1, sort: "sequence", direction: "desc",
        filters: { conversationId: id },
      });
      return sanitizedAdminView({ conversation: record, messages: [...(messages.items || [])].reverse() });
    }
    return sanitizedAdminView(record);
  }

  async getMessageMedia({ auth, empresaId, messageId }) {
    await this.#tenant(auth, empresaId, ADMIN_RESOURCES.messages, { action: "messages.media.read", resource: "messages" });
    if (typeof this.repository.getPrivateMedia !== "function" || typeof this.mediaStore?.read !== "function") {
      throw new AdminNotFoundError();
    }
    const id = requiredText(messageId, "messageId");
    const metadata = await this.repository.getPrivateMedia({ empresaId, messageId: id });
    if (!metadata) throw new AdminNotFoundError();
    let data;
    try {
      data = await this.mediaStore.read({ empresaId, storageKey: metadata.storageKey, expectedSha256: metadata.sha256 });
    } catch (error) {
      if (error?.code === "ENOENT") throw new AdminNotFoundError();
      throw error;
    }
    await this.#audit({ auth, empresaId, action: "messages.media.read", resource: "messages", resourceId: id });
    return Object.freeze({ data, mimeType: metadata.mimeType, sizeBytes: metadata.sizeBytes, sha256: metadata.sha256 });
  }

  async create({ auth, empresaId, resource, body }) {
    const definition = adminResource(resource);
    if (!definition || ["none", "credential"].includes(definition.write)) throw new AdminForbiddenError();
    assertTenantBody(empresaId, body);
    await this.#tenant(auth, empresaId, definition, { write: true, action: `${resource}.create`, resource });
    const payload = normalizedResourcePayload(resource, validatedPayload(resource, body));
    const id = this.idGenerator();
    const record = await this.#auditedMutation({
      auth,
      empresaId,
      platform: resource === "users",
      mutate: (transaction) => this.repository.create({ resource, empresaId, id, data: payload, transaction }),
      audit: (created) => ({ action: `${resource}.create`, resource, resourceId: created.id, fields: Object.keys(payload) }),
    });
    return sanitizedAdminView(record);
  }

  async update({ auth, empresaId, resource, id, body }) {
    const definition = adminResource(resource);
    if (!definition || ["none", "credential"].includes(definition.write)) throw new AdminForbiddenError();
    assertTenantBody(empresaId, body);
    await this.#tenant(auth, empresaId, definition, { write: true, operatorAllowed: definition.write === "operator", action: `${resource}.update`, resource });
    const payload = normalizedResourcePayload(resource, validatedPayload(resource, body, { partial: true }));
    if (resource === "users"
      && normalizedAdminAuth(auth).platformRole !== "platform_admin"
      && Object.keys(payload).some((field) => ["email", "name", "status", "initialPassword"].includes(field))
      && await this.repository.userHasOtherMemberships?.({ empresaId, userId: id })) {
      throw new AdminValidationError("Usuário vinculado a outras empresas só pode ter dados globais alterados por um administrador da plataforma.");
    }
    const recordId = requiredText(id, "id");
    const record = await this.#auditedMutation({
      auth,
      empresaId,
      platform: resource === "users",
      mutate: async (transaction) => {
        if (["users", "memberships"].includes(resource)) {
          await this.repository.assertTenantAdminContinuity?.({
            empresaId,
            userId: recordId,
            resource,
            changes: payload,
            transaction,
          });
        }
        const updated = await this.repository.update({ resource, empresaId, id: recordId, changes: payload, transaction });
        if (!updated) throw new AdminNotFoundError();
        return updated;
      },
      audit: { action: `${resource}.update`, resource, resourceId: recordId, fields: Object.keys(payload) },
    });
    return sanitizedAdminView(record);
  }

  async remove({ auth, empresaId, resource, id }) {
    const definition = adminResource(resource);
    if (!definition || ["none", "credential"].includes(definition.write)) throw new AdminForbiddenError();
    await this.#tenant(auth, empresaId, definition, { write: true, action: `${resource}.delete`, resource });
    const recordId = requiredText(id, "id");
    await this.#auditedMutation({
      auth,
      empresaId,
      platform: resource === "users",
      mutate: async (transaction) => {
        if (["users", "memberships"].includes(resource)) {
          await this.repository.assertTenantAdminContinuity?.({
            empresaId,
            userId: recordId,
            resource,
            remove: true,
            transaction,
          });
        }
        const removed = await this.repository.remove({ resource, empresaId, id: recordId, transaction });
        if (!removed) throw new AdminNotFoundError();
        return removed;
      },
      audit: { action: `${resource}.delete`, resource, resourceId: recordId },
    });
    return { deleted: true };
  }

  async createCredential({ auth, empresaId, body, correlationId }) {
    const definition = ADMIN_RESOURCES.credentials;
    assertTenantBody(empresaId, body);
    await this.#tenant(auth, empresaId, definition, { write: true, action: "credential.create", resource: "credentials" });
    if (!this.credentialVault?.createCredential) throw new AdminValidationError("Cofre de credenciais não configurado.");
    const provider = requiredText(body.provider, "provider");
    const purpose = requiredText(body.purpose, "purpose");
    const view = await this.credentialVault.createCredential({
      empresaId,
      credentialId: body.credentialId || this.idGenerator(),
      provider,
      purpose,
      secret: credentialSecret({ provider, purpose, secret: body.secret }),
      actorId: normalizedAdminAuth(auth).actorId,
      correlationId,
    });
    return sanitizedCredentialView(view);
  }

  async rotateCredential({ auth, empresaId, credentialId, body, correlationId }) {
    await this.#tenant(auth, empresaId, ADMIN_RESOURCES.credentials, { write: true, action: "credential.rotate", resource: "credentials" });
    if (!this.credentialVault?.rotateCredential) throw new AdminValidationError("Cofre de credenciais não configurado.");
    const normalizedCredentialId = requiredText(credentialId, "credentialId");
    const metadata = await this.credentialVault.getCredentialMetadata?.({ empresaId, credentialId: normalizedCredentialId });
    return sanitizedCredentialView(await this.credentialVault.rotateCredential({
      empresaId,
      credentialId: normalizedCredentialId,
      newSecret: metadata
        ? credentialSecret({ provider: metadata.provider, purpose: metadata.purpose, secret: body?.secret })
        : requiredSecret(body?.secret),
      actorId: normalizedAdminAuth(auth).actorId,
      correlationId,
    }));
  }

  async revokeCredential({ auth, empresaId, credentialId, correlationId }) {
    await this.#tenant(auth, empresaId, ADMIN_RESOURCES.credentials, { write: true, action: "credential.revoke", resource: "credentials" });
    if (!this.credentialVault?.revokeCredential) throw new AdminValidationError("Cofre de credenciais não configurado.");
    return sanitizedCredentialView(await this.credentialVault.revokeCredential({
      empresaId,
      credentialId: requiredText(credentialId, "credentialId"),
      actorId: normalizedAdminAuth(auth).actorId,
      correlationId,
    }));
  }

  async listMetaApplications({ auth, empresaId }) {
    await this.#tenant(auth, empresaId, META_RESOURCE, { action: "meta.app.list", resource: "meta-applications" });
    if (typeof this.metaAppRepository?.listApps !== "function") throw new AdminValidationError("Aplicativos Meta não configurados no runtime.");
    return sanitizedMetaView(await this.metaAppRepository.listApps({ empresaId }));
  }

  async createMetaApplication({ auth, empresaId, body, correlationId }) {
    assertTenantBody(empresaId, body);
    await this.#tenant(auth, empresaId, META_RESOURCE, { write: true, action: "meta.app.create", resource: "meta-applications" });
    if (typeof this.metaAppRepository?.createApp !== "function") throw new AdminValidationError("Aplicativos Meta não configurados no runtime.");
    if (body?.state != null) throw new AdminValidationError("O estado do aplicativo é controlado pelo preflight.", { field: "state" });
    try {
      return sanitizedMetaView(await this.metaAppRepository.createApp({
        empresaId,
        name: body?.name,
        metaAppId: body?.metaAppId,
        mode: body?.mode || "own",
        appSecretCredentialId: body?.appSecretCredentialId || null,
        verifyTokenCredentialId: body?.verifyTokenCredentialId || null,
        actorId: normalizedAdminAuth(auth).actorId,
        correlationId,
        createdAt: this.clock(),
      }));
    } catch (error) {
      return rethrowMetaError(error);
    }
  }

  async updateMetaApplication({ auth, empresaId, appId, body, correlationId }) {
    assertTenantBody(empresaId, body);
    await this.#tenant(auth, empresaId, META_RESOURCE, { write: true, action: "meta.app.update", resource: "meta-applications" });
    if (typeof this.metaAppRepository?.updateApp !== "function") throw new AdminValidationError("Aplicativos Meta não configurados no runtime.");
    if (["active", "failed"].includes(body?.state)) {
      throw new AdminValidationError("Ativação e falha são controladas pelo preflight.", { field: "state" });
    }
    const allowed = ["name", "metaAppId", "mode", "state", "appSecretCredentialId", "verifyTokenCredentialId"];
    const changes = Object.fromEntries(allowed.filter((field) => Object.hasOwn(body || {}, field)).map((field) => [field, body[field]]));
    if (Object.keys(changes).length === 0) {
      throw new AdminValidationError("Informe ao menos um campo do aplicativo Meta para atualizar.");
    }
    try {
      return sanitizedMetaView(await this.metaAppRepository.updateApp({
        empresaId,
        id: appId,
        expectedRevision: Number(body?.expectedRevision),
        actorId: normalizedAdminAuth(auth).actorId,
        correlationId,
        updatedAt: this.clock(),
        ...changes,
      }));
    } catch (error) {
      return rethrowMetaError(error);
    }
  }

  async rotateMetaApplicationSecret({ auth, empresaId, appId, body, correlationId }) {
    assertTenantBody(empresaId, body);
    await this.#tenant(auth, empresaId, META_RESOURCE, { write: true, action: "meta.app.secret.rotate", resource: "meta-applications" });
    if (typeof this.metaAppRepository?.findAppById !== "function" || typeof this.metaAppRepository?.updateApp !== "function") {
      throw new AdminValidationError("Aplicativos Meta não configurados no runtime.");
    }
    const rotationWindowSeconds = body?.rotationWindowSeconds == null ? 900 : Number(body.rotationWindowSeconds);
    if (!Number.isSafeInteger(rotationWindowSeconds) || rotationWindowSeconds < 60 || rotationWindowSeconds > 3_600) {
      throw new AdminValidationError("rotationWindowSeconds deve estar entre 60 e 3600.", { field: "rotationWindowSeconds" });
    }
    try {
      const current = await this.metaAppRepository.findAppById({ empresaId, appId });
      if (!current) throw Object.assign(new Error(), { code: "META_APP_NOT_FOUND" });
      if (current.mode !== "own" || !current.appSecretCredentialId) {
        throw new AdminValidationError("Somente aplicativo próprio configurado aceita rotação de App Secret.");
      }
      const rotatedAt = this.clock();
      return sanitizedMetaView(await this.metaAppRepository.updateApp({
        empresaId,
        id: appId,
        expectedRevision: Number(body?.expectedRevision),
        appSecretCredentialId: body?.newAppSecretCredentialId,
        previousAppSecretCredentialId: current.appSecretCredentialId,
        appSecretRotatedAt: rotatedAt,
        previousAppSecretValidUntil: new Date(rotatedAt.getTime() + rotationWindowSeconds * 1_000),
        state: "pending",
        actorId: normalizedAdminAuth(auth).actorId,
        correlationId,
        updatedAt: rotatedAt,
      }));
    } catch (error) {
      if (error instanceof AdminValidationError) throw error;
      return rethrowMetaError(error);
    }
  }

  async bindMetaNumber({ auth, empresaId, numberId, body, correlationId }) {
    assertTenantBody(empresaId, body);
    await this.#tenant(auth, empresaId, META_RESOURCE, { write: true, action: "meta.number.bind", resource: "meta-applications" });
    if (typeof this.metaAppRepository?.bindNumber !== "function") throw new AdminValidationError("Aplicativos Meta não configurados no runtime.");
    try {
      return sanitizedMetaView(await this.metaAppRepository.bindNumber({
        empresaId,
        numberId,
        metaAppId: body?.metaAppId,
        accessTokenCredentialId: body?.accessTokenCredentialId,
        expectedRevision: Number(body?.expectedRevision),
        actorId: normalizedAdminAuth(auth).actorId,
        correlationId,
        updatedAt: this.clock(),
      }));
    } catch (error) {
      return rethrowMetaError(error);
    }
  }

  async preflightMetaApplication({ auth, empresaId, appId, body, correlationId }) {
    assertTenantBody(empresaId, body);
    await this.#tenant(auth, empresaId, META_RESOURCE, { write: true, action: "meta.app.preflight", resource: "meta-applications" });
    if (typeof this.metaHealthService?.run !== "function") throw new AdminValidationError("Preflight Meta não configurado no runtime.");
    try {
      return sanitizedMetaView(await this.metaHealthService.run({
        empresaId,
        appId,
        numberId: body?.numberId,
        actorId: normalizedAdminAuth(auth).actorId,
        correlationId,
      }));
    } catch (error) {
      return rethrowMetaError(error);
    }
  }

  async syncGoogleSheets({ auth, empresaId, correlationId }) {
    await this.#tenant(auth, empresaId, ADMIN_RESOURCES.integrations, { write: true, action: "google_sheets.sync", resource: "integrations" });
    if (typeof this.googleSheetsIntegration?.syncTenant !== "function") throw new AdminValidationError("Google Sheets não configurado no runtime.");
    const result = await this.googleSheetsIntegration.syncTenant({ empresaId });
    await this.#audit({ auth, empresaId, action: "google_sheets.sync", resource: "integrations", result: result.health === "healthy" ? "success" : "failure", correlationId });
    return {
      health: result.health,
      stale: Boolean(result.stale),
      errorCode: result.errorCode || null,
      eventsImported: Array.isArray(result.snapshot?.events) ? result.snapshot.events.length : 0,
    };
  }

  async setConversationMode({ auth, empresaId, conversationId, mode, operatorId }) {
    await this.#tenant(auth, empresaId, ADMIN_RESOURCES.conversations, {
      write: true,
      operatorAllowed: true,
      action: `conversation.${mode}`,
      resource: "conversations",
    });
    if (!this.conversationService) throw new AdminValidationError("Serviço de conversas não configurado.");
    const recordId = requiredText(conversationId, "conversationId");
    return this.#auditedMutation({
      auth,
      empresaId,
      mutate: async (transaction) => {
        const context = { empresaId, conversationId: recordId, operatorId, transaction };
        if (mode === "human") return this.conversationService.handoffToHuman(context);
        if (mode === "paused") return this.conversationService.pauseBot(context);
        if (mode === "bot") return this.conversationService.resumeBot(context);
        throw new AdminValidationError("Modo de conversa inválido.");
      },
      audit: { action: `conversation.${mode}`, resource: "conversations", resourceId: recordId, fields: ["mode", "operatorId"] },
    });
  }

  async sendHumanMessage({ auth, empresaId, conversationId, body, correlationId }) {
    await this.#tenant(auth, empresaId, ADMIN_RESOURCES.conversations, {
      write: true,
      operatorAllowed: true,
      action: "conversation.message.send",
      resource: "conversations",
    });
    if (typeof this.repository.queueHumanMessage !== "function") {
      throw new AdminValidationError("Envio humano não configurado.");
    }
    assertTenantBody(empresaId, body);
    const identity = normalizedAdminAuth(auth);
    const recordId = requiredText(conversationId, "conversationId");
    const text = requiredHumanMessage(body?.text);
    const idempotencyKey = requiredIdempotencyKey(body?.idempotencyKey);
    const requestCorrelationId = safeCorrelationId(correlationId, this.idGenerator);
    try {
      return sanitizedAdminView(await this.#auditedMutation({
        auth,
        empresaId,
        mutate: async (transaction) => {
          const message = await this.repository.queueHumanMessage({
            empresaId,
            conversationId: recordId,
            operatorId: identity.actorId,
            text,
            idempotencyKey,
            correlationId: requestCorrelationId,
            transaction,
          });
          if (!message) throw new AdminNotFoundError();
          return message;
        },
        audit: (message) => ({
          action: "conversation.message.send",
          resource: "messages",
          resourceId: message.id,
          fields: ["text"],
          correlationId: requestCorrelationId,
        }),
      }));
    } catch (error) {
      if (error instanceof AdminForbiddenError) {
        await this.#audit({
          auth,
          empresaId,
          action: "conversation.message.send",
          resource: "messages",
          result: "denied",
          correlationId: requestCorrelationId,
        });
      }
      throw error;
    }
  }

  async listFailedJobs({ auth, empresaId, query = {} }) {
    const definition = ADMIN_RESOURCES["failed-jobs"];
    await this.#tenant(auth, empresaId, definition, { action: "failed_jobs.list", resource: "failed-jobs" });
    if (typeof this.repository.listFailedJobs !== "function") throw new TypeError("adminRepository.listFailedJobs é obrigatório.");
    const status = query.status == null || query.status === "" ? "open" : String(query.status);
    if (!["all", "open", "resolved"].includes(status)) {
      throw new AdminValidationError("status deve ser all, open ou resolved.", { field: "status" });
    }
    const options = pagination(definition, { ...query, status });
    return sanitizedAdminView(await this.repository.listFailedJobs({ empresaId, ...options }));
  }

  async getFailedJob({ auth, empresaId, failedJobId }) {
    const definition = ADMIN_RESOURCES["failed-jobs"];
    await this.#tenant(auth, empresaId, definition, { action: "failed_jobs.read", resource: "failed-jobs" });
    if (typeof this.repository.getFailedJob !== "function") throw new TypeError("adminRepository.getFailedJob é obrigatório.");
    const id = requiredText(failedJobId, "failedJobId");
    const record = await this.repository.getFailedJob({ empresaId, id });
    if (!record) throw new AdminNotFoundError();
    return sanitizedAdminView(record);
  }

  async retryFailedJob({ auth, empresaId, failedJobId, body, correlationId }) {
    const definition = ADMIN_RESOURCES["failed-jobs"];
    await this.#tenant(auth, empresaId, definition, {
      write: true,
      action: "failed_jobs.retry",
      resource: "failed-jobs",
    });
    if (typeof this.repository.retryFailedJob !== "function") throw new TypeError("adminRepository.retryFailedJob é obrigatório.");
    assertTenantBody(empresaId, body);
    const identity = normalizedAdminAuth(auth);
    const id = requiredText(failedJobId, "failedJobId");
    const reason = requiredResolutionReason(body?.reason);
    const requestCorrelationId = safeCorrelationId(correlationId, this.idGenerator);
    const retryJobId = this.idGenerator();
    return sanitizedAdminView(await this.#auditedMutation({
      auth,
      empresaId,
      mutate: async (transaction) => {
        const record = await this.repository.retryFailedJob({
          empresaId,
          id,
          retryJobId,
          actorId: identity.actorId,
          reason,
          correlationId: requestCorrelationId,
          transaction,
        });
        if (!record) throw new AdminNotFoundError();
        return record;
      },
      audit: {
        action: "failed_jobs.retry",
        resource: "failed-jobs",
        resourceId: id,
        fields: ["resolutionKind", "resolutionNote", "retryJobId"],
        correlationId: requestCorrelationId,
      },
    }));
  }

  async resolveFailedJob({ auth, empresaId, failedJobId, body, correlationId }) {
    const definition = ADMIN_RESOURCES["failed-jobs"];
    await this.#tenant(auth, empresaId, definition, {
      write: true,
      action: "failed_jobs.resolve",
      resource: "failed-jobs",
    });
    if (typeof this.repository.resolveFailedJob !== "function") throw new TypeError("adminRepository.resolveFailedJob é obrigatório.");
    assertTenantBody(empresaId, body);
    const identity = normalizedAdminAuth(auth);
    const id = requiredText(failedJobId, "failedJobId");
    const reason = requiredResolutionReason(body?.reason);
    const requestCorrelationId = safeCorrelationId(correlationId, this.idGenerator);
    return sanitizedAdminView(await this.#auditedMutation({
      auth,
      empresaId,
      mutate: async (transaction) => {
        const record = await this.repository.resolveFailedJob({
          empresaId,
          id,
          actorId: identity.actorId,
          reason,
          transaction,
        });
        if (!record) throw new AdminNotFoundError();
        return record;
      },
      audit: {
        action: "failed_jobs.resolve",
        resource: "failed-jobs",
        resourceId: id,
        fields: ["resolutionKind", "resolutionNote"],
        correlationId: requestCorrelationId,
      },
    }));
  }

  async diagnostics({ auth, empresaId = null }) {
    if (empresaId) {
      await this.#tenant(auth, empresaId, { read: "admin", write: "admin" }, { action: "diagnostics.read", resource: "diagnostics" });
    } else {
      await this.#platform(auth, "diagnostics.global.read", "diagnostics");
    }
    const [database, runtime] = await Promise.all([
      this.repository.diagnostics({ empresaId }),
      this.healthService?.diagnostics?.() || null,
    ]);
    return runtime ? { ...database, runtime } : database;
  }
}
