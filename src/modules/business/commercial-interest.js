const normalize = (value) => String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();
const body = (part) => String(part?.content || "").split("\n[Em resposta à mensagem:")[0].trim();
const invalid = (reason) => Object.assign(new Error("Interesse comercial sem confirmação original."), { code: "AI_INVALID_CUSTOMER_SERVICE", validationReason: `COMMERCIAL_INTEREST_${reason}` });
const refusesContact = (text) => /\b(?:nao (?:quero|desejo) (?:mais )?(?:comprar|negociar|contato|atendimento|falar|vendedor)|nao tenho interesse|sem interesse|desisti)\b/u.test(normalize(text));
const methodSubject = /\b(?:fotos?|avalia\p{L}*|simula\p{L}*|financiamento|cotac\p{L}*)\b/u;

export const COMMERCIAL_INTEREST_INSTRUCTIONS = `ENCERRAMENTO POR INTERESSE COMERCIAL:
- Simulação de financiamento e avaliação por fotos são caminhos OPCIONAIS para concluir a triagem comercial de veículos, não requisitos universais. Interesse real de compra/negociação confirmado também permite ficha e vendedor. Essa regra substitui a antiga exigência de simular ou receber fotos; não remove critérios de outros ramos nem autoriza coletar documentos sem aceite.
- Tente compreender objetivo, modelo/faixa, troca e condições, aproveitando tudo já informado. Se o cliente recusar, adiar ou não quiser prosseguir com simulação/fotos (inclusive "só estou fazendo cotações"), pare de repetir essas ofertas. Confirme uma vez se deseja negociar o veículo ou continuar com um vendedor, sem pressionar. Uma dúvida, busca de catálogo, cotação isolada, silêncio ou recusa ao contato não comprovam confirmação. Se disser que não quer atendimento, respeite; não prepare ficha por interesse.
- Preencha customerService.commercialInterest com status=confirmed somente com evidência ORIGINAL de intenção explícita de compra/negociação ou aceite da pergunta atual de confirmar interesse/continuidade com vendedor. interestEvidence copia uma mensagem original com o objetivo. Em aceite de oferta, offerEvidence copia a mensagem inteira da assistente, consentEvidence a mensagem inteira do cliente; em pedido direto, offerEvidence=null e consentEvidence copia o pedido direto inteiro. Não use o anúncio, a oferta da IA ou uma recusa como intenção do cliente. Preserve a confirmação original quando depois vier o nome.
- Com interesse confirmado, responda às dúvidas atuais e peça SOMENTE o nome se faltar, com awaiting_name e ficha factual de tudo coletado. Não exija fotos, CPF, nascimento ou simulação desse caminho. Se o nome já estiver no histórico, responda às dúvidas que puder e finalize qualified no mesmo turno, avisando continuidade por vendedor. Para dúvidas que só a equipe pode resolver, explique esse limite e encaminhe o pedido no resumo. Solicitação de novas fotos, nova busca ou comparação ainda por cumprir é atendida antes de concluir. Recusa somente aos métodos não é recusa ao atendimento humano.
- No resumo, mantenha número pelo sistema, carro(s) de interesse, objetivo, troca e características/histórico declarados (inclusive sinistro/leilão), orçamento, cidade e demais dados realmente recebidos. Registre quais métodos foram recusados/adiados; não diga que houve avaliação, fotos ou simulação se não houve. Ao pedir o nome, a regra de 15 minutos sem resposta continua valendo para essa ficha.`;

export function commercialInterestEvidence(transcript) {
  const direct = [], accepted = [];
  for (let index = 0; index < transcript.length; index++) {
    if (transcript[index].role !== "user") continue;
    const message = body(transcript[index]);
    const offer = body(transcript.slice(0, index).findLast(part => part.role === "assistant"));
    for (const offerEvidence of [null, ...(offer ? [offer] : [])]) {
      try {
        parseCommercialInterest({ status: "confirmed", interestEvidence: message, offerEvidence, consentEvidence: message }, transcript);
        if (offerEvidence === null) direct.push(message); else accepted.push({ offer, consent: message });
      } catch (error) { if (error.code !== "AI_INVALID_CUSTOMER_SERVICE") throw error; }
    }
  }
  return { direct: [...new Set(direct)], accepted };
}

export function commercialInterestFormat(transcript) {
  // A direct request is its own consent. Requiring the literal message here
  // prevents the model from repeatedly returning confirmed + null evidence.
  const envelope = (properties) => ({ type: "object", additionalProperties: false, properties,
    required: ["status", "interestEvidence", "offerEvidence", "consentEvidence"] });
  const original = { type: "string", minLength: 1, maxLength: 2000,
    description: "Copie UMA mensagem ORIGINAL INTEIRA do cliente, sem unir envios separados nem usar citação. Em pedido direto, interestEvidence e consentEvidence copiam a MESMA declaração de interesse, mesmo se depois só informou nome." };
  const alternatives = [envelope({ status: { type: "string", enum: ["none"] }, interestEvidence: { type: "null" }, offerEvidence: { type: "null" }, consentEvidence: { type: "null" } })];
  if (!transcript) alternatives.push(envelope({ status: { type: "string", enum: ["confirmed"] }, interestEvidence: { ...original }, offerEvidence: { type: ["string", "null"] }, consentEvidence: { ...original } }));
  else {
    const candidates = commercialInterestEvidence(transcript);
    if (candidates.direct.length) alternatives.push(envelope({ status: { type: "string", enum: ["confirmed"] },
      interestEvidence: { ...original, enum: candidates.direct }, offerEvidence: { type: "null" }, consentEvidence: { ...original, enum: candidates.direct } }));
    for (const { offer, consent } of candidates.accepted) alternatives.push(envelope({ status: { type: "string", enum: ["confirmed"] },
      interestEvidence: { ...original, enum: [consent] }, offerEvidence: { type: "string", enum: [offer] }, consentEvidence: { ...original, enum: [consent] } }));
  }
  return { anyOf: alternatives };
}

