import {
  IntegrationError,
  detached,
  integrationHealth,
  requireTenantContext,
  safeIntegrationLog,
} from "../common.js";

function requireMethod(target, method, name) {
  if (typeof target?.[method] !== "function") throw new TypeError(`${name}.${method} é obrigatório.`);
}

function normalizeConfiguration(value) {
  if (!value?.enabled || !value.spreadsheetId || !value.integrationId) return null;
  const imports = Object.fromEntries(
    Object.entries(value.imports || {})
      .filter(([, range]) => typeof range === "string" && range.trim())
      .map(([name, range]) => [name, range.trim()]),
  );
  return {
    integrationId: String(value.integrationId),
    spreadsheetId: String(value.spreadsheetId),
    imports,
    orderExportRange: String(value.exports?.orders || "").trim() || null,
    healthRange: String(value.healthRange || Object.values(imports)[0] || "").trim() || null,
    version: Number(value.version || 1),
  };
}

function defaultOrderRow(order, idempotencyKey) {
  return [
    idempotencyKey,
    order.id || "",
    order.customerName || "",
    order.eventId || order.itemId || "",
    order.amount ?? "",
    order.status || "Aguardando conferência",
    order.createdAt || new Date().toISOString(),
  ];
}

/**
 * Tenant-aware facade over a Google Sheets client such as the existing
 * GoogleSheetsClient. The client itself is injected and receives scoped config.
 */
