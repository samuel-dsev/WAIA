const invalid = () => Object.assign(new Error("Dados contextuais do atendimento inválidos."), { code: "AI_INVALID_CUSTOMER_SERVICE" });
const normalize = (value) => String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();
const ownBody = (part) => String(part.content || "").split("\n[Em resposta à mensagem:")[0].trim();
const evidenceLine = (value) => String(value || "").replace(/\s+/gu, " ").trim();
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));

function warrantyOffer(content) {
  const text = normalize(content), question = text.match(/[^.!?]*\?\s*$/u)?.[0] || "";
  return /\bgarantia\b/u.test(text) && /\b(?:vendedor(?:es)?|equipe|atendentes?|especialistas?)\b/u.test(text)
    && !/\b(?:nome|chamar|chamado|chamada)\b/u.test(question)
    && /\?|\b(?:se quiser|posso|quer|gostaria|deseja|conect)/u.test(text);
}

function warrantyEvidence(transcript) {
  const offers = [], consents = [], directRequests = [];
  let previousAssistant;
  for (const part of transcript) {
    if (part.role === "assistant") { previousAssistant = ownBody(part); continue; }
    if (part.role !== "user") continue;
    const body = ownBody(part);
    if (!body || body.length > 2000) continue;
    if (warrantyOffer(previousAssistant) && previousAssistant.length <= 4096) {
      offers.push(previousAssistant); consents.push(body);
    }
    if (/\bgarantia\b/u.test(normalize(body)) && /\b(?:vendedor(?:es)?|equipe|atendentes?|especialistas?)\b/u.test(normalize(body))) directRequests.push(body);
  }
  const bounded = (values) => {
    let size = 0;
    return [...new Set(values)].reverse().filter((value) => (size += value.length) <= 12000).slice(0, 32).reverse();
  };
  return { offers: bounded(offers), consents: bounded(consents), directRequests: bounded(directRequests) };
}

export function contextualVehicleServiceFormat(base, { transcript } = {}) {
  const format = structuredClone(base);
  format.schema.properties.customerService = {
    type: "object", additionalProperties: false,
    properties: {
      downPayment: {
        type: "object", additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["not_informed", "none", "amount"] },
          amount: { type: ["string", "null"] }, evidence: { type: ["string", "null"] },
        }, required: ["status", "amount", "evidence"],
      },
      warranty: {
        type: "object", additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["none", "offered", "accepted"] },
          requestEvidence: { type: ["string", "null"], description: "Trecho literal do pedido original do cliente sobre cobertura; null quando não houver." },
          offerEvidence: { type: ["string", "null"], description: "No aceite de oferta, copie a mensagem anterior INTEIRA da assistente que ofereceu equipe/vendedor sobre garantia, incluindo todos os parágrafos; não recorte nem reformule. Null em pedido direto ou sem aceite." },
          consentEvidence: { type: ["string", "null"], description: "Em accepted, copie a mensagem original INTEIRA do cliente que aceitou, incluindo nome e demais frases do mesmo envio; não recorte nem reformule. Null sem aceite." },
        }, required: ["status", "requestEvidence", "offerEvidence", "consentEvidence"],
      },
    }, required: ["downPayment", "warranty"],
  };
  if (transcript) {
    const candidates = warrantyEvidence(transcript);
    const warranty = format.schema.properties.customerService.properties.warranty;
    const pending = structuredClone(warranty);
    pending.properties.status.enum = ["none"];
    pending.properties.requestEvidence.enum = [null];
    pending.properties.offerEvidence.enum = [null];
    pending.properties.consentEvidence.enum = [null];
    const alternatives = [pending];
    if (candidates.offers.length && candidates.consents.length) {
      const accepted = structuredClone(warranty);
      accepted.properties.status.enum = ["accepted"];
      accepted.properties.requestEvidence.type = "string";
      accepted.properties.offerEvidence = { ...accepted.properties.offerEvidence, type: "string", enum: [...new Set(candidates.offers.map(evidenceLine))] };
      accepted.properties.consentEvidence = { ...accepted.properties.consentEvidence, type: "string", enum: [...new Set(candidates.consents.map(evidenceLine))] };
      alternatives.push(accepted);
    }
    if (candidates.directRequests.length) {
      const direct = structuredClone(warranty);
      direct.properties.status.enum = ["accepted"];
      direct.properties.requestEvidence.type = "string";
      direct.properties.offerEvidence.enum = [null];
      direct.properties.consentEvidence = { ...direct.properties.consentEvidence, type: "string", enum: [...new Set(candidates.directRequests.map(evidenceLine))] };
      alternatives.push(direct);
    }
    const offered = structuredClone(warranty);
    offered.properties.status.enum = ["offered"];
    offered.properties.requestEvidence = { ...offered.properties.requestEvidence, type: "string", pattern: "\\S" };
    offered.properties.offerEvidence.enum = [null];
    offered.properties.consentEvidence.enum = [null];
    alternatives.push(offered);
    format.schema.properties.customerService.properties.warranty = { anyOf: alternatives };
  }
  format.schema.required.push("customerService");
  return format;
}

