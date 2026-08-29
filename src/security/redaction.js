export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /(?:^|[_-])(?:authorization|cookie|password|passphrase|secret|secrets|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|app[_-]?secret|webhook[_-]?secret|master[_-]?key|ciphertext|auth[_-]?tag)(?:$|[_-])/iu;

function redactText(value, additionalSecrets) {
  let result = String(value);
  for (const secret of additionalSecrets) {
    if (secret.length >= 3) result = result.split(secret).join(REDACTED);
  }
  return result
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED}`)
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, REDACTED)
    .replace(/([?&](?:access_token|api_key|key|secret|token)=)[^&\s]+/giu, `$1${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, REDACTED);
}

export function isSensitiveKey(key) {
  const normalized = String(key || "").replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
  return SENSITIVE_KEY.test(`_${normalized}_`);
}

export function redactSensitive(value, { additionalSecrets = [], maxDepth = 12 } = {}) {
  const secrets = additionalSecrets.map((item) => String(item || "")).filter(Boolean).sort((a, b) => b.length - a.length);
  const seen = new WeakSet();

  function visit(current, depth) {
    if (typeof current === "string") return redactText(current, secrets);
    if (current === null || typeof current === "number" || typeof current === "boolean" || typeof current === "undefined") return current;
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "function" || typeof current === "symbol") return undefined;
    if (Buffer.isBuffer(current) || current instanceof Uint8Array) return REDACTED;
    if (current instanceof Date) return current.toISOString();
    if (depth >= maxDepth) return "[MAX_DEPTH]";
    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);

    if (current instanceof Error) {
      return {
        name: current.name,
        ...(current.code ? { code: redactText(current.code, secrets) } : {}),
        message: redactText(current.message || "Falha interna.", secrets),
      };
    }
    if (Array.isArray(current)) return current.map((item) => visit(item, depth + 1));

    const result = {};
    for (const [key, item] of Object.entries(current)) {
      result[key] = isSensitiveKey(key) ? REDACTED : visit(item, depth + 1);
    }
    return result;
  }

  return visit(value, 0);
}

export function sanitizeError(error, options) {
  const sanitized = redactSensitive(error instanceof Error ? error : new Error("Falha interna."), options);
  return Object.freeze({
    name: sanitized.name || "Error",
    ...(sanitized.code ? { code: sanitized.code } : {}),
    message: sanitized.message || "Falha interna.",
  });
}
