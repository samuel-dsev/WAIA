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

export const CATALOG_SELECTION_INSTRUCTIONS = "FORMATO DA RESPOSTA: preencha productIds com até três IDs exatos do catálogo validado quando for apresentar modelos ou fotos ao cliente. Quando o cliente pedir três modelos ou todos os modelos, selecione todos os IDs pertinentes, até três; não selecione apenas o primeiro nem prometa uma quantidade maior do que a seleção. Use o interesse, a cidade/unidade e o histórico para selecionar produtos pertinentes; não envie modelos em toda resposta nem repita fichas já enviadas sem necessidade. O sistema enviará cada produto em uma mensagem própria com sua imagem e legenda de dados confirmados. Não escreva URLs, fichas, preços ou especificações dos produtos selecionados em text, pois suas legendas serão montadas pelo sistema. text contém apenas a resposta conversacional ou uma pergunta útil após as fichas; pode ficar vazio quando as fichas bastarem. Se nenhum produto precisar ser apresentado, use productIds vazio e responda normalmente em text. Nunca diga que a foto já foi entregue.";

const normalizeRequest = (value) => String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

// Only complete an explicit, unfiltered list request. Named models, exclusions,
// specifications and follow-up questions remain selections made by the model.
function completeListSelection(ids, products, message) {
  if (!ids.length) return ids; // Preserve the script's city/name question before offering products.
  const normalized = normalizeRequest(message);
  if (/\b(?:nao|apenas|somente|exceto|menos)\b/u.test(normalized)) return ids;
  const sentences = normalized.split(/[.!?;\n]+/u).map((part) => part.trim()).filter(Boolean);
  if (sentences.length > 2) return ids;
  const prefix = sentences.length === 2 ? sentences[0] : "";
  if (prefix && !/^(?:sou|falo|estou falando) de [a-z ]+$/u.test(prefix)) return ids;
  const match = sentences.at(-1)?.match(/^(?:(?:pode|poderia) (?:me )?)?(?:mostrar|mostre|enviar|envie|mandar|mande|apresentar|apresente|quero ver|quero conhecer) (?:os |as )?(todos(?: os)?|todas(?: as)?|tres|3|dois|duas|2) (?:modelos|produtos|opcoes)(?: disponiveis| do catalogo)?(?: com (?:fotos?|imagens?)(?: e (?:precos?|valores?))?)?(?:,? por favor)?$/u);
  if (!match) return ids;
  const target = /^(?:dois|duas|2)$/u.test(match[1]) ? 2 : 3;
  let eligible = products;
  if (prefix) {
    const city = prefix.replace(/^(?:sou|falo|estou falando) de /u, "");
    eligible = products.filter((item) => !item.units?.length || item.units.some((unit) => normalizeRequest(unit) === city));
    if (!eligible.some((item) => ids.includes(item.id))) return ids;
  } else {
    const selectedUnits = new Set(products.filter((item) => ids.includes(item.id)).flatMap((item) => item.units || []).map(normalizeRequest));
    if (selectedUnits.size) eligible = products.filter((item) => !item.units?.length || item.units.some((unit) => selectedUnits.has(normalizeRequest(unit))));
  }
  // Never replace the model's chosen products or exceed the three-card limit.
  const result = [...ids];
  for (const item of eligible) {
    if (result.length >= target) break;
    if (!result.includes(item.id)) result.push(item.id);
  }
  return result;
}

export function parseCatalogSelection(output, catalog, { message } = {}) {
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
  const selectedIds = completeListSelection(value.productIds, products, message);
  const messages = selectedIds.map((id) => productMessage(byId.get(id)));
  const text = value.text.trim();
  if (text) messages.push({ text, buttons: [] });
  if (!messages.length) throw Object.assign(new Error("Resposta de catálogo vazia."), { code: "AI_EMPTY_RESPONSE" });
  return { text: messages.map((item) => item.text).join("\n\n"), ...(selectedIds.length ? { messages } : {}) };
}
