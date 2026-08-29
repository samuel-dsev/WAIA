export function retryDelay(attempt, {
  baseDelayMs = 1_000,
  maxDelayMs = 60_000,
  jitter = 0.25,
  random = Math.random,
} = {}) {
  const normalizedAttempt = Math.max(1, Number(attempt) || 1);
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** (normalizedAttempt - 1)));
  const boundedJitter = Math.min(1, Math.max(0, Number(jitter) || 0));
  const multiplier = 1 - boundedJitter + ((Number(random()) || 0) * boundedJitter);
  return Math.max(0, Math.round(exponential * multiplier));
}
