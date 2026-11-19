import { availableCatalogProducts } from "./catalog-messages.js";
import { vehicleFactsText } from "../../core/vehicle-facts.js";

const MONEY = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const STEPS = ["list", "gallery", "discussion", "photo_offer", "finance_offer", "finance_accepted", "closed", "declined"];
const listQuestion = "Gostou de algum? Se sim, gostaria de ver as fotos dele? Me diga qual modelo chamou sua atenção.";
export const WEBSITE_CATALOG_LIST_FORMAT_VERSION = 2;
export const CONTEXTUAL_CATALOG_LIST_FORMAT_VERSION = 3;
export const websiteCatalogSelectionPrompt = "Qual modelo chamou sua atenção?";
export const websiteGalleryClosing = "Qual modelo você mais gostou?\n\nSe quiser fazer a simulação do financiamento de algum deles, é só me falar!";
const galleryQuestion = "Você gostou desse veículo?";
const normalize = (text) => String(text || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim().replace(/\s+/gu, " ");

export function normalizeWebsiteInteraction(value) {
  if (!value || !STEPS.includes(value.step) || !Array.isArray(value.productIds)
    || value.productIds.length < 1 || value.productIds.length > 100
    || (["photo_offer", "finance_offer"].includes(value.step) && value.productIds.length !== 1)
    || (value.step !== "list" && value.productIds.length > 3)
    || new Set(value.productIds).size !== value.productIds.length
    || value.productIds.some((id) => typeof id !== "string" || !/^turim:[1-9]\d*$/u.test(id))) return null;
  return { step: value.step, productIds: [...value.productIds] };
}

/** Rebuild from confirmed sends, so restarts and unrelated photo/detail replies
 * cannot lose accepted vehicles. Cancelling one keeps the others pending. */
export function pendingWebsiteFinancingSession(states) {
  let productIds = [];
  for (const value of states) {
    const state = normalizeWebsiteInteraction(value);
    if (state?.step === "finance_accepted") productIds = state.productIds;
    else if (["closed", "declined"].includes(state?.step)) productIds = productIds.filter((id) => !state.productIds.includes(id));
  }
  return productIds.length ? { productIds, ...(productIds.length === 1 ? { productId: productIds[0] } : {}), status: "pending" } : null;
}

export function websiteReferenceClarification(catalog, message, selectedIds = []) {
  const answer = normalize(message);
  if (!/\b(?:ele|ela|dele|dela|nele|nela|desse|dessa|esse|essa|este|esta|daquele|daquela)\b/u.test(answer)
    || /\b(?:eles|elas|deles|delas|esses|essas|ambos|ambas|os dois|as duas|primeiro|primeira|segundo|segunda|terceiro|terceira|outro|outra|ultimo|ultima)\b/u.test(answer)
    || catalog.quotedProductId) return null;
  const focus = normalizeWebsiteInteraction(catalog.interaction);
  const ids = focus && catalog.interaction.direct && focus.productIds.length > 1 && focus.productIds.length <= 3
    ? focus.productIds : Array.isArray(selectedIds) ? selectedIds : [];
  const candidates = availableCatalogProducts(catalog).filter((item) => ids.includes(item.id));
  if (candidates.length < 2) return null;
  const words = new Set(answer.replace(/[^\p{L}\p{N}]+/gu, " ").split(" "));
  const named = candidates.filter((item) => normalize(item.name).split(/[^\p{L}\p{N}]+/u)
    .some((word) => word.length >= 3 && words.has(word)));
  // An explicit distinguishing name or a quoted card resolves the singular.
  // With multiple equal referents, never turn "dele" into consent for both or
  // silently select one. The model still resolves all unambiguous references.
  if (named.length === 1) return null;
  return { text: "Você se refere a " + candidates.map((item) => item.name).join(" ou ") + "?",
    websiteInteraction: { step: "discussion", productIds: candidates.map((item) => item.id) } };
}

function choiceQuestion(step, item, text) {
  return { text, websiteInteraction: { step, productIds: [item.id] } };
}

export function normalizeWebsiteListFormatVersion(value) {
  return value === undefined ? 1 : [1, 2, 3].includes(value) ? value : null;
}

export function validCatalogContinuation(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1000
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function listEntry(item, formatVersion = WEBSITE_CATALOG_LIST_FORMAT_VERSION) {
  const price = item.price == null ? "Sob consulta" : MONEY.format(item.price);
  return [`*${item.name}*`, formatVersion === 1 ? `Modelo: ${item.model || item.name}` : vehicleFactsText(item), `Valor: ${price}`].join("\n");
}

export function websiteCatalogListText(items, { formatVersion = WEBSITE_CATALOG_LIST_FORMAT_VERSION, continuation } = {}) {
  if (normalizeWebsiteListFormatVersion(formatVersion) === null) throw new TypeError("Formato de lista inválido.");
  if (formatVersion === 3 && !validCatalogContinuation(continuation)) throw new TypeError("Continuidade contextual inválida.");
  return [...items.map((item) => listEntry(item, formatVersion)), formatVersion === 3 ? continuation : listQuestion].join("\n\n");
}

export function websiteCatalogList(candidates, continuation = listQuestion) {
  const items = [];
  let size = continuation.length;
  for (const item of candidates) {
    size += listEntry(item).length + 2;
    if (size > 4096) break;
    items.push(item);
  }
  return items;
}

function photoUrls(item) {
  return item.imageUrls?.length ? item.imageUrls : item.imageUrl ? [item.imageUrl] : [];
}

export function websiteGalleryPart(item, index) {
  const urls = photoUrls(item);
  if (!urls[index]) return null;
  const text = index === 0 ? [...(item.introduction || `🚗 *${item.name}*`)].slice(0, 1024).join("") : "";
  return { text, buttons: [], imageUrl: urls[index], catalogProductId: item.id, catalogPhotoIndex: index };
}

export function matchesWebsiteGalleryPart(item, index, { text, imageUrl, catalogContinuation }) {
  const current = websiteGalleryPart(item, index);
  if (!current || current.imageUrl !== imageUrl) return false;
  if (catalogContinuation !== undefined) return index === photoUrls(item).length - 1 && validCatalogContinuation(catalogContinuation)
    && galleryClosingCaption(current, catalogContinuation) === text;
  if (current.text === text) return true;
  // Retomadas de galerias preparadas antes da pergunta em separado.
  const last = index === photoUrls(item).length - 1;
  if (last && [websiteGalleryClosing, financingOffer(item).text].some((closing) => galleryClosingCaption(current, closing) === text)) return true;
  const question = last ? `\n\n${galleryQuestion}` : "";
  const caption = index === 0 ? current.text : item.name;
  return text === [...caption].slice(0, 1024 - question.length).join("") + question;
}

function galleryClosingCaption(part, closing) {
  const body = [...part.text].slice(0, 1024 - [...closing].length - 2).join("").trimEnd();
  return [body, closing].filter(Boolean).join("\n\n");
}

function closeGallery(messages, closing) {
  const last = messages.at(-1);
  if (last.imageUrl) Object.assign(last, { ...closing, text: galleryClosingCaption(last, closing.text) });
  else Object.assign(last, { text: last.text + "\n\n" + closing.text, websiteInteraction: closing.websiteInteraction });
  return { text: messages[0].text, messages };
}

export function websiteGalleryReply(item) {
  const messages = photoUrls(item).map((_, index) => websiteGalleryPart(item, index));
  if (!messages.length) return choiceQuestion("gallery", item, `${item.introduction || `🚗 *${item.name}*`}\n\nA ficha está sem fotos no momento. ${galleryQuestion}`);
  return closeGallery(messages, financingOffer(item));
}

export function websiteGalleriesReply(items, { continuation } = {}) {
  if (continuation !== undefined) {
    if (!validCatalogContinuation(continuation) || items.some((item) => !photoUrls(item).length)) {
      throw Object.assign(new Error("Galeria contextual inválida."), { code: "AI_INVALID_CATALOG_SELECTION" });
    }
    const messages = items.flatMap((item) => photoUrls(item).map((_, index) => websiteGalleryPart(item, index)));
    return closeGallery(messages, { text: continuation, catalogContinuation: continuation, buttons: [],
      websiteInteraction: { step: "gallery", productIds: items.map((item) => item.id) } });
  }
  if (items.length === 1) return websiteGalleryReply(items[0]);
  // Put unavailable-photo notices before the actual galleries. The final
  // invitation belongs to the last image payload, so it cannot overtake it.
  const messages = [
    ...items.filter((item) => !photoUrls(item).length).map((item) => ({ text: `${item.introduction || `🚗 *${item.name}*`}\n\nA ficha está sem fotos no momento.`, buttons: [] })),
    ...items.filter((item) => photoUrls(item).length).flatMap((item) => photoUrls(item).map((_, index) => websiteGalleryPart(item, index))),
  ];
  return closeGallery(messages, { text: websiteGalleryClosing, buttons: [],
    websiteInteraction: { step: "gallery", productIds: items.map((item) => item.id) } });
}

export function acceptsWebsiteAlternativesOffer(message, history) {
  const last = normalize(history.findLast((item) => item.role === "assistant")?.content);
  const question = last.match(/\b(?:gostaria|quer|deseja|prefere|posso|podemos)\b[^?]*\?\s*$/u)?.[0] || "";
  if (/\b(?:simulacao|simular|financiamento|financiar)\b/u.test(question)
    || !/\b(?:(?:outros|outras) (?:modelos|opcoes|veiculos)|(?:modelos|opcoes|veiculos) (?:semelhantes|similares|parecidos|proximos))\b/u.test(question)) return false;
  const parts = String(message || "").split("\n").map(normalize).filter(Boolean);
  const yes = (part) => /^(?:sim|pode(?: sim| ser| mandar| enviar| mostrar)?|quero(?: sim)?|claro|com certeza|por favor)[,.! ]*$/u.test(part);
  return parts.some(yes) && parts.every((part) => yes(part) || /^(?:entendi|certo|ta|tudo bem)[,.! ]*$/u.test(part));
}

export function websitePhotoHistoryLine(catalog) {
  const ids = [...new Set(catalog?.photoHistoryProductIds || [])].slice(-3);
  const names = ids.map((id) => catalog.items.find((item) => item.id === id)?.name).filter(Boolean);
  return names.length ? "Últimos modelos com fotos no atendimento: " + names.join("; ") : "";
}

function affirmative(message) {
  return /^(?:sim(?:[, ]+(?:por favor|quero|gostei|curti))?|quero|pode|pode (?:mandar|enviar|mostrar|simular)|claro|com certeza|isso mesmo|gostei|curti|tenho interesse)[.!? ]*$/u.test(normalize(message));
}

function negative(message) {
  return /^(?:nao\b|desisti\b|deixa pra la\b|agora nao\b)/u.test(normalize(message));
}

export function hasWebsiteFinancingConsent(catalog, message, productId, history) {
  const answer = normalize(message);
  // Negation of a down payment is not cancellation of an accepted simulation.
  if (/\b(?:nao (?:quero|vou|preciso)(?: mais)?(?: fazer| de)?(?: a| o)? (?:simulacao|simular|financiamento|financiar)|cancel[ae]|desisti)\b/u.test(answer)
    || /^(?:nao quero|nao vou|nao preciso)[.! ]*$/u.test(answer)) return false;
  if (catalog.financingSession?.productIds?.includes(productId) || catalog.financingSession?.productId === productId
    || catalog.interaction?.step === "finance_accepted" && catalog.interaction.productIds.includes(productId)) return true;
  if (/\b(?:quero|gostaria|vamos|preciso|aceito|pode(?: me)?|poderia)\b.{0,60}\b(?:simular|simulacao|financiar|financiamento)\b/u.test(answer)) return true;
  const last = history.findLast((item) => item.role === "assistant")?.content || "";
  const offer = catalog.interaction?.step === "finance_offer" && catalog.interaction.direct
    && catalog.interaction.productIds[0] === productId;
  // A short acceptance needs a current financing question, never an older offer.
  const currentQuestion = /\b(?:gostaria|quer|deseja|posso|podemos|vamos)\b[^?]*\b(?:simula[cç][aã]o|simular|financiamento|financiar)\b[^?]*\?\s*$/iu.test(last);
  // The model has classified finance and resolved the selected IDs using the
  // whole transcript. This guard checks the current offer, not a vocabulary of
  // allowed answers: "quero sim, dos dois" and a selection such as "deles" are
  // valid contextual answers too. An acknowledgement alone authorizes nothing.
  const acknowledgementOnly = String(message).split("\n").map(normalize)
    .every((part) => /^(?:entendi|certo|ta|tudo bem)?[.! ]*$/u.test(part));
  const uncertain = negative(message) || /\b(?:talvez|nao sei|ainda nao|depois|mais tarde)\b/u.test(answer);
  return (offer || currentQuestion) && !acknowledgementOnly && !uncertain;
}

export function hasWebsitePhotoConsent(message, history) {
  const answer = normalize(message);
  if (/\bnao\b[^.!?\n]{0,35}\b(?:envie|mande|quero|preciso|mostre)\b[^.!?\n]{0,25}\bfotos?\b/u.test(answer)
    || /^(?:nao|agora nao|dispenso)[.! ]*$/u.test(answer)) return false;
  const requested = answer.split(/\b(?:mas|porem)\b|[;.!?\n]/u).some((part) => /\b(?:fotos?|imagens?)\b/u.test(part)
    && /\b(?:tem|teria|manda(?:r|m|e)?|envia(?:r|m)?|envie|mostra(?:r|m)?|mostre|ver|quero|gostaria|pode|poderia)\b/u.test(part)
    && !/\b(?:nao|sem)\b.{0,35}\b(?:fotos?|imagens?)\b/u.test(part));
  if (requested) return true;
  const last = normalize(history.findLast((part) => part.role === "assistant")?.content);
  const question = last.match(/[^.!?]*\?\s*$/u)?.[0] || "";
  const accepts = /^(?:sim|pode(?: sim| ser| mandar| enviar| mostrar)?|quero(?: sim)?|gostaria(?: sim)?|claro|por favor|com certeza|mande|envie|os dois|as duas|ambos|ambas|esses(?: aqui)?|essas(?: aqui)?|deles|delas)(?:\b|$)/u;
  return /\b(?:fotos?|imagens?)\b/u.test(question)
    && /\b(?:quer|gostaria|posso|deseja|pode|prefere)\b/u.test(question)
    && !/\b(?:simulacao|financiamento)\b/u.test(question)
    && answer.split("\n").some((part) => accepts.test(part.trim()))
    && !/\b(?:depois|mais tarde|ainda nao|agora nao)\b/u.test(answer);
}

function financingOffer(item) {
  return choiceQuestion("finance_offer", item, `Você gostaria de fazer uma simulação de financiamento para o ${item.name}?`);
}

function selectedVehicle(catalog) {
  const state = catalog?.interaction;
  if (!state || state.productIds.length !== 1) return null;
  return availableCatalogProducts(catalog).find((item) => item.id === state.productIds[0]) || null;
}

export function continueWebsiteInteraction(catalog, message) {
  const state = catalog?.interaction;
  if (!state?.direct) return null;
  // A simple yes after the combined question needs the name of the vehicle.
  if (state.step === "list" && affirmative(message)) {
    return { text: websiteCatalogSelectionPrompt, websiteInteraction: normalizeWebsiteInteraction(state) };
  }
  const item = selectedVehicle(catalog);
  if (!item) return null;
  if (state.step === "photo_offer") {
    const requested = /^(?:(?:sim|pode)[, ]+)?(?:me )?(?:manda(?:r)?|envia(?:r)?|mostra(?:r)?|quero ver) (?:as? )?(?:fotos?|imagens?)(?: (?:dele|desse veiculo|desse modelo))?[.!? ]*$/u.test(normalize(message));
    if (affirmative(message) || requested) return websiteGalleryReply(item);
    if (/^(?:nao(?:,? (?:obrigado|obrigada|quero (?:ver )?(?:as )?fotos))?|sem fotos)[.!? ]*$/u.test(normalize(message))) return financingOffer(item);
  }
  if (state.step === "gallery" && affirmative(message)) return financingOffer(item);
  if (["finance_offer", "finance_accepted"].includes(state.step) && negative(message)) {
    return choiceQuestion("declined", item, "Tudo bem. Posso continuar tirando suas dúvidas sobre esse veículo.");
  }
  return null;
}

export function chooseWebsiteVehicle(catalog, item, message) {
  const state = catalog?.interaction;
  if (!state || !item || !state.productIds.includes(item.id)) return { text: "Qual veículo chamou sua atenção?" };
  if (state.step === "list") {
    if (affirmative(message)) return { text: websiteCatalogSelectionPrompt, websiteInteraction: normalizeWebsiteInteraction(state) };
    return choiceQuestion("photo_offer", item, `Você gostaria de ver as fotos do ${item.name}?`);
  }
  if (state.step === "gallery" && !negative(message)) return financingOffer(item);
  return { text: "Como posso ajudar com esse veículo?" };
}

export function websiteFinancingVehicle(catalog, message) {
  const state = catalog?.interaction;
  if (!state) return null;
  const answer = normalize(message);
  if (state.step === "finance_accepted") return negative(answer) ? null : selectedVehicle(catalog);
  if (!["finance_offer", "photo_offer", "gallery"].includes(state.step)) return null;
  const request = state.step === "photo_offer" ? answer.replace(/^nao,\s*/u, "") : answer;
  const explicit = /^(?:(?:sim|ok)[, ]+)?(?:quero|gostaria de|vamos|pode|pode me) (?:simular|fazer (?:a|uma) simulacao)(?: de financiamento| o financiamento)?(?: (?:dele|desse veiculo|desse modelo))?[.!? ]*$/u.test(request);
  const acceptsOffer = state.step === "finance_offer" && state.direct && affirmative(message);
  return explicit || acceptsOffer ? selectedVehicle(catalog) : null;
}
