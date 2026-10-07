import { randomUUID } from "node:crypto";
import {
  withPlatformTransaction,
  withTenantTransaction,
} from "../../infra/postgres/transaction.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MODE_FROM_DB = Object.freeze({ compartilhado: "shared", proprio: "own", ycloud: "ycloud" });
const MODE_TO_DB = Object.freeze({ shared: "compartilhado", own: "proprio", ycloud: "ycloud" });
const STATE_FROM_DB = Object.freeze({
  pendente: "pending",
  ativo: "active",
  inativo: "inactive",
  falha: "failed",
  revogado: "revoked",
});
const STATE_TO_DB = Object.freeze(Object.fromEntries(
  Object.entries(STATE_FROM_DB).map(([database, domain]) => [domain, database]),
));
const CREDENTIAL_PURPOSES = Object.freeze({
  appSecret: Object.freeze(["meta-app-secret"]),
  verifyToken: Object.freeze(["meta-verify-token"]),
  accessToken: Object.freeze(["whatsapp-access-token", "whatsapp"]),
});

function repositoryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredUuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${field} deve ser um UUID válido.`);
  }
  return value.toLowerCase();
}

function optionalUuid(value, field) {
  if (value == null || value === "") return null;
  return requiredUuid(value, field);
}

function requiredText(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new TypeError(`${field} deve conter entre 1 e ${maxLength} caracteres.`);
  }
  return value.trim();
}

function optionalDate(value, field) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} deve ser uma data válida.`);
  return date;
}

