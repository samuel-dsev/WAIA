import { availableCatalogProducts } from './catalog-messages.js';
import { lastPendingQuestion } from '../ai/choice-clarification.js';

const normalize = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const words = value => normalize(value).match(/[\p{L}\p{N}]+/gu) || [];
const body = part => String(part?.content || '').split('\n[Em resposta à mensagem:')[0];
const brands = new Set(['chevrolet','hyundai','ford','fiat','volkswagen','citroen','nissan','jeep','toyota','honda','renault','mitsubishi']);
const modelWords = item => words(item.name).filter(word => word.length >= 2 && !/^\d+$/u.test(word) && !brands.has(word));

/** A delivered model question for a simulation can be answered by the model's
 * name, even when an image or a clarification intervened. No image is read. */
export function pendingWebsiteFinancingModel(catalog, message, history = []) {
  const question = lastPendingQuestion(history), pending = normalize(question);
  if (!question || !/\b(?:simulacao|simular|financiamento|financiar)\b/u.test(pending)
    || !/\b(?:modelo|veiculo|carro)\b/u.test(pending)
    || !/\b(?:qual|quais|tem|possui|mente|escolheu|escolher|interesse)\b/u.test(pending)
    || /\b(?:troca|avaliacao|oferecer|fotos|imagens|conhecer)\b/u.test(pending)) return null;
  const answer = normalize(message);
  if (/^(?:nao\b|desisti\b|talvez\b)|\b(?:nao sei|depois|mais tarde|nao quero|cancela|cancelar|desisti)\b/u.test(answer)
    || /\b(?:endereco|garantia|quilometragem|preco|quanto|onde|como|aceita|cambio|motor|envie|envia|mande|manda|mostre|mostra)\b/u.test(answer)
    || /\b(?:quero|gostaria|pode|poderia)\b[^.!?]{0,30}\b(?:ver|receber|enviar)\b[^.!?]{0,20}\bfotos?\b/u.test(answer)) return null;
  let requestEvidence = null, cancelled = false;
  for (const part of history) {
    if (part.role !== 'user') continue;
    const original = body(part), text = normalize(original);
    if (/\b(?:cancel[ae]|cancelar|desisti|nao quero|nao vou)\b[^.!?]{0,40}\b(?:simulacao|simular|financiamento|financiar)\b/u.test(text)) { cancelled = true; requestEvidence = null; }
    else if (/\b(?:quero|gostaria|preciso|vamos|pode|poderia)\b[^.!?]{0,45}\b(?:simular|simulacao)\b/u.test(text)
      && !/\b(?:saber|entender|funciona|possivel|condicoes)\b/u.test(text)) { requestEvidence = original; cancelled = false; }
  }
  if (cancelled) return null;
  const tokens = new Set(words(message));
  const vehicleText = answer.replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/gu, '')
    .replace(/\b(?:nascimento|nasci|nascido|nascida)\s*(?:em|e|:)?\s*(?:19|20)\d{2}\b/gu, '');
  const years = [...new Set(vehicleText.match(/\b(?:19|20)\d{2}\b/gu) || [])];
  if (years.length > 1) return null;
  let candidates = availableCatalogProducts(catalog).map(item => ({ item, score: modelWords(item).filter(word => tokens.has(word)).length }))
    .filter(({item,score}) => score > 0 && (!years.length || Number(item.year) === Number(years[0]) || !item.year && words(item.name).includes(years[0])));
  const score = Math.max(0, ...candidates.map(candidate => candidate.score));
  candidates = candidates.filter(candidate => candidate.score === score);
  if (candidates.length > 1) {
    const focus = catalog.quotedProductId || (catalog.interaction?.productIds?.length === 1 ? catalog.interaction.productIds[0] : null);
    const focused = candidates.filter(({item}) => item.id === focus);
    if (focused.length === 1) candidates = focused;
  }
  if (candidates.length !== 1) return null;
  return { question, requestEvidence, productIds: [candidates[0].item.id], modelName: candidates[0].item.name };
}
