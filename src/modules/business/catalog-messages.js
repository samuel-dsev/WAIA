import { publicProductImageUrl } from "../../integrations/google-sheets/products-snapshot.js";

const MONEY = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const compact = (value, limit) => {
  const chars = [...String(value || "").trim()];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("").trimEnd()}…` : chars.join("");
};

export function availableCatalogProducts(catalog) {
  if (catalog?.source?.status === "unavailable") return [];
  return (catalog?.items || []).filter((item) => item.active !== false && item.availability !== "unavailable");
}

/** Product facts and photo come from validated tenant data, never from model output. */
export function productMessage(item) {
  const lines = [
    `*${item.name}*`,
    item.price == null ? "Preço: consulte a equipe." : `Preço: ${MONEY.format(item.price)}`,
    item.brand ? `Marca: ${item.brand}` : null,
    item.category ? `Categoria: ${item.category}` : null,
    item.powerWatts == null ? null : `Potência: ${item.powerWatts} W`,
    item.autonomyKm == null ? null : `Autonomia informada: ${item.autonomyKm} km`,
    item.units?.length ? `Unidades: ${compact(item.units.join("; "), 200)}` : null,
    item.availability === "on_request" ? "Disponibilidade: sob consulta." : "Estoque e condições sujeitos à confirmação da equipe.",
    item.description || null,
  ];
  const text = compact(lines.filter(Boolean).join("\n"), 1024);
  return { text, buttons: [], ...(item.imageUrl ? { imageUrl: publicProductImageUrl(item.imageUrl) } : {}) };
}

export function catalogSelectionFormat(catalog) {
  if (catalog?.source?.type !== "google_sheets" || catalog.source.status !== "healthy") return null;
  const products = availableCatalogProducts(catalog);
  if (!products.length) return null;
  return {
    type: "json_schema", name: "catalog_reply", strict: true,
    schema: {
      type: "object", additionalProperties: false,
      properties: {
        text: { type: "string" },
        productIds: { type: "array", maxItems: 3, items: { type: "string", enum: products.map((item) => item.id) } },
      },
      required: ["text", "productIds"],
    },
  };
}

export const CATALOG_SELECTION_INSTRUCTIONS = "FORMATO DA RESPOSTA: preencha productIds com até três IDs exatos do catálogo validado quando for apresentar modelos ou fotos ao cliente. Use o interesse, a cidade/unidade e o histórico para selecionar produtos pertinentes; não envie modelos em toda resposta nem repita fichas já enviadas sem necessidade. O sistema enviará cada produto em uma mensagem própria com sua imagem e legenda de dados confirmados. Não escreva URLs, fichas, preços ou especificações dos produtos selecionados em text, pois suas legendas serão montadas pelo sistema. text contém apenas a resposta conversacional ou uma pergunta útil após as fichas; pode ficar vazio quando as fichas bastarem. Se nenhum produto precisar ser apresentado, use productIds vazio e responda normalmente em text. Nunca diga que a foto já foi entregue.";

export function parseCatalogSelection(output, catalog) {
  let value;
  try { value = JSON.parse(output); } catch { value = null; }
  const products = availableCatalogProducts(catalog);
  const byId = new Map(products.map((item) => [item.id, item]));
  if (!value || typeof value.text !== "string" || value.text.length > 4096
    || !Array.isArray(value.productIds) || value.productIds.length > 3
    || new Set(value.productIds).size !== value.productIds.length
    || value.productIds.some((id) => !byId.has(id))
    || Object.keys(value).some((key) => !["text", "productIds"].includes(key))) {
    throw Object.assign(new Error("Seleção de catálogo inválida."), { code: "AI_INVALID_CATALOG_SELECTION" });
  }
  const messages = value.productIds.map((id) => productMessage(byId.get(id)));
  const text = value.text.trim();
  if (text) messages.push({ text, buttons: [] });
  if (!messages.length) throw Object.assign(new Error("Resposta de catálogo vazia."), { code: "AI_EMPTY_RESPONSE" });
  return { text: messages.map((item) => item.text).join("\n\n"), ...(value.productIds.length ? { messages } : {}) };
}
