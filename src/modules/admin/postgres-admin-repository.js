import { hashPassword } from "../auth/password.js";
import { withPlatformTransaction, withTenantTransaction } from "../../infra/postgres/transaction.js";
import { AdminForbiddenError, AdminValidationError } from "./errors.js";

const TENANT_STATUS_TO_DB = Object.freeze({ draft: "rascunho", active: "ativa", suspended: "suspensa", archived: "arquivada" });
const TENANT_STATUS_FROM_DB = Object.freeze(Object.fromEntries(Object.entries(TENANT_STATUS_TO_DB).map(([key, value]) => [value, key])));
const USER_STATUS_TO_DB = Object.freeze({ active: "ativo", blocked: "bloqueado", disabled: "desativado" });
const USER_STATUS_FROM_DB = Object.freeze(Object.fromEntries(Object.entries(USER_STATUS_TO_DB).map(([key, value]) => [value, key])));
const MEMBER_ROLE_TO_DB = Object.freeze({ tenant_admin: "administrador", tenant_operator: "operador" });
const MEMBER_ROLE_FROM_DB = Object.freeze(Object.fromEntries(Object.entries(MEMBER_ROLE_TO_DB).map(([key, value]) => [value, key])));
const MEMBER_STATUS_TO_DB = Object.freeze({ active: "ativo", suspended: "suspenso" });
const MEMBER_STATUS_FROM_DB = Object.freeze(Object.fromEntries(Object.entries(MEMBER_STATUS_TO_DB).map(([key, value]) => [value, key])));

const mapValue = (mapping) => (value) => mapping[value] || value;
const toTenantStatus = mapValue(TENANT_STATUS_TO_DB);
const fromTenantStatus = mapValue(TENANT_STATUS_FROM_DB);
const toUserStatus = mapValue(USER_STATUS_TO_DB);
const fromUserStatus = mapValue(USER_STATUS_FROM_DB);
const toMemberRole = mapValue(MEMBER_ROLE_TO_DB);
const fromMemberRole = mapValue(MEMBER_ROLE_FROM_DB);
const toMemberStatus = mapValue(MEMBER_STATUS_TO_DB);
const fromMemberStatus = mapValue(MEMBER_STATUS_FROM_DB);

const commonDates = { createdAt: "created_at", updatedAt: "updated_at" };

function descriptor({ table, alias = "r", id = "id", fields, select = {}, filters = {}, sorts = {}, search = [], softDelete = false, singleton = false }) {
  return Object.freeze({ table, alias, id, fields: Object.freeze(fields), select: Object.freeze({ id, empresaId: "empresa_id", ...fields, ...commonDates, ...select }), filters: Object.freeze(filters), sorts: Object.freeze(sorts), search: Object.freeze(search), softDelete, singleton });
}

