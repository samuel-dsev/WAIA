import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAiConfigResolver, MemoryAiLedger, MemoryAiSecretResolver, MemoryPricingCatalog,
  MemoryResponsesClientFactory, MultiTenantAiService } from "../src/modules/ai/index.js";
import { compileTenantRuntimeConfigV2, materializeLegacyTenantDefinition, verifyCompiledTenantRuntimeConfigV2 } from "../src/modules/configuration/index.js";
import { createConfiguredTenantRuntime } from "../src/tenants/configured-runtime.js";
import { appendCustomerServiceData, parseCustomerService } from "../src/modules/business/contextual-vehicle-service.js";
import { parseCatalogSalesReply } from "../src/modules/business/catalog-sales.js";
import { matchesWebsiteGalleryPart, websiteCatalogListText } from "../src/modules/business/website-catalog-interaction.js";
import { replyFromRow, websiteListFormatMetadata } from "../src/modules/jobs/reply-batch.js";
import { notificationText } from "../src/modules/group-notifier/qualification.js";

const noDownPayment = { status: "not_informed", amount: null, evidence: null };
const noWarranty = { status: "none", requestEvidence: null, offerEvidence: null, consentEvidence: null };
const collecting = { status: "collecting", name: null, summary: null, qualification: null };
const lead = { status: "qualified", name: "Ana Teste", summary: "Nome: Ana Teste. Interesse declarado: Onix Joy. Pediu fotos e simulação, com dados já informados.", qualification: "Solicitou simulação e forneceu os dados necessários." };
const item = { id: "turim:1", name: "Onix Joy", price: 55900, mileageKm: 73000, year: 2019,
  imageUrl: "https://example.test/onix1.jpg", imageUrls: ["https://example.test/onix1.jpg", "https://example.test/onix2.jpg"],
  introduction: "🚗 *ONIX JOY*\n\nUma opção para o dia a dia.", description: "Carro flex." };
const catalog = { source: { type: "website_catalog", status: "healthy" }, salesMode: true, items: [item],
  photoHistoryProductIds: [item.id], financingSession: { productIds: [item.id], status: "pending" } };
const response = (text, { downPayment = noDownPayment, warranty = noWarranty, qualification = collecting, action = "none", ids = [], evaluation } = {}) => ({
  output_text: JSON.stringify({ text, catalogAction: action, productIds: ids, filters: { category: null, minPrice: null, maxPrice: null },
    leadQualification: qualification, customerService: { downPayment, warranty }, ...(evaluation === undefined ? {} : { tradeInEvaluation: evaluation }) }), usage: { input_tokens: 10, output_tokens: 10 },
});
function service(responder, history = [], overrides = {}) {
  const factory = new MemoryResponsesClientFactory(responder);
  const ai = new MultiTenantAiService({
    configResolver: new MemoryAiConfigResolver([{ empresaId: "test", enabled: true, provider: "openai", model: "test", keyType: "shared",
      prompt: "Financiamento em até 60 parcelas, entrada em até 24x no cartão. Laudo aprovado e até um ano pela Gestauto, somente se perguntado.",
      contextualServiceEnabled: true, leadQualificationEnabled: true, leadQualificationCriteria: "Nome e dados de financiamento OU nome e contato sobre garantia aceito.",
      leadQualificationClosing: "ENCERRAMENTO ANTIGO QUE NÃO DEVE SER ENVIADO", allowedContextKeys: ["catalog", "tradeInEvaluation"], version: 2, maxOutputTokens: 1200, ...overrides }]),
    conversationService: { async getHistory() { return history; } }, clientFactory: factory,
    secretResolver: new MemoryAiSecretResolver({ sharedSecret: "fake" }), ledger: new MemoryAiLedger(),
    pricingCatalog: new MemoryPricingCatalog({ test: { inputPerMillion: 1, outputPerMillion: 1, version: "test" } }), logger: { warn() {}, info() {} },
  });
  return { ai, factory };
}
const request = (message, extra = {}) => ({ empresaId: "test", conversationId: "chat", correlationId: "c", messageId: "current", message,
  context: { catalog }, ...extra });
const history = (role, body) => ({ type: "text", direction: role === "user" ? "inbound" : "outbound", status: "sent", body });

