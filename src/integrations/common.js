import { INTEGRATION_HEALTH } from "../core/contracts.js";

const HEALTH_SET = new Set(INTEGRATION_HEALTH);

export function requireTenantContext(context, { requireNumber = false } = {}) {
  const empresaId = String(context?.empresaId || "").trim();
  const numeroWhatsappId = String(context?.numeroWhatsappId || "").trim();
  if (!empresaId) throw new TypeError("context.empresaId é obrigatório.");
  if (requireNumber && !numeroWhatsappId) throw new TypeError("context.numeroWhatsappId é obrigatório.");
  return { empresaId, ...(numeroWhatsappId ? { numeroWhatsappId } : {}) };
}

export function integrationHealth(state, extra = {}) {
  if (!HEALTH_SET.has(state)) throw new TypeError(`Estado de integração inválido: ${state}.`);
  return Object.freeze({ state, ...extra });
}

export function assertSimulationAllowed(environment = process.env.NODE_ENV) {
  if (!new Set(["development", "test"]).has(environment)) {
    throw new Error("Adaptadores simulados são permitidos somente em development e test.");
  }
}

export function safeIntegrationLog(logger, level, event, context, extra = {}) {
  const candidateCode = String(extra.errorCode || "");
  const errorCode = /^[A-Z][A-Z0-9_]{1,63}$/u.test(candidateCode)
    ? candidateCode
    : "INTEGRATION_ERROR";
  logger?.[level]?.(event, {
    empresaId: context?.empresaId || null,
    numeroWhatsappId: context?.numeroWhatsappId || null,
    integration: extra.integration,
    operation: extra.operation,
    status: Number.isInteger(extra.status) ? extra.status : undefined,
    errorCode,
  });
}

export class IntegrationError extends Error {
  constructor(message, { code = "INTEGRATION_ERROR", status, retryable = true } = {}) {
    super(message);
    this.name = "IntegrationError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function detached(value) {
  return value == null ? value : structuredClone(value);
}
