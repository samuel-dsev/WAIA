const normalize = (value) => String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();

export const CONTEXTUAL_CONTINGENCY = "Não entendi, pode ser mais claro na sua solicitação?";
export const CONTEXTUAL_PROCESSING_FAILURE = "Tive uma falha ao processar sua mensagem. As informações que você enviou continuam no atendimento; você não precisa repeti-las.";
const contingencyPhrases = /(?:Não entendi, pode ser mais claro na sua solicitação\?|Pode confirmar sua resposta para eu continuar\?|Pode confirmar qual opção você deseja\?\s*Se desejar mais de uma opção, me diga quais\.)/giu;
const deliveredBody = (part) => String(part?.content || "").split("\n[Em resposta à mensagem:")[0].trim();

export function isContextualContingency(text, config = {}) {
  return String(text || "").search(contingencyPhrases) >= 0 || isConfiguredContingency(text, config);
}

export function isContextualProcessingFailure(text) {
  return normalize(text) === normalize(CONTEXTUAL_PROCESSING_FAILURE);
}

export function contextualContingencyReply(history, config = {}) {
  const previous = history.findLast((part) => part.role === "assistant");
  // Delivered history is the checkpoint: no process-local flag or tenant state.
  return isContextualContingency(deliveredBody(previous), config)
    ? { text: "", code: "AI_CONTINGENCY_ALREADY_SENT" }
    : { text: CONTEXTUAL_CONTINGENCY };
}

/** Only delivered assistant text from the conversation loader is eligible.
 * Keep the offered choices verbatim rather than reconstructing a sales scenario. */
export function lastPendingQuestion(history, config = {}) {
  const index = history.findLastIndex((part) => part.role === "assistant");
  if (index < 0) return null;
  const original = deliveredBody(history[index]);
  let body = original.replace(contingencyPhrases, "").trim();
  if (!body || isContextualProcessingFailure(body) || isConfiguredContingency(body, config) || isContextualContingency(original, config) && /^(?:Gostaria\?|Pode ser\?)$/iu.test(body)) {
    return lastPendingQuestion(history.slice(0, index), config);
  }
  const end = body.lastIndexOf("?");
  const requestsData = /\b(?:informe|diga|passe|me (?:conte|fale)|precis[oa]mos? saber|preciso saber|(?:pode|poderia) me (?:dizer|informar|passar)|como (?:posso|podemos) (?:te |lhe )?chamar)\b/iu;
  // Follow-up offers often end with an explanatory sentence after the question.
  // That sentence does not cancel the offer or create a new choice.
  if (end >= 0 && (!requestsData.test(body.slice(end + 1)) || /^(?:por favor[, ]+)?(?:me (?:informe|diga)|aguardo)\b/iu.test(body.slice(end + 1).trim()))) body = body.slice(0, end + 1);
  if (!body.endsWith("?")) {
    // Requests remain pending even when conversational punctuation is a period.
    // Recover the original sentence; interpretation of its answer belongs to AI.
    if (body.length > 1000 || !requestsData.test(body)) return null;
    return body.replace(/[.!]+$/u, "") + "?";
  }
  const sentences = body.split(/(?<=[.!?])\s+|\n\s*\n/u);
  const statement = sentences.findLastIndex((sentence) => !sentence.trim().endsWith("?"));
  let question = sentences.slice(statement + 1).join(" ").trim();
  // A bare invitation needs its actual proposal, e.g. "Posso ajudar com a
  // simulação de financiamento para algum deles. Gostaria?".
  if (/^(?:Gostaria|Pode ser)\?$/iu.test(question) && statement >= 0) question = sentences.slice(statement).join(" ").trim();
  if (!question || question.length > 1000) return null;
  return question;
}

export function lastChoiceQuestion(history) {
  const question = lastPendingQuestion(history), text = normalize(question);
  return /\bou\b/u.test(text) || /\b(?:qual|quais|prefere|escolh\w*)\b[^?]*:[^?]*[,;]/u.test(text) ? question : null;
}

export function ambiguousChoiceReply(message, history) {
  const parts = String(message || "").split(/\n+/u).map(normalize).filter(Boolean);
  const neutral = /^(?:(?:sim|ok|okay|certo|entendi|isso(?: mesmo)?|aham|uhum|claro|pode(?: sim| ser)?|quero(?: sim)?|gostaria(?: sim)?|tudo bem|com certeza|por favor|nao sei|nao entendi|qualquer um|tanto faz|👍|👌)(?:[,!?. ]+|$))+$/u;
  return parts.length && parts.every((part) => neutral.test(part)) ? lastChoiceQuestion(history) : null;
}

export function acceptsAllChoices(message, history) {
  return Boolean(lastChoiceQuestion(history)) && /^(?:(?:sim[, ]+)?(?:quero|gostaria|pode ser|prefiro|desejo)\s+)?(?:as duas|os dois|ambos|ambas|todas|todos)(?: as opcoes| os dois| as duas)?[.! ]*$/u.test(normalize(message));
}

export function choiceClarificationFormat() {
  return { type: "json_schema", name: "choice_clarification", strict: true,
    schema: { type: "object", additionalProperties: false,
      properties: { text: { type: "string", pattern: "\\?\\s*$", description: "Uma pergunta curta que repete a solicitação pendente. Reapresente todas as alternativas da última oferta, incluindo ambas quando compatíveis, e peça escolha explícita. Termine com a pergunta." } }, required: ["text"] } };
}

export function clarificationAwareFormat(base) {
  const format = structuredClone(base || { type: "json_schema", name: "contextual_reply", strict: true,
    schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } }, required: ["text"] } });
  format.schema.properties = { turnIntent: { type: "string", enum: ["answer", "clarify"],
    description: "Decida ANTES de responder. answer se houver dado solicitado identificável em qualquer parte da mensagem, mesmo com desculpas, apresentação, texto adicional ou outra ordem. Não considere sequência aleatória/de teclado ou resposta sem identidade como nome só por ser a pergunta pendente. answer também para escolha clara, recusa ou novo pedido compreensível. clarify se não houver dado útil nem novo pedido compreensível, ou faltar escolha entre alternativas. Nunca use contingência genérica." }, ...format.schema.properties };
  format.schema.required.unshift("turnIntent");
  return format;
}

export function parseChoiceClarification(text) {
  const value = JSON.parse(text);
  if (!value || Object.keys(value).length !== 1 || typeof value.text !== "string" || !value.text.trim()
    || value.text.length > 1000 || !value.text.includes("?")) {
    throw Object.assign(new Error("Esclarecimento de opções inválido."), { code: "AI_INVALID_CLARIFICATION" });
  }
  return { text: value.text.trim() };
}

export function isConfiguredContingency(text, config) {
  return Boolean(config.contingencyMessage) && normalize(text) === normalize(config.contingencyMessage);
}
