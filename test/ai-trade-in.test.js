import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAiConfigResolver, MemoryAiLedger, MemoryAiSecretResolver, MemoryPricingCatalog,
  MemoryResponsesClientFactory, MultiTenantAiService } from "../src/modules/ai/index.js";

const state = (step, interestName = null, interestSource = "unknown") => ({ step, interestName, interestSource });
const collecting = { status: "collecting", name: null, summary: null, qualification: null };
const card = { status: "qualified", name: "Ana", summary: "Solicita avaliação presencial. Dados coletados: HB20 cinza, 2016, oferecido na troca.",
  qualification: "Necessita avaliação do veículo de troca e confirmação dos detalhes pela equipe." };
function setup(responder, histories = [], overrides = {}) {
  const config = { empresaId: "a", enabled: true, provider: "openai", model: "test", prompt: "Aceitamos avaliar veículos na troca. Endereço em Taubaté.",
    keyType: "shared", maxOutputTokens: 800, leadQualificationEnabled: true, leadQualificationCriteria: "Nome e pedido de avaliação.",
    tradeInEvaluationEnabled: true, allowedContextKeys: ["catalog", "adContext", "tradeInEvaluation", "identity"], version: 1, ...overrides };
  const factory = new MemoryResponsesClientFactory(responder);
  const ai = new MultiTenantAiService({ configResolver: new MemoryAiConfigResolver([config]), conversationService: { async getHistory() { return histories; } },
    clientFactory: factory, secretResolver: new MemoryAiSecretResolver({ sharedSecret: "fake" }), ledger: new MemoryAiLedger(),
    pricingCatalog: new MemoryPricingCatalog({ test: { inputPerMillion: 1, outputPerMillion: 1, version: "test" } }), timeoutMs: 1000, logger: { warn() {} } });
  return { ai, factory };
}
function output(text, evaluation, leadQualification = collecting) {
  return { output_text: JSON.stringify({ text, catalogAction: "none", productIds: [], filters: { category: null, minPrice: null, maxPrice: null },
    leadQualification, tradeInEvaluation: evaluation }), usage: { input_tokens: 10, output_tokens: 10 } };
}
function request(message, session, extra = {}) {
  return { empresaId: "a", conversationId: "chat", correlationId: "c", messageId: "current", message,
    context: { catalog: { source: { type: "website_catalog", status: "healthy" }, salesMode: true, items: [{ id: "turim:1", name: "Onix Joy" }],
      adContext: { match: "unique", productId: "turim:1", referral: { headline: "Onix Joy" } } },
    tradeInEvaluation: { session } }, ...extra };
}

test("troca e endereço no turno recebem uma resposta, com oferta e sem qualificação", async () => {
  const { ai } = setup(async (call) => {
    assert.ok(call.text.format.schema.properties.tradeInEvaluation);
    assert.match(call.instructions, /todas as perguntas/u);
    assert.deepEqual(call.input.slice(-2).map((part) => part.content), ["Aceita veículo na troca?", "Qual cidade fica essa loja?"]);
    return output("Sim, avaliamos seu veículo na troca.\n\nFicamos em Taubaté.\n\nGostaria de solicitar uma avaliação presencial?", state("offer_visit"));
  });
  const reply = await ai.reply(request("", null, { turnMessages: [{ id: "trade", text: "Aceita veículo na troca?" }, { id: "city", text: "Qual cidade fica essa loja?" }] }));
  assert.equal(reply.source, "ai");
  assert.equal(reply.messages, undefined);
  assert.match(reply.text, /troca[\s\S]*Taubaté/u);
  assert.equal(reply.leadQualification, undefined);
  assert.equal(reply.tradeInEvaluation.step, "offer_visit");
});