const RESOURCES = Object.freeze({
  memberships: descriptor({
    table: "usuarios_empresas", id: "usuario_id",
    fields: { userId: "usuario_id", role: "papel", status: "status", permissions: "permissoes" },
    select: { id: "usuario_id", role: "papel", status: "status", permissions: "permissoes" },
    filters: { role: "papel", status: "status", userId: "usuario_id" }, sorts: { createdAt: "created_at", userId: "usuario_id" },
  }),
  numbers: descriptor({
    table: "numeros_whatsapp", fields: { phoneNumberId: "phone_number_id", wabaId: "waba_id", numeroE164: "numero_e164", numeroMascarado: "numero_mascarado", nomeVerificado: "nome_verificado", status: "status", principal: "principal" },
    filters: { status: "status", principal: "principal" }, sorts: { createdAt: "created_at", status: "status", nomeVerificado: "nome_verificado" }, search: ["phone_number_id", "numero_mascarado", "nome_verificado"], softDelete: true,
  }),
  credentials: descriptor({
    table: "credenciais_empresa", fields: {}, select: {
      provider: "provedor", purpose: "finalidade", status: "status",
      maskedSecret: "valor_mascarado", keyVersion: "key_version",
      secretVersion: "secret_version", revokedAt: "revoked_at",
    },
    filters: { provider: "provedor", status: "status" }, sorts: { createdAt: "created_at", provider: "provedor", status: "status" },
  }),
  "ai-config": descriptor({
    table: "configuracoes_ia", id: "empresa_id", singleton: true,
    fields: { enabled: "habilitada", provider: "provedor", model: "modelo", prompt: "prompt", personality: "personalidade", keyType: "tipo_chave", ownCredentialId: "credencial_propria_id", monthlyTokenLimit: "limite_tokens_mensal", monthlyCostLimit: "limite_custo_mensal", alertPercent: "alerta_percentual", maxHistoryMessages: "max_historico_mensagens", maxOutputTokens: "max_output_tokens", fallbackMessage: "mensagem_contingencia" },
    select: { id: "empresa_id" }, sorts: { updatedAt: "updated_at" },
  }),
  "runtime-config": descriptor({
    table: "configuracoes_empresa", id: "empresa_id", singleton: true,
    fields: { greeting: "saudacao", fallbackMessage: "mensagem_fallback", address: "endereco", menuUrl: "link_cardapio", birthdayRule: "regra_aniversariante", schedules: "horarios", publicReplies: "respostas_publicas", routing: "roteamento" },
    select: { id: "empresa_id" }, sorts: { updatedAt: "updated_at" },
  }),
  modules: descriptor({
    table: "modulos_empresa", id: "module_key", fields: { moduleKey: "module_key", enabled: "habilitado", configuration: "configuracao" },
    select: { id: "module_key" }, filters: { enabled: "habilitado", moduleKey: "module_key" }, sorts: { moduleKey: "module_key", updatedAt: "updated_at" },
  }),
  menus: descriptor({
    table: "menus", fields: { menuKey: "menu_key", title: "titulo", message: "mensagem", active: "ativo", version: "version" },
    filters: { active: "ativo", menuKey: "menu_key" }, sorts: { menuKey: "menu_key", createdAt: "created_at", updatedAt: "updated_at" }, softDelete: true,
  }),
  "menu-items": descriptor({
    table: "menu_itens", fields: { menuId: "menu_id", position: "posicao", title: "titulo", actionType: "action_type", actionKey: "action_key", configuration: "configuracao", enabled: "ativo" },
    filters: { menuId: "menu_id", enabled: "ativo" }, sorts: { position: "posicao", createdAt: "created_at", updatedAt: "updated_at" },
  }),
  catalog: descriptor({
    table: "produtos_servicos", fields: { type: "tipo", sku: "sku", name: "nome", description: "descricao", price: "preco", currency: "moeda", stockControl: "controle_estoque", availableQuantity: "quantidade_disponivel", active: "ativo" },
    filters: { type: "tipo", active: "ativo" }, sorts: { name: "nome", price: "preco", createdAt: "created_at", updatedAt: "updated_at" }, search: ["nome", "sku", "descricao"], softDelete: true,
  }),
  events: descriptor({
    table: "eventos", fields: { externalSource: "origem_externa", externalId: "external_id", name: "nome", attractions: "atracoes", startsAt: "inicio_at", endsAt: "fim_at", timezone: "timezone", location: "local", birthdayRule: "regra_vip", notes: "observacoes", capacity: "capacidade", status: "status" },
    filters: { status: "status", from: "inicio_at", to: "inicio_at" }, sorts: { startsAt: "inicio_at", name: "nome", createdAt: "created_at" }, search: ["nome", "atracoes", "local"], softDelete: true,
  }),
  orders: descriptor({
    table: "pedidos", fields: { status: "status", paymentStatus: "pagamento_status", integrationStatus: "integracao_status" },
    select: { contactId: "contato_id", conversationId: "conversa_id", receiptMessageId: "comprovante_mensagem_id", buyerName: "nome_comprador", total: "total", currency: "moeda" },
    filters: { status: "status", paymentStatus: "pagamento_status", contactId: "contato_id", conversationId: "conversa_id", from: "created_at", to: "created_at" }, sorts: { createdAt: "created_at", updatedAt: "updated_at", status: "status", total: "total" }, softDelete: true,
  }),
  appointments: descriptor({
    table: "agendamentos", fields: { status: "status", notes: "observacoes", operatorId: "operador_usuario_id" },
    select: { contactId: "contato_id", conversationId: "conversa_id", startsAt: "inicio_at", endsAt: "fim_at" },
    filters: { status: "status", contactId: "contato_id", conversationId: "conversa_id", from: "inicio_at", to: "inicio_at" }, sorts: { startsAt: "inicio_at", createdAt: "created_at", status: "status" }, softDelete: true,
  }),
  contacts: descriptor({
    table: "contatos", fields: { name: "nome", consentStatus: "consentimento_status", botPaused: "bot_pausado", blocked: "bloqueado", deletionRequestedAt: "exclusao_solicitada_at" },
    select: { phoneMasked: "telefone_mascarado", firstInteractionAt: "primeira_interacao_at", lastInteractionAt: "ultima_interacao_at", anonymizedAt: "anonimizado_at" },
    filters: { botPaused: "bot_pausado", blocked: "bloqueado", consentStatus: "consentimento_status" }, sorts: { lastInteractionAt: "ultima_interacao_at", firstInteractionAt: "primeira_interacao_at", name: "nome", createdAt: "created_at" }, search: ["nome", "telefone_mascarado"], softDelete: true,
  }),
  conversations: descriptor({
    table: "conversas", fields: { status: "status", mode: "modo_atendimento", operatorId: "operador_usuario_id" },
    select: { contactId: "contato_id", numberId: "numero_whatsapp_id", lastMessageAt: "ultima_mensagem_at", correlationId: "correlation_id" },
    filters: { status: "status", mode: "modo_atendimento", contactId: "contato_id", numberId: "numero_whatsapp_id" }, sorts: { lastMessageAt: "ultima_mensagem_at", createdAt: "created_at", status: "status" }, search: ["correlation_id::text"],
  }),
  messages: descriptor({
    table: "mensagens", fields: {}, select: { conversationId: "conversa_id", contactId: "contato_id", direction: "direcao", type: "tipo", body: "corpo", mediaMimeType: "media_mime_type", mediaSizeBytes: "media_size_bytes", mediaSha256: "media_sha256", externalMessageId: "external_message_id", status: "status", responseOrigin: "origem_resposta", operatorId: "operador_usuario_id", sequence: "sequence", attempts: "tentativas", error: "error_sanitized", correlationId: "correlation_id" },
    filters: { conversationId: "conversa_id", contactId: "contato_id", status: "status", direction: "direcao", type: "tipo", correlationId: "correlation_id", from: "created_at", to: "created_at" }, sorts: { createdAt: "created_at", sequence: "sequence", status: "status" },
  }),
  logs: descriptor({
    table: "logs_operacionais", fields: {}, select: { severity: "severidade", category: "categoria", service: "servico", eventCode: "event_code", correlationId: "correlation_id", conversationId: "conversa_id", messageId: "mensagem_id", summary: "resumo_sanitizado", metadata: "metadata_sanitized", occurredAt: "occurred_at" },
    filters: { severity: "severidade", category: "categoria", service: "servico", correlationId: "correlation_id", conversationId: "conversa_id", messageId: "mensagem_id", from: "occurred_at", to: "occurred_at" }, sorts: { occurredAt: "occurred_at", severity: "severidade", createdAt: "created_at" },
  }),
  audit: descriptor({
    table: "logs_auditoria", fields: {}, select: { actorId: "ator_usuario_id", action: "acao", resource: "recurso_tipo", resourceId: "recurso_id", result: "resultado", changedFields: "campos_alterados_redigidos", correlationId: "correlation_id", occurredAt: "occurred_at" },
    filters: { action: "acao", result: "resultado", actorId: "ator_usuario_id", from: "occurred_at", to: "occurred_at" }, sorts: { occurredAt: "occurred_at", action: "acao", result: "resultado" },
  }),
  "ai-usage": descriptor({
    table: "uso_ia", fields: {}, select: { conversationId: "conversa_id", model: "modelo", keyType: "tipo_chave", inputTokens: "input_tokens", outputTokens: "output_tokens", totalTokens: "total_tokens", estimatedCost: "custo_estimado", success: "sucesso", error: "error_sanitized", occurredAt: "occurred_at" },
    filters: { model: "modelo", keyType: "tipo_chave", success: "sucesso", conversationId: "conversa_id", from: "occurred_at", to: "occurred_at" }, sorts: { occurredAt: "occurred_at", totalTokens: "total_tokens", estimatedCost: "custo_estimado" },
  }),
  integrations: descriptor({
    table: "integracoes", fields: { type: "tipo", name: "nome", enabled: "habilitada", requiredForConfirmation: "obrigatoria_para_confirmacao", status: "status", configuration: "configuracao" },
    select: { lastAttemptAt: "last_attempt_at", lastSuccessAt: "last_success_at", lastError: "last_error_sanitized" },
    filters: { type: "tipo", enabled: "habilitada", status: "status" }, sorts: { createdAt: "created_at", name: "nome", status: "status" }, softDelete: true,
  }),
  payments: descriptor({
    table: "formas_pagamento", fields: { type: "tipo", name: "nome", maskedIdentifier: "identificador_mascarado", recipient: "favorecido", instructions: "instrucoes", credentialId: "credencial_id", enabled: "ativa" },
    filters: { type: "tipo", enabled: "ativa" }, sorts: { createdAt: "created_at", name: "nome", type: "tipo" }, softDelete: true,
  }),
  availability: descriptor({
    table: "disponibilidades_servico", fields: { productServiceId: "produto_servico_id", startsAt: "inicio_at", endsAt: "fim_at", capacity: "capacidade", reserved: "reservados", status: "status" },
    filters: { productServiceId: "produto_servico_id", status: "status", from: "inicio_at", to: "inicio_at" }, sorts: { startsAt: "inicio_at", createdAt: "created_at", updatedAt: "updated_at" }, softDelete: true,
  }),
});