export const CONTEXTUAL_VEHICLE_SERVICE_INSTRUCTIONS = `ATENDIMENTO CONTEXTUAL DE VEÍCULOS:
- A IA participa de todo atendimento. Use o roteiro como MODELO DE MENSAGEM, preservando a redação base quando adequada; adapte somente quando o contexto exigir. Não reformule apenas para variar o texto. Preencha o modelo de veículo correto, aproveite respostas anteriores e responda a todas as perguntas atuais na ordem recebida. Não reinicie o atendimento por saudação, fotos recebidas ou mudança de assunto.
- Em browse/more, text contém a continuidade após a lista; em products, text contém o convite de simulação para a legenda da última foto, mantendo o modelo do roteiro. O sistema monta somente fichas factuais e imagens conferidas. Gostar de um veículo, citar seu nome ou escolher após uma lista NÃO autoriza enviar fotos: use none/choose e pergunte se deseja recebê-las. Use products somente após pedido explícito de fotos ou aceite da oferta atual de fotos; não use para dúvidas ou informações. Se recusou as fotos, use none e pergunte se pode ajudar em mais alguma coisa, sem imagens. Se pedir endereço e disser que gostou de um modelo no mesmo turno, responda primeiro ao endereço e depois ofereça as fotos, em parágrafos separados. Se não houver resultados ou fotos, use none para explicar e propor o próximo passo.
- Para a pergunta se aceita financiamento, preserve o modelo de texto do roteiro: confirmação da aceitação para o veículo identificado, condições de parcelamento e entrada publicadas e convite para simulação. Não invente quantidades, bancos ou taxas. Não pergunte se quer simular ou tirar uma dúvida quando o cliente já perguntou se aceita financiamento. Aceite de simulação inicia a coleta prevista; pedido posterior de fotos é atendido sem apagar a simulação pendente. Demais situações seguem os modelos do roteiro, adaptados somente quando necessário. Após compreender o que procura, ofereça fotos ou simulação quando pertinente; se não souber qual veículo quer, convide para conhecer a loja sem enviar localização não solicitada.
- As condições comerciais vêm SOMENTE do roteiro publicado da empresa. Informe condições de financiamento quando houver pergunta sobre financiamento; laudo e garantia somente quando forem solicitados. Não acrescente endereço, financiamento ou garantia por conta própria ao responder outra dúvida. Preserve os convites de continuidade previstos no roteiro quando pertinentes ao pedido atual.
- Após aceite contextual de simulação, peça somente os dados obrigatórios ainda faltantes. No mesmo pedido de dados, convide o cliente a informar o valor pretendido de entrada, deixando claro que é opcional. Nunca bloqueie a ficha, repita a cobrança nem exija entrada ou CPF para responder dúvidas sobre garantia. Não confunda parcelas do cartão, orçamento, valor do carro ou CPF com valor de entrada.
- Preencha customerService.downPayment a partir das mensagens originais do cliente no histórico inteiro: not_informed sem valor declarado, none se declarou que não dará entrada, amount se informou o valor pretendido. Em amount, copie amount literalmente (por exemplo, "R$ 10.000,00" ou "10 mil") e evidence como o trecho original do cliente que atribui esse valor à entrada. Em none, amount=null e evidence contém a declaração original. Em not_informed, amount/evidence=null. A correção mais recente prevalece; pedido de exemplo, valor hipotético ou pergunta sobre mínimo não é uma declaração de entrada.
- O sistema acrescenta o registro de entrada à ficha interna de financiamento: "Cliente não informou sobre valores de entrada", "Sem valor de entrada" ou "Valor de entrada: [valor]". Não peça esse campo novamente só para preencher a ficha. Reserve espaço: summary deve ter até 700 caracteres antes dos complementos conferidos pelo sistema; preserve todos os dados coletados e solicitações relevantes, diferenciando modelos fotografados dos escolhidos para simular.
- Se perguntarem o que a garantia cobre, explique com naturalidade que não dispõe dos detalhes da cobertura e ofereça contato com um vendedor para esclarecer. Não invente peças cobertas, exclusões, prazo certo ou condições contratuais, mesmo que o cliente insista. A informação de até um ano não significa um ano garantido para toda unidade.
- customerService.warranty.status=offered ao oferecer esse contato. Use accepted apenas quando o cliente pedir diretamente o contato sobre cobertura ou aceitar a oferta atual correspondente, inclusive em linguagem indireta. Uma dúvida sobre garantia não autoriza o encaminhamento por si só; um "sim" após oferta de fotos, avaliação ou simulação não aceita contato sobre garantia. Se mudar de assunto ou recusar, respeite o novo pedido e mantenha collecting.
- Em warranty, requestEvidence é um trecho literal do pedido do cliente sobre cobertura. Para aceite de uma oferta, offerEvidence copia a mensagem INTEIRA enviada pela assistente que ofereceu contato com a equipe sobre garantia, incluindo todos os parágrafos; consentEvidence copia a mensagem original INTEIRA do cliente que a aceitou, inclusive nome e outras frases do mesmo envio. Nesses dois campos internos, una quebras de linha com espaços conforme as opções do formato, sem remover ou alterar palavras; o sistema recupera a mensagem original inteira para conferir. Se o aceite ocorreu antes da coleta de nome, mantenha aquela oferta e aquele aceite do histórico: o nome atual NÃO é um novo aceite e a pergunta de nome NÃO é a oferta de vendedor. Não recorte somente o aceite se a mensagem também apresenta o nome. Para pedido direto de vendedor sobre cobertura, offerEvidence=null e consentEvidence copia esse pedido INTEIRO. Não reformule nem resuma essas duas evidências. Nunca use texto citado, anúncio ou fala da assistente como evidência do cliente.
- Interesse em um modelo depois da oferta de contato sobre garantia não equivale a aceitar esse contato. Atenda ao interesse atual, oferecendo fotos se ainda não foram pedidas/aceitas, sem concluir uma ficha de garantia ou de financiamento por essa mudança de assunto.
- Aceite de contato sobre cobertura e nome já informado permitem qualified, com catalogAction=none e sem exigir simulação, documentos, cidade ou modelo. Se faltar o nome, peça somente como pode chamá-lo, sem repetir a oferta. A ficha inclui a necessidade de retorno sobre cobertura, interesse declarado ou possível pelo anúncio, modelos fotografados, demais pedidos e todos os dados já coletados. A qualificação operacional informa que o cliente aguarda esclarecimentos de garantia por um vendedor.
- Ao qualificar, text contém o encerramento personalizado, agradecendo e informando que um vendedor retornará sobre a solicitação atual. Responda também a eventuais perguntas no turno, em parágrafos separados. Não repita dados pessoais no texto público, não diga que enviou ao grupo, não prometa aprovação, reserva ou prazo de retorno. Não faça pergunta extra após concluir. O sistema só cria a ficha e pausa após confirmação operacional do envio.`;