export function declinesOptionalTriage(message) {
  const text = normalize(message);
  return /\bso (?:estou )?(?:fazendo )?(?:uma )?(?:cotacoes|cotacao|cotando|pesquisando|olhando)\b/u.test(text)
    || /\b(?:nao quero|nao vou|nao consigo|nao tenho|prefiro nao|depois|mais tarde)\b[^.!?]{0,70}\b(?:simul\p{L}*|fotos?|avali\p{L}*|financiamento)\b/u.test(text)
    || /\b(?:simul\p{L}*|fotos?|avali\p{L}*)\b[^.!?]{0,50}\b(?:depois|mais tarde|agora nao)\b/u.test(text);
}

export function optionalTriageStillDeclined(message, history, pendingQuestion) {
  if (declinesOptionalTriage(message)) return true;
  const text = normalize(message);
  // A new explicit method request, or acceptance of its current offer, replaces
  // an earlier postponement. An unrelated name/goal does not erase it.
  if (methodSubject.test(text) || /^(?:sim|pode(?: sim| ser)?|quero(?: sim)?|gostaria(?: sim)?)[,.! ]*(?:obrigad[oa])?/u.test(text)
    && methodSubject.test(normalize(pendingQuestion))) return false;
  const previous = history.findLast(part => part.role === "user" && methodSubject.test(normalize(body(part))));
  return Boolean(previous && declinesOptionalTriage(body(previous)));
}

export function offersOptionalTriage(text) {
  return String(text || '').split(/[.!?\n]/u).some((sentence) => {
    const value = normalize(sentence);
    if (/\bnao (?:pode|consegue|quer|deseja|precisa|vai)\b/u.test(value)) return false;
    return /\b(?:quer|gostaria|podemos|posso|poderia|envie|envia|manda|mande|pode (?:(?:me|nos) )?(?:enviar|mandar|simular|fazer))\b/u.test(value)
      && /\b(?:simula\p{L}*|fotos?|avalia\p{L}*)\b/u.test(value);
  });
}

export function parseCommercialInterest(value, transcript) {
  if (value === undefined) return false; // Old checkpoints/test providers remain compatible.
  if (!value || Object.keys(value).length !== 4 || !["status", "interestEvidence", "offerEvidence", "consentEvidence"].every((key) => Object.hasOwn(value, key))) throw invalid("SHAPE");
  if (value.status === "none") {
    if ([value.interestEvidence, value.offerEvidence, value.consentEvidence].some((quote) => quote !== null)) throw invalid("NONE_EVIDENCE");
    return false;
  }
  const literal = (quote) => typeof quote === "string" && quote.trim().length > 0 && quote.length <= 2000;
  if (value.status !== "confirmed" || !literal(value.interestEvidence) || !literal(value.consentEvidence)) throw invalid("EVIDENCE");
  const interest = transcript.findIndex((part) => part.role === "user" && normalize(body(part)) === normalize(value.interestEvidence));
  const consent = transcript.findLastIndex((part) => part.role === "user" && normalize(body(part)) === normalize(value.consentEvidence));
  if (interest < 0 || consent < interest) throw invalid("EVIDENCE");
  if (transcript.slice(consent + 1).some((part) => part.role === "user" && refusesContact(body(part)))) throw invalid("DECLINED");
  const answer = normalize(body(transcript[consent]));
  if (/\b(?:nao (?:quero|desejo) (?:mais )?(?:comprar|negociar|contato|atendimento|falar|vendedor)|nao tenho interesse|sem interesse|desisti)\b/u.test(answer)
    || /^(?:nao|nao quero|nao sei|negativo|dispenso|so (?:estou )?(?:olhando|cotando|pesquisando))[.! ]*$/u.test(answer)) throw invalid("DECLINED");
  if (value.offerEvidence === null) {
    const directInterest = /\b(?:quero (?:comprar|negociar|fechar|falar com (?:um |o )?vendedor)|(?:tenho|estou com) interesse (?:em|no|na)|gostaria de (?:comprar|negociar|falar com (?:um |o )?vendedor)|estou interessad[oa] (?:em|n[oa]|ness[ea]|nest[ea])|preciso (?:de )?(?:um |o )?(?:carro|veiculo)\b[^.!?]*\b(?:trabalhar|comprar|uber|urber))\b/u.test(answer);
    if (!directInterest || /\b(?:nao (?:estou|sou) interessad[oa]|so (?:estou )?(?:cotando|pesquisando|olhando|fazendo cotacoes))\b/u.test(answer)) throw invalid("INTENT");
  } else {
    const offer = body(transcript.slice(0, consent).findLast((part) => part.role === "assistant"));
    const question = normalize(offer).split(/[.!]/u).at(-1)?.trim() || "";
    if (!literal(value.offerEvidence) || normalize(offer) !== normalize(value.offerEvidence)
      || !/\b(?:interesse|comprar|negociar|vendedor)\b/u.test(question)
      || !/\b(?:quer|deseja|gostaria|confirma|podemos|posso|vamos)\b/u.test(normalize(offer))
      || !/\b(?:sim|quero|pode|gostaria|desejo|tenho interesse|vamos|isso)\b/u.test(answer)
      || /^(?:talvez|depois|mais tarde)\b/u.test(answer)
      || /\b(?:simular|simulacao|financiamento|fotos|avaliacao)\b/u.test(question) && !/\b(?:sem|mesmo sem)\b/u.test(question)) throw invalid("OFFER");
  }
  return true;
}