function quoteIdentifier(value) { return `"${String(value).replaceAll('"', '""')}"`; }
function qualified(alias, expression) {
  if (expression.startsWith("'") || expression.includes("::")) return expression.replace(/^([a-z_]+)/u, `${alias}.$1`);
  return `${alias}.${expression}`;
}
function selectSql(definition) {
  return Object.entries(definition.select).map(([name, column]) => `${qualified(definition.alias, column)} AS ${quoteIdentifier(name)}`).join(", ");
}
function decodeBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}
function outputRow(resource, row) {
  if (!row) return null;
  const result = { ...row };
  if (resource === "memberships") { result.role = fromMemberRole(result.role); result.status = fromMemberStatus(result.status); }
  if (resource === "users") { result.status = fromUserStatus(result.status); result.role = fromMemberRole(result.role); }
  return result;
}
function inputValue(resource, field, value) {
  if (resource === "memberships" && field === "role") return toMemberRole(value);
  if (resource === "memberships" && field === "status") return toMemberStatus(value);
  if (resource === "users" && field === "status") return toUserStatus(value);
  return value;
}
function resourceDefinition(resource) {
  const definition = RESOURCES[resource];
  if (!definition) throw new TypeError("Recurso administrativo não suportado pelo PostgreSQL.");
  return definition;
}

function useTenantTransaction(pool, { empresaId, transaction }, callback) {
  if (transaction) {
    if (!transaction?.client?.query || (!transaction.isPlatformAdmin && transaction.tenantId !== empresaId)) {
      throw new TypeError("Transação administrativa incompatível com a empresa.");
    }
    return callback(transaction);
  }
  return withTenantTransaction(pool, { empresaId }, callback);
}