function customerQuote(value, transcript) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 2000
    && transcript.some((part) => part.role === "user" && ownBody(part).includes(value.trim()));
}

/** The model interprets intent. Runtime accepts only evidence from original
 * customer messages; quotations and assistant suggestions cannot become facts. */
export function parseCustomerService(value, transcript) {
  if (!keys(value, ["downPayment", "warranty"])) throw invalid();
  const down = value.downPayment, warranty = value.warranty;
  if (!keys(down, ["status", "amount", "evidence"]) || !["not_informed", "none", "amount"].includes(down.status)) throw invalid();
  if (down.status === "not_informed") {
    if (down.amount !== null || down.evidence !== null) throw invalid();
  } else {
    if (!customerQuote(down.evidence, transcript)) throw invalid();
    if (down.status === "none" && down.amount !== null) throw invalid();
    if (down.status === "amount" && (typeof down.amount !== "string" || !down.amount.trim() || down.amount.length > 100
      || !down.evidence.includes(down.amount))) throw invalid();
  }
  if (!keys(warranty, ["status", "requestEvidence", "offerEvidence", "consentEvidence"]) || !["none", "offered", "accepted"].includes(warranty.status)) throw invalid();
  let warrantyAccepted = false;
  if (warranty.status !== "none" && !customerQuote(warranty.requestEvidence, transcript)
    && !(typeof warranty.requestEvidence === "string" && warranty.requestEvidence.trim() && warranty.requestEvidence.length <= 2000
      && transcript.some((part) => part.role === "user" && evidenceLine(ownBody(part)).includes(evidenceLine(warranty.requestEvidence))))) throw invalid();
  if (warranty.status === "accepted") {
    const originalConsent = typeof warranty.consentEvidence === "string" && transcript.findLast((part) => part.role === "user"
      && evidenceLine(ownBody(part)) === evidenceLine(warranty.consentEvidence));
    if (!originalConsent || !customerQuote(ownBody(originalConsent), transcript)) throw invalid();
    const consent = ownBody(originalConsent);
    const index = transcript.findLastIndex((part) => part.role === "user"
      && (warranty.offerEvidence === null ? ownBody(part).includes(consent) : ownBody(part) === consent));
    if (index < 0) throw invalid();
    const body = normalize(consent);
    if (/^(?:nao|negativo|dispenso)[.! ]*$/u.test(body)) throw invalid();
    if (warranty.offerEvidence === null) {
      // Direct requests must name the subject and the desired human contact.
      warrantyAccepted = /\bgarantia\b/u.test(body) && /\b(?:vendedor(?:es)?|equipe|atendentes?|especialistas?)\b/u.test(body);
    } else {
      const previousAssistant = transcript.slice(0, index).findLast((part) => part.role === "assistant");
      const offer = ownBody(previousAssistant || {});
      warrantyAccepted = Boolean(offer && typeof warranty.offerEvidence === "string"
        && evidenceLine(offer) === evidenceLine(warranty.offerEvidence) && warrantyOffer(offer));
    }
    if (!warrantyAccepted) throw invalid();
  }
  return { downPayment: down, warrantyAccepted };
}