test("modo contextual atravessa compilação e envia saudações, aliases, menu e escolhas para IA", async () => {
  const cfg = { schemaVersion: 2, identity: { name: "Loja fictícia" }, modules: ["catalog", "human_handoff", "ai_freeform"],
    menu: { text: "SAUDAÇÃO AUTOMÁTICA ANTIGA", options: [{ id: "endereco", label: "Endereço", action: "catalog.address" }] },
    routing: { greetings: ["oi"], aliases: [{ terms: ["troca", "endereço"], action: "catalog.address" }] },
    publicReplies: [{ action: "catalog.address", text: "ENDEREÇO AUTOMÁTICO ANTIGO" }],
    humanHandoff: { message: "Aguarde" }, ai: { enabled: true, provider: "simulated", model: "test", keyMode: "simulated", prompt: "Responda contextualmente", contextualServiceEnabled: true } };
  const compiled = compileTenantRuntimeConfigV2(cfg, { empresaId: "test", configVersion: 1 });
  assert.equal(verifyCompiledTenantRuntimeConfigV2(compiled), true);
  const definition = materializeLegacyTenantDefinition(compiled);
  assert.equal(definition.ai.contextualServiceEnabled, true);
  let calls = 0, paused = false;
  const runtime = createConfiguredTenantRuntime({ definition,
    stateRepository: { async load() { return paused ? { module: "human_handoff", step: "waiting_operator", data: {} } : null; }, async save() {} },
    aiHandler: async () => { calls++; return { reply: { text: "Resposta contextual conforme o pedido." } }; } });
  for (const input of [{ text: "oi" }, { text: "Aceita troca?" }, { text: "Endereço" }, { text: "até 60 mil" },
    { text: "endereco", selectionId: "endereco", type: "interactive" }]) {
    const reply = await runtime.handle({ conversationId: "chat", ...input });
    assert.equal(reply.module, "ai_freeform"); assert.equal(reply.text, "Resposta contextual conforme o pedido.");
  }
  assert.equal(calls, 5);
  const empty = await runtime.handle({ conversationId: "chat", type: "system", text: "" });
  assert.equal(empty.code, "NO_CUSTOMER_CONTENT"); assert.equal(empty.text, ""); assert.equal(calls, 5);
  paused = true;
  await runtime.handle({ conversationId: "chat", text: "oi" });
  assert.equal(calls, 5, "Pausa humana ainda impede inferência.");
  assert.throws(() => compileTenantRuntimeConfigV2({ ...cfg, modules: ["catalog"], ai: { ...cfg.ai, enabled: false } },
    { empresaId: "test", configVersion: 2 }));
});

test("ficha distingue entrada omitida, sem entrada e valor literal; não confunde negativa com cancelar simulação", async () => {
  for (const [message, downPayment, expected] of [
    ["Sou Ana Teste. CPF: 000.000.000-00. Nascimento: 01/01/1990. Moro em Taubaté.", noDownPayment, "Cliente não informou sobre valores de entrada"],
    ["Sou Ana Teste. Não vou dar entrada.", { status: "none", amount: null, evidence: "Não vou dar entrada." }, "Sem valor de entrada"],
    ["Sou Ana Teste. Pretendo dar 10 mil de entrada.", { status: "amount", amount: "10 mil", evidence: "Pretendo dar 10 mil de entrada." }, "Valor de entrada: 10 mil"],
    ["Sou Ana Teste. Minha entrada será de dez mil reais.", { status: "amount", amount: "dez mil reais", evidence: "Minha entrada será de dez mil reais." }, "Valor de entrada: dez mil reais"],
  ]) {
    const closing = "Obrigada, Ana! Um vendedor retornará sobre a simulação do Onix.";
    const { ai, factory } = service(async (call) => {
      assert.ok(call.text.format.schema.properties.customerService);
      assert.match(call.instructions, /é opcional|que é opcional/u);
      return response(closing, { downPayment, qualification: lead, action: "finance", ids: [item.id] });
    });
    const result = await ai.reply(request(message));
    assert.equal(result.source, "ai"); assert.equal(result.text, closing); assert.equal(factory.requests.length, 1);
    assert.ok(result.leadQualification.summary.includes(expected));
    assert.match(result.leadQualification.summary, /Últimos modelos com fotos no atendimento: Onix Joy/u);
    assert.equal(result.websiteInteraction.step, "closed");
    const cardText = notificationText({ companyName: "Loja fictícia", phone: "5511000000001", ...result.leadQualification });
    assert.ok(cardText.includes(expected));
    if (downPayment.status === "not_informed") {
      assert.match(cardText, /CPF informado: 000\.000\.000-00/u);
      assert.match(cardText, /Data de nascimento informada: 01\/01\/1990/u);
      assert.match(cardText, /Taubaté/u);
    }
    assert.doesNotMatch(result.text, /CPF|nascimento|ENCERRAMENTO ANTIGO/u);
  }
});

