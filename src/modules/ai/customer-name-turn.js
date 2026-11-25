import { asksOnlyForCustomerName } from '../group-notifier/qualification.js';

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
      if (name && !/^(?:Sou|Moro|Estou|Quero|Tenho|Pode|Certo|Sim|Nao|Não|Entendi|Obrigado|Obrigada|Cliente|Teste)\b/iu.test(name)) names.push(name);
    }
  }
  return [...new Set(names)].slice(0, 5);
}
