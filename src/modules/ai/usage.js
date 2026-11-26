function tokenCount(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

// Unknown cache usage stays unknown, including events written before collection.
export function normalizeCacheUsage(usage = {}, inputTokens = 0) {
  let cachedInputTokens = tokenCount(usage.cachedInputTokens);
  let cacheWriteInputTokens = tokenCount(usage.cacheWriteInputTokens);
  if (cachedInputTokens > inputTokens) cachedInputTokens = null;
  if (cacheWriteInputTokens > inputTokens) cacheWriteInputTokens = null;
  if (cachedInputTokens != null && cacheWriteInputTokens != null
    && cachedInputTokens + cacheWriteInputTokens > inputTokens) {
    cachedInputTokens = null;
    cacheWriteInputTokens = null;
  }
  return { cachedInputTokens, cacheWriteInputTokens };
}

export function normalizeProviderUsage(response) {
  const usage = response?.usage || {};
  const inputTokens = tokenCount(usage.input_tokens ?? usage.inputTokens) ?? 0;
  const outputTokens = tokenCount(usage.output_tokens ?? usage.outputTokens) ?? 0;
  const details = usage.input_tokens_details;
  const cache = normalizeCacheUsage({
    cachedInputTokens: details?.cached_tokens,
    // Earlier models report cache reads without a cache-write field.
    cacheWriteInputTokens: details && Object.hasOwn(details, "cache_write_tokens")
      ? details.cache_write_tokens : details?.cached_tokens != null ? 0 : null,
  }, inputTokens);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, ...cache };
}

export function addProviderUsage(previous, current) {
  if (!previous) return { ...current };
  const inputTokens = previous.inputTokens + current.inputTokens;
  const outputTokens = previous.outputTokens + current.outputTokens;
  const sumKnown = (key) => previous[key] == null || current[key] == null ? null : previous[key] + current[key];
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    cachedInputTokens: sumKnown("cachedInputTokens"), cacheWriteInputTokens: sumKnown("cacheWriteInputTokens") };
}

export function nullableCacheCost(value) {
  if (value == null) return null;
  const cost = Number(value);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}
