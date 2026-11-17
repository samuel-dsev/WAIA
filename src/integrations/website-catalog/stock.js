import { z } from "zod";

export const WEBSITE_CATALOG_TYPE = "website_catalog";
export const WEBSITE_CATALOG_URL = "https://turimautos.com/estoque";
export const WEBSITE_CATALOG_MAX_AGE_MS = 10 * 60_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 100;
const SITE_ORIGIN = new URL(WEBSITE_CATALOG_URL).origin;
const mileage = new Intl.NumberFormat("pt-BR");

const stockVehicle = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  titulo: z.string().trim().min(1).max(160),
  ano: z.number().int().min(1886).max(2100),
  preco: z.number().min(0).max(1_000_000_000),
  km: z.number().int().nonnegative().max(9_999_999),
  cambio: z.string().trim().max(60),
  combustivel: z.string().trim().max(60),
  cor: z.string().trim().max(60),
  carroceria: z.string().trim().max(100).nullish(),
  imagens: z.array(z.string().max(2000)).max(100),
});

function stockError(code) {
  return Object.assign(new Error("Não foi possível atualizar o estoque público da Turim."), { code });
}

function stockPhoto(value) {
  if (!value) return undefined;
  let url;
  try { url = new URL(value, SITE_ORIGIN); } catch { throw stockError("WEBSITE_CATALOG_INVALID_IMAGE"); }
  if (url.origin !== SITE_ORIGIN || url.username || url.password || url.search || url.hash
    || !/^\/storage\/veiculos\/[\w-]+\.(?:jpe?g|png|webp)$/iu.test(url.pathname)) {
    throw stockError("WEBSITE_CATALOG_INVALID_IMAGE");
  }
  return url.href;
}

export function parseWebsiteStock(html) {
  const entries = [...html.matchAll(/^[\t ]*window\.VEICULOS[\t ]*=[\t ]*(\[[^\r\n]*\]);[\t ]*\r?$/gmu)];
  if (entries.length !== 1) throw stockError("WEBSITE_CATALOG_STOCK_NOT_FOUND");
  let raw;
  try { raw = JSON.parse(entries[0][1]); } catch { throw stockError("WEBSITE_CATALOG_INVALID_STOCK"); }
  const parsed = z.array(stockVehicle).max(MAX_ITEMS).safeParse(raw);
  if (!parsed.success || new Set(parsed.data.map((vehicle) => vehicle.id)).size !== parsed.data.length) {
    throw stockError("WEBSITE_CATALOG_INVALID_STOCK");
  }
  const products = parsed.data.map((vehicle) => ({
    id: `turim:${vehicle.id}`,
    name: vehicle.titulo,
    price: vehicle.preco > 0 ? Math.round(vehicle.preco * 100) / 100 : null,
    description: [
      `Ano ${vehicle.ano}`, `${mileage.format(vehicle.km)} km`, vehicle.cambio, vehicle.combustivel, vehicle.cor,
    ].filter(Boolean).join(" · "),
    ...(vehicle.carroceria ? { category: vehicle.carroceria } : {}),
    url: `${SITE_ORIGIN}/veiculo?id=${vehicle.id}`,
    imageUrl: stockPhoto(vehicle.imagens[0]),
    availability: vehicle.preco > 0 ? "available" : "on_request",
    active: true,
  }));
  return { profile: WEBSITE_CATALOG_TYPE, schemaVersion: 1, products };
}

export async function fetchWebsiteStock({ fetchImpl = fetch, signal } = {}) {
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetchImpl(WEBSITE_CATALOG_URL, {
    redirect: "error", headers: { Accept: "text/html", "Cache-Control": "no-cache" },
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("text/html") || !response.body) {
    await response.body?.cancel();
    throw stockError("WEBSITE_CATALOG_HTTP_ERROR");
  }
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body.cancel();
    throw stockError("WEBSITE_CATALOG_RESPONSE_TOO_LARGE");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) throw stockError("WEBSITE_CATALOG_RESPONSE_TOO_LARGE");
    chunks.push(chunk);
  }
  return parseWebsiteStock(Buffer.concat(chunks, size).toString("utf8"));
}

export function websiteCatalogFromCache(row, now = Date.now()) {
  const timestamp = row?.last_success_at == null ? NaN : new Date(row.last_success_at).getTime();
  const age = now - timestamp;
  const snapshot = row?.cache_snapshot;
  const healthy = row?.status === "saudavel" && age >= 0 && age <= WEBSITE_CATALOG_MAX_AGE_MS
    && snapshot?.profile === WEBSITE_CATALOG_TYPE && snapshot.schemaVersion === 1
    && Array.isArray(snapshot.products) && snapshot.products.length <= MAX_ITEMS;
  return {
    items: healthy ? snapshot.products : [],
    source: {
      type: WEBSITE_CATALOG_TYPE, status: healthy ? "healthy" : "unavailable",
      lastSyncedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined,
    },
  };
}
