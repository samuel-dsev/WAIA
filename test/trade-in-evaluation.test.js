import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTradeInEvaluation, tradeInOfferFromAnswer, reconcileTradeInEvaluation, hasTradeInEvaluationConsent, mayQualifyTradeInEvaluation, evaluationLeadCard, evaluationClosing, announcesEvaluationBooking, announcesEvaluationDelivery } from "../src/modules/business/trade-in-evaluation.js";
import { inboundMessageContent } from "../src/modules/ai/inbound-content.js";
import { loadConversationContext } from "../src/modules/ai/conversation-context.js";
import { requireAiRequest } from "../src/modules/ai/contracts.js";

const state = (step, interestName = null, interestSource = "unknown") => ({ step, interestName, interestSource });
test("reparo de aceite curto não promove reconhecimento, dúvida, recusa ou alternativa ambígua", () => {
  const proposal=state("offer_visit"),context={session:{...proposal,direct:true}};
  const history=[{role:"assistant",content:"Gostaria de solicitar uma avaliação presencial?"}];
  for(const text of ["Entendi","Qual cidade fica essa loja?","Não quero","Talvez","Sou Ana"]) assert.deepEqual(reconcileTradeInEvaluation(proposal,context,text,history,[]),proposal,text);
  assert.deepEqual(reconcileTradeInEvaluation(proposal,{session:{...proposal,direct:false}},"Pode sim",history,[]),proposal);
  assert.deepEqual(reconcileTradeInEvaluation(null,context,"Pode sim",[{role:"assistant",content:"Prefere enviar fotos ou agendar uma avaliação presencial?"}],[]),null);
  assert.deepEqual(reconcileTradeInEvaluation(null,context,"Pode sim",history,[]),state("visit_requested"));
});
test("registro da oferta escrita não confunde galeria ou dúvida com consentimento", () => {
  assert.deepEqual(tradeInOfferFromAnswer("Podemos iniciar a avaliação por fotos. Gostaria de enviar as fotos do seu veículo?"), state("offer_photos"));
  assert.deepEqual(tradeInOfferFromAnswer("Podemos agendar uma avaliação presencial. Gostaria de solicitar essa avaliação?", state("collect_photos", "Onix", "customer")), state("offer_visit", "Onix", "customer"));
  for (const text of ["Gostaria de ver fotos do Onix?", "Qual é sua dúvida sobre avaliação presencial?", "A avaliação é presencial.", "Quer fazer uma simulação?"]) assert.equal(tradeInOfferFromAnswer(text), null, text);
});
test("aceite de avaliação acompanha a oferta atual e não aceita lista, reconhecimento ou recusa", () => {
  const history = [{ role: "assistant", content: "Você gostaria de solicitar uma avaliação presencial do seu veículo?" }];
  const context = { session: { ...state("offer_visit"), direct: true } };
  assert.equal(hasTradeInEvaluationConsent(context, "Sim, amanhã", history), true);
  assert.equal(hasTradeInEvaluationConsent({}, "Quero agendar uma avaliação", []), true);
  assert.equal(hasTradeInEvaluationConsent({}, "Não quero financiar, mas quero fazer uma avaliação", []), true);
  assert.equal(hasTradeInEvaluationConsent({ session: state("visit_requested") }, "Não quero financiar", []), true);
  for (const message of ["Entendi", "Não quero", "Talvez", "Mais tarde"]) assert.equal(hasTradeInEvaluationConsent(context, message, history), false);
  assert.equal(hasTradeInEvaluationConsent({ session: { ...context.session, direct: false } }, "Pode sim", [...history,
    { role: "assistant", content: "Posso mostrar opções semelhantes?" }]), false);
  assert.equal(hasTradeInEvaluationConsent({ session: state("offer_photos") }, "[Imagem recebida]", [], [{ type: "image" }]), true);
  assert.equal(hasTradeInEvaluationConsent({ session: state("collect_photos") }, "[Imagem recebida]", [], [{ type: "image" }], "visit_requested"), false);
  assert.equal(hasTradeInEvaluationConsent({ session: state("collect_photos") }, "[Imagem recebida]", [], [{ type: "image" }], "human_review_requested"), false);
  assert.equal(hasTradeInEvaluationConsent({ session: { ...state("collect_photos"), visitAccepted: true } }, "Sou Ana", [], [], "visit_requested"), true);
  for (const message of ["Qual cidade fica essa loja?", "Sim, qual endereço da loja?", "A avaliação é presencial?", "Onde fica a loja?"]) {
    assert.equal(hasTradeInEvaluationConsent({ session: state("collect_photos") }, message, [], [], "visit_requested"), false, message);
  }
  assert.equal(hasTradeInEvaluationConsent(context, "Qual cidade fica essa loja?", history, [], "visit_requested"), false);
  assert.equal(hasTradeInEvaluationConsent(context, "Sim, qual endereço da loja?", history, [], "visit_requested"), true);
  for (const message of ["Quero agendar uma avaliação presencial. Qual endereço?", "Prefiro levar o carro", "Vou até a loja para a avaliação", "Pode marcar a avaliação"]) {
    assert.equal(hasTradeInEvaluationConsent({ session: state("collect_photos") }, message, [], [], "visit_requested"), true, message);
  }
  assert.equal(hasTradeInEvaluationConsent({ session: state("collect_photos") }, "A equipe já avaliou?", [], [], "human_review_requested"), false);
  assert.equal(hasTradeInEvaluationConsent({ session: state("collect_photos") }, "Não quero que o vendedor ligue", [], [], "human_review_requested"), false);
  assert.equal(mayQualifyTradeInEvaluation(state("collect_photos"), true), false);
  assert.equal(mayQualifyTradeInEvaluation(state("visit_requested"), true), true);
  assert.equal(mayQualifyTradeInEvaluation(state("visit_requested"), false), false);
  assert.throws(() => normalizeTradeInEvaluation({ ...state("offer_visit"), injected: true }));
});

