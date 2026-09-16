import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { withTenantTransaction } from "../../infra/postgres/transaction.js";
import { verifyCompiledTenantRuntimeConfigV2 } from "../configuration/index.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const uuidOrNew = (value) => UUID_PATTERN.test(String(value || "")) ? value : randomUUID();
const nullableUuid = (value) => UUID_PATTERN.test(String(value || "")) ? value : null;
const month = (value) => `${new Date(value).toISOString().slice(0, 7)}-01`;

function referenceId(reference, prefix) {
  const value = String(reference || "").trim();
  return value.startsWith(`${prefix}:`) ? value.slice(prefix.length + 1) : null;
}

export class AiRuntimeConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AiRuntimeConfigurationError";
    this.code = code;
  }
}

function legacyAiConfig(row, empresaId) {
  if (!row) return null;
  return {
    empresaId,
    enabled: row.habilitada,
    provider: row.provedor === "simulado" ? "simulated" : row.provedor,
    model: row.modelo,
    prompt: row.prompt,
    personality: row.personalidade,
    keyType: row.tipo_chave === "propria" ? "own" : "shared",
    credentialId: row.credencial_propria_id,
    monthlyTokenLimit: row.limite_tokens_mensal == null ? null : Number(row.limite_tokens_mensal),
    monthlyCostLimit: row.limite_custo_mensal == null ? null : Number(row.limite_custo_mensal),
    alertPercent: row.alerta_percentual,
    maxHistoryMessages: row.max_historico_mensagens,
    maxOutputTokens: row.max_output_tokens,
    contingencyMessage: row.mensagem_contingencia,
    allowedContextKeys: ["identity", "menu", "events", "catalog", "services", "knowledgeBase", "hours", "address"],
    version: Number(row.version),
  };
}

function versionedAiConfig(compiled, empresaId, configVersion, revisionChecksum) {
  const validEnvelope = compiled?.empresaId === empresaId
    && Number(compiled?.configVersion) === Number(configVersion)
    && compiled?.checksum === revisionChecksum
    && verifyCompiledTenantRuntimeConfigV2(compiled);
  if (!validEnvelope) {
    throw new AiRuntimeConfigurationError(
      "AI_ACTIVE_CONFIGURATION_CORRUPTED",
      "A configuração ativa de IA falhou na verificação de integridade.",
    );
  }
  const ai = compiled.configuration.ai;
  const enabled = compiled.configuration.modules.includes("ai_freeform") && ai.enabled === true;
  return {
    empresaId,
    enabled,
    provider: ai.provider === "simulado" ? "simulated" : ai.provider,
    model: ai.model,
    prompt: ai.prompt,
    personality: ai.personality,
    keyType: ai.keyMode,
    credentialId: ai.keyMode === "own" ? referenceId(ai.credentialRef, "credential") : null,
    monthlyTokenLimit: ai.monthlyTokenLimit,
    monthlyCostLimit: ai.monthlyCostLimit,
    alertPercent: 80,
    maxHistoryMessages: 8,
    maxOutputTokens: ai.maxOutputTokens,
    contingencyMessage: ai.fallbackMessage,
    allowedContextKeys: ["identity", "menu", "events", "catalog", "services", "knowledgeBase", "hours", "address"],
    version: Number(configVersion),
  };
}

export class PostgresAiConfigResolver {
  constructor(pool) { this.pool = pool; }
  getAiConfig({ empresaId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const company = (await client.query(
        `SELECT configuracao_runtime_modo, configuracao_ativa_versao, versao_configuracao
           FROM empresas
          WHERE id = $1 AND deleted_at IS NULL`,
        [empresaId],
      )).rows[0];
      if (!company) return null;
      if (company.configuracao_runtime_modo === "legado") {
        const legacy = await client.query("SELECT * FROM configuracoes_ia WHERE empresa_id = $1", [empresaId]);
        return legacyAiConfig(legacy.rows[0], empresaId);
      }
      if (company.configuracao_runtime_modo !== "versionado") {
        throw new AiRuntimeConfigurationError("AI_CONFIGURATION_MODE_UNSUPPORTED", "O modo de configuração de IA não é suportado.");
      }
      if (!company.configuracao_ativa_versao) {
        throw new AiRuntimeConfigurationError("AI_ACTIVE_CONFIGURATION_REQUIRED", "A empresa versionada não possui configuração ativa de IA.");
      }
      if (Number(company.versao_configuracao) !== Number(company.configuracao_ativa_versao)) {
        throw new AiRuntimeConfigurationError(
          "AI_ACTIVE_CONFIGURATION_POINTER_INVALID",
          "A versão ativa da configuração de IA está inconsistente.",
        );
      }
      const revision = (await client.query(
        `SELECT config_version, checksum, configuracao_compilada
           FROM configuracoes_revisoes
          WHERE empresa_id = $1 AND config_version = $2`,
        [empresaId, company.configuracao_ativa_versao],
      )).rows[0];
      if (!revision) {
        throw new AiRuntimeConfigurationError("AI_ACTIVE_CONFIGURATION_NOT_FOUND", "A revisão ativa de IA não foi encontrada.");
      }
      return versionedAiConfig(
        revision.configuracao_compilada,
        empresaId,
        revision.config_version,
        revision.checksum,
      );
    });
  }
}

