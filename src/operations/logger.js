import { redactSensitive, sanitizeError } from "../security/redaction.js";

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, critical: 50 });

export function createStructuredLogger({ level = "info", service = "waia", output = console, sink } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  function emit(severity, eventCode, fields = {}) {
    if ((LEVELS[severity] ?? 100) < threshold) return;
    const record = redactSensitive({
      timestamp: new Date().toISOString(),
      severity,
      service,
      eventCode: String(eventCode || "unknown_event"),
      ...fields,
    });
    const line = JSON.stringify(record);
    const method = severity === "debug" ? "debug" : severity === "warn" ? "warn" : severity === "info" ? "info" : "error";
    output[method]?.(line);
    try { sink?.write?.(record); } catch { /* stdout continua sendo o fallback */ }
  }
  return Object.freeze({
    debug: (code, fields) => emit("debug", code, fields),
    info: (code, fields) => emit("info", code, fields),
    warn: (code, fields) => emit("warn", code, fields),
    error: (code, fields = {}) => emit("error", code, {
      ...fields,
      ...(fields.error ? { error: sanitizeError(fields.error) } : {}),
    }),
    critical: (code, fields) => emit("critical", code, fields),
  });
}