test("ficha distingue interesse declarado, anúncio e carro de troca sem eliminar dados", () => {
  const card = { summary: "Dados coletados:\nTroca: HB20 cinza 2016\nCPF: 000.000.000-00\nInteresse: texto incorreto", qualification: "Necessita avaliação." };
  const context = { catalog: { items: [{ id: "turim:1", name: "HB20 SENSE" }], adContext: {
    match: "unique", productId: "turim:1", referral: { headline: "HB20 SENSE" },
  } } };
  const declared = evaluationLeadCard(card, state("visit_requested", "Onix", "customer"), context, ["Quero o Onix; tenho um HB20 para trocar"]);
  assert.match(declared.summary, /Interesse declarado: Onix/u);
  assert.match(declared.summary, /Troca: HB20 cinza 2016/u);
  assert.match(declared.summary, /000\.000\.000-00/u);
  assert.doesNotMatch(declared.summary, /texto incorreto|Possível interesse/u);
  assert.match(evaluationLeadCard(card, state("visit_requested"), context, []).summary, /Possível interesse: HB20 SENSE/u);
  assert.match(evaluationLeadCard(card, state("visit_requested"), {}, []).summary, /Interesse não informado/u);
  const aliasContext = { catalog: { items: [{ id: "turim:1", name: "ONIX JOY" }, { id: "turim:2", name: "HB20 SENSE" }] } };
  assert.match(evaluationLeadCard(card, state("visit_requested", "ONIX JOY", "customer"), aliasContext, ["Quero o Onix, tenho um HB20 para trocar"]).summary, /Interesse declarado: ONIX JOY/u);
  assert.match(evaluationLeadCard(card, state("visit_requested", "Outro modelo", "customer"), context, ["Quero o Onix"]).summary, /Interesse declarado a confirmar/u);
  const missingStock = { adContext: { referral: { headline: "Hyundai HB20 Comfort 2017" } } };
  assert.match(evaluationLeadCard(card, state("visit_requested", "HB20 Comfort", "ad"), missingStock, []).summary, /Possível interesse: HB20 Comfort/u);
  assert.match(evaluationLeadCard(card, state("visit_requested", "Modelo inventado", "ad"), missingStock, []).summary, /Interesse não informado/u);
  const closing = evaluationClosing("Ficamos em Taubaté.", undefined, "Ana");
  assert.match(closing, /^Ficamos em Taubaté\.\n\nObrigada, Ana!/u);
  assert.doesNotMatch(closing, /agendado|grupo/u);
  const natural = "Obrigada, Ana! Um vendedor entrará em contato por aqui para combinar a avaliação.";
  assert.equal(evaluationClosing(natural, undefined, "Ana"), natural);
  assert.equal(evaluationClosing(natural.replace("Ana", "{nome}"), undefined, "Ana"), natural);
  assert.equal(announcesEvaluationDelivery("Encaminhei a ficha para o vendedor."), true);
  assert.equal(announcesEvaluationDelivery("Um vendedor entrará em contato por aqui."), false);
  assert.equal(announcesEvaluationBooking("Agendei a avaliação para amanhã."), true);
  assert.equal(announcesEvaluationBooking("Seu horário está confirmado."), true);
  assert.equal(announcesEvaluationBooking("O horário ainda não está confirmado."), false);
  assert.equal(announcesEvaluationBooking("A equipe precisa confirmar o horário."), false);
});

test("imagens entram como recebimento e legenda, sem visão, links privados ou falsa evidência de nome", async () => {
  const rows = [{ id: "photo", sequence: 1, type: "image", direction: "inbound", body: "HB20 cinza",
    mediaExternalId: "provider-id", mediaStorageKey: "private/internal-key" },
  { id: "current", sequence: 2, type: "text", direction: "inbound", body: "Quero ver o Onix" }];
  const service = { async getHistory() { return rows; } };
  const request = requireAiRequest({ empresaId: "a", conversationId: "chat", messageId: "current", correlationId: "c", message: rows[1].body });
  const without = await loadConversationContext(service, request, new Date());
  assert.equal(without.input.length, 0);
  const withImages = await loadConversationContext(service, request, new Date(), { includeIncomingImages: true });
  assert.match(withImages.input[0].content, /Imagem recebida.*sem análise visual/u);
  assert.match(withImages.input[0].content, /Legenda escrita pelo cliente: HB20 cinza/u);
  assert.doesNotMatch(withImages.input[0].content, /private\/internal-key|provider-id/u);
  assert.deepEqual(withImages.evidence, ["HB20 cinza", "Quero ver o Onix"]);
  const burst = requireAiRequest({ empresaId: "a", conversationId: "chat", correlationId: "c", turnMessages: [
    { id: "image", type: "image", text: "", mediaStored: true }, { id: "name", text: "Ana" },
  ] });
  assert.equal(burst.turnMessages[0].text, "");
  assert.match(burst.message, /Imagem recebida/u);
  assert.match(inboundMessageContent({ type: "image", text: "" }), /armazenamento ainda não confirmado/u);
});
