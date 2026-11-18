import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAiConfigResolver, MemoryAiLedger, MemoryAiSecretResolver, MemoryPricingCatalog,
  MemoryResponsesClientFactory, MultiTenantAiService } from "../src/modules/ai/index.js";
import { acceptsWebsiteAlternativesOffer, websiteGalleriesReply, websiteGalleryReply, websiteGalleryClosing,
  matchesWebsiteGalleryPart, hasWebsiteFinancingConsent } from "../src/modules/business/website-catalog-interaction.js";
import { createWhatsAppReplyPayload } from "../src/modules/whatsapp/outbound.js";

const items = ["ÔNIX JOY", "HB20 SENSE 1.0"].map((name, index) => ({ id: "turim:" + (index + 1), name,
  category: "Hatch", imageUrls: [0, 1].map((photo) => "https://turimautos.com/storage/veiculos/test-" + index + "-" + photo + ".jpg") }));
const catalog = { source: { type: "website_catalog", status: "healthy" }, salesMode: true, items };
const history = [
  { type: "text", direction: "outbound", status: "sent", body: "Gostaria de fazer uma simulação?" },
  { type: "text", direction: "inbound", body: "Tem fotos do HB20 Comfort 2017 manual?" },
  { type: "text", direction: "outbound", status: "sent", body: "Esse modelo não está no estoque. Gostaria que eu confirme com a equipe a disponibilidade de modelos semelhantes para você, ou prefere conhecer outras opções próximas desse perfil?" },
];
const collecting = { status: "collecting", name: null, summary: null, qualification: null };
const response = (catalogAction, productIds, text, leadQualification = collecting) => ({ output_text: JSON.stringify({ text,
  catalogAction, productIds, filters: { category: null, minPrice: null, maxPrice: null }, leadQualification,
  tradeInEvaluation: null }), usage: { input_tokens: 10, output_tokens: 10 } });
function setup(responder, previous = history) {
  const config = { empresaId: "a", enabled: true, provider: "openai", model: "test", prompt: "Atenda o pedido atual, com dados válidos.",
    keyType: "shared", maxOutputTokens: 800, leadQualificationEnabled: true, leadQualificationCriteria: "Nome e dados após aceite.",
    tradeInEvaluationEnabled: true, allowedContextKeys: ["catalog", "tradeInEvaluation"], version: 1 };
  const factory = new MemoryResponsesClientFactory(responder);
  const service = new MultiTenantAiService({ configResolver: new MemoryAiConfigResolver([config]),
    conversationService: { async getHistory() { return previous; } }, clientFactory: factory,
    secretResolver: new MemoryAiSecretResolver({ sharedSecret: "fake" }), ledger: new MemoryAiLedger(),
    pricingCatalog: new MemoryPricingCatalog({ test: { inputPerMillion: 1, outputPerMillion: 1, version: "test" } }),
    timeoutMs: 1000, logger: { warn() {} } });
  return { service, factory };
}
const request = (message, currentCatalog = catalog) => ({ empresaId: "a", conversationId: "chat", messageId: "current",
  correlationId: "c", message, context: { catalog: currentCatalog } });

test("aceite da oferta recente de alternativas vence oferta antiga de simulação, inclusive na segunda tentativa inválida", async () => {
  const { service, factory } = setup(async () => response("finance", [], "Para quais modelos você quer a simulação?"));
  const reply = await service.reply(request("Entendi\nPode sim"));
  assert.equal(reply.source, "ai");
  assert.equal(factory.requests.length, 2);
  assert.match(factory.requests[1].request.instructions, /OFERTA ATUAL ACEITA/u);
  assert.equal(reply.messages.length, 1);
  assert.equal(reply.messages[0].websiteInteraction.step, "list");
  assert.ok(items.every((item) => reply.messages[0].text.includes(item.name)));
  assert.doesNotMatch(reply.messages[0].text, /simulação|CPF|nascimento/u);
  assert.equal(reply.messages[0].imageUrl, undefined);
  assert.equal(reply.leadQualification, undefined);
  assert.equal(reply.usage.totalTokens, 40);
});

test("oferta de alternativas não apaga pedido explícito posterior de simulação", async () => {
  const { service, factory } = setup(async () => response("finance", [items[0].id], "Para a simulação, me informe CPF e data de nascimento, por favor."));
  const reply = await service.reply(request("Quero fazer uma simulação de financiamento do Onix"));
  assert.equal(reply.source, "ai");
  assert.equal(factory.requests.length, 1);
  assert.match(reply.text, /CPF/u);
  assert.equal(reply.websiteInteraction.step, "finance_accepted");
  assert.equal(reply.leadQualification, undefined);
});