test("dúvida de garantia oferece contato e só o aceite correspondente permite ficha sem financiar", async () => {
  const question = "O que a garantia de um ano cobre?";
  const offer = "Não tenho os detalhes da cobertura da garantia. Quer que um vendedor entre em contato para explicar?";
  const offered = { status: "offered", requestEvidence: question, offerEvidence: null, consentEvidence: null };
  const first = service(async () => response(offer, { warranty: offered }));
  const reply = await first.ai.reply(request(question));
  assert.equal(reply.source, "ai"); assert.equal(reply.text, offer); assert.equal(reply.leadQualification, undefined);
  const accepted = { status: "accepted", requestEvidence: question, offerEvidence: offer, consentEvidence: "Pode pedir pra ele me explicar sim" };
  const known = [history("user", question), history("assistant", offer), history("user", "Pode pedir pra ele me explicar sim"), history("assistant", "Como posso te chamar?")];
  const closing = "Obrigada, Ana! Um vendedor retornará para esclarecer a cobertura da garantia.";
  const second = service(async () => response(closing, { warranty: accepted, qualification: lead }), known);
  const result = await second.ai.reply(request("Ana Teste"));
  assert.equal(result.source, "ai"); assert.equal(result.text, closing);
  assert.match(result.leadQualification.summary, /cliente aguarda retorno de um vendedor com informações sobre a cobertura da garantia/u);
  assert.match(result.leadQualification.qualification, /aguarda esclarecimentos/u);
  assert.equal(result.websiteInteraction, undefined, "Encaminhamento de garantia não conclui a simulação pendente.");
  assert.doesNotMatch(result.text, /CPF|nascimento|entrada/u);
});

test("pedido direto de vendedor sobre garantia aproveita nome e possível interesse do anúncio", async () => {
  const message = "Sou Ana Teste e quero falar com um vendedor sobre o que a garantia cobre.";
  const { ai } = service(async () => response("Obrigada, Ana! Um vendedor retornará sobre a cobertura.", {
    warranty: { status: "accepted", requestEvidence: message, offerEvidence: null, consentEvidence: message },
    qualification: { ...lead, summary: "Cliente Ana Teste deseja esclarecimentos da cobertura antes de escolher um veículo." },
  }));
  const result = await ai.reply(request(message, { context: { catalog: { ...catalog, adContext: { match: "unique", productId: item.id } } } }));
  assert.equal(result.source, "ai"); assert.match(result.leadQualification.summary, /Possível interesse: Onix Joy/u);
});

test("troca de assunto durante simulação responde ao pedido e não encerra nem impõe coleta", async () => {
  const message = "Antes da simulação, o que a garantia cobre?";
  const text = "Não tenho os detalhes da cobertura. Quer conversar com um vendedor sobre a garantia?";
  const { ai } = service(async () => response(text, {
    warranty: { status: "offered", requestEvidence: message, offerEvidence: null, consentEvidence: null },
  }), [history("user", "Sou Ana Teste, quero simular o Onix."), history("assistant", "Informe CPF e nascimento, por favor.")]);
  const result = await ai.reply(request(message));
  assert.equal(result.text, text); assert.equal(result.leadQualification, undefined); assert.equal(result.websiteInteraction, undefined);
});

test("evidências da atendente, anúncios, citações e aceite de outra oferta não autorizam dados nem ficha", () => {
  for (const transcript of [[{ role: "assistant", content: "Entrada 10 mil" }],
    [{ role: "user", content: "Pode ser\n[Em resposta à mensagem: Entrada 10 mil]" }]]) {
    assert.throws(() => parseCustomerService({ downPayment: { status: "amount", amount: "10 mil", evidence: "Entrada 10 mil" }, warranty: noWarranty }, transcript), { code: "AI_INVALID_CUSTOMER_SERVICE" });
  }
  assert.throws(() => parseCustomerService({ downPayment: noDownPayment,
    warranty: { status: "accepted", requestEvidence: "E a garantia?", offerEvidence: "Posso enviar fotos do Onix?", consentEvidence: "sim" } },
  [{ role: "user", content: "E a garantia?" }, { role: "assistant", content: "Posso enviar fotos do Onix?" }, { role: "user", content: "sim" }]), { code: "AI_INVALID_CUSTOMER_SERVICE" });
  const card = appendCustomerServiceData(lead, { downPayment: noDownPayment, warrantyAccepted: true }, { possibleInterest: "HB20" });
  assert.doesNotMatch(card.summary, /Possível interesse: HB20/u, "Escolha explícita prevalece sobre anúncio.");
});

