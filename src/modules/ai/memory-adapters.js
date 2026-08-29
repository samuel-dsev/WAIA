import { randomUUID } from "node:crypto";
import { normalizePricing } from "./pricing.js";

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function assertMemoryEnvironment(environment = process.env.NODE_ENV || "development") {
  if (environment !== "development" && environment !== "test") {
    throw new Error("Adaptadores de IA em memória são permitidos apenas em development ou test.");
  }
}

function monthKey(date) {
  return new Date(date).toISOString().slice(0, 7);
}

export class MemoryAiConfigResolver {
  constructor(configs = [], { environment } = {}) {
    assertMemoryEnvironment(environment);
    this.configs = new Map(configs.map((config) => [config.empresaId, clone(config)]));
  }

  async getAiConfig({ empresaId }) {
    return clone(this.configs.get(empresaId) || null);
  }

  set(config) {
    this.configs.set(config.empresaId, clone(config));
  }
}

export class MemoryAiSecretResolver {
  constructor({ sharedSecret = null, ownSecrets = new Map(), environment } = {}) {
    assertMemoryEnvironment(environment);
    this.sharedSecret = sharedSecret;
    this.ownSecrets = ownSecrets instanceof Map ? ownSecrets : new Map(Object.entries(ownSecrets));
    this.requests = [];
  }

  async resolve(input) {
    this.requests.push({ ...input });
    if (input.keyType === "simulated") return { apiKey: null, keyType: "simulated" };
    if (input.keyType === "shared" && this.sharedSecret) {
      return { apiKey: this.sharedSecret, keyType: "shared" };
    }
    const secret = this.ownSecrets.get(`${input.empresaId}:${input.credentialId}`);
    if (input.keyType === "own" && secret) return { apiKey: secret, keyType: "own" };
    const error = new Error("Credencial de IA não configurada.");
    error.code = "AI_CREDENTIAL_NOT_CONFIGURED";
    throw error;
  }
}

export class MemoryPricingCatalog {
  constructor(prices = {}, { environment } = {}) {
    assertMemoryEnvironment(environment);
    this.prices = new Map(Object.entries(prices));
  }

  async get({ model }) {
    return normalizePricing(this.prices.get(model), model);
  }
}

export class MemoryAiLedger {
  constructor({ clock = () => new Date(), idFactory = randomUUID, environment } = {}) {
    assertMemoryEnvironment(environment);
    this.clock = clock;
    this.idFactory = idFactory;
    this.accounts = new Map();
    this.reservations = new Map();
    this.events = [];
  }

  #account(empresaId, occurredAt) {
    const period = monthKey(occurredAt);
    const key = `${empresaId}:${period}`;
    if (!this.accounts.has(key)) {
      this.accounts.set(key, {
        empresaId,
        period,
        tokens: 0,
        cost: 0,
        reservedTokens: 0,
        reservedCost: 0,
        alertSent: false,
      });
    }
    return this.accounts.get(key);
  }

  async reserve(input) {
    const occurredAt = input.occurredAt || this.clock();
    const account = this.#account(input.empresaId, occurredAt);
    const estimatedTokens = Math.max(0, Number(input.estimatedTokens) || 0);
    const estimatedCost = Math.max(0, Number(input.estimatedCost) || 0);
    const tokenTotal = account.tokens + account.reservedTokens + estimatedTokens;
    const costTotal = account.cost + account.reservedCost + estimatedCost;
    const allowed = (input.tokenLimit == null || tokenTotal <= input.tokenLimit)
      && (input.costLimit == null || costTotal <= input.costLimit);
    if (!allowed) {
      return Object.freeze({
        allowed: false,
        period: account.period,
        usage: { tokens: account.tokens, cost: account.cost },
      });
    }
    const reservationId = this.idFactory();
    account.reservedTokens += estimatedTokens;
    account.reservedCost += estimatedCost;
    this.reservations.set(reservationId, {
      empresaId: input.empresaId,
      period: account.period,
      estimatedTokens,
      estimatedCost,
      tokenLimit: input.tokenLimit,
      costLimit: input.costLimit,
      alertPercent: input.alertPercent,
    });
    return Object.freeze({ allowed: true, reservationId, period: account.period });
  }

  async finalize(input) {
    const reservation = this.reservations.get(input.reservationId);
    if (!reservation || reservation.empresaId !== input.empresaId) {
      throw new Error("Reserva de consumo de IA inválida.");
    }
    this.reservations.delete(input.reservationId);
    const account = this.accounts.get(`${reservation.empresaId}:${reservation.period}`);
    account.reservedTokens = Math.max(0, account.reservedTokens - reservation.estimatedTokens);
    account.reservedCost = Math.max(0, account.reservedCost - reservation.estimatedCost);
    const inputTokens = Math.max(0, Number(input.inputTokens) || 0);
    const outputTokens = Math.max(0, Number(input.outputTokens) || 0);
    const totalTokens = inputTokens + outputTokens;
    const cost = Math.max(0, Number(input.cost) || 0);
    account.tokens += totalTokens;
    account.cost += cost;

    const tokenRatio = reservation.tokenLimit > 0 ? account.tokens / reservation.tokenLimit : 0;
    const costRatio = reservation.costLimit > 0 ? account.cost / reservation.costLimit : 0;
    const alertTriggered = !account.alertSent
      && Math.max(tokenRatio, costRatio) * 100 >= reservation.alertPercent;
    if (alertTriggered) account.alertSent = true;
    const event = Object.freeze({
      empresaId: input.empresaId,
      conversationId: input.conversationId,
      messageId: input.messageId || null,
      correlationId: input.correlationId,
      provider: input.provider,
      model: input.model,
      keyType: input.keyType,
      inputTokens,
      outputTokens,
      totalTokens,
      cost,
      pricingVersion: input.pricingVersion,
      configVersion: input.configVersion,
      success: input.success === true,
      errorCode: input.errorCode || null,
      occurredAt: new Date(input.occurredAt || this.clock()),
    });
    this.events.push(event);
    return Object.freeze({
      usage: { tokens: account.tokens, cost: account.cost, period: account.period },
      alertTriggered,
      event,
    });
  }

  usage(empresaId, date = this.clock()) {
    const account = this.#account(empresaId, date);
    return clone({ tokens: account.tokens, cost: account.cost, period: account.period });
  }
}

export class MemoryResponsesClientFactory {
  constructor(responder = async () => ({ output_text: "Resposta simulada.", usage: {} }), { environment } = {}) {
    assertMemoryEnvironment(environment);
    this.responder = responder;
    this.clients = [];
    this.requests = [];
  }

  async create(options) {
    this.clients.push({ ...options });
    return {
      responses: {
        create: async (request, transportOptions) => {
          this.requests.push({ request: clone(request), transportOptions, client: { ...options } });
          return this.responder(request, transportOptions, options);
        },
      },
    };
  }
}

export class MemoryAiAlertSink {
  constructor({ environment } = {}) {
    assertMemoryEnvironment(environment);
    this.alerts = [];
  }
  async notify(alert) { this.alerts.push(clone(alert)); }
}
