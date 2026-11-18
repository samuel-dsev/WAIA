const STEPS = ["offer_photos", "offer_visit", "collect_photos", "visit_requested", "human_review_requested", "declined", "completed"];
const ACCEPTED = ["collect_photos", "visit_requested", "human_review_requested"];
const normalized = (value) => String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();
const invalid = () => Object.assign(new Error("Contexto de avaliação inválido."), { code: "AI_INVALID_TRADE_EVALUATION" });
export const EVALUATION_CLOSING = "Obrigada, {nome}! Um de nossos vendedores entrará em contato por aqui para combinar a avaliação do seu veículo e os próximos passos.";

export function normalizeTradeInEvaluation(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3
    || !STEPS.includes(value.step) || !["customer", "ad", "unknown"].includes(value.interestSource)
    || !(value.interestName === null || typeof value.interestName === "string" && value.interestName.trim().length >= 2 && value.interestName.length <= 200
      && !/[\u0000-\u001f\u007f<>]/u.test(value.interestName))
    || value.interestSource === "unknown" && value.interestName !== null) throw invalid();
  return { step: value.step, interestName: value.interestName?.trim() || null, interestSource: value.interestSource };
}

export function tradeInEvaluationFormat(base) {
  const format = structuredClone(base);
  format.schema.properties.tradeInEvaluation = {
    type: ["object", "null"], additionalProperties: false,
    description: "Estado de avaliação obrigatório ao oferecer fotos/visita, receber fotos, aceitar, continuar ou recusar avaliação. Null somente quando não tratar desse assunto.",
    properties: {
      step: { type: "string", enum: STEPS.filter((step) => step !== "completed") },
      interestName: { type: ["string", "null"] },
      interestSource: { type: "string", enum: ["customer", "ad", "unknown"] },
    }, required: ["step", "interestName", "interestSource"],
  };
  format.schema.required.push("tradeInEvaluation");
  return format;
}

export const TRADE_IN_EVALUATION_INSTRUCTIONS = [
  "AVALIAÇÃO DE VEÍCULO NA TROCA (capacidade habilitada pela empresa):",
  "A política comercial continua sendo a publicada no roteiro. Responda explicitamente se a empresa avalia veículos na troca, sem garantir aceitação, valor, condição mecânica ou aprovação. Responda também a endereço e outras perguntas do turno, em UMA mensagem personalizada, antes de uma única pergunta de continuidade.",
  "Há dois caminhos distintos. Na análise inicial por fotos, ofereça essa possibilidade (step=offer_photos), após aceite use collect_photos e peça fotos do veículo que o cliente quer oferecer na troca. Recebendo anexos, agradeça uma vez e continue pelo modelo de interesse; não encerre apenas pelas fotos ou pelo nome. Se ainda não escolheu, pergunte qual modelo procura; se já escolheu, ofereça as fotos dele sem repetir a pergunta; depois da galeria, ofereça simulação, que continua exigindo aceite próprio.",
  "Na avaliação presencial, ofereça registrar o pedido (offer_visit). Quando aceitar ou pedir a avaliação, use visit_requested. Primeiro nome informado e aceite de avaliação presencial bastam para qualificar, mesmo sem modelo de interesse, fotos, CPF, nascimento ou horário escolhido. Pergunte como pode chamar somente se o nome faltar. human_review_requested vale quando o cliente pede explicitamente que a equipe avalie a troca por atendimento humano. Não confunda uma dúvida isolada com aceite.",
  "O sim curto se refere à oferta efetivamente enviada mais recente. Não converta aceite de fotos/lista em visita ou financiamento. tradeInEvaluation.session preserva a pendência confirmada. Fotos, dúvidas ou mudança de assunto suspendem a coleta sem apagar dados nem presumir desistência. Use declined somente para recusa explícita da avaliação; falta de fotos não é recusa. Uma pergunta sobre localização não constitui pedido de avaliação.",
  "As mensagens de imagem fornecem somente metadados de recebimento e legenda escrita pelo cliente. Não há análise visual: não identifique marca, modelo, placa, estado, danos ou valor pela imagem. Se o arquivo estiver indisponível, explique o problema e permita alternativa. Não chame foto de carro de comprovante.",
  "Separe o veículo de troca do veículo de interesse. Em quero o Onix e tenho um HB20 para trocar, interesse é Onix e troca é HB20. interestName descreve só o interesse de compra, nunca o carro de troca. Use interestSource=customer apenas para escolha explícita do cliente, com a forma do nome que ele escreveu; ad para modelo identificável no anúncio e ainda não escolhido; unknown e interestName=null quando desconhecido. O anúncio não comprova intenção. Uma escolha recente prevalece e possível interesse não precisa ser dito ao cliente.",
  "Sempre preencha tradeInEvaluation ao oferecer avaliação por fotos ou presencial, receber fotos ou tratar de uma avaliação pendente; null não registra a oferta e impede o aceite curto seguinte. Quando oferecer as duas alternativas, use offer_visit; o próximo pedido explícito de fotos deve usar collect_photos. Recusa explícita usa declined mesmo quando atender um pedido de galeria na mesma resposta. Quando houver atualização, retorne step, interestName e interestSource. O sistema valida aceite, acrescenta o rótulo de interesse na ficha e só conclui após a confirmação de envio. Não use finance para avaliação; use none/details conforme a solicitação. Preserve a simulação pendente quando houver.",
  "Ao qualificar para avaliação, summary e qualification preservam todos os dados fornecidos: finalidade, necessidade de avaliação, carro de troca, características declaradas, fotos recebidas quando houver, interesse e preferência de visita. Não diga que um horário está reservado. text responde às dúvidas atuais e pode encerrar naturalmente agradecendo pelo nome e informando que um vendedor entrará em contato para combinar os detalhes, seguindo a referência de encerramento. Encerre sem pergunta: não peça nova confirmação de cadastro/telefone/interesse nem pergunte se pode ajudar em algo mais. O sistema completa o encerramento quando faltar, sem duplicá-lo. Nunca afirme que enviou a ficha ou notificou o grupo/equipe e não repita CPF/nascimento no texto público.",
].join("\n");