test("dado sem evidência é reavaliado antes de responder; garantia sem aceite nunca gera ficha", async () => {
  let calls = 0;
  const { ai } = service(async () => response("Obrigada, Ana! Um vendedor retornará sobre a simulação.", {
    downPayment: ++calls === 1 ? { status: "amount", amount: "20 mil", evidence: "Vou dar 20 mil de entrada" } : noDownPayment,
    action: "finance", ids: [item.id], qualification: lead,
  }));
  const corrected = await ai.reply(request("Sou Ana Teste"));
  assert.equal(corrected.source, "ai"); assert.equal(calls, 2);
  assert.match(corrected.leadQualification.summary, /Cliente não informou sobre valores de entrada/u);
  assert.doesNotMatch(corrected.leadQualification.summary, /20 mil/u);
  const invalid = service(async () => response("Um vendedor retornará sobre a garantia.", { qualification: lead }));
  const blocked = await invalid.ai.reply(request("Sou Ana Teste. O que a garantia cobre?"));
  assert.equal(blocked.source, "fallback"); assert.equal(blocked.leadQualification, undefined);
  assert.doesNotMatch(blocked.text, /principal ponto|mais alguma informação|Para quais modelos/u);
});

test("IA escreve continuidade da lista e última foto; dados do catálogo continuam conferidos", () => {
  const options = { contextualServiceEnabled: true, leadQualificationEnabled: true, message: "Mostre os modelos" };
  const text = "Qual dessas opções combina mais com o que você procura?";
  const output = (action, ids) => JSON.stringify({ text, catalogAction: action, productIds: ids, filters: { category: null, minPrice: null, maxPrice: null } });
  const list = parseCatalogSalesReply(output("browse", []), catalog, options);
  const part = list.messages[0];
  assert.equal(part.catalogListFormatVersion, 3); assert.equal(part.catalogContinuation, text);
  assert.equal(part.text, websiteCatalogListText([item], { formatVersion: 3, continuation: text }));
  assert.match(part.text, /73\.000 km - 2019/u); assert.doesNotMatch(part.text, /Gostou de algum\?/u);
  const hydrated = replyFromRow({ corpo: part.text, outbound_payload: part });
  assert.equal(hydrated.catalogContinuation, text); assert.equal(hydrated.catalogListFormatVersion, 3);
  assert.throws(() => websiteListFormatMetadata({ ...part, catalogContinuation: undefined }), { code: "BOT_REPLY_BATCH_INVALID" });
  const gallery = parseCatalogSalesReply(output("products", [item.id]), catalog, { ...options, message: "Envie fotos do Onix" });
  assert.equal(gallery.messages.length, 2);
  assert.equal(gallery.messages[0].text, item.introduction);
  assert.equal(gallery.messages[0].catalogContinuation, undefined);
  assert.equal(gallery.messages[1].text, text); assert.equal(gallery.messages[1].catalogContinuation, text);
  assert.ok(matchesWebsiteGalleryPart(item, 1, gallery.messages[1]));
  assert.equal(matchesWebsiteGalleryPart(item, 0, { ...gallery.messages[0], catalogContinuation: text }), false);
  assert.equal(matchesWebsiteGalleryPart(item, 1, { ...gallery.messages[1], text: "Alterado" }), false);
  assert.deepEqual(websiteListFormatMetadata(gallery.messages[1]), { catalogContinuation: text });
  const choice = parseCatalogSalesReply(output("choose", [item.id]), catalog, options);
  assert.equal(choice.text, text); assert.equal(choice.messages, undefined);
  assert.throws(() => parseCatalogSalesReply(output("choose", []), catalog, options), { code: "AI_INVALID_CATALOG_SELECTION" });
  const clarification = parseCatalogSalesReply(output("none", []), { ...catalog,
    items: [item, { ...item, id: "turim:2", name: "Tracker" }], interaction: { step: "gallery", productIds: [item.id, "turim:2"], direct: true } },
  { ...options, message: "Qual ano dele?" });
  assert.equal(clarification.text, text, "Pergunta da IA não é substituída pela frase de esclarecimento cadastrada.");
  const other = { ...item, id: "turim:2", name: "Tracker", introduction: "🚗 *TRACKER*" };
  const two = parseCatalogSalesReply(output("products", [item.id, other.id]), { ...catalog, items: [item, other] }, { ...options, message: "Fotos dos dois" });
  assert.equal(two.messages.length, 4);
  assert.equal(two.messages[1].catalogContinuation, undefined);
  assert.equal(two.messages.at(-1).catalogContinuation, text);
  assert.deepEqual(two.messages.at(-1).websiteInteraction.productIds, [item.id, other.id]);
});

