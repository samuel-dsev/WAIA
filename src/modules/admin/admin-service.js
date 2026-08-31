import { randomUUID } from "node:crypto";
import {
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

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const SENSITIVE_FIELD = /secret|token|password|senha|credential|cipher|nonce|tag|authorization/iu;
const OPERATOR_ASSIGNABLE_PERMISSIONS = new Set([
  "contacts.read", "contacts.update", "conversations.read", "conversations.update",
  "orders.read", "orders.update", "appointments.read", "appointments.update",
]);
const TENANT_MODULES = Object.freeze([
  "catalog", "orders", "events", "appointments", "payments", "human_handoff", "ai_freeform", "external_integrations",
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

export class AdminService {
  constructor({ repository, credentialVault, conversationService, healthService, mediaStore, googleSheetsIntegration, clock = () => new Date(), idGenerator = randomUUID } = {}) {
    assertRepository(repository);
    this.repository = repository;
    this.credentialVault = credentialVault;
    this.conversationService = conversationService;
    this.healthService = healthService;
    this.mediaStore = mediaStore;
    this.googleSheetsIntegration = googleSheetsIntegration;
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

  async getTenant({ auth, empresaId }) {
    await this.#tenant(auth, empresaId, { write: "admin" }, { action: "tenant.read", resource: "tenants" });
    const tenant = await this.repository.getTenant({ empresaId });
    if (!tenant) throw new AdminNotFoundError();
    return tenant;
  }

  async createTenant({ auth, body }) {
    await this.#platform(auth, "tenant.create", "tenants");
    const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const payload = validatedPayload("tenants", {
      slug: input.slug || slugFromName(input.name),
      name: input.name,
      displayName: input.displayName || input.name,
      identity: input.identity == null || input.identity === "" ? null : input.identity,
      timezone: input.timezone || "America/Sao_Paulo",
      locale: input.locale || "pt-BR",
      status: input.status || "draft",
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

  async suspendTenant({ auth, empresaId, suspended = true }) {
    await this.#platform(auth, suspended ? "tenant.suspend" : "tenant.activate", "tenants");
    return this.#auditedMutation({
      auth,
      empresaId,
      platform: true,
      mutate: async (transaction) => {
        const tenant = await this.repository.updateTenant({ empresaId, changes: { status: suspended ? "suspended" : "active" }, transaction });
        if (!tenant) throw new AdminNotFoundError();
        return tenant;
      },
      audit: { action: suspended ? "tenant.suspend" : "tenant.activate", resource: "tenants", resourceId: empresaId, fields: ["status"] },
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
    const payload = validatedPayload(resource, body);
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
    const payload = validatedPayload(resource, body, { partial: true });
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
    const view = await this.credentialVault.createCredential({
      empresaId,
      credentialId: body.credentialId || this.idGenerator(),
      provider: requiredText(body.provider, "provider"),
      purpose: requiredText(body.purpose, "purpose"),
      secret: requiredText(body.secret, "secret", 20_000),
      actorId: normalizedAdminAuth(auth).actorId,
      correlationId,
    });
    return sanitizedCredentialView(view);
  }

  async rotateCredential({ auth, empresaId, credentialId, body, correlationId }) {
    await this.#tenant(auth, empresaId, ADMIN_RESOURCES.credentials, { write: true, action: "credential.rotate", resource: "credentials" });
    if (!this.credentialVault?.rotateCredential) throw new AdminValidationError("Cofre de credenciais não configurado.");
    return sanitizedCredentialView(await this.credentialVault.rotateCredential({
      empresaId,
      credentialId: requiredText(credentialId, "credentialId"),
      newSecret: requiredText(body?.secret, "secret", 20_000),
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