function usePlatformTransaction(pool, { transaction }, callback) {
  if (transaction) {
    if (!transaction?.client?.query || !transaction.isPlatformAdmin) {
      throw new TypeError("A operação exige uma transação administrativa da plataforma.");
    }
    return callback(transaction);
  }
  return withPlatformTransaction(pool, {}, callback);
}
function baseConditions(definition, empresaId, params) {
  params.push(empresaId);
  const conditions = [`${definition.alias}.empresa_id = $${params.length}`];
  if (definition.softDelete) conditions.push(`${definition.alias}.deleted_at IS NULL`);
  return conditions;
}
function filterConditions(definition, filters, params) {
  const conditions = [];
  for (const [name, raw] of Object.entries(filters || {})) {
    if (name === "search") {
      if (!definition.search.length) continue;
      params.push(`%${String(raw).replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
      conditions.push(`(${definition.search.map((column) => `${qualified(definition.alias, column)} ILIKE $${params.length} ESCAPE '\\'`).join(" OR ")})`);
      continue;
    }
    const column = definition.filters[name];
    if (!column) continue;
    params.push(decodeBoolean(raw));
    const operator = name === "from" ? ">=" : name === "to" ? "<=" : "=";
    conditions.push(`${qualified(definition.alias, column)} ${operator} $${params.length}`);
  }
  return conditions;
}
function paginationMeta(total, page, pageSize) { return { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }; }

const FAILED_JOB_SELECT = `
  f.id,
  f.job_type AS "jobType",
  f.conversa_id AS "conversationId",
  f.mensagem_id AS "messageId",
  f.tentativas AS attempts,
  f.max_tentativas AS "maxAttempts",
  f.error_code AS "errorCode",
  f.error_sanitized AS error,
  f.correlation_id AS "correlationId",
  f.first_failure_at AS "firstFailureAt",
  f.last_failure_at AS "lastFailureAt",
  f.resolved_at AS "resolvedAt",
  f.resolved_by_usuario_id AS "resolvedByUserId",
  f.resolution_kind AS "resolutionKind",
  f.resolution_note AS "resolutionNote",
  f.outbox_job_id AS "originalJobId",
  original.status AS "originalJobStatus",
  f.retry_job_id AS "retryJobId",
  retry.status AS "retryJobStatus",
  CASE WHEN f.resolved_at IS NULL THEN 'open' ELSE 'resolved' END AS status,
  f.created_at AS "createdAt",
  f.updated_at AS "updatedAt"`;

async function failedJobDetail(client, empresaId, id) {
  return (await client.query(
    `SELECT ${FAILED_JOB_SELECT}
       FROM jobs_falhos f
       LEFT JOIN outbox_jobs original
         ON original.empresa_id = f.empresa_id AND original.id = f.outbox_job_id
       LEFT JOIN outbox_jobs retry
         ON retry.empresa_id = f.empresa_id AND retry.id = f.retry_job_id
      WHERE f.empresa_id = $1 AND f.id = $2`,
    [empresaId, id],
  )).rows[0] || null;
}

const USER_DEFINITION = Object.freeze({
  ...descriptor({ table: "usuarios", alias: "u", fields: { email: "email", name: "nome", status: "status" }, select: { id: "id", empresaId: "ue.empresa_id", email: "email", name: "nome", role: "ue.papel", status: "status", createdAt: "created_at", updatedAt: "updated_at" }, filters: { status: "status" }, sorts: { name: "nome", email: "email", createdAt: "created_at" }, search: ["email::text", "nome"] }),
  from: "usuarios u JOIN usuarios_empresas ue ON ue.usuario_id = u.id",
});

export class PostgresAdminRepository {
  constructor(pool) {
    if (!pool?.connect) throw new TypeError("Pool PostgreSQL inválido.");
    this.pool = pool;
  }

  withAuditedMutation({ empresaId, actorId, platform = false } = {}, callback) {
    if (typeof callback !== "function") throw new TypeError("Callback transacional administrativo é obrigatório.");
    if (platform) return withPlatformTransaction(this.pool, { usuarioId: actorId || undefined }, callback);
    return withTenantTransaction(this.pool, { empresaId, usuarioId: actorId || undefined }, callback);
  }

  async listTenants({ allowedIds = null, limit = 25, page = 1, sort = "createdAt", direction = "desc", filters = {} } = {}) {
    return withPlatformTransaction(this.pool, {}, async ({ client }) => {
      const columns = { createdAt: "created_at", name: "nome", status: "status" };
      const sortColumn = columns[sort] || columns.createdAt;
      const params = [];
      const conditions = ["deleted_at IS NULL"];
      if (Array.isArray(allowedIds)) { params.push(allowedIds); conditions.push(`id = ANY($${params.length}::uuid[])`); }
      if (filters.status) { params.push(toTenantStatus(filters.status)); conditions.push(`status = $${params.length}`); }
      if (filters.search) { params.push(`%${filters.search}%`); conditions.push(`(nome ILIKE $${params.length} OR nome_exibicao ILIKE $${params.length} OR slug::text ILIKE $${params.length})`); }
      const where = `WHERE ${conditions.join(" AND ")}`;
      const total = Number((await client.query(`SELECT count(*)::int AS total FROM empresas ${where}`, params)).rows[0]?.total || 0);
      params.push(limit, (page - 1) * limit);
      const rows = (await client.query(
        `SELECT id, slug::text, nome AS "name", nome_exibicao AS "displayName", identidade AS identity, timezone, locale, status,
                retencao_mensagens_dias AS "messageRetentionDays", retencao_logs_dias AS "logRetentionDays", created_at AS "createdAt", updated_at AS "updatedAt"
           FROM empresas ${where} ORDER BY ${sortColumn} ${direction === "asc" ? "ASC" : "DESC"}, id ${direction === "asc" ? "ASC" : "DESC"} LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      )).rows.map((row) => ({ ...row, status: fromTenantStatus(row.status) }));
      return { items: rows, pagination: paginationMeta(total, page, limit) };
    });
  }

  async getTenant({ empresaId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const row = (await client.query(`SELECT id, slug::text, nome AS "name", nome_exibicao AS "displayName", identidade AS identity, timezone, locale, status, retencao_mensagens_dias AS "messageRetentionDays", retencao_logs_dias AS "logRetentionDays", created_at AS "createdAt", updated_at AS "updatedAt" FROM empresas WHERE id = $1 AND deleted_at IS NULL`, [empresaId])).rows[0];
      return row ? { ...row, status: fromTenantStatus(row.status) } : null;
    });
  }

  async createTenant({ transaction, ...input }) {
    return usePlatformTransaction(this.pool, { transaction }, async ({ client }) => {
      const row = (await client.query(
        `INSERT INTO empresas (id, slug, nome, nome_exibicao, identidade, timezone, locale, status, retencao_mensagens_dias, retencao_logs_dias)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, slug::text, nome AS "name", nome_exibicao AS "displayName", identidade AS identity, timezone, locale, status, retencao_mensagens_dias AS "messageRetentionDays", retencao_logs_dias AS "logRetentionDays", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [input.id, input.slug, input.name, input.displayName, input.identity || "", input.timezone, input.locale, toTenantStatus(input.status), input.messageRetentionDays, input.logRetentionDays],
      )).rows[0];
      await client.query(
        `INSERT INTO configuracoes_empresa (empresa_id, saudacao, mensagem_fallback)
         VALUES ($1, $2, $3)`,
        [input.id, `Olá! Bem-vindo à ${input.displayName}. Como podemos ajudar?`, "No momento não foi possível concluir esta solicitação. Fale com a equipe."],
      );
      await client.query(
        `INSERT INTO configuracoes_ia (empresa_id, mensagem_contingencia)
         VALUES ($1, $2)`,
        [input.id, "O atendimento inteligente está temporariamente indisponível."],
      );
      await client.query(
        `INSERT INTO modulos_empresa (empresa_id, module_key, habilitado)
         SELECT $1, module_key, false
           FROM unnest($2::text[]) AS module_key`,
        [input.id, ["catalog", "orders", "events", "appointments", "payments", "human_handoff", "ai_freeform", "external_integrations"]],
      );
      return { ...row, status: fromTenantStatus(row.status) };
    });
  }

  async replaceModules({ empresaId, enabledModules, transaction }) {
    const allModules = ["catalog", "orders", "events", "appointments", "payments", "human_handoff", "ai_freeform", "external_integrations"];
    return useTenantTransaction(this.pool, { empresaId, transaction }, async ({ client }) => {
      await client.query(
        `INSERT INTO modulos_empresa (empresa_id, module_key, habilitado)
         SELECT $1, module_key, module_key = ANY($2::text[])
           FROM unnest($3::text[]) AS module_key
         ON CONFLICT (empresa_id, module_key) DO UPDATE
           SET habilitado = EXCLUDED.habilitado,
               version = modulos_empresa.version + 1,
               updated_at = now()`,
        [empresaId, enabledModules, allModules],
      );
      await client.query("UPDATE empresas SET versao_configuracao = versao_configuracao + 1 WHERE id = $1", [empresaId]);
      const rows = (await client.query(
        `SELECT module_key AS id, empresa_id AS "empresaId", module_key AS "moduleKey",
                habilitado AS enabled, configuracao AS configuration, updated_at AS "updatedAt"
           FROM modulos_empresa WHERE empresa_id = $1 ORDER BY module_key`,
        [empresaId],
      )).rows;
      return { items: rows, pagination: paginationMeta(rows.length, 1, rows.length || 1) };
    });
  }

  async updateTenant({ empresaId, changes, transaction }) {
    const columns = { slug: "slug", name: "nome", displayName: "nome_exibicao", identity: "identidade", timezone: "timezone", locale: "locale", status: "status", messageRetentionDays: "retencao_mensagens_dias", logRetentionDays: "retencao_logs_dias" };
    return usePlatformTransaction(this.pool, { transaction }, async ({ client }) => {
      const entries = Object.entries(changes).filter(([name]) => columns[name]);
      const params = [empresaId];
      const assignments = entries.map(([name, value]) => { params.push(name === "status" ? toTenantStatus(value) : value); return `${columns[name]} = $${params.length}`; });
      if (!assignments.length) return this.getTenant({ empresaId });
      const row = (await client.query(`UPDATE empresas SET ${assignments.join(", ")} WHERE id = $1 AND deleted_at IS NULL RETURNING id, slug::text, nome AS "name", nome_exibicao AS "displayName", identidade AS identity, timezone, locale, status, retencao_mensagens_dias AS "messageRetentionDays", retencao_logs_dias AS "logRetentionDays", created_at AS "createdAt", updated_at AS "updatedAt"`, params)).rows[0];
      return row ? { ...row, status: fromTenantStatus(row.status) } : null;
    });
  }

  async #listUsers({ empresaId, limit, page, sort, direction, filters }) {
    return withPlatformTransaction(this.pool, {}, async ({ client }) => {
      const definition = USER_DEFINITION;
      const params = [empresaId];
      const conditions = ["ue.empresa_id = $1", "u.deleted_at IS NULL"];
      conditions.push(...filterConditions(definition, filters, params));
      const where = `WHERE ${conditions.join(" AND ")}`;
      const total = Number((await client.query(`SELECT count(*)::int total FROM ${definition.from} ${where}`, params)).rows[0]?.total || 0);
      const sortColumn = qualified("u", definition.sorts[sort] || definition.sorts.createdAt);
      params.push(limit, (page - 1) * limit);
      const rows = (await client.query(`SELECT u.id, ue.empresa_id AS "empresaId", u.email::text, u.nome AS name, ue.papel AS role, u.status, u.created_at AS "createdAt", u.updated_at AS "updatedAt" FROM ${definition.from} ${where} ORDER BY ${sortColumn} ${direction === "asc" ? "ASC" : "DESC"}, u.id ${direction === "asc" ? "ASC" : "DESC"} LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows.map((row) => outputRow("users", row));
      return { items: rows, pagination: paginationMeta(total, page, limit) };
    });
  }

  async list({ resource, empresaId, limit = 25, page = 1, sort, direction = "desc", filters = {} }) {
    if (resource === "users") return this.#listUsers({ empresaId, limit, page, sort, direction, filters });
    const definition = resourceDefinition(resource);
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const params = [];
      const conditions = [...baseConditions(definition, empresaId, params), ...filterConditions(definition, filters, params)];
      const where = `WHERE ${conditions.join(" AND ")}`;
      const total = Number((await client.query(`SELECT count(*)::int total FROM ${definition.table} ${definition.alias} ${where}`, params)).rows[0]?.total || 0);
      const sortColumn = qualified(definition.alias, definition.sorts[sort] || Object.values(definition.sorts)[0] || definition.id);
      const idColumn = qualified(definition.alias, definition.id);
      params.push(limit, (page - 1) * limit);
      const rows = (await client.query(`SELECT ${selectSql(definition)} FROM ${definition.table} ${definition.alias} ${where} ORDER BY ${sortColumn} ${direction === "asc" ? "ASC" : "DESC"}, ${idColumn} ${direction === "asc" ? "ASC" : "DESC"} LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows.map((row) => outputRow(resource, row));
      return { items: rows, pagination: paginationMeta(total, page, limit) };
    });
  }

  async get({ resource, empresaId, id }) {
    if (resource === "users") {
      return withPlatformTransaction(this.pool, {}, async ({ client }) => outputRow("users", (await client.query(`SELECT u.id, ue.empresa_id AS "empresaId", u.email::text, u.nome AS name, ue.papel AS role, u.status, u.created_at AS "createdAt", u.updated_at AS "updatedAt" FROM usuarios u JOIN usuarios_empresas ue ON ue.usuario_id = u.id WHERE ue.empresa_id = $1 AND u.id = $2 AND u.deleted_at IS NULL`, [empresaId, id])).rows[0]));
    }
    const definition = resourceDefinition(resource);
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const conditions = [`${definition.alias}.empresa_id = $1`, `${qualified(definition.alias, definition.id)} = $2`];
      if (definition.softDelete) conditions.push(`${definition.alias}.deleted_at IS NULL`);
      return outputRow(resource, (await client.query(`SELECT ${selectSql(definition)} FROM ${definition.table} ${definition.alias} WHERE ${conditions.join(" AND ")} LIMIT 1`, [empresaId, id])).rows[0]);
    });
  }

  async getPrivateMedia({ empresaId, messageId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => (
      await client.query(
        `SELECT id, media_storage_key AS "storageKey", media_mime_type AS "mimeType",
                media_size_bytes::int AS "sizeBytes", media_sha256 AS sha256
           FROM mensagens
          WHERE empresa_id = $1 AND id = $2 AND direcao = 'entrada'
            AND tipo IN ('imagem', 'documento') AND media_storage_key IS NOT NULL
          LIMIT 1`,
        [empresaId, messageId],
      )
    ).rows[0] || null);
  }

  async queueHumanMessage({ empresaId, conversationId, operatorId, text, idempotencyKey, correlationId, transaction }) {
    return useTenantTransaction(this.pool, { empresaId, transaction }, async ({ client }) => {
      const conversation = (await client.query(
        `SELECT c.id, c.contato_id, c.numero_whatsapp_id, c.status, c.modo_atendimento,
                c.operador_usuario_id, ct.bloqueado, n.status AS numero_status
           FROM conversas c
           JOIN contatos ct ON ct.empresa_id = c.empresa_id AND ct.id = c.contato_id
           JOIN numeros_whatsapp n ON n.empresa_id = c.empresa_id AND n.id = c.numero_whatsapp_id
          WHERE c.empresa_id = $1 AND c.id = $2
          FOR UPDATE OF c`,
        [empresaId, conversationId],
      )).rows[0];
      if (!conversation) return null;
      if (conversation.status !== "aberta") throw new AdminValidationError("A conversa precisa estar aberta para receber uma resposta.");
      if (conversation.modo_atendimento !== "humano") throw new AdminValidationError("Assuma a conversa antes de responder.");
      if (String(conversation.operador_usuario_id) !== String(operatorId)) throw new AdminForbiddenError();
      if (conversation.bloqueado) throw new AdminValidationError("O contato está bloqueado para envios.");
      if (conversation.numero_status !== "ativo") throw new AdminValidationError("O número de WhatsApp desta conversa não está ativo.");

      const existing = (await client.query(
        `SELECT id, conversa_id AS "conversationId", corpo AS text, status,
                external_message_id AS "externalMessageId", correlation_id AS "correlationId",
                created_at AS "createdAt"
           FROM mensagens
          WHERE empresa_id = $1 AND client_idempotency_key = $2
          LIMIT 1`,
        [empresaId, idempotencyKey],
      )).rows[0];
      if (existing) {
        if (String(existing.conversationId) !== String(conversationId)) {
          throw new AdminValidationError("A chave de idempotência já foi usada em outra conversa.");
        }
        return { ...existing, duplicate: true };
      }

      const sequence = (await client.query(
        `UPDATE conversas
            SET next_sequence = next_sequence + 1,
                ultima_mensagem_at = GREATEST(COALESCE(ultima_mensagem_at, now()), now())
          WHERE empresa_id = $1 AND id = $2
        RETURNING next_sequence - 1 AS sequence`,
        [empresaId, conversationId],
      )).rows[0].sequence;
      const message = (await client.query(
        `INSERT INTO mensagens (
           empresa_id, conversa_id, contato_id, numero_whatsapp_id, direcao, tipo,
           corpo, status, origem_resposta, sequence, operador_usuario_id,
           correlation_id, client_idempotency_key, enqueued_at
         ) VALUES ($1,$2,$3,$4,'saida','texto',$5,'enfileirada','operador',$6,$7,$8,$9,now())
         RETURNING id, conversa_id AS "conversationId", corpo AS text, status,
                   external_message_id AS "externalMessageId", correlation_id AS "correlationId",
                   created_at AS "createdAt"`,
        [
          empresaId,
          conversationId,
          conversation.contato_id,
          conversation.numero_whatsapp_id,
          text,
          sequence,
          operatorId,
          correlationId,
          idempotencyKey,
        ],
      )).rows[0];
      await client.query(
        `INSERT INTO outbox_jobs (
           empresa_id, conversa_id, mensagem_id, job_type, dedup_key, payload, correlation_id
         ) VALUES ($1,$2,$3,'send_human_message',$4,$5::jsonb,$6)`,
        [
          empresaId,
          conversationId,
          message.id,
          `send_human_message:${idempotencyKey}`,
          JSON.stringify({ payloadVersion: 1 }),
          correlationId,
        ],
      );
      return { ...message, duplicate: false };
    });
  }

  async listFailedJobs({ empresaId, limit = 25, page = 1, sort = "lastFailureAt", direction = "desc", filters = {} }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const columns = { lastFailureAt: "f.last_failure_at", createdAt: "f.created_at", attempts: "f.tentativas" };
      const sortColumn = columns[sort] || columns.lastFailureAt;
      const params = [empresaId];
      const conditions = ["f.empresa_id = $1"];
      if (filters.status === "open") conditions.push("f.resolved_at IS NULL");
      if (filters.status === "resolved") conditions.push("f.resolved_at IS NOT NULL");
      if (filters.search) {
        params.push(`%${String(filters.search).replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
        conditions.push(`(
          f.job_type ILIKE $${params.length} ESCAPE '\\'
          OR f.error_code ILIKE $${params.length} ESCAPE '\\'
          OR f.error_sanitized ILIKE $${params.length} ESCAPE '\\'
          OR f.correlation_id::text ILIKE $${params.length} ESCAPE '\\'
        )`);
      }
      for (const [name, column] of [
        ["jobType", "f.job_type"],
        ["errorCode", "f.error_code"],
        ["conversationId", "f.conversa_id"],
        ["messageId", "f.mensagem_id"],
      ]) {
        if (!filters[name]) continue;
        params.push(filters[name]);
        conditions.push(`${column} = $${params.length}`);
      }
      if (filters.from) {
        params.push(filters.from);
        conditions.push(`f.last_failure_at >= $${params.length}`);
      }
      if (filters.to) {
        params.push(filters.to);
        conditions.push(`f.last_failure_at <= $${params.length}`);
      }
      const where = `WHERE ${conditions.join(" AND ")}`;
      const total = Number((await client.query(`SELECT count(*)::int AS total FROM jobs_falhos f ${where}`, params)).rows[0]?.total || 0);
      params.push(limit, (page - 1) * limit);
      const items = (await client.query(
        `SELECT ${FAILED_JOB_SELECT}
           FROM jobs_falhos f
           LEFT JOIN outbox_jobs original
             ON original.empresa_id = f.empresa_id AND original.id = f.outbox_job_id
           LEFT JOIN outbox_jobs retry
             ON retry.empresa_id = f.empresa_id AND retry.id = f.retry_job_id
          ${where}
          ORDER BY ${sortColumn} ${direction === "asc" ? "ASC" : "DESC"}, f.id ${direction === "asc" ? "ASC" : "DESC"}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      )).rows;
      return { items, pagination: paginationMeta(total, page, limit) };
    });
  }

  getFailedJob({ empresaId, id }) {
    return withTenantTransaction(this.pool, { empresaId }, ({ client }) => failedJobDetail(client, empresaId, id));
  }

  retryFailedJob({ empresaId, id, retryJobId, actorId, reason, correlationId, transaction }) {
    return useTenantTransaction(this.pool, { empresaId, transaction }, async ({ client }) => {
      const failed = (await client.query(
        `SELECT id, outbox_job_id, resolved_at
           FROM jobs_falhos
          WHERE empresa_id = $1 AND id = $2
          FOR UPDATE`,
        [empresaId, id],
      )).rows[0];
      if (!failed) return null;
      if (failed.resolved_at) throw new AdminValidationError("Este job falho já foi encerrado.");
      if (!failed.outbox_job_id) throw new AdminValidationError("O job original não possui referência segura para retentativa.");

      const original = (await client.query(
        `SELECT id, conversa_id, mensagem_id, job_type, payload, status
           FROM outbox_jobs
          WHERE empresa_id = $1 AND id = $2
          FOR UPDATE`,
        [empresaId, failed.outbox_job_id],
      )).rows[0];
      if (!original) throw new AdminValidationError("O job original não foi encontrado.");
      if (original.status !== "falhou") throw new AdminValidationError("Somente jobs com falha final podem ser reenfileirados.");

      if (["process_inbound_message", "send_human_message"].includes(original.job_type)) {
        const message = (await client.query(
          "SELECT status FROM mensagens WHERE empresa_id = $1 AND id = $2 FOR UPDATE",
          [empresaId, original.mensagem_id],
        )).rows[0];
        if (!message) throw new AdminValidationError("A mensagem vinculada ao job não foi encontrada.");
        if (message.status !== "falhou") {
          throw new AdminValidationError("A mensagem já avançou de estado e não pode ser reenviada com segurança.");
        }
      }

      await client.query(
        `INSERT INTO outbox_jobs (
           id, empresa_id, conversa_id, mensagem_id, job_type, dedup_key,
           payload, status, tentativas, disponivel_at, correlation_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'pendente',0,now(),$8)`,
        [
          retryJobId,
          empresaId,
          original.conversa_id,
          original.mensagem_id,
          original.job_type,
          `manual-retry:${id}:${retryJobId}`,
          JSON.stringify(original.payload || { payloadVersion: 1 }),
          correlationId,
        ],
      );
      if (["process_inbound_message", "send_human_message"].includes(original.job_type)) {
        await client.query(
          `UPDATE mensagens
              SET status = 'enfileirada', error_code = NULL, error_sanitized = NULL,
                  enqueued_at = now(), processing_at = NULL
            WHERE empresa_id = $1 AND id = $2 AND status = 'falhou'`,
          [empresaId, original.mensagem_id],
        );
      }
      await client.query(
        `UPDATE jobs_falhos
            SET resolved_at = now(), resolved_by_usuario_id = $3,
                resolution_kind = 'reenfileirado', resolution_note = $4,
                retry_job_id = $5, updated_at = now()
          WHERE empresa_id = $1 AND id = $2`,
        [empresaId, id, actorId, reason, retryJobId],
      );
      return failedJobDetail(client, empresaId, id);
    });
  }

  resolveFailedJob({ empresaId, id, actorId, reason, transaction }) {
    return useTenantTransaction(this.pool, { empresaId, transaction }, async ({ client }) => {
      const failed = (await client.query(
        `SELECT id, resolved_at
           FROM jobs_falhos
          WHERE empresa_id = $1 AND id = $2
          FOR UPDATE`,
        [empresaId, id],
      )).rows[0];
      if (!failed) return null;
      if (failed.resolved_at) throw new AdminValidationError("Este job falho já foi encerrado.");
      await client.query(
        `UPDATE jobs_falhos
            SET resolved_at = now(), resolved_by_usuario_id = $3,
                resolution_kind = 'resolvido', resolution_note = $4,
                updated_at = now()
          WHERE empresa_id = $1 AND id = $2`,
        [empresaId, id, actorId, reason],
      );
      return failedJobDetail(client, empresaId, id);
    });
  }

  async create({ resource, empresaId, id, data, transaction }) {
    if (resource === "users") return this.#createUser({ empresaId, id, data, transaction });
    const definition = resourceDefinition(resource);
    return useTenantTransaction(this.pool, { empresaId, transaction }, async ({ client }) => {
      if (resource === "payments" && data.credentialId) {
        const credential = await client.query(
          "SELECT 1 FROM credenciais_empresa WHERE empresa_id = $1 AND id = $2 AND provedor = 'payment' AND status = 'ativa'",
          [empresaId, data.credentialId],
        );
        if (!credential.rowCount) throw new AdminValidationError("Credencial de pagamento ativa não encontrada para esta empresa.");
      }
      const entries = Object.entries(data).filter(([field]) => definition.fields[field]);
      const columns = ["empresa_id"];
      const values = [empresaId];
      if (!definition.singleton && definition.id !== "module_key" && definition.id !== "usuario_id") { columns.push(definition.id); values.push(id); }
      for (const [field, value] of entries) { columns.push(definition.fields[field]); values.push(inputValue(resource, field, value)); }
      const placeholders = values.map((_, index) => `$${index + 1}`);
      await client.query(`INSERT INTO ${definition.table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`, values);
      const recordId = definition.singleton ? empresaId : definition.id === "module_key" ? data.moduleKey : definition.id === "usuario_id" ? data.userId : id;
      return outputRow(resource, (await client.query(`SELECT ${selectSql(definition)} FROM ${definition.table} ${definition.alias} WHERE ${definition.alias}.empresa_id = $1 AND ${qualified(definition.alias, definition.id)} = $2`, [empresaId, recordId])).rows[0]);
    });
  }

  async #createUser({ empresaId, id, data, transaction }) {
    if (!data.initialPassword) throw new TypeError("Senha inicial obrigatória para criar usuário.");
    const passwordHash = await hashPassword(data.initialPassword);
    return usePlatformTransaction(this.pool, { transaction }, async ({ client }) => {
      const row = (await client.query(`INSERT INTO usuarios (id, email, nome, password_hash, status) VALUES ($1,$2,$3,$4,$5) RETURNING id, email::text, nome AS name, status, created_at AS "createdAt", updated_at AS "updatedAt"`, [id, data.email, data.name, passwordHash, toUserStatus(data.status)])).rows[0];
      await client.query(`INSERT INTO usuarios_empresas (empresa_id, usuario_id, papel, status) VALUES ($1,$2,$3,'ativo')`, [empresaId, id, toMemberRole(data.role)]);
      return outputRow("users", { ...row, empresaId, role: toMemberRole(data.role) });
    });
  }

  async update({ resource, empresaId, id, changes, transaction }) {
    if (resource === "users") return this.#updateUser({ empresaId, id, changes, transaction });
    const definition = resourceDefinition(resource);
    return useTenantTransaction(this.pool, { empresaId, transaction }, async ({ client }) => {
      if (resource === "ai-config" && changes.ownCredentialId) {
        const credential = await client.query(
          "SELECT 1 FROM credenciais_empresa WHERE empresa_id = $1 AND id = $2 AND provedor = 'openai' AND status = 'ativa'",
          [empresaId, changes.ownCredentialId],
        );
        if (!credential.rowCount) throw new AdminValidationError("Credencial OpenAI ativa não encontrada para esta empresa.");
      }
      if (resource === "payments" && changes.credentialId) {
        const credential = await client.query(
          "SELECT 1 FROM credenciais_empresa WHERE empresa_id = $1 AND id = $2 AND provedor = 'payment' AND status = 'ativa'",
          [empresaId, changes.credentialId],
        );
        if (!credential.rowCount) throw new AdminValidationError("Credencial de pagamento ativa não encontrada para esta empresa.");
      }
      const entries = Object.entries(changes).filter(([field]) => definition.fields[field]);
      if (!entries.length) return this.get({ resource, empresaId, id });
      const params = [empresaId, id];
      const assignments = entries.map(([field, value]) => { params.push(inputValue(resource, field, value)); return `${definition.fields[field]} = $${params.length}`; });
      const conditions = [`empresa_id = $1`, `${definition.id} = $2`];
      if (definition.softDelete) conditions.push("deleted_at IS NULL");
      const row = (await client.query(`UPDATE ${definition.table} SET ${assignments.join(", ")} WHERE ${conditions.join(" AND ")} RETURNING *`, params)).rows[0];
      if (!row) return null;
      return outputRow(resource, (await client.query(`SELECT ${selectSql(definition)} FROM ${definition.table} ${definition.alias} WHERE ${definition.alias}.empresa_id = $1 AND ${qualified(definition.alias, definition.id)} = $2`, [empresaId, id])).rows[0]);
    });
  }

  async #updateUser({ empresaId, id, changes, transaction }) {
    return usePlatformTransaction(this.pool, { transaction }, async ({ client }) => {
      const membership = await client.query("SELECT 1 FROM usuarios_empresas WHERE empresa_id = $1 AND usuario_id = $2", [empresaId, id]);
      if (!membership.rowCount) return null;
      const columns = { email: "email", name: "nome", status: "status" };
      if (changes.role) await client.query("UPDATE usuarios_empresas SET papel = $3 WHERE empresa_id = $1 AND usuario_id = $2", [empresaId, id, toMemberRole(changes.role)]);
      const entries = Object.entries(changes).filter(([field]) => columns[field] || field === "initialPassword");
      const params = [id];
      const assignments = [];
      for (const [field, value] of entries) {
        params.push(field === "initialPassword" ? await hashPassword(value) : inputValue("users", field, value));
        assignments.push(`${field === "initialPassword" ? "password_hash" : columns[field]} = $${params.length}`);
      }
      if (assignments.length) await client.query(`UPDATE usuarios SET ${assignments.join(", ")} WHERE id = $1 AND deleted_at IS NULL`, params);
      return outputRow("users", (await client.query(`SELECT u.id, ue.empresa_id AS "empresaId", u.email::text, u.nome AS name, ue.papel AS role, u.status, u.created_at AS "createdAt", u.updated_at AS "updatedAt" FROM usuarios u JOIN usuarios_empresas ue ON ue.usuario_id = u.id AND ue.empresa_id = $1 WHERE u.id = $2 AND u.deleted_at IS NULL`, [empresaId, id])).rows[0]);
    });
  }

  async userHasOtherMemberships({ empresaId, userId }) {
    return withPlatformTransaction(this.pool, {}, async ({ client }) => (
      await client.query(
        "SELECT 1 FROM usuarios_empresas WHERE usuario_id = $1 AND empresa_id <> $2 AND status = 'ativo' LIMIT 1",
        [userId, empresaId],
      )
    ).rowCount > 0);
  }

  async remove({ resource, empresaId, id, transaction }) {
    if (resource === "users") return usePlatformTransaction(this.pool, { transaction }, async ({ client }) => (await client.query("DELETE FROM usuarios_empresas WHERE empresa_id = $1 AND usuario_id = $2", [empresaId, id])).rowCount > 0);
    const definition = resourceDefinition(resource);
    return useTenantTransaction(this.pool, { empresaId, transaction }, async ({ client }) => {
      const sql = definition.softDelete
        ? `UPDATE ${definition.table} SET deleted_at = now() WHERE empresa_id = $1 AND ${definition.id} = $2 AND deleted_at IS NULL`
        : `DELETE FROM ${definition.table} WHERE empresa_id = $1 AND ${definition.id} = $2`;
      return (await client.query(sql, [empresaId, id])).rowCount > 0;
    });
  }

  async globalDashboard() {
    return withPlatformTransaction(this.pool, {}, async ({ client }) => {
      const row = (await client.query(`SELECT
        (SELECT count(*)::int FROM empresas WHERE deleted_at IS NULL) AS "companiesTotal",
        (SELECT count(*)::int FROM empresas WHERE status = 'ativa' AND deleted_at IS NULL) AS "activeCompanies",
        (SELECT count(*)::int FROM empresas WHERE status = 'suspensa' AND deleted_at IS NULL) AS "suspendedCompanies",
        (SELECT count(DISTINCT empresa_id)::int FROM jobs_falhos WHERE resolved_at IS NULL) AS "companiesWithFailures",
        (SELECT count(*)::int FROM numeros_whatsapp WHERE deleted_at IS NULL) AS "whatsappNumbers",
        (SELECT count(*)::int FROM mensagens WHERE direcao = 'entrada') AS "messagesReceived",
        (SELECT count(*)::int FROM mensagens WHERE direcao = 'saida') AS "messagesSent",
        (SELECT count(*)::int FROM mensagens WHERE status IN ('recebida','enfileirada','processando')) AS "pendingMessages",
        (SELECT count(*)::int FROM mensagens WHERE status = 'falhou') AS "failedMessages",
        (SELECT count(*)::int FROM outbox_jobs WHERE status IN ('pendente','publicado')) AS "pendingJobs",
        (SELECT count(*)::int FROM outbox_jobs WHERE status = 'em_publicacao') AS "processingJobs",
        (SELECT count(*)::int FROM jobs_falhos WHERE resolved_at IS NULL) AS "failedJobs",
        (SELECT count(*)::int FROM contatos WHERE deleted_at IS NULL) AS contacts,
        (SELECT count(*)::int FROM pedidos WHERE deleted_at IS NULL) AS orders,
        (SELECT count(*)::int FROM agendamentos WHERE deleted_at IS NULL) AS appointments,
        (SELECT coalesce(sum(custo_estimado),0) FROM uso_ia) AS "aiEstimatedCost"`)).rows[0];
      return { ...row, alerts: [] };
    });
  }

  async tenantDashboard({ empresaId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => (await client.query(`SELECT
      (SELECT count(*)::int FROM mensagens WHERE empresa_id = $1 AND direcao = 'entrada') AS "messagesReceived",
      (SELECT count(*)::int FROM mensagens WHERE empresa_id = $1 AND direcao = 'saida') AS "messagesSent",
      (SELECT count(*)::int FROM mensagens WHERE empresa_id = $1 AND status = 'falhou') AS "failedMessages",
      (SELECT count(*)::int FROM contatos WHERE empresa_id = $1 AND deleted_at IS NULL) AS "newContacts",
      (SELECT count(*)::int FROM conversas WHERE empresa_id = $1) AS conversations,
      (SELECT count(*)::int FROM pedidos WHERE empresa_id = $1 AND deleted_at IS NULL) AS orders,
      (SELECT count(*)::int FROM agendamentos WHERE empresa_id = $1 AND deleted_at IS NULL) AS appointments,
      (SELECT count(*)::int FROM mensagens WHERE empresa_id = $1 AND status IN ('recebida','enfileirada','processando')) AS "pendingMessages",
      (SELECT coalesce(sum(custo_estimado),0) FROM uso_ia WHERE empresa_id = $1) AS "aiEstimatedCost"`, [empresaId])).rows[0]);
  }

  async diagnostics({ empresaId = null }) {
    const run = empresaId ? withTenantTransaction : withPlatformTransaction;
    const context = empresaId ? { empresaId } : {};
    return run(this.pool, context, async ({ client }) => {
      const started = Date.now();
      await client.query("SELECT 1");
      const params = empresaId ? [empresaId] : [];
      const where = empresaId ? "WHERE empresa_id = $1" : "";
      const queue = (await client.query(`SELECT count(*) FILTER (WHERE status IN ('pendente','em_publicacao'))::int AS pending, count(*) FILTER (WHERE status = 'falhou')::int AS failed FROM outbox_jobs ${where}`, params)).rows[0];
      const integrations = (await client.query(
        `SELECT tipo AS type, status, count(*)::int AS count
           FROM integracoes ${where}
          GROUP BY tipo, status ORDER BY tipo, status`,
        params,
      )).rows;
      return { database: { status: "healthy", latencyMs: Date.now() - started }, queue, integrations };
    });
  }

  async writeAudit(event, { transaction } = {}) {
    const write = ({ client }) => client.query(
      `INSERT INTO logs_auditoria (id, empresa_id, ator_usuario_id, acao, recurso_tipo, recurso_id, resultado, campos_alterados_redigidos, correlation_id, occurred_at)
       VALUES ($1,(SELECT id FROM empresas WHERE id = $2),$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [event.id, event.empresaId, event.actorId || null, event.action, event.resource, event.resourceId, event.result === "success" ? "sucesso" : event.result === "denied" ? "negado" : "falha", JSON.stringify({ fields: event.changedFields || [] }), event.correlationId || null, event.occurredAt],
    );
    if (transaction) return write(transaction);
    return withPlatformTransaction(this.pool, { usuarioId: event.actorId || undefined }, write);
  }
}

export const POSTGRES_ADMIN_RESOURCES = Object.freeze(Object.keys(RESOURCES));