export function createGoogleSheetsIntegration({
  configurationResolver,
  credentialResolver,
  clientFactory,
  cacheRepository,
  idempotencyRepository,
  snapshotMapper = (raw) => raw,
  orderRowMapper = defaultOrderRow,
  logger = console,
} = {}) {
  requireMethod(configurationResolver, "resolveGoogleSheets", "configurationResolver");
  requireMethod(credentialResolver, "resolveGoogleSheets", "credentialResolver");
  if (typeof clientFactory !== "function") throw new TypeError("clientFactory é obrigatório.");
  requireMethod(cacheRepository, "load", "cacheRepository");
  requireMethod(cacheRepository, "save", "cacheRepository");
  requireMethod(idempotencyRepository, "runOnce", "idempotencyRepository");

  async function resolve(context) {
    const tenant = requireTenantContext(context);
    const config = normalizeConfiguration(await configurationResolver.resolveGoogleSheets(tenant));
    if (!config) return { tenant, config: null, credentials: null, client: null };
    const credentials = await credentialResolver.resolveGoogleSheets({
      ...tenant,
      integrationId: config.integrationId,
    });
    if (!credentials) return { tenant, config, credentials: null, client: null };
    const client = await clientFactory({
      ...tenant,
      integrationId: config.integrationId,
      spreadsheetId: config.spreadsheetId,
      credentials,
    });
    requireMethod(client, "getValues", "googleClient");
    requireMethod(client, "appendValues", "googleClient");
    return { tenant, config, credentials, client };
  }

  async function resolveConfiguration(context) {
    const tenant = requireTenantContext(context);
    const config = normalizeConfiguration(await configurationResolver.resolveGoogleSheets(tenant));
    return { tenant, config };
  }

  function cacheScope(tenant, config) {
    return { empresaId: tenant.empresaId, integrationId: config.integrationId };
  }

  async function syncTenant(context) {
    let scoped;
    try {
      scoped = await resolve(context);
      if (!scoped.config || !scoped.credentials) {
        return { health: "not_configured", snapshot: null, stale: false };
      }
      const rawEntries = await Promise.all(Object.entries(scoped.config.imports).map(async ([name, range]) => [
        name,
        await scoped.client.getValues(range),
      ]));
      const snapshot = await snapshotMapper(Object.fromEntries(rawEntries), scoped.config, scoped.tenant);
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        throw new IntegrationError("O Google Sheets retornou dados inválidos.", { code: "GOOGLE_INVALID_SNAPSHOT", retryable: false });
      }
      await cacheRepository.save(cacheScope(scoped.tenant, scoped.config), {
        snapshot: detached(snapshot),
        configVersion: scoped.config.version,
        syncedAt: new Date().toISOString(),
      });
      return { health: "healthy", snapshot: detached(snapshot), stale: false };
    } catch (error) {
      const tenant = scoped?.tenant || requireTenantContext(context);
      if (scoped?.config && typeof cacheRepository.markFailure === "function") {
        await cacheRepository.markFailure(cacheScope(tenant, scoped.config), error?.code || "GOOGLE_SYNC_FAILED").catch(() => {});
      }
      safeIntegrationLog(logger, "warn", "google_sheets_sync_failed", tenant, {
        integration: "google_sheets",
        operation: "sync",
        errorCode: error?.code || "GOOGLE_SYNC_FAILED",
      });
      const cached = scoped?.config ? await cacheRepository.load(cacheScope(tenant, scoped.config)) : null;
      return {
        health: "unavailable",
        snapshot: detached(cached?.snapshot || null),
        stale: Boolean(cached?.snapshot),
        errorCode: error?.code || "GOOGLE_SYNC_FAILED",
      };
    }
  }

  async function getCachedSnapshot(context) {
    const scoped = await resolveConfiguration(context);
    if (!scoped.config) return null;
    const cached = await cacheRepository.load(cacheScope(scoped.tenant, scoped.config));
    return detached(cached?.snapshot || null);
  }

  async function exportOrder(context, order, { idempotencyKey } = {}) {
    const scoped = await resolve(context);
    if (!scoped.config || !scoped.credentials || !scoped.config.orderExportRange) {
      throw new IntegrationError("Exportação de pedidos no Google Sheets não configurada.", {
        code: "GOOGLE_ORDER_EXPORT_NOT_CONFIGURED",
        retryable: false,
      });
    }
    const key = String(idempotencyKey || order?.idempotencyKey || order?.id || "").trim();
    if (!key) throw new TypeError("idempotencyKey é obrigatório para exportar pedido.");
    try {
      return await idempotencyRepository.runOnce({
        empresaId: scoped.tenant.empresaId,
        integrationId: scoped.config.integrationId,
        operation: "order_export",
        idempotencyKey: key,
      }, async () => {
        const row = await orderRowMapper(detached(order), key, scoped.config, scoped.tenant);
        if (!Array.isArray(row)) throw new TypeError("orderRowMapper deve retornar um array.");
        const providerResult = await scoped.client.appendValues(scoped.config.orderExportRange, row);
        return { exported: true, providerResult };
      });
    } catch (error) {
      safeIntegrationLog(logger, "warn", "google_sheets_order_export_failed", scoped.tenant, {
        integration: "google_sheets",
        operation: "order_export",
        errorCode: error?.code || "GOOGLE_ORDER_EXPORT_FAILED",
      });
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError("Não foi possível exportar o pedido.", { code: "GOOGLE_ORDER_EXPORT_FAILED" });
    }
  }

  async function health(context) {
    try {
      const scoped = await resolve(context);
      if (!scoped.config || !scoped.credentials) return integrationHealth("not_configured", { integration: "google_sheets" });
      if (typeof scoped.client.checkHealth === "function") await scoped.client.checkHealth();
      else if (scoped.config.healthRange) await scoped.client.getValues(scoped.config.healthRange);
      else throw new IntegrationError("Range de diagnóstico não configurado.", { code: "GOOGLE_HEALTH_NOT_CONFIGURED", retryable: false });
      return integrationHealth("healthy", { integration: "google_sheets" });
    } catch (error) {
      return integrationHealth("unavailable", { integration: "google_sheets", errorCode: error?.code || "GOOGLE_UNAVAILABLE" });
    }
  }

  return Object.freeze({ syncTenant, getCachedSnapshot, exportOrder, health });
}
