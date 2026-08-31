import { createHash } from "node:crypto";
import { withPlatformTransaction, withTenantTransaction } from "../../infra/postgres/transaction.js";

const DEFAULT_IMPORTS = Object.freeze({ agenda: "Agenda!A2:I", settings: "Configurações!A2:C" });
const DEFAULT_ORDER_RANGE = "Pedidos!A:G";

function text(value, max = 5_000) {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim().slice(0, max);
}

function price(value) {
  const normalized = text(value, 80).replace(/R\$\s*/giu, "").replace(/\s/gu, "");
  if (!normalized) return 0;
  const decimal = normalized.includes(",")
    ? normalized.replace(/\./gu, "").replace(",", ".")
    : normalized;
  const parsed = Number(decimal);
  if (!Number.isFinite(parsed) || parsed < 0) throw Object.assign(new Error("Preço inválido na agenda."), { code: "GOOGLE_INVALID_PRICE", retryable: false });
  return Math.round(parsed * 100) / 100;
}

function localDate(dateValue, timeValue) {
  const date = text(dateValue, 20);
  const time = text(timeValue, 20) || "00:00";
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/u) || date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/u);
  if (!match) throw Object.assign(new Error("Data inválida na agenda."), { code: "GOOGLE_INVALID_DATE", retryable: false });
  const isoDate = match[1].length === 4 ? `${match[1]}-${match[2]}-${match[3]}` : `${match[3]}-${match[2]}-${match[1]}`;
  if (!/^\d{2}:\d{2}(?::\d{2})?$/u.test(time)) throw Object.assign(new Error("Horário inválido na agenda."), { code: "GOOGLE_INVALID_TIME", retryable: false });
  const instant = new Date(`${isoDate}T${time.length === 5 ? `${time}:00` : time}-03:00`);
  if (Number.isNaN(instant.getTime())) throw Object.assign(new Error("Data inválida na agenda."), { code: "GOOGLE_INVALID_DATE", retryable: false });
  return instant.toISOString();
}

function normalizedStatus(value) {
  const status = text(value, 80).normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLowerCase();
  return status;
}

function parseAgenda(rows = [], now = new Date()) {
  const ids = new Set();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const todayStart = new Date(`${today}T00:00:00-03:00`).getTime();
  const events = [];
  rows.filter((row) => Array.isArray(row) && row.some((cell) => text(cell))).forEach((row, index) => {
    const status = normalizedStatus(row[8]);
    if (!["ativo", "active", "disponivel"].includes(status)) return;
    const id = text(row[0], 240);
    if (!id || ids.has(id)) throw Object.assign(new Error(`ID inválido ou duplicado na agenda (linha ${index + 2}).`), { code: "GOOGLE_INVALID_EVENT_ID", retryable: false });
    ids.add(id);
    const date = text(row[1], 20);
    const startsAt = localDate(row[1], row[3]);
    if (new Date(startsAt).getTime() < todayStart) return;
    const attractions = text(row[4], 2_000);
    const weekday = text(row[2], 100);
    events.push({
      id,
      name: attractions || `${weekday || "Evento"} ${text(row[1], 20)}`.trim(),
      date,
      weekday,
      time: text(row[3], 20),
      attractions,
      price: price(row[5]),
      birthdayRule: text(row[6], 2_000),
      notes: text(row[7], 3_000),
      status: "publicado",
      startsAt,
    });
  });
  if (!events.length) throw Object.assign(new Error("A planilha não contém eventos ativos, futuros e válidos."), { code: "GOOGLE_NO_ACTIVE_EVENTS", retryable: false });
  return events.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function parseSettings(rows = []) {
  const settings = {};
  const allowed = new Set(["endereco", "endereco_completo", "link_cardapio", "cardapio", "url_cardapio", "regra_aniversariante", "aniversariante", "regra_aniversario"]);
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const key = text(row[0], 120).normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_|_$/gu, "");
    if (!key) continue;
    if (!allowed.has(key)) continue;
    settings[key] = text(row[1], 10_000);
  }
  return settings;
}

export function mapCapitaoMorSnapshot(raw, { now = new Date() } = {}) {
  return Object.freeze({
    events: parseAgenda(raw?.agenda || [], now),
    settings: parseSettings(raw?.settings || []),
  });
}

function setting(settings, ...keys) {
  for (const key of keys) if (settings[key]) return settings[key];
  return null;
}

function productSku(externalId) {
  return `GSHEET-${createHash("sha256").update(externalId).digest("hex").slice(0, 24)}`;
}

export class PostgresGoogleSheetsSnapshotMapper {
  constructor(pool, { clock = () => new Date() } = {}) { this.pool = pool; this.clock = clock; }