export class PostgresAiLedger {
  constructor(pool, { reservationTtlMs = 60_000 } = {}) {
    this.pool = pool;
    this.reservationTtlMs = reservationTtlMs;
  }

  reserve(input) {
    return withTenantTransaction(this.pool, { empresaId: input.empresaId }, async ({ client }) => {
      const period = month(input.occurredAt || new Date());
      await client.query(
        `INSERT INTO ai_quota_accounts (empresa_id, periodo) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [input.empresaId, period],
      );
      const expired = await client.query(
        `UPDATE ai_quota_reservations
            SET status = 'expirada', updated_at = now()
          WHERE empresa_id = $1 AND periodo = $2 AND status = 'reservada' AND expires_at < now()
          RETURNING tokens_estimados, custo_estimado`,
        [input.empresaId, period],
      );
      if (expired.rows.length) {
        const tokens = expired.rows.reduce((sum, row) => sum + Number(row.tokens_estimados), 0);
        const cost = expired.rows.reduce((sum, row) => sum + Number(row.custo_estimado), 0);
        await client.query(
          `UPDATE ai_quota_accounts SET
             tokens_reservados = GREATEST(0, tokens_reservados - $3),
             custo_reservado = GREATEST(0, custo_reservado - $4), updated_at = now()
           WHERE empresa_id = $1 AND periodo = $2`,
          [input.empresaId, period, tokens, cost],
        );
      }
      const locked = await client.query(
        `SELECT * FROM ai_quota_accounts WHERE empresa_id = $1 AND periodo = $2 FOR UPDATE`,
        [input.empresaId, period],
      );
      const account = locked.rows[0];
      const estimatedTokens = Math.max(0, Math.ceil(Number(input.estimatedTokens) || 0));
      const estimatedCost = Math.max(0, Number(input.estimatedCost) || 0);
      const tokensTotal = Number(account.tokens_usados) + Number(account.tokens_reservados) + estimatedTokens;
      const costTotal = Number(account.custo_usado) + Number(account.custo_reservado) + estimatedCost;
      const allowed = (input.tokenLimit == null || tokensTotal <= input.tokenLimit)
        && (input.costLimit == null || costTotal <= input.costLimit);
      if (!allowed) {
        return { allowed: false, usage: { tokens: Number(account.tokens_usados), cost: Number(account.custo_usado), period } };
      }
      const reservation = await client.query(
        `INSERT INTO ai_quota_reservations (
           empresa_id, periodo, tokens_estimados, custo_estimado, limite_tokens,
           limite_custo, alerta_percentual, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,now() + ($8 * interval '1 millisecond'))
         RETURNING id`,
        [input.empresaId, period, estimatedTokens, estimatedCost, input.tokenLimit, input.costLimit, input.alertPercent, this.reservationTtlMs],
      );
      await client.query(
        `UPDATE ai_quota_accounts SET tokens_reservados = tokens_reservados + $3,
           custo_reservado = custo_reservado + $4, updated_at = now()
         WHERE empresa_id = $1 AND periodo = $2`,
        [input.empresaId, period, estimatedTokens, estimatedCost],
      );
      return { allowed: true, reservationId: reservation.rows[0].id, period };
    });
  }

  finalize(input) {
    return withTenantTransaction(this.pool, { empresaId: input.empresaId }, async ({ client }) => {
      const reservationResult = await client.query(
        `SELECT * FROM ai_quota_reservations WHERE empresa_id = $1 AND id = $2 FOR UPDATE`,
        [input.empresaId, input.reservationId],
      );
      const reservation = reservationResult.rows[0];
      if (!reservation) throw new Error("Reserva de IA não encontrada.");
      if (reservation.status === "finalizada") {
        const account = await client.query(
          `SELECT * FROM ai_quota_accounts WHERE empresa_id = $1 AND periodo = $2`,
          [input.empresaId, reservation.periodo],
        );
        return { usage: this.#usage(account.rows[0]), alertTriggered: false };
      }
      const inputTokens = Math.max(0, Math.ceil(Number(input.inputTokens) || 0));
      const outputTokens = Math.max(0, Math.ceil(Number(input.outputTokens) || 0));
      const totalTokens = inputTokens + outputTokens;
      const cost = Math.max(0, Number(input.cost) || 0);
      const accountResult = await client.query(
        `UPDATE ai_quota_accounts SET
           tokens_reservados = GREATEST(0, tokens_reservados - $3),
           custo_reservado = GREATEST(0, custo_reservado - $4),
           tokens_usados = tokens_usados + $5,
           custo_usado = custo_usado + $6, updated_at = now()
         WHERE empresa_id = $1 AND periodo = $2 RETURNING *`,
        [input.empresaId, reservation.periodo, reservation.tokens_estimados, reservation.custo_estimado, totalTokens, cost],
      );
      const account = accountResult.rows[0];
      const tokenRatio = reservation.limite_tokens > 0 ? Number(account.tokens_usados) / Number(reservation.limite_tokens) : 0;
      const costRatio = reservation.limite_custo > 0 ? Number(account.custo_usado) / Number(reservation.limite_custo) : 0;
      const alertTriggered = !account.alerta_enviado
        && Math.max(tokenRatio, costRatio) * 100 >= Number(reservation.alerta_percentual);
      if (alertTriggered) {
        await client.query(
          `UPDATE ai_quota_accounts SET alerta_enviado = true WHERE empresa_id = $1 AND periodo = $2`,
          [input.empresaId, reservation.periodo],
        );
        account.alerta_enviado = true;
      }
      await client.query(
        `UPDATE ai_quota_reservations SET status = 'finalizada', finalized_at = now(), updated_at = now()
          WHERE empresa_id = $1 AND id = $2`,
        [input.empresaId, input.reservationId],
      );
      await client.query(
        `INSERT INTO uso_ia (
           empresa_id, conversa_id, mensagem_id, provedor, modelo, tipo_chave,
           input_tokens, output_tokens, total_tokens, custo_estimado, sucesso,
           error_code, correlation_id, occurred_at, reservation_id, pricing_version, config_version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (empresa_id, reservation_id) WHERE reservation_id IS NOT NULL DO NOTHING`,
        [
          input.empresaId,
          input.conversationId,
          nullableUuid(input.messageId),
          input.provider,
          input.model,
          ({ shared: "compartilhada", own: "propria", simulated: "simulada" })[input.keyType] || "simulada",
          inputTokens,
          outputTokens,
          totalTokens,
          cost,
          input.success === true,
          input.errorCode || null,
          uuidOrNew(input.correlationId),
          input.occurredAt || new Date(),
          input.reservationId,
          input.pricingVersion || "unknown",
          Number(input.configVersion || 1),
        ],
      );
      return { usage: this.#usage(account), alertTriggered };
    });
  }

  #usage(row) {
    return { tokens: Number(row.tokens_usados), cost: Number(row.custo_usado), period: String(row.periodo).slice(0, 10) };
  }
}

export class AiSecretResolver {
  constructor({ sharedApiKey, credentialVault }) {
    this.sharedApiKey = sharedApiKey;
    this.credentialVault = credentialVault;
  }
  async resolve(input) {
    if (input.keyType === "simulated") return { apiKey: null, keyType: "simulated" };
    if (input.keyType === "shared") return { apiKey: this.sharedApiKey || null, keyType: "shared" };
    const metadata = await this.credentialVault?.getCredentialMetadata({
      empresaId: input.empresaId,
      credentialId: input.credentialId,
    });
    if (metadata?.empresaId !== input.empresaId || metadata?.provider !== input.provider
        || metadata?.status !== "active" || metadata?.configured !== true) {
      throw new AiRuntimeConfigurationError(
        "AI_CREDENTIAL_UNAVAILABLE",
        "A credencial de IA selecionada não está disponível para este provedor.",
      );
    }
    return {
      apiKey: await this.credentialVault.getCredentialForUse({ empresaId: input.empresaId, credentialId: input.credentialId }),
      keyType: "own",
    };
  }
}

export class ResponsesClientFactory {
  constructor({ environment = process.env.NODE_ENV || "development" } = {}) { this.environment = environment; }
  async create({ provider, apiKey }) {
    if (provider === "simulated") {
      if (!['development', 'test'].includes(this.environment)) throw new Error("Cliente simulado não é permitido em produção.");
      return {
        responses: {
          async create() {
            return { output_text: "Resposta simulada de desenvolvimento.", usage: { input_tokens: 1, output_tokens: 1 } };
          },
        },
      };
    }
    return new OpenAI({ apiKey });
  }
}

export class VersionedPricingCatalog {
  constructor(prices = {}) {
    const defaults = {
      "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6, version: "openai-2026-09-04" },
      "gpt-4.1-mini-2025-04-14": { inputPerMillion: 0.4, outputPerMillion: 1.6, version: "openai-2026-09-04" },
    };
    let overrides = prices;
    if (typeof prices === "string") {
      try { overrides = prices.trim() ? JSON.parse(prices) : {}; }
      catch { throw new TypeError("OPENAI_PRICING_CATALOG deve conter JSON válido."); }
    }
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      throw new TypeError("Catalogo de precos OpenAI invalido.");
    }
    this.prices = new Map(Object.entries({ ...defaults, ...overrides }));
  }
  async get({ model }) { return this.prices.get(model) || null; }
}
