import assert from "node:assert/strict";
import test from "node:test";
import { parseTenantRuntimeConfig } from "../src/modules/runtime/tenant-runtime-config.js";
import { createConfiguredTenantRuntime } from "../src/tenants/configured-runtime.js";
import { createWorkerHandlers } from "../src/modules/jobs/handlers.js";
import { parseCatalogSalesReply } from "../src/modules/business/catalog-sales.js";
import { websiteGalleryReply } from "../src/modules/business/website-catalog-interaction.js";

const item = { id: "turim:66", name: "Carro de teste", description: "Descrição completa do anúncio. ".repeat(180).trim(),
  introduction: "🚗 *Carro de teste*\n\nApresentação do anúncio.", details: "*Equipamentos*\n\n- Câmbio manual\n- Ar-condicionado",
  imageUrls: ["https://turimautos.com/storage/veiculos/test-a.jpg", "https://turimautos.com/storage/veiculos/test-b.jpg"] };
const definition = () => ({ runtime: { empresaId: "tenant", identity: { name: "Teste" }, enabledModules: ["catalog", "ai_freeform"],
  menu: { text: "Menu", options: [] }, catalog: { source: { type: "website_catalog", status: "healthy" }, items: [item] } },
  ai: { enabled: true, prompt: "Responda ao pedido atual", responseDelayEnabled: false }, routing: { fallbackAction: "ai_freeform.reply" } });

test("runtime preserva descrição longa, introdução e detalhes do site sem truncar ou alterar a fonte", async () => {
  const config = parseTenantRuntimeConfig(definition().runtime);
  assert.equal(config.catalog.items[0].description, item.description);
  assert.equal(config.catalog.items[0].introduction, item.introduction);
  assert.equal(config.catalog.items[0].details, item.details);
  const runtime = createConfiguredTenantRuntime({ definition: definition(),
    stateRepository: { async load() { return null; }, async save() {} },
    async aiHandler({ config, input }) {
      const details = input.text.includes("informações");
      return { reply: parseCatalogSalesReply(JSON.stringify({ catalogAction: details ? "details" : "products", productIds: [item.id],
        text: details ? config.catalog.items[0].details : "", filters: { category: null, minPrice: null, maxPrice: null } }), config.catalog, { message: input.text }) };
    },
  });
  const photos = await runtime.handle({ conversationId: "chat", type: "text", text: "Me envie as fotos desse carro" });
  assert.equal(photos.messages[0].text, item.introduction);
  assert.match(photos.messages.at(-1).text, /simulação/u);
  const details = await runtime.handle({ conversationId: "chat", type: "text", text: "Quero mais informações" });
  assert.equal(details.text, item.details);
  assert.equal(details.messages, undefined);
});

test("limite do site é finito e não amplia descrições de outras fontes nem de eventos", () => {
  for (const key of ["description", "introduction", "details"]) {
    const input = structuredClone(definition().runtime);
    input.catalog.items[0][key] = "x".repeat(24_001);
    assert.throws(() => parseTenantRuntimeConfig(input), new RegExp(key + " excede 24000"));
  }
  const ordinary = structuredClone(definition().runtime);
  ordinary.catalog.source.type = "google_sheets";
  assert.throws(() => parseTenantRuntimeConfig(ordinary), /description excede/u);
  const events = { ...definition().runtime, catalog: { items: [] }, events: { items: [{ id: "event", name: "Evento", startsAt: "2026-11-18", price: 0, description: "x".repeat(501) }] } };
  assert.throws(() => parseTenantRuntimeConfig(events), /description excede 500/u);
});

test("worker recebe mensagem, constrói runtime com catálogo longo e prepara as fotos com a introdução preservada", async () => {
  const message = { id: "in", conversationId: "chat", contactId: "contact", numeroWhatsappId: "number", senderPhone: "5511000000001",
    type: "text", text: "Quero as fotos do Carro de teste", correlationId: "correlation" };
  let prepared, calls = 0;
  const sent = [];
  const handler = createWorkerHandlers({
    repository: {
      async inboundMessage() { return message; }, async statusEvent() {}, async preparedReply() { return prepared; }, async catalogBrowseState() { return null; },
      async prepareReply({ reply }) { prepared = { id: "0", status: "processando", text: reply.text,
        messages: reply.messages.map((part, index) => ({ ...part, id: String(index), status: "processando" })) }; return prepared; },
      async markReplySent({ replyId, externalMessageId }) { prepared.messages.find(part => part.id === replyId).externalMessageId = externalMessageId; },
      async canSendBotReply() { return true; },
    },
    conversationService: { async getConversation() { return { mode: "bot" }; }, async getState() { return { data: {} }; },
      async saveState() {}, async recordMessage() {}, async applyMetaStatus() {} },
    tenantDefinitionRepository: { async load() { return definition(); } },
    aiService: { async reply(input) { calls++; assert.equal(input.context.catalog.items[0].description, item.description);
      assert.equal(input.context.catalog.items[0].introduction, item.introduction); return { source: "ai", ...websiteGalleryReply(input.context.catalog.items[0]) }; } },
    metaGateway: { async sendReply(_scope, part) { sent.push(part); return { messages: [{ id: `synthetic-${sent.length}` }] }; } },
    aiReplyDelayMs: () => 0, logger: { info() {}, warn() {} },
  }).process_inbound_message;
  const result = await handler({ empresaId: "tenant", messageId: message.id, conversationId: message.conversationId });
  assert.equal(result.replied, true);
  assert.equal(calls, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].text, item.introduction);
  assert.match(sent.at(-1).text, /simulação/u);
});