  async map(raw, _config, { empresaId }) {
    const snapshot = mapCapitaoMorSnapshot(raw, { now: this.clock() });
    await withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const company = (await client.query("SELECT timezone FROM empresas WHERE id = $1", [empresaId])).rows[0];
      if (!company) throw Object.assign(new Error("Empresa não encontrada."), { code: "TENANT_NOT_FOUND", retryable: false });
      const current = (await client.query("SELECT endereco FROM configuracoes_empresa WHERE empresa_id = $1", [empresaId])).rows[0] || {};
      const address = setting(snapshot.settings, "endereco", "endereco_completo") || current.endereco || "";
      await client.query(
        `UPDATE configuracoes_empresa
            SET endereco = COALESCE($2, endereco),
                link_cardapio = COALESCE($3, link_cardapio),
                regra_aniversariante = COALESCE($4, regra_aniversariante),
                updated_at = now()
          WHERE empresa_id = $1`,
        [empresaId,
          setting(snapshot.settings, "endereco", "endereco_completo"),
          setting(snapshot.settings, "link_cardapio", "cardapio", "url_cardapio"),
          setting(snapshot.settings, "regra_aniversariante", "aniversariante", "regra_aniversario")],
      );

      for (const event of snapshot.events) {
        const sku = productSku(event.id);
        const product = (await client.query(
          `INSERT INTO produtos_servicos (empresa_id, tipo, sku, nome, descricao, preco, moeda, controle_estoque, ativo)
           VALUES ($1,'convite',$2,$3,$4,$5,'BRL','sob_consulta',$6)
           ON CONFLICT (empresa_id, sku) WHERE sku IS NOT NULL AND deleted_at IS NULL
           DO UPDATE SET nome = EXCLUDED.nome, descricao = EXCLUDED.descricao, preco = EXCLUDED.preco,
                         ativo = EXCLUDED.ativo, updated_at = now()
           RETURNING id`,
          [empresaId, sku, `Convite ${event.name}`.slice(0, 200), event.notes, event.price, event.status === "publicado"],
        )).rows[0];
        const eventRow = (await client.query(
          `INSERT INTO eventos (empresa_id, origem_externa, external_id, nome, atracoes, inicio_at, timezone,
                               local, regra_vip, observacoes, status)
           VALUES ($1,'google_sheets',$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (empresa_id, origem_externa, external_id)
             WHERE origem_externa IS NOT NULL AND external_id IS NOT NULL AND deleted_at IS NULL
           DO UPDATE SET nome = EXCLUDED.nome, atracoes = EXCLUDED.atracoes, inicio_at = EXCLUDED.inicio_at,
                         timezone = EXCLUDED.timezone, local = EXCLUDED.local, regra_vip = EXCLUDED.regra_vip,
                         observacoes = EXCLUDED.observacoes, status = EXCLUDED.status, updated_at = now()
           RETURNING id`,
          [empresaId, event.id, event.name, event.attractions, event.startsAt, company.timezone || "America/Sao_Paulo",
            address, event.birthdayRule, event.notes, event.status],
        )).rows[0];
        await client.query(
          `INSERT INTO eventos_produtos (empresa_id, evento_id, produto_servico_id)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [empresaId, eventRow.id, product.id],
        );
      }

      const activeIds = snapshot.events.map((event) => event.id);
      const activeSkus = snapshot.events.map((event) => productSku(event.id));
      await client.query(
        `UPDATE eventos SET status = 'cancelado', updated_at = now()
          WHERE empresa_id = $1 AND origem_externa = 'google_sheets' AND deleted_at IS NULL
            AND NOT (external_id = ANY($2::text[]))`,
        [empresaId, activeIds],
      );
      await client.query(
        `UPDATE produtos_servicos SET ativo = false, updated_at = now()
          WHERE empresa_id = $1 AND tipo = 'convite' AND sku LIKE 'GSHEET-%' AND deleted_at IS NULL
            AND NOT (sku = ANY($2::text[]))`,
        [empresaId, activeSkus],
      );
    });
    return snapshot;
  }
}

export class PostgresGoogleSheetsConfigurationResolver {
  constructor(pool) { this.pool = pool; }

  resolveGoogleSheets({ empresaId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const row = (await client.query(
        `SELECT id, habilitada, configuracao, cache_version
           FROM integracoes
          WHERE empresa_id = $1 AND tipo = 'google_sheets' AND deleted_at IS NULL
          ORDER BY created_at, id LIMIT 1`,
        [empresaId],
      )).rows[0];
      if (!row) return null;
      const config = row.configuracao || {};
      return {
        enabled: row.habilitada,
        integrationId: row.id,
        spreadsheetId: config.spreadsheetId,
        imports: config.imports || DEFAULT_IMPORTS,
        exports: config.exports || { orders: DEFAULT_ORDER_RANGE },
        healthRange: config.healthRange,
        version: Number(config.version || row.cache_version + 1 || 1),
      };
    });
  }

  listEnabledTenants() {
    return withPlatformTransaction(this.pool, {}, async ({ client }) => (
      await client.query(
        `SELECT DISTINCT i.empresa_id
           FROM integracoes i JOIN empresas e ON e.id = i.empresa_id
          WHERE i.tipo = 'google_sheets' AND i.habilitada AND i.deleted_at IS NULL
            AND e.status = 'ativa' AND e.deleted_at IS NULL
          ORDER BY i.empresa_id`,
      )
    ).rows.map((row) => ({ empresaId: row.empresa_id })));
  }
}

export class GoogleSheetsCredentialResolver {
  constructor(pool, credentialVault) {
    this.pool = pool;
    this.credentialVault = credentialVault;
  }

  resolveGoogleSheets({ empresaId, integrationId }) {
    if (!this.credentialVault) return null;
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const row = (await client.query(
        `SELECT id FROM credenciais_empresa
          WHERE empresa_id = $1 AND provedor = 'google' AND status = 'ativa'
            AND finalidade IN ($2, 'google_sheets')
          ORDER BY CASE WHEN finalidade = $2 THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 1`,
        [empresaId, `google_sheets:${integrationId}`],
      )).rows[0];
      if (!row) return null;
      const raw = await this.credentialVault.getCredentialForUse({ empresaId, credentialId: row.id });
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw Object.assign(new Error("JSON da conta de serviço Google inválido."), { code: "GOOGLE_CREDENTIAL_INVALID", retryable: false }); }
      if (parsed?.type !== "service_account" || !parsed.client_email || !parsed.private_key) {
        throw Object.assign(new Error("Credencial Google incompleta."), { code: "GOOGLE_CREDENTIAL_INVALID", retryable: false });
      }
      return { clientEmail: parsed.client_email, privateKey: parsed.private_key };
    });
  }
}

export class PostgresGoogleSheetsCacheRepository {
  constructor(pool) { this.pool = pool; }

  load({ empresaId, integrationId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const row = (await client.query(
        "SELECT cache_snapshot, cache_version, last_success_at FROM integracoes WHERE empresa_id = $1 AND id = $2",
        [empresaId, integrationId],
      )).rows[0];
      return row?.cache_snapshot && { snapshot: row.cache_snapshot, configVersion: Number(row.cache_version), syncedAt: row.last_success_at };
    });
  }

  save({ empresaId, integrationId }, value) {
    return withTenantTransaction(this.pool, { empresaId }, ({ client }) => client.query(
      `UPDATE integracoes SET cache_snapshot = $3::jsonb, cache_version = $4, status = 'saudavel',
                              last_attempt_at = now(), last_success_at = $5, last_error_sanitized = NULL, updated_at = now()
        WHERE empresa_id = $1 AND id = $2`,
      [empresaId, integrationId, JSON.stringify(value.snapshot), value.configVersion, value.syncedAt],
    ));
  }

  markFailure({ empresaId, integrationId }, errorCode) {
    return withTenantTransaction(this.pool, { empresaId }, ({ client }) => client.query(
      `UPDATE integracoes SET status = 'indisponivel', last_attempt_at = now(),
                              last_error_sanitized = $3, updated_at = now()
        WHERE empresa_id = $1 AND id = $2`,
      [empresaId, integrationId, text(errorCode, 240) || "GOOGLE_SYNC_FAILED"],
    ));
  }
}

export class PostgresIntegrationOperationRepository {
  constructor(pool) { this.pool = pool; }

  runOnce(scope, callback) {
    return withTenantTransaction(this.pool, { empresaId: scope.empresaId }, async ({ client }) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${scope.empresaId}:${scope.integrationId}:${scope.operation}:${scope.idempotencyKey}`,
      ]);
      const existing = (await client.query(
        `SELECT resultado FROM integracao_operacoes
          WHERE empresa_id = $1 AND integracao_id = $2 AND operacao = $3 AND idempotency_key = $4`,
        [scope.empresaId, scope.integrationId, scope.operation, scope.idempotencyKey],
      )).rows[0];
      if (existing) return { ...existing.resultado, duplicate: true };
      const result = await callback();
      await client.query(
        `INSERT INTO integracao_operacoes (empresa_id, integracao_id, operacao, idempotency_key, resultado)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [scope.empresaId, scope.integrationId, scope.operation, scope.idempotencyKey, JSON.stringify({ exported: true })],
      );
      return result;
    });
  }
}

export function legacyCapitaoMorOrderRow(order) {
  return [
    order.createdAt || new Date().toISOString(),
    order.customerPhone || "",
    order.eventName || order.eventId || "",
    order.customerName || "",
    order.receiptId || "",
    order.status || "Aguardando conferência",
    "",
  ];
}
