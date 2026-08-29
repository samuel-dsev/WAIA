import { sanitizeError } from "../../security/redaction.js";
import { assertAiDependencies, normalizeAiConfig, requireAiRequest } from "./contracts.js";
import {
  allowlistedTenantContext,
  buildInstructions,
  isPromptInjectionAttempt,
  serializeTenantContext,
} from "./guardrails.js";
import { calculateCost, estimateTokens, normalizePricing } from "./pricing.js";

function historyInput(messages, messageId) {
  return messages
    .filter((item) => item?.id !== messageId)
    .filter((item) => item?.type === "text" && typeof item.body === "string" && item.body.trim())
    .filter((item) => item.direction === "inbound" || item.direction === "outbound")
    .filter((item) => item.direction !== "inbound" || !isPromptInjectionAttempt(item.body))
    .map((item) => ({
      role: item.direction === "inbound" ? "user" : "assistant",
      content: item.body.slice(0, 8_000),
    }));
}

function normalizeUsage(response) {
  const inputTokens = Math.max(0, Number(response?.usage?.input_tokens ?? response?.usage?.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(response?.usage?.output_tokens ?? response?.usage?.outputTokens) || 0);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function timeoutError() {
  const error = new Error("Tempo limite da IA excedido.");
  error.name = "AiTimeoutError";
  error.code = "AI_TIMEOUT";
  error.retryable = true;
  return error;
}

async function responseWithTimeout(client, request, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      client.responses.create(request, { signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fallback(config, reason, extra = {}) {
  return Object.freeze({
    text: config?.contingencyMessage
      || "O atendimento inteligente está temporariamente indisponível. Consulte o menu ou fale com a equipe.",
    source: "fallback",
    reason,
    ...extra,
  });
}

export class MultiTenantAiService {
  constructor({
    configResolver,
    conversationService,
    clientFactory,
    secretResolver,
    ledger,
    pricingCatalog,
    alertSink = null,
    timeoutMs = 15_000,
    clock = () => new Date(),
    logger = console,
  } = {}) {
    assertAiDependencies({ configResolver, conversationService, clientFactory, secretResolver, ledger, pricingCatalog });
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs inválido.");
    this.configResolver = configResolver;
    this.conversationService = conversationService;
    this.clientFactory = clientFactory;
    this.secretResolver = secretResolver;
    this.ledger = ledger;
    this.pricingCatalog = pricingCatalog;
    this.alertSink = alertSink;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
    this.logger = logger;
  }

  async reply(input) {
    const request = requireAiRequest(input);
    let config;
    try {
      config = normalizeAiConfig(
        await this.configResolver.getAiConfig({ empresaId: request.empresaId }),
        request.empresaId,
      );
    } catch (error) {
      this.#logFailure(request, error, "AI_CONFIG_UNAVAILABLE");
      return fallback(null, "not_configured");
    }
    if (!config.enabled) return fallback(config, "disabled");
    if (isPromptInjectionAttempt(request.message)) {
      this.logger.warn?.("ai_prompt_injection_blocked", {
        empresaId: request.empresaId,
        conversationId: request.conversationId,
        correlationId: request.correlationId,
      });
      return Object.freeze({ text: config.guardrailMessage, source: "guardrail", reason: "prompt_injection" });
    }

    let reservation;
    let pricing;
    let keyType = config.keyType;
    const occurredAt = this.clock();
    try {
      const history = config.maxHistoryMessages
        ? await this.conversationService.getHistory({
          empresaId: request.empresaId,
          conversationId: request.conversationId,
          limit: config.maxHistoryMessages,
        })
        : [];
      const safeContext = allowlistedTenantContext(request.context, config.allowedContextKeys);
      const contextContent = `TENANT_DATA_START\n${serializeTenantContext(safeContext)}\nTENANT_DATA_END`;
      const instructions = buildInstructions(config);
      const inputMessages = [
        { role: "developer", content: contextContent },
        ...historyInput(history, request.messageId),
        { role: "user", content: request.message },
      ];
      pricing = normalizePricing(await this.pricingCatalog.get({
        provider: config.provider,
        model: config.model,
      }), config.model);
      const estimatedInputTokens = estimateTokens(`${instructions}\n${JSON.stringify(inputMessages)}`);
      const estimatedTokens = estimatedInputTokens + config.maxOutputTokens;
      const estimatedCost = calculateCost(pricing, {
        inputTokens: estimatedInputTokens,
        outputTokens: config.maxOutputTokens,
      });
      reservation = await this.ledger.reserve({
        empresaId: request.empresaId,
        occurredAt,
        tokenLimit: config.monthlyTokenLimit,
        costLimit: config.monthlyCostLimit,
        alertPercent: config.alertPercent,
        estimatedTokens,
        estimatedCost,
      });
      if (!reservation?.allowed) return fallback(config, "monthly_limit", { quota: reservation?.usage });

      const credential = await this.secretResolver.resolve({
        empresaId: request.empresaId,
        provider: config.provider,
        keyType: config.keyType,
        credentialId: config.credentialId,
      });
      keyType = credential?.keyType || config.keyType;
      if (config.provider !== "simulated" && !credential?.apiKey) {
        const error = new Error("Credencial de IA indisponível.");
        error.code = "AI_CREDENTIAL_NOT_CONFIGURED";
        throw error;
      }
      const client = await this.clientFactory.create({
        empresaId: request.empresaId,
        provider: config.provider,
        apiKey: credential?.apiKey || null,
      });
      if (typeof client?.responses?.create !== "function") throw new TypeError("Cliente Responses API inválido.");
      const response = await responseWithTimeout(client, {
        model: config.model,
        store: false,
        max_output_tokens: config.maxOutputTokens,
        instructions,
        input: inputMessages,
      }, this.timeoutMs);
      const text = String(response?.output_text || "").trim();
      if (!text) {
        const error = new Error("A IA não retornou texto.");
        error.code = "AI_EMPTY_RESPONSE";
        throw error;
      }
      const usage = normalizeUsage(response);
      const cost = calculateCost(pricing, usage);
      const finalized = await this.ledger.finalize({
        reservationId: reservation.reservationId,
        empresaId: request.empresaId,
        conversationId: request.conversationId,
        messageId: request.messageId,
        correlationId: request.correlationId,
        provider: config.provider,
        model: config.model,
        keyType,
        ...usage,
        cost,
        pricingVersion: pricing.version,
        configVersion: config.version,
        success: true,
        occurredAt,
      });
      await this.#notifyAlert(config, request, finalized);
      return Object.freeze({
        text,
        source: "ai",
        reason: "completed",
        usage: Object.freeze({ ...usage, cost, pricingVersion: pricing.version }),
        quota: finalized.usage,
      });
    } catch (error) {
      const sanitized = sanitizeError(error);
      if (reservation?.allowed) {
        try {
          await this.ledger.finalize({
            reservationId: reservation.reservationId,
            empresaId: request.empresaId,
            conversationId: request.conversationId,
            messageId: request.messageId,
            correlationId: request.correlationId,
            provider: config.provider,
            model: config.model,
            keyType,
            inputTokens: 0,
            outputTokens: 0,
            cost: 0,
            pricingVersion: pricing?.version || "unknown",
            configVersion: config.version,
            success: false,
            errorCode: sanitized.code || "AI_REQUEST_FAILED",
            occurredAt,
          });
        } catch (ledgerError) {
          this.#logFailure(request, ledgerError, "AI_LEDGER_FINALIZE_FAILED");
        }
      }
      this.#logFailure(request, error, sanitized.code || "AI_REQUEST_FAILED");
      return fallback(config, sanitized.code === "AI_TIMEOUT" ? "timeout" : "provider_failure");
    }
  }

  async #notifyAlert(config, request, finalized) {
    if (!finalized?.alertTriggered || typeof this.alertSink?.notify !== "function") return;
    try {
      await this.alertSink.notify({
        empresaId: request.empresaId,
        period: finalized.usage.period,
        usage: finalized.usage,
        thresholdPercent: config.alertPercent,
        correlationId: request.correlationId,
      });
    } catch (error) {
      this.#logFailure(request, error, "AI_ALERT_FAILED");
    }
  }

  #logFailure(request, error, fallbackCode) {
    const sanitized = sanitizeError(error);
    this.logger.warn?.("ai_request_failed", {
      empresaId: request.empresaId,
      conversationId: request.conversationId,
      correlationId: request.correlationId,
      code: sanitized.code || fallbackCode,
    });
  }
}
