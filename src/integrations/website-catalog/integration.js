import { withPlatformTransaction, withTenantTransaction } from "../../infra/postgres/transaction.js";
import { fetchWebsiteStock, websiteCatalogFromCache } from "./stock.js";

export class WebsiteCatalogIntegration {
  constructor({ pool, fetchStock = fetchWebsiteStock, logger = console }) {
    this.pool = pool;
    this.fetchStock = fetchStock;
    this.logger = logger;
  }

  read(empresaId) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const { rows: [row] } = await client.query(
        `SELECT status, cache_snapshot, last_success_at, last_error_sanitized
           FROM integracoes WHERE empresa_id = $1 AND tipo = 'website_catalog'
            AND habilitada AND deleted_at IS NULL`, [empresaId],
      );
      const catalog = websiteCatalogFromCache(row);
      return {
        health: row ? catalog.source.status : "not_configured",
        lastSyncedAt: catalog.source.lastSyncedAt ?? null,
        errorCode: row?.last_error_sanitized ?? null,
        items: catalog.items,
      };
    });
  }

  async syncTenant(empresaId) {
    const attempt = await withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const { rows: [row] } = await client.query(
        `UPDATE integracoes SET last_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE empresa_id = $1 AND tipo = 'website_catalog' AND habilitada AND deleted_at IS NULL
          RETURNING id, updated_at::text AS revision`, [empresaId],
      );
      return row;
    });
    if (!attempt) return { health: "not_configured", productsImported: 0 };

    let snapshot, errorCode;
    try {
      snapshot = await this.fetchStock();
    } catch (error) {
      errorCode = /^WEBSITE_CATALOG_[A-Z_]+$/u.test(error?.code) ? error.code : "WEBSITE_CATALOG_FETCH_FAILED";
    }
    // Only the latest attempt for this still-enabled integration may publish.
    const saved = await withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const params = [empresaId, attempt.id, attempt.revision];
      const updates = snapshot
        ? `cache_version = cache_version + (cache_snapshot IS DISTINCT FROM $4::jsonb)::int,
           cache_snapshot = $4::jsonb, status = 'saudavel', last_success_at = clock_timestamp(), last_error_sanitized = NULL`
        : `status = 'indisponivel', last_error_sanitized = $4::text`;
      const result = await client.query(
        `UPDATE integracoes SET ${updates}, updated_at = clock_timestamp()
          WHERE empresa_id = $1 AND id = $2 AND updated_at = $3::timestamptz
            AND tipo = 'website_catalog' AND habilitada AND deleted_at IS NULL`,
        [...params, snapshot ? JSON.stringify(snapshot) : errorCode],
      );
      return result.rowCount === 1;
    });
    if (!saved) return { health: "superseded", productsImported: 0 };
    return snapshot
      ? { health: "healthy", productsImported: snapshot.products.length }
      : { health: "unavailable", productsImported: 0, errorCode };
  }

  async runOnce() {
    const tenants = await withPlatformTransaction(this.pool, {}, async ({ client }) => (
      await client.query(
        `SELECT i.empresa_id FROM integracoes i JOIN empresas e ON e.id = i.empresa_id
          WHERE i.tipo = 'website_catalog' AND i.habilitada AND i.deleted_at IS NULL
            AND e.status = 'ativa' AND e.deleted_at IS NULL ORDER BY i.empresa_id`,
      )
    ).rows);
    for (const { empresa_id: empresaId } of tenants) {
      try {
        await this.syncTenant(empresaId);
      } catch {
        this.logger.warn?.("website_catalog_tenant_sync_failed", { empresaId });
      }
    }
  }
}
