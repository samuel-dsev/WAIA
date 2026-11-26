function nonNegative(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${field} inválido.`);
  return number;
}

export function normalizePricing(input, model) {
  if (!input || typeof input !== "object") throw new TypeError(`Preço não configurado para ${model}.`);
  const cachedPrice = input.cachedInputPerMillion == null ? NaN : Number(input.cachedInputPerMillion);
  return Object.freeze({
    model,
    inputPerMillion: nonNegative(input.inputPerMillion, "inputPerMillion"),
    outputPerMillion: nonNegative(input.outputPerMillion, "outputPerMillion"),
    // Optional observation must not disable attendance on a malformed cache tariff.
    ...(Number.isFinite(cachedPrice) && cachedPrice >= 0 ? {
      cachedInputPerMillion: cachedPrice,
    } : {}),
    version: String(input.version || "unknown").slice(0, 100),
  });
}

export function calculateCost(pricing, { inputTokens = 0, outputTokens = 0 } = {}) {
  return ((Number(inputTokens) * pricing.inputPerMillion)
    + (Number(outputTokens) * pricing.outputPerMillion)) / 1_000_000;
}

// Observational estimate only: reservations and monthly quotas keep calculateCost.
export function calculateCacheAdjustedCost(pricing, usage) {
  if (!usage || usage.cachedInputTokens == null || usage.cacheWriteInputTokens == null) return null;
  // Cache-write tariffs vary by model and lifetime. Do not invent a tariff.
  if (usage.cacheWriteInputTokens > 0) return null;
  if (usage.cachedInputTokens > 0 && pricing.cachedInputPerMillion == null) return null;
  return ((usage.inputTokens - usage.cachedInputTokens) * pricing.inputPerMillion
    + usage.cachedInputTokens * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion)
    + usage.outputTokens * pricing.outputPerMillion) / 1_000_000;
}

export function estimateTokens(value) {
  return Math.max(1, Math.ceil(String(value || "").length / 4));
}
