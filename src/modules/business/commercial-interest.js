const normalize = (value) => String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();
const body = (part) => String(part?.content || "").split("\n[Em resposta à mensagem:")[0].trim();
const invalid = () => Object.assign(new Error("Interesse comercial sem confirmação original."), { code: "AI_INVALID_CUSTOMER_SERVICE" });
const refusesContact = (text) => /\b(?:nao (?:quero|desejo) (?:mais )?(?:comprar|negociar|contato|atendimento|falar|vendedor)|nao tenho interesse|sem interesse|desisti)\b/u.test(normalize(text));

export const COMMERCIAL_INTEREST_INSTRUCTIONS = `ENCERRAMENTO POR INTERESSE COMERCIAL:
- Simulação de financiamento e avaliação por fotos são caminhos OPCIONAIS para concluir a triagem comercial de veículos, não requisitos universais. Interesse real de compra/negociação confirmado também permite ficha e vendedor. Essa regra substitui a antiga exigência de simular ou receber fotos; não remove critérios de outros ramos nem autoriza coletar documentos sem aceite.
- Tente compreender objetivo, modelo/faixa, troca e condições, aproveitando tudo já informado. Se o cliente recusar, adiar ou não quiser prosseguir com simulação/fotos (inclusive "só estou fazendo cotações"), pare de repetir essas ofertas. Confirme uma vez se deseja negociar o veículo ou continuar com um vendedor, sem pressionar. Uma dúvida, busca de catálogo, cotação isolada, silêncio ou recusa ao contato não comprovam confirmação. Se disser que não quer atendimento, respeite; não prepare ficha por interesse.
- Preencha customerService.commercialInterest com status=confirmed somente com evidência ORIGINAL de intenção explícita de compra/negociação ou aceite da pergunta atual de confirmar interesse/continuidade com vendedor. interestEvidence copia uma mensagem original com o objetivo. Em aceite de oferta, offerEvidence copia a mensagem inteira da assistente, consentEvidence a mensagem inteira do cliente; em pedido direto, offerEvidence=null e consentEvidence copia o pedido direto inteiro. Não use o anúncio, a oferta da IA ou uma recusa como intenção do cliente. Preserve a confirmação original quando depois vier o nome.
- Com interesse confirmado, responda às dúvidas atuais e peça SOMENTE o nome se faltar, com awaiting_name e ficha factual de tudo coletado. Não exija fotos, CPF, nascimento ou simulação desse caminho. Se o nome já estiver no histórico, responda às dúvidas que puder e finalize qualified no mesmo turno, avisando continuidade por vendedor. Para dúvidas que só a equipe pode resolver, explique esse limite e encaminhe o pedido no resumo. Solicitação de novas fotos, nova busca ou comparação ainda por cumprir é atendida antes de concluir. Recusa somente aos métodos não é recusa ao atendimento humano.
- No resumo, mantenha número pelo sistema, carro(s) de interesse, objetivo, troca e características/histórico declarados (inclusive sinistro/leilão), orçamento, cidade e demais dados realmente recebidos. Registre quais métodos foram recusados/adiados; não diga que houve avaliação, fotos ou simulação se não houve. Ao pedir o nome, a regra de 15 minutos sem resposta continua valendo para essa ficha.`;

export function commercialInterestFormat() {
  return { type: "object", additionalProperties: false, properties: {
    status: { type: "string", enum: ["none", "confirmed"] },
    interestEvidence: { type: ["string", "null"] }, offerEvidence: { type: ["string", "null"] }, consentEvidence: { type: ["string", "null"] },
  }, required: ["status", "interestEvidence", "offerEvidence", "consentEvidence"] };
}

export function declinesOptionalTriage(message) {
  const text = normalize(message);
  return /\bso (?:estou )?(?:fazendo )?(?:uma )?(?:cotacoes|cotacao|cotando|pesquisando|olhando)\b/u.test(text)
    || /\b(?:nao quero|nao vou|nao consigo|nao tenho|prefiro nao|depois|mais tarde)\b[^.!?]{0,70}\b(?:simul\p{L}*|fotos?|avali\p{L}*|financiamento)\b/u.test(text)
    || /\b(?:simul\p{L}*|fotos?|avali\p{L}*)\b[^.!?]{0,50}\b(?:depois|mais tarde|agora nao)\b/u.test(text);
}

export function offersOptionalTriage(text) {
  return String(text || '').split(/[.!?\n]/u).some((sentence) => /\b(?:quer|gostaria|podemos|posso|pode|poderia|envie|envia|manda|mande)\b/iu.test(sentence)
    && /\b(?:simula\p{L}*|fotos?|avalia\p{L}*)\b/iu.test(sentence));
}

export function parseCommercialInterest(value, transcript) {
  if (value === undefined) return false; // Old checkpoints/test providers remain compatible.
  if (!value || Object.keys(value).length !== 4 || !["status", "interestEvidence", "offerEvidence", "consentEvidence"].every((key) => Object.hasOwn(value, key))) throw invalid();
  if (value.status === "none") {
    if ([value.interestEvidence, value.offerEvidence, value.consentEvidence].some((quote) => quote !== null)) throw invalid();
    return false;
  }
  const literal = (quote) => typeof quote === "string" && quote.trim().length > 0 && quote.length <= 2000;
  if (value.status !== "confirmed" || !literal(value.interestEvidence) || !literal(value.consentEvidence)) throw invalid();
  const interest = transcript.findIndex((part) => part.role === "user" && normalize(body(part)) === normalize(value.interestEvidence));
  const consent = transcript.findLastIndex((part) => part.role === "user" && normalize(body(part)) === normalize(value.consentEvidence));
  if (interest < 0 || consent < interest) throw invalid();
  if (transcript.slice(consent + 1).some((part) => part.role === "user" && refusesContact(body(part)))) throw invalid();
  const answer = normalize(body(transcript[consent]));
  if (/\b(?:nao (?:quero|desejo) (?:mais )?(?:comprar|negociar|contato|atendimento|falar|vendedor)|nao tenho interesse|sem interesse|desisti)\b/u.test(answer)
    || /^(?:nao|nao quero|nao sei|negativo|dispenso|so (?:estou )?(?:olhando|cotando|pesquisando))[.! ]*$/u.test(answer)) throw invalid();
  if (value.offerEvidence === null) {
    if (!/\b(?:quero (?:comprar|negociar|fechar|falar com (?:um |o )?vendedor)|(?:tenho|estou com) interesse (?:em|no|na)|gostaria de (?:comprar|negociar|falar com (?:um |o )?vendedor))\b/u.test(answer)) throw invalid();
  } else {
    const offer = body(transcript.slice(0, consent).findLast((part) => part.role === "assistant"));
    const question = normalize(offer).split(/[.!]/u).at(-1)?.trim() || "";
    if (!literal(value.offerEvidence) || normalize(offer) !== normalize(value.offerEvidence)
      || !/\b(?:interesse|comprar|negociar|vendedor)\b/u.test(question)
      || !/\b(?:quer|deseja|gostaria|confirma|podemos|posso|vamos)\b/u.test(normalize(offer))
      || !/\b(?:sim|quero|pode|gostaria|desejo|tenho interesse|vamos|isso)\b/u.test(answer)
      || /^(?:talvez|depois|mais tarde)\b/u.test(answer)
      || /\b(?:simular|simulacao|financiamento|fotos|avaliacao)\b/u.test(question) && !/\b(?:sem|mesmo sem)\b/u.test(question)) throw invalid();
  }
  return true;
}