export function tradeInTurnInstructions(context, turnMessages = []) {
  const photos = turnMessages.filter((part) => part.type === "image").length;
  if (!photos || !["offer_photos", "collect_photos"].includes(context?.session?.step)) return "";
  return "CONTEXTO DO TURNO ATUAL: recebidas " + photos + " imagens durante a avaliação inicial por fotos. "
    + "O cliente já está enviando as fotos solicitadas; não pergunte novamente se quer avaliar por fotos. "
    + "A resposta deve agradecer explicitamente o recebimento, responder também às perguntas textuais deste turno e continuar pelo modelo de compra. "
    + "Se o modelo ainda não foi escolhido, pergunte qual procura; se já foi, ofereça as fotos desse modelo quando apropriado. "
    + "Uma pergunta sobre cidade/endereço e o nome não autorizam visita nem contato de vendedor: nesse caso mantenha collect_photos e collecting, sem prometer retorno da equipe. "
    + "Somente um pedido explícito de visita, atendimento humano ou recusa neste turno muda esse percurso. Não deduza características pelas imagens.";
}

export function tradeInOfferFromAnswer(text, session) {
  const answer = normalized(text);
  const question = answer.match(/(?:^|[.!?])([^.!?]*\?)\s*$/u)?.[1] || "";
  if (!/\b(?:gostaria|quer|deseja|posso|podemos|prefere|vamos|que tal)\b/u.test(question)) return null;
  const evaluation = /\bavalia(?:r|cao)\b/u.test(answer);
  const visit = /\bavalia(?:r|cao)\b/u.test(question) && /\b(?:presencial|agendar|agendamento|marcar|visita|loja)\b/u.test(answer);
  const photos = /\bfotos\b/u.test(question) && (evaluation || /\bseu (?:carro|veiculo)\b/u.test(question))
    || /\bavalia(?:r|cao)\b/u.test(question) && /\bfotos\b/u.test(answer);
  if (!visit && !photos) return null;
  // This records only the offer in the assistant's own answer. Customer consent
  // is still validated separately against the sent turn and conversation.
  return { step: visit ? "offer_visit" : "offer_photos", interestName: session?.interestName || null,
    interestSource: session?.interestSource || "unknown" };
}

