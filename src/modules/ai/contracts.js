const PROVIDERS = new Set(["openai", "simulated"]);
const KEY_TYPES = new Set(["shared", "own", "simulated"]);
const PROVIDER_ALIASES = Object.freeze({ openai: "openai", simulated: "simulated", simulado: "simulated" });
const KEY_TYPE_ALIASES = Object.freeze({
  shared: "shared",
  compartilhada: "shared",
  own: "own",
  propria: "own",
  simulated: "simulated",
  simulada: "simulated",
});

function requiredText(value, field, max = 10_000) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw new TypeError(`${field} inválido.`);
  return text;
}

function optionalText(value, field, max = 10_000) {
  if (value == null || value === "") return "";
  return requiredText(value, field, max);
}

function optionalLimit(value, field) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${field} inválido.`);
  return number;
}

function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new TypeError(`${field} inválido.`);
  }
  return number;
}

export function requireAiRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Requisição de IA inválida.");
  return Object.freeze({
    empresaId: requiredText(input.empresaId, "empresaId", 200),
    conversationId: requiredText(input.conversationId, "conversationId", 200),
    messageId: input.messageId == null ? null : requiredText(input.messageId, "messageId", 200),
    correlationId: requiredText(input.correlationId, "correlationId", 200),
    message: requiredText(input.message, "message", 8_000),
    context: input.context && typeof input.context === "object" && !Array.isArray(input.context)
      ? input.context
      : {},
  });
}

export function normalizeAiConfig(input, empresaId) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Configuração de IA não encontrada.");
  }
  if (String(input.empresaId || "") !== empresaId) {
    throw new TypeError("Configuração de IA pertence a outra empresa.");
  }
  const provider = PROVIDER_ALIASES[String(input.provider || "openai")];
  const keyType = provider === "simulated"
    ? "simulated"
    : KEY_TYPE_ALIASES[String(input.keyType || "shared")];
  if (!PROVIDERS.has(provider)) throw new TypeError("Provedor de IA inválido.");
  if (!KEY_TYPES.has(keyType)) throw new TypeError("Tipo de chave de IA inválido.");
  if (keyType === "own" && !input.credentialId) throw new TypeError("Credencial própria obrigatória.");
  const allowedContextKeys = Array.isArray(input.allowedContextKeys)
    ? [...new Set(input.allowedContextKeys.map((key) => requiredText(key, "allowedContextKeys", 100)))]
    : [];
  return Object.freeze({
    empresaId,
    enabled: input.enabled === true,
    provider,
    model: requiredText(input.model || "gpt-4.1-mini", "model", 200),
    prompt: optionalText(input.prompt, "prompt", 20_000),
    personality: optionalText(input.personality, "personality", 5_000),
    keyType,
    credentialId: keyType === "own" ? requiredText(input.credentialId, "credentialId", 200) : null,
    monthlyTokenLimit: optionalLimit(input.monthlyTokenLimit, "monthlyTokenLimit"),
    monthlyCostLimit: optionalLimit(input.monthlyCostLimit, "monthlyCostLimit"),
    alertPercent: integer(input.alertPercent ?? 80, "alertPercent", { min: 1, max: 100 }),
    maxHistoryMessages: integer(input.maxHistoryMessages ?? 8, "maxHistoryMessages", { max: 100 }),
    maxOutputTokens: integer(input.maxOutputTokens ?? 300, "maxOutputTokens", { min: 1, max: 32_768 }),
    contingencyMessage: optionalText(input.contingencyMessage, "contingencyMessage", 2_000)
      || "O atendimento inteligente está temporariamente indisponível. Consulte o menu ou fale com a equipe.",
    guardrailMessage: optionalText(input.guardrailMessage, "guardrailMessage", 2_000)
      || "Não posso seguir instruções para alterar ou revelar as regras internas do atendimento. Posso ajudar com informações desta empresa.",
    allowedContextKeys,
    version: integer(input.version ?? 1, "version", { min: 1 }),
  });
}

export function assertAiDependencies({ configResolver, conversationService, clientFactory, secretResolver, ledger, pricingCatalog }) {
  const required = [
    [configResolver, "getAiConfig", "configResolver"],
    [conversationService, "getHistory", "conversationService"],
    [clientFactory, "create", "clientFactory"],
    [secretResolver, "resolve", "secretResolver"],
    [ledger, "reserve", "ledger"],
    [ledger, "finalize", "ledger"],
    [pricingCatalog, "get", "pricingCatalog"],
  ];
  for (const [dependency, method, name] of required) {
    if (typeof dependency?.[method] !== "function") throw new TypeError(`${name}.${method} é obrigatório.`);
  }
}
