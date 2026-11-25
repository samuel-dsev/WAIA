import { asksOnlyForCustomerName } from '../group-notifier/qualification.js';
import { lastPendingQuestion } from './choice-clarification.js';

/** A conservative hint for rechecking interpretation, never a completed card.
 * Keep each original message separate so a city/question cannot become a name. */
export function customerNameTurn(question, current) {
  if (!question || !asksOnlyForCustomerName(question)) return [];
  const names = [];
  for (const part of current) {
    const text = String(part.content || "").split("\n[Em resposta à mensagem:")[0];
    for (const line of text.split(/\n/u)) {
      const explicit = /\b(?:meu nome [ée]|me chamo)\s+([\p{L}]+(?:[ -][\p{L}]+){0,4})/iu.exec(line)?.[1];
      const name = explicit || (/^\s*\p{Lu}\p{Ll}+(?:[ -](?:(?:da|de|do|dos|das) |\p{Lu})\p{Ll}*){0,4}\s*[.!]?\s*$/u.test(line) ? line.trim().replace(/[.!]$/u, "") : "");
      if (name && !/^(?:Sou|Moro|Estou|Quero|Tenho|Pode|Certo|Sim|Nao|Não|Entendi|Obrigado|Obrigada|Bom|Boa|Preciso|Cliente|Teste)\b/iu.test(name)) names.push(name);
    }
  }
  return [...new Set(names)].slice(0, 5);
}

/** Reuse a literal answer to an actually delivered name question, including
 * answers preceding a processing failure. This never supplies a lead by itself. */
export function customerNameHistory(transcript) {
  const names = [];
  let question;
  for (let index = 0; index < transcript.length; index++) {
    const part = transcript[index];
    if (part.role === 'assistant') question = lastPendingQuestion(transcript.slice(0, index + 1));
    else if (part.role === 'user') names.push(...customerNameTurn(question, [part]));
  }
  return [...new Set(names)];
}
