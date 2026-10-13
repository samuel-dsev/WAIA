import { createHash } from "node:crypto";

export const PRODUCT_IMPORT_RANGE = "Produtos!A2:L1000";
export const PRODUCT_HEALTH_RANGE = "Produtos!A1:L1";
export const MAX_SHEET_PRODUCTS = 100;

const normalized = (value) => String(value ?? "").trim().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

function invalid(code, line) {
  // Report the row and field, never the contents of a spreadsheet cell.
  throw Object.assign(new Error(`Catálogo Google Sheets inválido na linha ${line}.`), { code, retryable: false });
}

function text(value, max, line, required = false) {
  const result = String(value ?? "").trim();
  if ((required && !result) || result.length > max) invalid("GOOGLE_INVALID_PRODUCT_TEXT", line);
  return result;
}

function number(value, line, currency = false) {
  let input = String(value ?? "").trim();
  if (!input) return undefined;
  if (currency) input = input.replace(/^R\$\s*/u, "");
  input = input.replace(/\s/gu, "");
  if (!/^(?:\d+(?:\.\d+)?|\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+,\d+)$/u.test(input)) invalid("GOOGLE_INVALID_PRODUCT_NUMBER", line);
  const result = Number(input.includes(",") ? input.replace(/\./gu, "").replace(",", ".") : input);
  if (!Number.isFinite(result) || result < 0 || result > 1_000_000_000) invalid("GOOGLE_INVALID_PRODUCT_NUMBER", line);
  return currency ? Math.round(result * 100) / 100 : result;
}

export function publicProductImageUrl(value, line = 0) {
  const input = text(value, 2_000, line);
  if (!input) return undefined;
  let url;
  try { url = new URL(input); } catch { invalid("GOOGLE_INVALID_PRODUCT_IMAGE", line); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname || url.hash
    || /^(?:localhost|.*\.localhost|.*\.local|127\..*|10\..*|192\.168\..*|172\.(?:1[6-9]|2\d|3[01])\..*|\[.*\])$/iu.test(url.hostname)) {
    invalid("GOOGLE_INVALID_PRODUCT_IMAGE", line);
  }
  return url.href;
}

/** Fixed A:L contract; inactive rows and blank rows never become AI context. */
export function mapProductsSnapshot(raw) {
  const rows = raw?.products;
  if (!Array.isArray(rows)) invalid("GOOGLE_INVALID_PRODUCTS_RANGE", 2);
  const ids = new Set();
  const items = [];
  for (const [index, row] of rows.entries()) {
    const line = index + 2;
    if (!Array.isArray(row)) invalid("GOOGLE_INVALID_PRODUCT_ROW", line);
    if (!row.some((cell) => String(cell ?? "").trim())) continue;
    const status = normalized(row[11]);
    // A partially entered row is a draft until explicitly marked Ativo.
    if (!status || status === "inativo") continue;
    if (status !== "ativo") invalid("GOOGLE_INVALID_PRODUCT_STATUS", line);
    const sku = text(row[0], 100, line, true);
    if (ids.has(sku.toLowerCase())) invalid("GOOGLE_DUPLICATE_PRODUCT_CODE", line);
    ids.add(sku.toLowerCase());
    const availability = { disponivel: "available", "sob consulta": "on_request", indisponivel: "unavailable" }[normalized(row[7])];
    if (!availability) invalid("GOOGLE_INVALID_PRODUCT_AVAILABILITY", line);
    const units = text(row[8], 500, line).split(";").map((unit) => unit.trim()).filter(Boolean);
    if (units.length > 20 || units.some((unit) => unit.length > 100)) invalid("GOOGLE_INVALID_PRODUCT_UNITS", line);
    items.push({
      id: `gs:${createHash("sha256").update(sku.toLowerCase()).digest("hex").slice(0, 32)}`,
      sku,
      name: text(row[1], 160, line, true),
      category: text(row[2], 100, line) || undefined,
      brand: text(row[3], 100, line) || undefined,
      powerWatts: number(row[4], line),
      autonomyKm: number(row[5], line),
      price: number(row[6], line, true),
      availability,
      units,
      imageUrl: publicProductImageUrl(row[9], line),
      description: text(row[10], 500, line) || undefined,
      // Unavailable items remain explicit in AI context, but are not offered by deterministic lists.
      active: availability !== "unavailable",
    });
    if (items.length > MAX_SHEET_PRODUCTS) invalid("GOOGLE_PRODUCT_LIMIT_EXCEEDED", line);
  }
  return { profile: "products", schemaVersion: 1, products: items };
}

export function catalogFromProductsCache(row, { now = new Date() } = {}) {
  const lastSyncedAt = row.last_success_at ? new Date(row.last_success_at).toISOString() : undefined;
  const fresh = lastSyncedAt && now.getTime() - Date.parse(lastSyncedAt) <= 600_000;
  const valid = row.cache_snapshot?.profile === "products" && row.cache_snapshot?.schemaVersion === 1
    && Array.isArray(row.cache_snapshot.products) && row.cache_snapshot.products.length <= MAX_SHEET_PRODUCTS
    && Number(row.cache_version) === Number(row.configuracao?.version);
  const healthy = row.status === "saudavel" && fresh && valid;
  return {
    items: healthy ? row.cache_snapshot.products : [],
    source: { type: "google_sheets", status: healthy ? "healthy" : "unavailable", lastSyncedAt },
  };
}
