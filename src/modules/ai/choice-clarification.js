const normalize = (value) => String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();

/** Only delivered assistant text from the conversation loader is eligible.
 * Keep the offered choices verbatim rather than reconstructing a sales scenario. */
export function lastPendingQuestion(history) {
  let body = String(history.findLast((part) => part.role === "assistant")?.content || "")
    .split("\n[Em resposta à mensagem:")[0].trim();
  const end = body.lastIndexOf("?");
  if (end >= 0 && /^(?:por favor[, ]+)?(?:me (?:informe|diga)|aguardo)\b/iu.test(body.slice(end + 1).trim())) body = body.slice(0, end + 1);
  if (!body.endsWith("?")) return null;
  const sentences = body.split(/(?<=[.!?])\s+|\n\s*\n/u);
  const statement = sentences.findLastIndex((sentence) => !sentence.trim().endsWith("?"));
  const question = sentences.slice(statement + 1).join(" ").trim();
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
    description: "Decida ANTES de responder. clarify se a resposta for incompreensível, não escolher entre as opções ou precisar de confirmação da pergunta anterior. Nunca use contingência genérica nesse caso. answer para escolha clara, recusa, dados solicitados ou nova solicitação compreensível." }, ...format.schema.properties };
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

export function choiceClarificationFallback(question) {
  return (lastChoiceQuestion([{ role: "assistant", content: question }])
    ? "Pode confirmar qual opção você deseja? Se desejar mais de uma opção, me diga quais."
    : "Pode confirmar sua resposta para eu continuar?") + "\n\n" + question;
}

export function isConfiguredContingency(text, config) {
  return Boolean(config.contingencyMessage) && normalize(text) === normalize(config.contingencyMessage);
}