test("oferta escrita sem metadata é preservada para interpretar o próximo aceite", async () => {
  const text = "Aceitamos veículo na troca mediante avaliação. Ficamos em Taubaté. Posso ajudar você a agendar uma avaliação presencial do seu veículo?";
  const { ai } = setup(async () => output(text, null));
  const offer = await ai.reply(request("Aceita veículo na troca? Qual cidade fica essa loja?", null));
  assert.equal(offer.source, "ai");
  assert.equal(offer.text, text);
  assert.equal(offer.tradeInEvaluation.step, "offer_visit");
  assert.equal(offer.leadQualification, undefined);
  const next = setup(async () => output("Como posso te chamar?", state("offer_visit")),
    [{ type: "text", direction: "outbound", status: "sent", body: text }]);
  const accepted = await next.ai.reply(request("Pode sim", { ...offer.tradeInEvaluation, direct: true }));
  assert.equal(accepted.tradeInEvaluation.step, "visit_requested");
  assert.equal(accepted.leadQualification, undefined);
});

test("metadata repetido na oferta de fotos aceita muda apenas para coleta, sem ficha", async () => {
  const { ai } = setup(async () => output("Pode enviar as fotos do seu veículo.", state("offer_photos")),
    [{ type: "text", direction: "outbound", status: "sent", body: "Gostaria de enviar fotos do seu veículo para avaliação?" }]);
  const reply = await ai.reply(request("Entendi\nPode sim", { ...state("offer_photos"), direct: true }));
  assert.equal(reply.tradeInEvaluation.step, "collect_photos");
  assert.equal(reply.leadQualification, undefined);
});

test("aceite presencial com nome aproveita anúncio, preserva resposta pública e fecha uma ficha de avaliação", async () => {
  const history = [{ type: "text", direction: "outbound", status: "sent", body: "Você gostaria de solicitar uma avaliação presencial?" }];
  const { ai } = setup(async () => output("A loja fica em Taubaté.", state("visit_requested"), card), history);
  const reply = await ai.reply(request("Sim, sou Ana. Tenho um HB20 cinza 2016 para trocar. Qual a cidade?", { ...state("offer_visit"), direct: true }));
  assert.equal(reply.source, "ai");
  assert.equal(reply.tradeInEvaluation.step, "completed");
  assert.match(reply.leadQualification.summary, /Possível interesse: Onix Joy/u);
  assert.match(reply.leadQualification.summary, /HB20 cinza, 2016/u);
  assert.match(reply.leadQualification.qualification, /avaliação/u);
  assert.match(reply.text, /^A loja fica em Taubaté\.\n\nObrigada, Ana!/u);
  assert.doesNotMatch(reply.text, /CPF|nascimento|agendad|grupo/u);
});

test("aceite após outro assunto não autoriza avaliação nem gera ficha", async () => {
  const { ai } = setup(async () => output("Você gostaria de solicitar uma avaliação presencial?", state("visit_requested"), card),
    [{ type: "text", direction: "outbound", status: "sent", body: "Posso mostrar opções semelhantes?" },
      { type: "text", direction: "inbound", body: "Sou Ana" }]);
  const reply = await ai.reply(request("Pode sim", { ...state("offer_visit"), direct: false }));
  assert.equal(reply.source, "ai");
  assert.equal(reply.leadQualification, undefined);
  assert.equal(reply.tradeInEvaluation, undefined);
});

test("fotos e nome não encerram a avaliação inicial; legendas são contexto sem análise visual", async () => {
  const { ai } = setup(async (call) => {
    assert.match(call.input.at(-1).content, /Imagem recebida/u);
    assert.match(call.input.at(-1).content, /sem análise visual/u);
    assert.match(call.instructions, /CONTEXTO DO TURNO ATUAL: recebidas 1 imagens/u);
    assert.match(call.instructions, /nome não autorizam visita/u);
    return output("Obrigada pelas fotos! Você já tem algum modelo em mente?", state("collect_photos"), card);
  });
  const reply = await ai.reply(request("", { ...state("collect_photos"), direct: true }, { turnMessages: [
    { id: "name", text: "Sou Ana, tenho um HB20" }, { id: "photo", type: "image", text: "Meu carro é cinza", mediaStored: true },
  ] }));
  assert.equal(reply.source, "ai");
  assert.equal(reply.leadQualification, undefined);
  assert.equal(reply.tradeInEvaluation.step, "collect_photos");
  assert.match(reply.text, /Obrigada pelas fotos/u);
});

