import { randomUUID } from "node:crypto";

export const TENANT_STATUSES = Object.freeze(["draft", "active", "suspended", "archived"]);
export const USER_ROLES = Object.freeze(["platform_admin", "tenant_admin", "tenant_operator"]);
export const MODULE_KEYS = Object.freeze([
  "catalog",
  "orders",
  "events",
  "appointments",
  "payments",
  "human_handoff",
  "ai_freeform",
  "external_integrations",
]);

export const MESSAGE_STATUSES = Object.freeze([
  "received",
  "queued",
  "processing",
  "responded",
  "sent",
  "delivered",
  "read",
  "failed",
  "duplicate_ignored",
]);

export const INTEGRATION_HEALTH = Object.freeze([
  "not_configured",
  "not_checked",
  "healthy",
  "unavailable",
]);

export function requireTenantContext(context) {
  if (!context?.empresaId) throw new Error("Contexto de empresa obrigatório.");
  return context;
}

export function createCorrelationId(value) {
  const normalized = String(value || "").trim();
  return normalized || randomUUID();
}

export function isModuleKey(value) {
  return MODULE_KEYS.includes(value);
}
