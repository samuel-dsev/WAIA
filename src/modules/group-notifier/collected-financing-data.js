import { isContextualContingency, isContextualProcessingFailure } from '../ai/choice-clarification.js';

const normalized = (value) => String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();

function collectionBodies(evidence, transcript) {
  const allowed = new Set(evidence.map((value) => String(value || "").trim())), answers = new Set();
  let collecting = false;
  for (const part of transcript) {
    if (part.role === "assistant") {
      if (isContextualContingency(part.content) || isContextualProcessingFailure(part.content)) continue;
      const text = normalized(part.content);
      collecting = /\b(?:cpf|nascimento)\b/u.test(text) && /\b(?:informe|informar|envie|enviar|preciso|passe|qual|por favor)\b/u.test(text)
        && !/\b(?:nao|nunca) (?:informe|envie|enviar|informar)\b/u.test(text);
    } else if (collecting && part.role === "user") {
      const body = String(part.content || "").split("\n[Em resposta à mensagem:")[0].trim();
      if (allowed.has(body)) answers.add(body);
    }
  }
  return answers;
}

const cpfPattern = /(?<!\d)(?:\d{11}|\d{3}[.\s]\d{3}[.\s]\d{3}[-\s]\d{2})(?!\d)/gu;
const datePattern = /(?<!\d)(\d{1,2})([\/.-]|\s+)(\d{1,2})\2(\d{4}|\d{2})(?!\d)/gu;
const compactDatePattern = /(?<!\d)(\d{2})(\d{2})(\d{4}|\d{2})(?!\d)/gu;
const unique = (values) => { const candidates = [...new Set(values)]; return candidates.length === 1 ? candidates[0] : undefined; };
const dateValue = (day, month, year) => Number(day) >= 1 && Number(day) <= 31 && Number(month) >= 1 && Number(month) <= 12
  ? day.padStart(2, "0") + "/" + month.padStart(2, "0") + "/" + year : null;
const unrelatedNumbers = (body) => body
  .replace(/\b(?:telefone|celular|whats(?:app)?|contato)\s*(?:(?:é|e|eh)\s*)?[:=]?\s*[+()\d .-]{7,}/giu, " ")
  .replace(/\b(?:entrada|valor(?: de entrada)?|r\$)\s*[:=]?\s*(?:r\$\s*)?[\d.,]+(?:\s*(?:mil|reais|real))?/giu, " ")
  .replace(/(?<!\d)[\d.,]+\s*(?:mil\b|reais\b|real\b|de entrada\b)/giu, " ");

/** Shape and collection context identify fields, never the message position.
 * Two-digit years remain literal; ambiguous candidates are not guessed. */
export function collectedFinancingFields(evidence = [], transcript = [], name = "") {
  const collected = collectionBodies(evidence, transcript);
  let cpf, birthDate, city;
  for (const value of evidence) {
    const body = String(value || "").trim(), text = normalized(body);
    if (/^(?:exemplo\s*:|por exemplo\b|como exemplo\b)/u.test(text)
      || /\bnao (?:e|eh|use|considere|utilize|quero (?:informar|enviar|usar))\b/u.test(text)) continue;
    const numbers = unrelatedNumbers(body);
    const labeledCpf = body.match(/\bcpf\s*(?:(?:é|e|eh)\s*)?[:=-]?\s*(\d{11}|\d{3}[.\s]\d{3}[.\s]\d{3}[-\s]\d{2})(?!\d)/iu)?.[1];
    const suppliedCpfs = [...numbers.matchAll(cpfPattern)].filter((match) => collected.has(body) || /\d{3}\.\d{3}\.\d{3}-\d{2}/u.test(match[0]))
      .map((match) => match[0].replace(/\D/gu, ""));
    const suppliedCpf = labeledCpf?.replace(/\D/gu, "") || unique(suppliedCpfs);
    if (suppliedCpf) cpf = suppliedCpf;
    const birthLabel = /\b(?:nascimento|nasci|nascido|nascida)\b/iu.exec(numbers);
    if (collected.has(body) || birthLabel) {
      const dateText = birthLabel ? numbers.slice(birthLabel.index + birthLabel[0].length).replace(/^\s*[:=]?\s*/u, "").split(/[\n;]/u)[0] : numbers;
      const dates = [...dateText.matchAll(datePattern)].map((m) => dateValue(m[1], m[3], m[4]));
      dates.push(...[...dateText.matchAll(compactDatePattern)].map((m) => dateValue(m[1], m[2], m[3])));
      const suppliedDate = unique(dates.filter(Boolean));
      if (suppliedDate) birthDate = suppliedDate;
    }
    const locality = body.match(/\b(?:moro em|resido em|sou de|minha cidade (?:é|e))\s+([\p{L}][\p{L} '-]{1,90}?)(?=\s+(?:e (?:tenho|quero|sou)|mas|com|para)\b|[,.;!?/\n]|$)/iu)?.[1]
      || (text.includes(normalized(name)) && /\b(?:sou|me chamo|meu nome)\b/u.test(text)
        ? body.match(/,\s*de\s+([\p{L}][\p{L} '-]{1,90}?)(?=\s+(?:e (?:tenho|quero|sou)|mas|com|para)\b|[,.;!?/\n]|$)/iu)?.[1] : null);
    if (locality && !/^(?:verdade|novo|fato|passagem|acordo|boa)$/u.test(normalized(locality))) city = locality.trim();
  }
  return { cpf, birthDate, city };
}

/** Copy only literal customer-supplied values. This is not document validation
 * or a reason to qualify: the existing consent/name/card gates still apply. */
export function preserveCollectedFinancingData(card, evidence = [], transcript = []) {
  const { cpf, birthDate, city } = collectedFinancingFields(evidence, transcript, card.name);
  const summary = String(card.summary || ""), compactSummary = normalized(summary);
  const summaryCpfs = [...summary.matchAll(/(?<!\d)\d{3}[. ]?\d{3}[. ]?\d{3}[- ]?\d{2}(?!\d)/gu)].map((match) => match[0].replace(/\D/gu, ""));
  const lines = [];
  if (city && !compactSummary.includes(normalized(city))) lines.push("Cidade informada: " + city);
  if (cpf && !summaryCpfs.includes(cpf)) lines.push("CPF informado: " + cpf.slice(0, 3) + "." + cpf.slice(3, 6) + "." + cpf.slice(6, 9) + "-" + cpf.slice(9));
  if (birthDate && !summary.includes(birthDate)) lines.push("Data de nascimento informada: " + birthDate);
  return lines.length ? { ...card, summary: summary + "\nDados coletados:\n" + lines.join("\n") } : card;
}

/** Evidence for a model recheck only; it neither validates documents nor qualifies a lead. */
export function hasCollectedFinancingDocuments(evidence = [], transcript = []) {
  const { cpf, birthDate } = collectedFinancingFields(evidence, transcript);
  return Boolean(cpf && birthDate);
}