test("interesse explícito prevalece sobre anúncio e nome já informado não é repetido", async () => {
  const { ai } = setup(async () => output("", state("visit_requested", "HB20", "customer"), card),
    [{ type: "text", direction: "inbound", body: "Sou Ana. Quero comprar um HB20; meu carro para troca é um Gol" }]);
  const reply = await ai.reply(request("Pode agendar a avaliação", state("visit_requested")));
  assert.equal(reply.source, "ai");
  assert.match(reply.leadQualification.summary, /Interesse declarado: HB20/u);
  assert.doesNotMatch(reply.leadQualification.summary, /Possível interesse/u);
  assert.doesNotMatch(reply.text, /Como posso te chamar/u);
});

test("pergunta de localização durante coleta de fotos não autoriza visita nem ficha", async () => {
  const { ai } = setup(async () => output("Ficamos em Taubaté. Gostaria de solicitar uma avaliação presencial?", state("visit_requested"), card),
    [{ type: "text", direction: "inbound", body: "Sou Ana. Vou enviar fotos do meu HB20" }]);
  const reply = await ai.reply(request("Qual cidade fica essa loja?", state("collect_photos")));
  assert.equal(reply.source, "ai");
  assert.equal(reply.leadQualification, undefined);
  assert.equal(reply.tradeInEvaluation, undefined);
  assert.match(reply.text, /Taubaté/u);
});

test("encerramento de avaliação não duplica promessa nem repete CPF no texto público", async () => {
  let calls = 0;
  const { ai } = setup(async () => output(++calls === 1 ? "Nosso vendedor entrará em contato. CPF 000.000.000-00." : "A loja fica em Taubaté.",
    state("visit_requested"), card), [{ type: "text", direction: "inbound", body: "Sou Ana. Quero fazer uma avaliação presencial." }]);
  const reply = await ai.reply(request("Pode continuar a avaliação", state("visit_requested")));
  assert.equal(calls, 2);
  assert.equal(reply.source, "ai");
  assert.equal((reply.text.match(/entrará em contato/gu) || []).length, 1);
  assert.doesNotMatch(reply.text, /000\.000/u);
  assert.match(reply.text, /^A loja fica em Taubaté/u);
  assert.equal(reply.usage.totalTokens, 40);
});

test("encerramento natural válido da IA é aproveitado sem exigir texto vazio nem duplicar modelo", async () => {
  const text = "Obrigada, Ana! Um de nossos vendedores entrará em contato por aqui para combinar a avaliação do seu HB20.";
  const { ai, factory } = setup(async () => output(text, state("visit_requested"), card),
    [{ type: "text", direction: "inbound", body: "Sou Ana, quero avaliação presencial do meu HB20" }]);
  const reply = await ai.reply(request("Pode continuar a avaliação", state("visit_requested")));
  assert.equal(reply.source, "ai");
  assert.equal(reply.text, text);
  assert.equal(factory.requests.length, 1);
  assert.equal(reply.tradeInEvaluation.step, "completed");
});

test("ficha validada remove pergunta extra mantendo endereço e encerramento natural", async () => {
  const text = "Ficamos na Av. Central, 30, Taubaté. Obrigada, Ana! Um vendedor entrará em contato. Posso ajudar em mais alguma coisa?";
  const { ai, factory } = setup(async () => output(text, state("visit_requested"), card),
    [{ type: "text", direction: "inbound", body: "Sou Ana, quero avaliação presencial do meu HB20" }]);
  const reply = await ai.reply(request("Pode continuar a avaliação", state("visit_requested")));
  assert.equal(reply.source, "ai");
  assert.equal(reply.text, text.replace(" Posso ajudar em mais alguma coisa?", ""));
  assert.equal(factory.requests.length, 1);
  assert.equal(reply.tradeInEvaluation.step, "completed");
});

test("recusa explícita encerra a pendência mesmo quando o modelo omite metadata", async () => {
  const { ai } = setup(async () => output("Tudo bem, podemos falar do Onix.", null),
    [{ type: "text", direction: "inbound", body: "Sou Ana, quero avaliação presencial do meu HB20" }]);
  const reply = await ai.reply(request("Não quero mais a avaliação. Quero saber do Onix.", state("visit_requested")));
  assert.equal(reply.source, "ai");
  assert.equal(reply.leadQualification, undefined);
  assert.equal(reply.tradeInEvaluation.step, "declined");
});