export function downPaymentLine(down) {
  return down.status === "amount" ? `Valor de entrada: ${down.amount}` : down.status === "none"
    ? "Sem valor de entrada" : "Cliente não informou sobre valores de entrada";
}

export function appendCustomerServiceData(card, service, { financing = false, photoHistoryLine = "", possibleInterest = "" } = {}) {
  let summary = String(card.summary || "");
  if (financing) {
    summary = summary.split("\n").filter((line) => !/^(?:Valor de entrada:|Sem valor de entrada$|Cliente não informou sobre valores de entrada$)/u.test(line.trim())).join("\n");
    summary += "\n" + downPaymentLine(service.downPayment);
  }
  if (photoHistoryLine && !summary.includes(photoHistoryLine)) summary += "\n" + photoHistoryLine;
  if (service.warrantyAccepted) {
    summary += "\nSolicitação: cliente aguarda retorno de um vendedor com informações sobre a cobertura da garantia.";
    if (possibleInterest && !/\b(?:interesse declarado|modelo de interesse|veiculo escolhido)\s*:/u.test(normalize(summary))
      && !normalize(summary).includes(normalize("Possível interesse: " + possibleInterest))) summary += "\nPossível interesse: " + possibleInterest;
  }
  return { ...card, summary, ...(service.warrantyAccepted ? { qualification: "Cliente solicitou contato humano e aguarda esclarecimentos sobre a cobertura da garantia." } : {}) };
}