export function hasTradeInEvaluationConsent(context, message, history, turnMessages = [], targetStep) {
  const answer = normalized(message), session = context?.session;
  const last = history.findLast((part) => part.role === "assistant")?.content || "";
  if (targetStep === "visit_requested" && session?.step !== "visit_requested" && !session?.visitAccepted) {
    const offeredVisit = session?.step === "offer_visit" && session.direct === true && /\bavalia[cç][aã]o\b[^?]*\?\s*$/iu.test(last);
    const clauses = answer.split(/\b(?:mas|porem|so que)\b|[,;.!?\n]/u);
    const explicitVisit = clauses.some((part) => !/\b(?:nao|talvez|se eu)\b/u.test(part)
      && (/^\s*(?:agende|marque|agendar|marcar)\b/u.test(part)
        || /\b(?:quero|gostaria|prefiro|preciso|vou|irei|vamos|pode|posso|poderia)\b.{0,100}\b(?:agendar|marcar|presencial|pessoalmente|levar|visitar)\b/u.test(part)
        || /\b(?:vou|irei|vamos|quero ir|gostaria de ir)\b.{0,60}\bloja\b/u.test(part)));
    const locationQuestion = /\b(?:qual (?:a |e a |o |e o )?(?:cidade|endereco)|onde fica|onde e|localizacao)\b/u.test(answer);
    const separateAcceptance = clauses.some((part) => /^\s*(?:sim|pode sim|pode ser|claro|com certeza|vamos sim)\s*$/u.test(part));
    if (!offeredVisit && !explicitVisit || locationQuestion && !explicitVisit && !separateAcceptance
      || turnMessages.length > 0 && turnMessages.every((part) => part.type === "image") && !explicitVisit) return false;
  }
  if (targetStep === "human_review_requested" && session?.step !== "human_review_requested" && !session?.humanReviewAccepted) {
    const humanClause = answer.split(/\b(?:mas|porem|so que)\b|[,;.!?]/u).findLast((part) => /\b(?:vendedor|atendente|equipe|humano|pessoa)\b/u.test(part));
    if (!humanClause || /\bnao (?:quero|preciso|cham)/u.test(humanClause)
      || !/\b(?:quero|gostaria|preciso|pode(?:m)?|chame|chamar|falar|contato|encaminh[ae])\b/u.test(humanClause)) return false;
  }
  const evaluationClause = answer.split(/\b(?:mas|porem|so que)\b|[,;.!?]/u).findLast((part) => /\bavalia(?:r|cao)\b/u.test(part));
  if (declinesTradeInEvaluation(message)) return false;
  if (/^(?:nao(?: quero)?|desisti|cancela|cancele)[.! ]*$/u.test(answer)) return false;
  if (ACCEPTED.includes(session?.step)) return true;
  if (evaluationClause && /\b(?:quero|gostaria|preciso|vamos|pode(?:mos)?|poderia)\b.{0,100}\bavalia(?:r|cao)\b/u.test(evaluationClause)) return true;
  const images = turnMessages.some((part) => part.type === "image");
  if (images && session?.step === "offer_photos") return true;
  const question = /(?:avalia[cç][aã]o|avaliar|fotos do seu|fotos d[oa] (?:seu )?(?:carro|ve[ií]culo))[^?]*\?\s*$/iu.test(last);
  const acknowledgements = String(message).split("\n").map(normalized).every((part) => /^(?:entendi|certo|ta|tudo bem)?[.! ]*$/u.test(part));
  return ["offer_photos", "offer_visit"].includes(session?.step) && session.direct === true && question
    && !acknowledgements && !/^(?:nao\b|talvez\b)|\b(?:nao sei|ainda nao|depois|mais tarde)\b/u.test(answer);
}

export function declinesTradeInEvaluation(message) {
  const clause = normalized(message).split(/\b(?:mas|porem|so que)\b|[,;.!?]/u).findLast((part) => /\bavalia(?:r|cao)\b/u.test(part));
  return Boolean(clause && /\b(?:nao quero|desisti|cancel[ae])\b/u.test(clause));
}

export function evaluationAnswerWithoutFollowUp(answer) {
  // With name and evaluation consent already validated, a trailing question is
  // unnecessary. Preserve the actual answers and use the closing reference.
  return String(answer || "").replace(/(?:^|(?<=[.!?\n]))\s*(?:posso|podemos|pode(?:ria)?|gostaria|quer|qual|como|mais alguma)[^.!?\n]*\?\s*$/iu, "").trim();
}