function positiveRevision(value, field = "expectedRevision") {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} deve ser um inteiro positivo.`);
  }
  return value;
}

function normalizeMode(value) {
  if (!MODE_TO_DB[value]) throw new TypeError("mode deve ser shared, own ou ycloud.");
  return value;
}

function normalizeState(value) {
  if (!STATE_TO_DB[value]) {
    throw new TypeError("state deve ser pending, active, inactive, failed ou revoked.");
  }
  return value;
}

function assertTenantTransaction(transaction, empresaId) {
  if (!transaction?.client?.query) throw new TypeError("Transação PostgreSQL é obrigatória.");
  if (transaction.tenantId && transaction.tenantId !== empresaId) {
    throw new TypeError("A transação pertence a outra empresa.");
  }
  return transaction;
}

function mapApp(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    empresaId: row.empresa_id,
    name: row.nome,
    appId: row.app_id,
    mode: MODE_FROM_DB[row.modo] || row.modo,
    webhookPublicId: row.webhook_public_id,
    state: STATE_FROM_DB[row.estado] || row.estado,
    appSecretCredentialId: row.app_secret_credencial_id,
    previousAppSecretCredentialId: row.app_secret_anterior_credencial_id,
    appSecretRotatedAt: row.app_secret_rotacionado_at,
    previousAppSecretValidUntil: row.app_secret_anterior_valido_ate,
    verifyTokenCredentialId: row.verify_token_credencial_id,
    revision: Number(row.revision),
    lastTestAt: row.ultimo_teste_at,
    lastWebhookValidAt: row.ultimo_webhook_valido_at,
    lastErrorSanitized: deserializeSanitizedError(row.ultimo_erro_sanitizado),
    lastErrorExpiresAt: row.ultimo_erro_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  });
}

function mapNumber(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    empresaId: row.empresa_id,
    phoneNumberId: row.phone_number_id,
    numeroE164: row.numero_e164,
    wabaId: row.waba_id,
    metaAppId: row.aplicativo_meta_id,
    accessTokenCredentialId: row.access_token_credencial_id,
    bindingRevision: Number(row.meta_binding_revision),
    status: row.status,
    primary: row.principal,
    updatedAt: row.updated_at,
  });
}

function normalizeApp(input, current = null) {
  const value = {
    name: input.name === undefined ? current?.name : requiredText(input.name, "name", 160),
    appId: input.metaAppId === undefined ? current?.appId : requiredText(input.metaAppId, "metaAppId", 120),
    mode: input.mode === undefined ? (current?.mode || "own") : normalizeMode(input.mode),
    state: input.state === undefined ? (current?.state || "pending") : normalizeState(input.state),
    appSecretCredentialId: input.appSecretCredentialId === undefined
      ? current?.appSecretCredentialId || null
      : optionalUuid(input.appSecretCredentialId, "appSecretCredentialId"),
    previousAppSecretCredentialId: input.previousAppSecretCredentialId === undefined
      ? current?.previousAppSecretCredentialId || null
      : optionalUuid(input.previousAppSecretCredentialId, "previousAppSecretCredentialId"),
    appSecretRotatedAt: input.appSecretRotatedAt === undefined
      ? current?.appSecretRotatedAt || null
      : optionalDate(input.appSecretRotatedAt, "appSecretRotatedAt"),
    previousAppSecretValidUntil: input.previousAppSecretValidUntil === undefined
      ? current?.previousAppSecretValidUntil || null
      : optionalDate(input.previousAppSecretValidUntil, "previousAppSecretValidUntil"),
    verifyTokenCredentialId: input.verifyTokenCredentialId === undefined
      ? current?.verifyTokenCredentialId || null
      : optionalUuid(input.verifyTokenCredentialId, "verifyTokenCredentialId"),
  };
  if (!value.name) throw new TypeError("name é obrigatório.");
  if (!value.appId) throw new TypeError("metaAppId é obrigatório.");
  if (current && (value.mode === "ycloud") !== (current.mode === "ycloud")) throw new TypeError("Crie uma nova conexão para trocar o provedor.");
  if (value.mode === "ycloud" && (value.verifyTokenCredentialId || value.previousAppSecretCredentialId)) {
    throw new TypeError("YCloud usa somente o segredo de assinatura do webhook.");
  }
  if (value.mode === "ycloud" && value.state === "active" && !value.appSecretCredentialId) {
    throw new TypeError("YCloud exige segredo de assinatura no cofre.");
  }
  const rotationValues = [
    value.previousAppSecretCredentialId,
    value.appSecretRotatedAt,
    value.previousAppSecretValidUntil,
  ];
  if (!rotationValues.every(Boolean) && rotationValues.some(Boolean)) {
    throw new TypeError("A credencial anterior, a data de rotação e sua validade devem ser informadas juntas.");
  }
  if (value.appSecretRotatedAt && value.previousAppSecretValidUntil <= value.appSecretRotatedAt) {
    throw new TypeError("A validade da credencial anterior deve ser posterior à rotação.");
  }
  if (value.mode === "shared" && (
    value.appSecretCredentialId
    || value.previousAppSecretCredentialId
    || value.appSecretRotatedAt
    || value.previousAppSecretValidUntil
    || value.verifyTokenCredentialId
  )) {
    throw new TypeError("Aplicativos compartilhados usam credenciais da infraestrutura.");
  }
  if (value.mode === "own" && value.state === "active"
    && (!value.appSecretCredentialId || !value.verifyTokenCredentialId)) {
    throw new TypeError("Aplicativo próprio ativo exige App Secret e verify token no cofre.");
  }
  return Object.freeze(value);
}

async function assertCredentialPurposes(client, empresaId, requirements) {
  const ids = [...new Set(requirements.map(({ id }) => id).filter(Boolean))];
  if (!ids.length) return;
  const rows = (await client.query(
    `SELECT id, provedor, finalidade, status
       FROM credenciais_empresa
      WHERE empresa_id = $1 AND id = ANY($2::uuid[])`,
    [empresaId, ids],
  )).rows;
  const records = new Map(rows.map((row) => [row.id, row]));
  const invalid = requirements.some(({ id, purposes, provider = "meta" }) => {
    if (!id) return false;
    const row = records.get(id);
    return !row || row.provedor !== provider || row.status !== "ativa" || !purposes.includes(row.finalidade);
  });
  if (invalid) {
    throw repositoryError(
      "META_CREDENTIAL_INVALID",
      "Uma referência não pertence a uma credencial Meta ativa desta empresa.",
    );
  }
}

function appCredentialRequirements(app) {
  if (app.mode === "ycloud") return [{ id: app.appSecretCredentialId, provider: "ycloud", purposes: ["ycloud-webhook-secret"] }];
  return [
    { id: app.appSecretCredentialId, purposes: CREDENTIAL_PURPOSES.appSecret },
    { id: app.previousAppSecretCredentialId, purposes: CREDENTIAL_PURPOSES.appSecret },
    { id: app.verifyTokenCredentialId, purposes: CREDENTIAL_PURPOSES.verifyToken },
  ];
}

function sanitizeText(value) {
  if (value == null || value === "") return null;
  let text = String(value).replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  text = text
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/\b(access[_-]?token|app[_-]?secret|verify[_-]?token|authorization|password|senha)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]")
    .replace(/\bsha256=[0-9a-f]{32,}\b/giu, "sha256=[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/gu, "[REDACTED]");
  if (!text) text = "Falha externa sanitizada.";
  return text.slice(0, 1000);
}

function sanitizeExternalError(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "object" || Array.isArray(value)) return sanitizeText(value);
  const sanitized = {
    code: (sanitizeText(value.code) || "META_EXTERNAL_FAILURE").slice(0, 120),
    message: (sanitizeText(value.message) || "Falha externa sanitizada.").slice(0, 600),
  };
  if (value.providerCode != null) sanitized.providerCode = sanitizeText(value.providerCode)?.slice(0, 120);
  if (value.status != null) {
    const status = Number(value.status);
    if (Number.isInteger(status) && status >= 100 && status <= 599) sanitized.status = status;
  }
  return JSON.stringify(sanitized);
}

function deserializeSanitizedError(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return Object.freeze(parsed);
  } catch {
    // Registros textuais anteriores permanecem legíveis.
  }
  return value;
}

async function writeAudit(client, {
  empresaId,
  actorId = null,
  action,
  resource,
  resourceId,
  changedFields,
  correlationId = null,
  occurredAt = new Date(),
}) {
  await client.query(
    `INSERT INTO logs_auditoria
       (id, empresa_id, ator_usuario_id, acao, recurso_tipo, recurso_id,
        resultado, campos_alterados_redigidos, correlation_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,'sucesso',$7::jsonb,$8,$9)`,
    [
      randomUUID(), empresaId, actorId, action, resource, String(resourceId),
      JSON.stringify({ fields: changedFields }), correlationId, occurredAt,
    ],
  );
}

export class PostgresMetaAppRepository {
  constructor(pool, {
    tenantTransactionRunner = withTenantTransaction,
    platformTransactionRunner = withPlatformTransaction,
    idGenerator = randomUUID,
    webhookIdGenerator = randomUUID,
  } = {}) {
    if (!pool?.connect) throw new TypeError("Pool PostgreSQL é obrigatório.");
    if (typeof tenantTransactionRunner !== "function" || typeof platformTransactionRunner !== "function") {
      throw new TypeError("Runners transacionais PostgreSQL são obrigatórios.");
    }
    this.pool = pool;
    this.tenantTransactionRunner = tenantTransactionRunner;
    this.platformTransactionRunner = platformTransactionRunner;
    this.idGenerator = idGenerator;
    this.webhookIdGenerator = webhookIdGenerator;
  }

  async createApp({
    empresaId,
    name,
    metaAppId,
    mode = "own",
    state = "pending",
    appSecretCredentialId = null,
    previousAppSecretCredentialId = null,
    appSecretRotatedAt = null,
    previousAppSecretValidUntil = null,
    verifyTokenCredentialId = null,
    actorId = null,
    correlationId = null,
    createdAt = new Date(),
    transaction = null,
  }) {
    const tenantId = requiredUuid(empresaId, "empresaId");
    const app = normalizeApp({
      name, metaAppId, mode, state, appSecretCredentialId,
      previousAppSecretCredentialId, appSecretRotatedAt,
      previousAppSecretValidUntil, verifyTokenCredentialId,
    });
    const persist = async (tx) => {
      const { client } = assertTenantTransaction(tx, tenantId);
      await assertCredentialPurposes(client, tenantId, appCredentialRequirements(app));
      const row = (await client.query(
        `INSERT INTO aplicativos_meta
           (id, empresa_id, nome, app_id, modo, webhook_public_id, estado,
            app_secret_credencial_id, app_secret_anterior_credencial_id,
            app_secret_rotacionado_at, app_secret_anterior_valido_ate,
            verify_token_credencial_id,
            revision, created_by, updated_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$13,$14,$14)
         RETURNING *`,
        [
          this.idGenerator(), tenantId, app.name, app.appId, MODE_TO_DB[app.mode],
          this.webhookIdGenerator(), STATE_TO_DB[app.state], app.appSecretCredentialId,
          app.previousAppSecretCredentialId, app.appSecretRotatedAt,
          app.previousAppSecretValidUntil, app.verifyTokenCredentialId, actorId, createdAt,
        ],
      )).rows[0];
      await writeAudit(client, {
        empresaId: tenantId,
        actorId,
        action: "meta.app.create",
        resource: "meta_app",
        resourceId: row.id,
        changedFields: ["name", "app_id", "mode", "state", "credential_references"],
        correlationId,
        occurredAt: createdAt,
      });
      return mapApp(row);
    };
    if (transaction) return persist(transaction);
    return this.tenantTransactionRunner(this.pool, { empresaId: tenantId, usuarioId: actorId || undefined }, persist);
  }

  findAppById({ empresaId, appId, transaction = null }) {
    const tenantId = requiredUuid(empresaId, "empresaId");
    const internalId = requiredUuid(appId, "appId");
    const find = async (tx) => mapApp((await assertTenantTransaction(tx, tenantId).client.query(
      `SELECT * FROM aplicativos_meta
        WHERE empresa_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [tenantId, internalId],
    )).rows[0]);
    if (transaction) return find(transaction);
    return this.tenantTransactionRunner(this.pool, { empresaId: tenantId }, find);
  }

  findAppByWebhookPublicId(input) {
    const webhookPublicId = typeof input === "string" ? input : input?.webhookPublicId;
    return this.resolveByWebhookPublicId({ webhookPublicId }).then((resolved) => resolved?.app || null);
  }

  resolveByWebhookPublicId(input) {
    const webhookPublicId = typeof input === "string" ? input : input?.webhookPublicId;
    const publicId = requiredUuid(webhookPublicId, "webhookPublicId");
    return this.platformTransactionRunner(this.pool, {}, async ({ client }) => {
      const app = mapApp((await client.query(
        `SELECT * FROM aplicativos_meta
          WHERE webhook_public_id = $1 AND deleted_at IS NULL
          LIMIT 1`,
        [publicId],
      )).rows[0]);
      if (!app) return null;
      const numbers = (await client.query(
        `SELECT * FROM numeros_whatsapp
          WHERE empresa_id = $1 AND aplicativo_meta_id = $2
            AND status = 'ativo' AND deleted_at IS NULL
            AND access_token_credencial_id IS NOT NULL
          ORDER BY principal DESC, created_at, id`,
        [app.empresaId, app.id],
      )).rows.map(mapNumber);
      return Object.freeze({ ...app, app, numbers: Object.freeze(numbers) });
    });
  }

  listApps({ empresaId }) {
    const tenantId = requiredUuid(empresaId, "empresaId");
    return this.tenantTransactionRunner(this.pool, { empresaId: tenantId }, async ({ client }) => Object.freeze(
      (await client.query(
        `SELECT * FROM aplicativos_meta
          WHERE empresa_id = $1 AND deleted_at IS NULL
          ORDER BY created_at, id`,
        [tenantId],
      )).rows.map(mapApp),
    ));
  }

  async updateApp({
    empresaId,
    id,
    expectedRevision,
    actorId = null,
    correlationId = null,
    updatedAt = new Date(),
    transaction = null,
    ...changes
  }) {
    const tenantId = requiredUuid(empresaId, "empresaId");
    const appId = requiredUuid(id, "id");
    const revision = positiveRevision(expectedRevision);
    const update = async (tx) => {
      const { client } = assertTenantTransaction(tx, tenantId);
      const current = mapApp((await client.query(
        `SELECT * FROM aplicativos_meta
          WHERE empresa_id = $1 AND id = $2 AND deleted_at IS NULL
          FOR UPDATE`,
        [tenantId, appId],
      )).rows[0]);
      if (!current) throw repositoryError("META_APP_NOT_FOUND", "Aplicativo Meta não encontrado.");
      if (current.revision !== revision) {
        throw repositoryError("META_APP_CONFLICT", `A revisão atual do aplicativo é ${current.revision}.`);
      }
      const next = normalizeApp(changes, current);
      await assertCredentialPurposes(client, tenantId, appCredentialRequirements(next));
      const row = (await client.query(
        `UPDATE aplicativos_meta
            SET nome = $4,
                app_id = $5,
                modo = $6,
                estado = $7,
                app_secret_credencial_id = $8,
                app_secret_anterior_credencial_id = $9,
                app_secret_rotacionado_at = $10,
                app_secret_anterior_valido_ate = $11,
                verify_token_credencial_id = $12,
                revision = revision + 1,
                updated_by = $13,
                updated_at = $14
          WHERE empresa_id = $1 AND id = $2 AND revision = $3 AND deleted_at IS NULL
          RETURNING *`,
        [
          tenantId, appId, revision, next.name, next.appId, MODE_TO_DB[next.mode],
          STATE_TO_DB[next.state], next.appSecretCredentialId,
          next.previousAppSecretCredentialId, next.appSecretRotatedAt,
          next.previousAppSecretValidUntil, next.verifyTokenCredentialId, actorId, updatedAt,
        ],
      )).rows[0];
      if (!row) throw repositoryError("META_APP_CONFLICT", "Aplicativo Meta foi alterado concorrentemente.");
      const changedFields = Object.keys(changes).filter((key) => changes[key] !== undefined);
      await writeAudit(client, {
        empresaId: tenantId,
        actorId,
        action: "meta.app.update",
        resource: "meta_app",
        resourceId: appId,
        changedFields,
        correlationId,
        occurredAt: updatedAt,
      });
      return mapApp(row);
    };
    if (transaction) return update(transaction);
    return this.tenantTransactionRunner(this.pool, { empresaId: tenantId, usuarioId: actorId || undefined }, update);
  }

  async bindNumber({
    empresaId,
    numberId,
    metaAppId,
    accessTokenCredentialId,
    expectedRevision,
    actorId = null,
    correlationId = null,
    updatedAt = new Date(),
    transaction = null,
  }) {
    const tenantId = requiredUuid(empresaId, "empresaId");
    const internalNumberId = requiredUuid(numberId, "numberId");
    const internalAppId = requiredUuid(metaAppId, "metaAppId");
    const credentialId = requiredUuid(accessTokenCredentialId, "accessTokenCredentialId");
    const revision = positiveRevision(expectedRevision);
    const bind = async (tx) => {
      const { client } = assertTenantTransaction(tx, tenantId);
      const app = (await client.query(
        `SELECT id, modo FROM aplicativos_meta
          WHERE empresa_id = $1 AND id = $2 AND deleted_at IS NULL AND estado <> 'revogado'`,
        [tenantId, internalAppId],
      )).rows[0];
      if (!app) throw repositoryError("META_APP_NOT_FOUND", "Aplicativo Meta não encontrado.");
      await assertCredentialPurposes(client, tenantId, [{
        id: credentialId,
        provider: app.modo === "ycloud" ? "ycloud" : "meta",
        purposes: [
          ...(app.modo === "ycloud" ? ["ycloud-api-key"] : [...CREDENTIAL_PURPOSES.accessToken, `whatsapp:${internalNumberId}`]),
        ],
      }]);
      const row = (await client.query(
        `UPDATE numeros_whatsapp
            SET aplicativo_meta_id = $4,
                access_token_credencial_id = $5,
                meta_binding_revision = meta_binding_revision + 1,
                updated_at = $6
          WHERE empresa_id = $1 AND id = $2 AND meta_binding_revision = $3
            AND deleted_at IS NULL
          RETURNING *`,
        [tenantId, internalNumberId, revision, internalAppId, credentialId, updatedAt],
      )).rows[0];
      if (!row) {
        const existing = (await client.query(
          `SELECT id, meta_binding_revision FROM numeros_whatsapp
            WHERE empresa_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [tenantId, internalNumberId],
        )).rows[0];
        if (!existing) throw repositoryError("META_NUMBER_NOT_FOUND", "Número WhatsApp não encontrado.");
        throw repositoryError("META_NUMBER_CONFLICT", `A revisão atual do vínculo é ${Number(existing.meta_binding_revision)}.`);
      }
      await writeAudit(client, {
        empresaId: tenantId,
        actorId,
        action: "meta.number.bind",
        resource: "whatsapp_number",
        resourceId: internalNumberId,
        changedFields: ["meta_app_id", "access_token_credential_id", "binding_revision"],
        correlationId,
        occurredAt: updatedAt,
      });
      return mapNumber(row);
    };
    if (transaction) return bind(transaction);
    return this.tenantTransactionRunner(this.pool, { empresaId: tenantId, usuarioId: actorId || undefined }, bind);
  }

  findNumberBinding({ empresaId, numberId, transaction = null }) {
    const tenantId = requiredUuid(empresaId, "empresaId");
    const internalNumberId = requiredUuid(numberId, "numberId");
    const find = async (tx) => mapNumber((await assertTenantTransaction(tx, tenantId).client.query(
      `SELECT * FROM numeros_whatsapp
        WHERE empresa_id = $1 AND id = $2 AND deleted_at IS NULL
          AND aplicativo_meta_id IS NOT NULL
          AND access_token_credencial_id IS NOT NULL`,
      [tenantId, internalNumberId],
    )).rows[0]);
    if (transaction) return find(transaction);
    return this.tenantTransactionRunner(this.pool, { empresaId: tenantId }, find);
  }

  async recordHealthCheck({
    empresaId,
    appId,
    expectedRevision,
    testedAt = new Date(),
    success,
    state,
    errorSanitized = null,
    actorId = null,
    correlationId = null,
    transaction = null,
  }) {
    const tenantId = requiredUuid(empresaId, "empresaId");
    const internalAppId = requiredUuid(appId, "appId");
    const revision = positiveRevision(expectedRevision);
    if (typeof success !== "boolean") throw new TypeError("success deve ser booleano.");
    const nextState = state == null ? null : normalizeState(state);
    const sanitized = success ? null : sanitizeExternalError(errorSanitized || "Falha externa sanitizada.");
    const occurredAt = optionalDate(testedAt, "testedAt");
    const record = async (tx) => {
      const { client } = assertTenantTransaction(tx, tenantId);
      const row = (await client.query(
        `UPDATE aplicativos_meta am
            SET ultimo_teste_at = $4,
                ultimo_erro_sanitizado = $5,
                ultimo_erro_expires_at = CASE
                  WHEN $5::text IS NULL THEN NULL
                  ELSE $4::timestamptz + make_interval(days => e.retencao_logs_dias)
                END,
                estado = COALESCE($6, am.estado),
                revision = am.revision + 1,
                updated_at = $4
           FROM empresas e
          WHERE am.empresa_id = $1 AND am.id = $2 AND am.deleted_at IS NULL
            AND am.revision = $3
            AND e.id = am.empresa_id
          RETURNING am.*`,
        [
          tenantId, internalAppId, revision, occurredAt, sanitized,
          nextState ? STATE_TO_DB[nextState] : null,
        ],
      )).rows[0];
      if (!row) {
        const current = (await client.query(
          `SELECT revision FROM aplicativos_meta
            WHERE empresa_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [tenantId, internalAppId],
        )).rows[0];
        if (!current) throw repositoryError("META_APP_NOT_FOUND", "Aplicativo Meta não encontrado.");
        throw repositoryError("META_APP_CONFLICT", `A revisão atual do aplicativo é ${Number(current.revision)}.`);
      }
      await writeAudit(client, {
        empresaId: tenantId,
        actorId,
        action: success ? "meta.app.health.success" : "meta.app.health.failure",
        resource: "meta_app",
        resourceId: internalAppId,
        changedFields: ["last_test_at", "last_error_sanitized", "state"],
        correlationId,
        occurredAt,
      });
      return mapApp(row);
    };
    if (transaction) return record(transaction);
    return this.tenantTransactionRunner(this.pool, { empresaId: tenantId, usuarioId: actorId || undefined }, record);
  }

  async recordValidWebhook({ empresaId, appId, receivedAt = new Date(), transaction = null }) {
    const tenantId = requiredUuid(empresaId, "empresaId");
    const internalAppId = requiredUuid(appId, "appId");
    const occurredAt = optionalDate(receivedAt, "receivedAt");
    const record = async (tx) => {
      const row = (await assertTenantTransaction(tx, tenantId).client.query(
        `UPDATE aplicativos_meta
            SET ultimo_webhook_valido_at = GREATEST(
                  COALESCE(ultimo_webhook_valido_at, '-infinity'::timestamptz),
                  $3::timestamptz
                ),
                updated_at = GREATEST(updated_at, $3::timestamptz)
          WHERE empresa_id = $1 AND id = $2 AND deleted_at IS NULL
          RETURNING *`,
        [tenantId, internalAppId, occurredAt],
      )).rows[0];
      if (!row) throw repositoryError("META_APP_NOT_FOUND", "Aplicativo Meta não encontrado.");
      return mapApp(row);
    };
    if (transaction) return record(transaction);
    return this.tenantTransactionRunner(this.pool, { empresaId: tenantId }, record);
  }

  clearExpiredErrors({ empresaId, before = new Date(), limit = 100 }) {
    const tenantId = requiredUuid(empresaId, "empresaId");
    const cutoff = optionalDate(before, "before");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError("limit deve ser um inteiro entre 1 e 1000.");
    }
    return this.tenantTransactionRunner(this.pool, { empresaId: tenantId }, async ({ client }) => {
      const rows = (await client.query(
        `WITH expired AS MATERIALIZED (
           SELECT empresa_id, id
             FROM aplicativos_meta
            WHERE empresa_id = $1
              AND ultimo_erro_sanitizado IS NOT NULL
              AND ultimo_erro_expires_at <= $2
            ORDER BY ultimo_erro_expires_at, id
            LIMIT $3
            FOR UPDATE SKIP LOCKED
         )
         UPDATE aplicativos_meta am
            SET ultimo_erro_sanitizado = NULL,
                ultimo_erro_expires_at = NULL
           FROM expired
          WHERE am.empresa_id = expired.empresa_id AND am.id = expired.id
         RETURNING am.id`,
        [tenantId, cutoff, limit],
      )).rows;
      return Object.freeze(rows.map((row) => row.id));
    });
  }
}

export { sanitizeExternalError };