test("galeria termina com convite na própria última imagem, incluindo um único arquivo e fotos indisponíveis", () => {
  for (const selected of [items, [{ ...items[0], imageUrls: [items[0].imageUrls[0]] }], [items[0], { ...items[1], imageUrls: [] }]]) {
    const reply = selected.length === 1 ? websiteGalleryReply(selected[0]) : websiteGalleriesReply(selected);
    const payloads = reply.messages.map((part) => createWhatsAppReplyPayload({ to: "test", ...part }));
    assert.equal(payloads.at(-1).type, "image");
    assert.match(payloads.at(-1).image.caption, /simulação/u);
    assert.ok([...payloads.at(-1).image.caption].length <= 1024);
    const part = reply.messages.at(-1), item = selected.find((product) => product.id === part.catalogProductId);
    assert.equal(matchesWebsiteGalleryPart(item, part.catalogPhotoIndex, part), true);
    assert.equal(matchesWebsiteGalleryPart(item, 0, { ...part, text: "Texto arbitrário" }), false);
    assert.equal(payloads.some((payload) => payload.type === "text" && /simulação/u.test(payload.text.body)), false);
  }
  const combined = websiteGalleriesReply(items);
  assert.deepEqual(combined.messages.map((part) => part.imageUrl), items.flatMap((item) => item.imageUrls));
  assert.equal(combined.messages.at(-1).text, websiteGalleryClosing);
  assert.deepEqual(combined.messages.at(-1).websiteInteraction, { step: "gallery", productIds: items.map((item) => item.id) });
  assert.equal(hasWebsiteFinancingConsent(catalog, "Sim, gostei dos dois", items[0].id, [{ role: "assistant", content: websiteGalleryClosing }]), false);
  assert.equal(hasWebsiteFinancingConsent(catalog, "Quero fazer a simulação dos dois", items[0].id, [{ role: "assistant", content: websiteGalleryClosing }]), true);
});

test("aceite de alternativas exige oferta atual e não confunde reconhecimento, recusa ou pedido de fotos", () => {
  const prior = history.map((part) => ({ role: part.direction === "outbound" ? "assistant" : "user", content: part.body }));
  assert.equal(acceptsWebsiteAlternativesOffer("Entendi\nPode sim", prior), true);
  for (const text of ["Entendi", "Não quero", "Tem fotos do Onix?", "Quero simular o financiamento"]) assert.equal(acceptsWebsiteAlternativesOffer(text, prior), false, text);
  assert.equal(acceptsWebsiteAlternativesOffer("Pode sim", [...prior, { role: "assistant", content: "Quer fazer uma simulação?" }]), false);
});

test("ficha de simulação preserva dados e distingue os modelos com fotos do único modelo financiado", async () => {
  const summary = "Ana solicita simulação do Onix. Dados coletados: CPF 000.000.000-00; nascimento 01/01/1990; Taubaté; entrada R$ 10.000; troca de Gol.";
  const { service } = setup(async () => response("finance", [items[0].id], "", { status: "qualified", name: "Ana", summary,
    qualification: "Dados informados para análise de financiamento do Onix. Pediu atendimento sobre troca também." }), []);
  const reply = await service.reply(request("Sou Ana. CPF 000.000.000-00. Nascimento 01/01/1990. Moro em Taubaté; entrada 10 mil e Gol na troca.",
    { ...catalog, photoHistoryProductIds: items.map((item) => item.id), financingSession: { productIds: [items[0].id], status: "pending" } }));
  assert.equal(reply.source, "ai");
  assert.ok(reply.leadQualification.summary.startsWith(summary));
  assert.match(reply.leadQualification.summary, /Últimos modelos com fotos no atendimento: ÔNIX JOY; HB20 SENSE 1.0/u);
  assert.deepEqual(reply.websiteInteraction.productIds, [items[0].id]);
  assert.equal(reply.websiteInteraction.step, "closed");
});

test("dados de financiamento aceito concluem ficha mesmo quando a IA classifica a continuação como none", async () => {
  const card = { status: "qualified", name: "Ana", summary: "Ana forneceu CPF e nascimento para a simulação do Onix que já aceitou.", qualification: "Dados coletados para análise da equipe." };
  const { service } = setup(async () => response("none", [items[0].id], "Recebi os dados e a equipe dará continuidade.", card),
    [{ type: "text", direction: "inbound", body: "Sou Ana, de Taubaté. Quero simular o Onix." },
      { type: "text", direction: "outbound", status: "sent", body: "Por favor, informe seu CPF e data de nascimento." }]);
  const current = { ...catalog, financingSession: { productIds: [items[0].id], status: "pending" }, photoHistoryProductIds: items.map((item) => item.id) };
  const reply = await service.reply(request("000.000.000-00\n01/01/1990", current));
  assert.equal(reply.source, "ai");
  assert.ok(reply.leadQualification);
  assert.equal(reply.websiteInteraction.step, "closed");
  assert.deepEqual(reply.websiteInteraction.productIds, [items[0].id]);
  assert.match(reply.leadQualification.summary, /Últimos modelos com fotos/u);
  assert.match(reply.leadQualification.summary, /CPF informado: 000\.000\.000-00/u);
  assert.match(reply.leadQualification.summary, /01\/01\/1990/u);
  assert.match(reply.leadQualification.summary, /Taubaté/u);
  const unaccepted = await service.reply(request("000.000.000-00\n01/01/1990", catalog));
  assert.equal(unaccepted.leadQualification, undefined);
  const photos = await service.reply({ ...request("", current), turnMessages: [{ id: "photo", type: "image", text: "Sou Ana", mediaStored: true }] });
  assert.equal(photos.leadQualification, undefined);
});

test("troca e localização exigem parágrafos distintos sem criar mensagens extras", async () => {
  const { service } = setup(async (call) => {
    assert.ok(call.text.format.schema.properties.text.pattern);
    const text = "Sim, avaliamos o veículo na troca.\n\nFicamos em Taubaté.\n\nGostaria de solicitar a avaliação?";
    assert.ok(new RegExp(call.text.format.schema.properties.text.pattern, "u").test(text));
    return response("none", [], text);
  }, []);
  const reply = await service.reply(request("Aceita veículo na troca?\nQual cidade fica essa loja?"));
  assert.equal(reply.source, "ai");
  assert.equal(reply.text.split("\n\n").length, 3);
  assert.equal(reply.messages, undefined);
});