export function mayQualifyTradeInEvaluation(state, consent) {
  return consent && ["visit_requested", "human_review_requested"].includes(state?.step);
}

export function evaluationInterest(state, context, evidence) {
  const name = state?.interestName;
  if (state?.interestSource === "customer" && name) {
    const words = (text) => normalized(text).replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter(Boolean);
    const items = context?.catalog?.items || [];
    const matches = items.filter((item) => normalized(item.name) === normalized(name));
    const uniqueTokens = matches.length === 1 ? words(name).filter((word) => word.length >= 2 && /\p{L}/u.test(word)
      && !["de", "da", "do", "se", "os", "as", "no", "na", "em", "um", "uma"].includes(word)
      && items.filter((item) => words(item.name).includes(word)).length === 1) : [];
    const supplied = evidence.some((body) => normalized(body).includes(normalized(name))
      || uniqueTokens.some((word) => words(body).includes(word)));
    return supplied ? { name, label: "Interesse declarado: " + name } : { name: null, label: "Interesse declarado a confirmar" };
  }
  const ad = context?.catalog?.adContext, referral = ad?.referral || context?.adContext?.referral;
  const item = ad?.match === "unique" && context.catalog.items.find((product) => product.id === ad.productId);
  if (item) return { name: item.name, label: "Possível interesse: " + item.name };
  const copy = normalized((referral?.headline || "") + " " + (referral?.body || ""));
  if (state?.interestSource === "ad" && name && copy.includes(normalized(name))) {
    return { name, label: "Possível interesse: " + name };
  }
  return { name: null, label: "Interesse não informado" };
}

export function evaluationLeadCard(value, state, context, evidence) {
  const interest = evaluationInterest(state, context, evidence);
  const summary = String(value.summary || "").split("\n")
    .filter((line) => !/^\s*(?:Interesse(?: declarado)?|Poss[ií]vel interesse)\s*:/iu.test(line)).join("\n").trim();
  return { ...value, summary: summary + "\n" + interest.label };
}

export function evaluationClosing(answer, template, name) {
  const publicAnswer = (answer || "").trim().replaceAll("{nome}", name);
  const contactReturn = /\b(?:vendedor(?:es)?|equipe|responsavel|atendente)\b[^.!?\n]{0,140}\b(?:contato|retorno|retornar|retornarao?|contatarao?)\b/u.test(normalized(publicAnswer));
  const body = contactReturn ? publicAnswer : publicAnswer.replace(/^\s*Obrigad[oa][^.!?\n]{0,100}[.!]\s*/iu, "");
  const text = contactReturn ? body : [body, (template || EVALUATION_CLOSING).replaceAll("{nome}", name)].filter(Boolean).join("\n\n");
  if (text.length > 4096) throw invalid();
  return text;
}

export function announcesEvaluationDelivery(text) {
  const value = normalized(text);
  return /\b(?:enviei|enviamos|encaminhei|encaminhamos|notifiquei|notificamos)\b[^.!?\n]{0,100}\b(?:grupo|equipe|vendedor)\b/u.test(value)
    || /\b(?:ficha|resumo|pedido|dados|informacoes|solicitacao)\b[^.!?\n]{0,55}\b(?:foi|foram|ja esta|esta|estao)\s+(?:enviad[oa]s?|encaminhad[oa]s?)\b/u.test(value)
    || /\b(?:equipe|vendedor|grupo)\b[^.!?\n]{0,45}\b(?:foi notificad[oa]|ja recebeu)\b/u.test(value)
    || /\b(?:enviarei|encaminharei|vou enviar|vou encaminhar|sera enviad[oa])\b[^.!?\n]{0,100}\bgrupo\b/u.test(value);
}

export function announcesEvaluationBooking(text) {
  return normalized(text).split(/\b(?:mas|porem)\b|[.!?\n]/u).some((part) =>
    !/\b(?:nao|a confirmar|sem confirmacao)\b/u.test(part)
    && (/\b(?:agendei|marquei|reservei)\b/u.test(part)
      || /\b(?:avaliacao|visita|horario|agendamento)\b.{0,55}\b(?:agendad[oa]|marcad[oa]|reservad[oa]|confirmad[oa])\b/u.test(part)));
}
