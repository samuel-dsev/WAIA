import { assertSimulationAllowed, detached, integrationHealth, requireTenantContext } from "./common.js";

function fixtureFor(fixtures, context, options) {
  const tenant = requireTenantContext(context, options);
  return { tenant, fixture: fixtures[tenant.empresaId] || null };
}

export function createSimulatedMetaGateway({ tenants = {}, environment = process.env.NODE_ENV } = {}) {
  assertSimulationAllowed(environment);
  const calls = [];
  function available(context) {
    const scoped = fixtureFor(tenants, context, { requireNumber: true });
    return { ...scoped, configured: Boolean(scoped.fixture?.configured !== false && scoped.fixture) };
  }
  async function sendReply(context, payload) {
    const scoped = available(context);
    if (!scoped.configured || scoped.fixture.unavailable) throw new Error("Meta simulada indisponível.");
    const result = { id: `sim-meta-${calls.length + 1}` };
    calls.push({ empresaId: scoped.tenant.empresaId, operation: "send_reply", payload: detached(payload) });
    return result;
  }
  async function sendStatus(context, payload) {
    const scoped = available(context);
    if (!scoped.configured || scoped.fixture.unavailable) throw new Error("Meta simulada indisponível.");
    calls.push({ empresaId: scoped.tenant.empresaId, operation: "send_status", payload: detached(payload) });
    return { success: true };
  }
  async function health(context) {
    const scoped = available(context);
    if (!scoped.configured) return integrationHealth("not_configured", { integration: "meta" });
    return integrationHealth(scoped.fixture.unavailable ? "unavailable" : "healthy", { integration: "meta" });
  }
  return Object.freeze({ sendReply, sendStatus, markRead: sendStatus, health, calls });
}

export function createSimulatedGoogleSheetsIntegration({ tenants = {}, environment = process.env.NODE_ENV } = {}) {
  assertSimulationAllowed(environment);
  const exportsByTenant = new Map();
  async function syncTenant(context) {
    const { fixture } = fixtureFor(tenants, context);
    if (!fixture?.configured) return { health: "not_configured", snapshot: null, stale: false };
    if (fixture.unavailable) return { health: "unavailable", snapshot: detached(fixture.lastValidSnapshot || null), stale: Boolean(fixture.lastValidSnapshot) };
    return { health: "healthy", snapshot: detached(fixture.snapshot || {}), stale: false };
  }
  async function getCachedSnapshot(context) {
    const { fixture } = fixtureFor(tenants, context);
    return detached(fixture?.lastValidSnapshot || fixture?.snapshot || null);
  }
  async function exportOrder(context, order, { idempotencyKey } = {}) {
    const { tenant, fixture } = fixtureFor(tenants, context);
    if (!fixture?.configured || fixture.unavailable) throw new Error("Google Sheets simulado indisponível.");
    const key = String(idempotencyKey || order?.idempotencyKey || order?.id || "");
    if (!key) throw new TypeError("idempotencyKey é obrigatório.");
    const tenantExports = exportsByTenant.get(tenant.empresaId) || new Map();
    exportsByTenant.set(tenant.empresaId, tenantExports);
    if (tenantExports.has(key)) return { executed: false, value: detached(tenantExports.get(key)) };
    const value = { exported: true, order: detached(order) };
    tenantExports.set(key, value);
    return { executed: true, value: detached(value) };
  }
  async function health(context) {
    const { fixture } = fixtureFor(tenants, context);
    if (!fixture?.configured) return integrationHealth("not_configured", { integration: "google_sheets" });
    return integrationHealth(fixture.unavailable ? "unavailable" : "healthy", { integration: "google_sheets" });
  }
  return Object.freeze({ syncTenant, getCachedSnapshot, exportOrder, health, exportsByTenant });
}

export function createSimulatedOpenAiGateway({ tenants = {}, environment = process.env.NODE_ENV } = {}) {
  assertSimulationAllowed(environment);
  const calls = [];
  async function reply(context, input) {
    const { tenant, fixture } = fixtureFor(tenants, context);
    if (!fixture?.configured || fixture.unavailable) throw new Error("OpenAI simulada indisponível.");
    calls.push({ empresaId: tenant.empresaId, message: String(input?.message || "") });
    return {
      text: fixture.response || "Resposta simulada.",
      model: fixture.model || "simulated-model",
      keyMode: fixture.keyMode || "shared",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }
  async function health(context) {
    const { fixture } = fixtureFor(tenants, context);
    if (!fixture?.configured) return integrationHealth("not_configured", { integration: "openai" });
    return integrationHealth(fixture.unavailable ? "unavailable" : "healthy", { integration: "openai" });
  }
  return Object.freeze({ reply, health, calls });
}
