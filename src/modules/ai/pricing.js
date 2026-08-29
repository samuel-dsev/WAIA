function nonNegative(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${field} inválido.`);
  return number;
}

export function normalizePricing(input, model) {
  if (!input || typeof input !== "object") throw new TypeError(`Preço não configurado para ${model}.`);
  return Object.freeze({
    model,
    inputPerMillion: nonNegative(input.inputPerMillion, "inputPerMillion"),
    outputPerMillion: nonNegative(input.outputPerMillion, "outputPerMillion"),
    version: String(input.version || "unknown").slice(0, 100),
  });
}

export function calculateCost(pricing, { inputTokens = 0, outputTokens = 0 } = {}) {
  return ((Number(inputTokens) * pricing.inputPerMillion)
    + (Number(outputTokens) * pricing.outputPerMillion)) / 1_000_000;
}

export function estimateTokens(value) {
  return Math.max(1, Math.ceil(String(value || "").length / 4));
}
