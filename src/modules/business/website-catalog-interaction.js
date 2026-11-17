import { availableCatalogProducts, productMessage } from "./catalog-messages.js";

const MONEY = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const STEPS = ["list", "gallery", "photo_offer", "finance_offer", "finance_accepted", "closed", "declined"];
const listQuestion = "Gostou de algum? Se sim, gostaria de ver as fotos dele? Me diga qual modelo chamou sua atenção.";
const galleryQuestion = "Você gostou desse veículo?";
const normalize = (text) => String(text || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim().replace(/\s+/gu, " ");

export function normalizeWebsiteInteraction(value) {
  if (!value || !STEPS.includes(value.step) || !Array.isArray(value.productIds)
    || value.productIds.length < 1 || value.productIds.length > 100
    || (value.step !== "list" && value.productIds.length !== 1)
    || new Set(value.productIds).size !== value.productIds.length
    || value.productIds.some((id) => typeof id !== "string" || !/^turim:[1-9]\d*$/u.test(id))) return null;
  return { step: value.step, productIds: [...value.productIds] };
}

function choiceQuestion(step, item, text) {
  return { text, websiteInteraction: { step, productIds: [item.id] } };
}

function listEntry(item) {
  const price = item.price == null ? "Sob consulta" : MONEY.format(item.price);
  return [`*${item.name}*`, `Modelo: ${item.model || item.name}`, item.description, `Valor: ${price}`].filter(Boolean).join("\n");
}

export function websiteCatalogListText(items) {
  return [...items.map(listEntry), listQuestion].join("\n\n");
}

export function websiteCatalogList(candidates) {
  const items = [];
  let size = listQuestion.length;
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
  const last = index === urls.length - 1;
  const caption = index === 0 ? productMessage(item).text : item.name;
  const limit = 1024 - (last ? galleryQuestion.length + 2 : 0);
  const text = [...caption].slice(0, limit).join("") + (last ? `\n\n${galleryQuestion}` : "");
  return { text, buttons: [], imageUrl: urls[index], catalogProductId: item.id, catalogPhotoIndex: index,
    ...(last ? { websiteInteraction: { step: "gallery", productIds: [item.id] } } : {}) };
}

export function websiteGalleryReply(item) {
  const messages = photoUrls(item).map((_, index) => websiteGalleryPart(item, index));
  if (!messages.length) return choiceQuestion("gallery", item, `${productMessage(item).text}\n\nA ficha está sem fotos no momento. ${galleryQuestion}`);
  return { text: messages[0].text, messages };
}

function affirmative(message) {
  return /^(?:sim(?:[, ]+(?:por favor|quero|gostei|curti))?|quero|pode|pode (?:mandar|enviar|mostrar|simular)|claro|com certeza|isso mesmo|gostei|curti|tenho interesse)[.!? ]*$/u.test(normalize(message));
}

function negative(message) {
  return /^(?:nao\b|desisti\b|deixa pra la\b|agora nao\b)/u.test(normalize(message));
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
    return { text: "Qual modelo chamou sua atenção?", websiteInteraction: normalizeWebsiteInteraction(state) };
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
    if (affirmative(message)) return { text: "Qual modelo chamou sua atenção?", websiteInteraction: normalizeWebsiteInteraction(state) };
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
