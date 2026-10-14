import { availableCatalogProducts } from "./catalog-messages.js";

const normalize = (value) => String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Only an entire, unambiguous choice. Questions, negations and extra clauses stay with AI. */
export function directCatalogInterest(message, catalog) {
  const handoff = catalog?.interestHandoff;
  if (catalog?.source?.type !== "google_sheets" || catalog.source.status !== "healthy"
    || handoff?.enabled !== true || typeof handoff.message !== "string" || !handoff.message.trim() || handoff.message.length > 1000
    || typeof message !== "string" || message.length > 4096 || message.includes("?")) return null;
  const text = normalize(message), products = availableCatalogProducts(catalog);
  const match = text.match(/^(?:gostei(?: d[aeo])?|me interessei (?:por|pela|pelo)|prefiro|quero(?: comprar)?|vou ficar com)(?: a| o)? (.+)$/u);
  if (!match) return null;
  const selected = /^(?:essa|esse|dessa|desse|essa moto|dessa moto|esse modelo|desse modelo)$/u.test(match[1])
    ? products.filter((item) => item.id === catalog.quotedProductId)
    : products.filter((item) => normalize(item.name) === match[1]);
  if (selected.length !== 1) return null;
  const item = selected[0];
  return { text: handoff.message.trim(), salesInterest: { products: [{ id: item.id, name: item.name }] } };
}