test("endereço e escolha recebem texto e oferta de fotos; galeria exige pedido ou aceite atual", async () => {
  let calls = 0;
  const text = "Ficamos na Av. Central, 30, Taubaté.\n\nExcelente escolha no Onix! Posso te enviar mais algumas fotos dele?";
  const initial = service(async () => ++calls === 1 ? response("Quer simular?", { action: "products", ids: [item.id] })
    : response(text, { action: "choose", ids: [item.id] }));
  const reply = await initial.ai.reply(request("Qual o endereço?\nGostei do Onix"));
  assert.equal(calls, 2); assert.equal(reply.text, text); assert.equal(reply.messages, undefined);
  const accepted = service(async () => response("Você gostaria de fazer uma simulação do financiamento?", { action: "products", ids: [item.id] }), [history("assistant", text)]);
  const photos = await accepted.ai.reply(request("Pode sim"));
  assert.equal(photos.messages.length, 2); assert.match(photos.messages.at(-1).text, /simulação/u);
  const declined = service(async () => response("Posso ajudar em mais alguma coisa?"), [history("assistant", text)]);
  const refusal = await declined.ai.reply(request("Não quero fotos agora"));
  assert.equal(refusal.messages, undefined); assert.equal(refusal.text, "Posso ajudar em mais alguma coisa?");
  const questionOnly = service(async () => response("Posso enviar fotos?", { action: "products", ids: [item.id] }), [history("assistant", text)]);
  assert.equal((await questionOnly.ai.reply(request("Qual o endereço?"))).source, "fallback");
});

test("avaliação por fotos reconhece recebimento, pede só nome e conclui após nome sem nova etapa", async () => {
  const evaluation = { step: "photos_received", interestName: null, interestSource: "unknown" };
  const config = { tradeInEvaluationEnabled: true, leadImageHandoffEnabled: true, leadQualificationCriteria: "Nome e fotos de avaliação recebidas." };
  const context = { catalog, tradeInEvaluation: { session: { step: "collect_photos", interestName: null, interestSource: "unknown", direct: true } } };
  const first = service(async (call) => {
    assert.match(call.instructions, /MODELO DE MENSAGEM/u);
    assert.match(call.instructions, /somente quando necessário|somente quando o contexto exigir/u);
    return response("Recebi as fotos do veículo. Para finalizar, como posso te chamar?", { evaluation });
  }, [], config);
  const reply = await first.ai.reply(request("", { context, turnMessages: [{ id: "image-1", type: "image", text: "", mediaStored: true }] }));
  assert.equal(reply.source, "ai"); assert.equal(reply.leadQualification, undefined);
  assert.equal(reply.tradeInEvaluation.step, "photos_received"); assert.match(reply.text, /Recebi as fotos/u);
  const closing = "Obrigado pelas informações, logo um de nossos vendedores vai entrar em contato com o retorno da avaliação e dará continuidade no seu atendimento.";
  const second = service(async () => response(closing, { evaluation, qualification: { ...lead,
    summary: "Ana Teste enviou imagens para avaliação do veículo de troca.", qualification: "Necessita retorno sobre avaliação por fotos." } }),
  [{ id: "image-1", type: "image", direction: "inbound", body: "", mediaStorageKey: "test/photo" }, history("assistant", reply.text)], config);
  const result = await second.ai.reply(request("Ana Teste", { context: { ...context, tradeInEvaluation: { session: { ...evaluation, direct: true } } } }));
  assert.equal(result.source, "ai"); assert.equal(result.text, closing); assert.equal(result.tradeInEvaluation.step, "completed");
  assert.match(result.leadQualification.summary, /Imagens recebidas do cliente: 1/u);
  assert.doesNotMatch(result.text, /CPF|modelo|visita/u);
  const missing = service(async () => response(closing, { evaluation, qualification: lead }), [], config);
  const rejected = await missing.ai.reply(request("Ana Teste", { context }));
  assert.equal(rejected.source, "fallback"); assert.equal(rejected.leadQualification, undefined);
});
