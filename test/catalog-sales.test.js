import test from "node:test";
import assert from "node:assert/strict";
import { catalogSalesFormat, parseCatalogSalesReply, normalizeCatalogBrowseState } from "../src/modules/business/catalog-sales.js";
import { createWorkerHandlers } from "../src/modules/jobs/handlers.js";
import { loadCatalogBrowseState } from "../src/modules/jobs/reply-batch.js";

const filters = (extra = {}) => ({ category: null, minPrice: null, maxPrice: null, ...extra });
const products = Array.from({ length: 8 }, (_, i) => ({ id: `p${i + 1}`, name: i === 0 ? "Harley" : `Modelo ${i + 1}`, price: (i + 1) * 1000,
  category: "MOTO ELÉTRICA", autonomyKm: 50, units: [i % 2 ? "Outra cidade" : "Taubaté"], description: "Bateria de lítio.", imageUrl: `https://example.com/${i + 1}.jpg` }));
const catalog = (extra = {}) => ({ items: structuredClone(products), source: { type: "google_sheets", status: "healthy" }, salesMode: true, ...extra });
const output = (extra = {}) => JSON.stringify({ text: "", productIds: [], catalogAction: "browse", filters: filters(), ...extra });
const cards = (reply) => reply.messages?.filter((part) => part.catalogProductId) || [];

test("pedido geral envia abertura, primeiros três produtos na ordem da planilha e pergunta separada", () => {
  const reply = parseCatalogSalesReply(output({ productIds: ["p8"], text: "Vou mandar três depois" }), catalog());
  assert.deepEqual(cards(reply).map((part) => part.catalogProductId), ["p1", "p2", "p3"]);
  assert.equal(reply.messages.length, 5);
  assert.match(reply.messages[0].text, /Vou te enviar/u);
  assert.equal(reply.messages[0].imageUrl, undefined);
  assert.match(reply.messages.at(-1).text, /interessou[\s\S]*mais opções\?$/u);
  assert.equal(reply.messages.at(-1).imageUrl, undefined);
  assert.doesNotMatch(cards(reply)[0].text, /mais opções/u);
  assert.deepEqual(reply.catalogBrowse.priorSeenProductIds, []);
  assert.doesNotMatch(parseCatalogSalesReply(output({ text: "Qual a sua cidade?" }), catalog()).messages.at(-1).text, /cidade/u);
});

test("mais opções percorre 3, 3, 2 e esgota sem repetir; novas fichas ficam disponíveis", () => {
  let data = catalog(), seen = [];
  for (const expected of [["p1", "p2", "p3"], ["p4", "p5", "p6"], ["p7", "p8"]]) {
    const reply = parseCatalogSalesReply(output({ catalogAction: seen.length ? "more" : "browse" }), data);
    assert.deepEqual(cards(reply).map((part) => part.catalogProductId), expected);
    seen = [...seen, ...expected]; data.browseState = { filters: filters(), seenProductIds: seen };
  }
  const exhausted = parseCatalogSalesReply(output({ catalogAction: "more" }), data);
  assert.equal(exhausted.messages, undefined);
  assert.match(exhausted.text, /todas as opções/u);
  data.items.push({ ...products[0], id: "new", name: "Novo modelo" });
  assert.deepEqual(cards(parseCatalogSalesReply(output({ catalogAction: "more" }), data)).map((part) => part.catalogProductId), ["new"]);
});

test("faixa de preço e categoria usam dados atuais, preservam filtros e excluem indisponíveis", () => {
  const data = catalog();
  data.items[2].category = "SCOOTER"; data.items[3].active = false; data.items[4].availability = "unavailable";
  data.items[6].price = undefined;
  const query = filters({ category: "MOTO ELÉTRICA", minPrice: 2000, maxPrice: 6000 });
  const reply = parseCatalogSalesReply(output({ filters: query }), data);
  assert.deepEqual(cards(reply).map((part) => part.catalogProductId), ["p2", "p6"]);
  data.browseState = { filters: query, seenProductIds: ["p2", "p6"] };
  assert.match(parseCatalogSalesReply(output({ catalogAction: "more", filters: filters({ maxPrice: 99999 }) }), data).text, /todas as opções/u);
  assert.match(parseCatalogSalesReply(output({ filters: filters({ maxPrice: 500 }) }), data).text, /Não encontrei modelos/u);
  assert.deepEqual(cards(parseCatalogSalesReply(output({ filters: filters({ minPrice: 1000, maxPrice: 1000 }) }), data)).map((part) => part.catalogProductId), ["p1"]);
});

test("modelo específico vai direto à ficha; pergunta técnica é texto sem reenviar imagem", () => {
  const reply = parseCatalogSalesReply(output({ catalogAction: "products", productIds: ["p1"] }), catalog());
  assert.equal(reply.messages.length, 2);
  assert.equal(reply.messages[0].imageUrl, products[0].imageUrl);
  assert.match(reply.messages.at(-1).text, /esse modelo[\s\S]*mais opções\?$/u);
  const technical = "A Harley tem autonomia informada de até 50 km por recarga e bateria de lítio. A autonomia real varia conforme o uso.";
  assert.deepEqual(parseCatalogSalesReply(output({ catalogAction: "details", productIds: ["p1"], text: technical }), catalog()), { text: technical });
  assert.deepEqual(parseCatalogSalesReply(output({ catalogAction: "products", productIds: [], text: "Qual modelo você quer conhecer?" }), catalog()), { text: "Qual modelo você quer conhecer?" });
});

test("reconhecer interesse não exige cidade; saudação e encerramento sem fichas ficam livres", () => {
  const reply = parseCatalogSalesReply(output({ catalogAction: "none", text: "Você já tem algum modelo em mente?" }), catalog());
  assert.equal(reply.messages, undefined);
  assert.equal(reply.text, "Você já tem algum modelo em mente?");
  assert.deepEqual(parseCatalogSalesReply(output({ catalogAction: "none", text: "A equipe pode continuar seu atendimento por aqui." }), catalog()), { text: "A equipe pode continuar seu atendimento por aqui." });
});

test("gostei da Harley não repete a ficha mesmo quando a IA classifica como products", () => {
  const data = catalog({ browseState: { filters: filters({ maxPrice: 5000 }), seenProductIds: ["p1", "p2", "p3"] } });
  const reply = parseCatalogSalesReply(output({ catalogAction: "products", productIds: ["p1"] }), data);
  assert.equal(reply.messages, undefined);
  assert.match(reply.text, /Sobre Harley[\s\S]*saber para decidir\?$/u);
  assert.deepEqual(cards(parseCatalogSalesReply(output({ catalogAction: "products", productIds: ["p1", "p4"] }), data)).map((part) => part.catalogProductId), ["p4"]);
});

test("novo pedido de catálogo reinicia pelos três primeiros, separado do avanço anterior", () => {
  const data = catalog({ browseState: { filters: filters({ maxPrice: 3000 }), seenProductIds: ["p1", "p3"], presentedProductIds: ["p1", "p3"] } });
  const reply = parseCatalogSalesReply(output({ filters: filters({ maxPrice: 6000 }) }), data);
  assert.deepEqual(cards(reply).map((part) => part.catalogProductId), ["p1", "p2", "p3"]);
  assert.deepEqual(reply.catalogBrowse.priorSeenProductIds, []);
  assert.equal(reply.messages.length, 5);
  data.browseState = { filters: reply.catalogBrowse.filters, seenProductIds: ["p1", "p2", "p3"], presentedProductIds: ["p1", "p2", "p3"] };
  assert.deepEqual(cards(parseCatalogSalesReply(output({ catalogAction: "more" }), data)).map((part) => part.catalogProductId), ["p4", "p5", "p6"]);
  data.browseState.seenProductIds = products.map((part) => part.id);
  assert.deepEqual(cards(parseCatalogSalesReply(output(), data)).map((part) => part.catalogProductId), ["p1", "p2", "p3"]);
});

test("escolha de modelo apresentado em outra consulta não repete a foto", () => {
  const data = catalog({ browseState: { filters: filters(), seenProductIds: ["p4"], presentedProductIds: ["p1", "p4"] } });
  const reply = parseCatalogSalesReply(output({ catalogAction: "products", productIds: ["p1"] }), data);
  assert.equal(reply.messages, undefined);
  assert.match(reply.text, /Sobre Harley/u);
  const technical = parseCatalogSalesReply(output({ catalogAction: "details", productIds: ["p1"], text: "A Harley tem autonomia informada de 50 km." }), data);
  assert.equal(technical.messages, undefined);
  assert.match(technical.text, /50 km/u);
});

test("contrato estrito recusa IDs estrangeiros, duplicados, categorias e faixas inválidas", () => {
  for (const extra of [{ productIds: ["foreign"] }, { productIds: ["p1", "p1"] }, { catalogAction: "unknown" },
    { filters: filters({ category: "foreign" }) }, { filters: filters({ minPrice: -1 }) }, { filters: filters({ minPrice: 6000, maxPrice: 2000 }) },
    { text: "x".repeat(4097) }, { injected: true }, { catalogAction: "none", text: "Olá", productIds: ["p1"] }, { catalogAction: "details", text: "50 km", filters: filters({ maxPrice: 5000 }) }]) {
    assert.throws(() => parseCatalogSalesReply(output(extra), catalog()), { code: "AI_INVALID_CATALOG_SELECTION" });
  }
  assert.throws(() => parseCatalogSalesReply("invalid JSON", catalog()));
  assert.equal(catalogSalesFormat(catalog({ source: { type: "google_sheets", status: "unavailable" } })), null);
  assert.equal(catalogSalesFormat(catalog({ items: [] })), null);
  assert.deepEqual(catalogSalesFormat(catalog()).schema.properties.productIds.items.enum, products.map((item) => item.id));
  assert.throws(() => normalizeCatalogBrowseState({ filters: filters(), seenProductIds: Array(101).fill("p1") }));
  assert.throws(() => normalizeCatalogBrowseState({ filters: filters(), seenProductIds: [], presentedProductIds: Array(101).fill("p1") }));
});

test("cursor inclui só partes de produto confirmadas, mantém escopo e não depende da janela de histórico", async () => {
  const parentId = "00000000-0000-0000-0000-000000000001", partId = "00000000-0000-0000-0000-000000000002", unsentId = "00000000-0000-0000-0000-000000000003";
  const parent = { id: parentId, corpo: "Abertura", status: "enviada", external_message_id: "sent-intro", outbound_payload: {
    catalogBrowse: { filters: filters({ maxPrice: 5000 }), priorSeenProductIds: ["older"] }, partIds: [parentId, partId, unsentId] } };
  const rows = [parent, { id: partId, status: "entregue", external_message_id: "sent-photo", outbound_payload: { parentReplyId: parentId, catalogProductId: "p1" } },
    { id: unsentId, status: "ignorada_duplicidade", external_message_id: null, outbound_payload: { parentReplyId: parentId, catalogProductId: "p2" } }];
  const client = { async query(sql, params) {
    assert.equal(params[0], "tenant-a");
    if (sql.includes("GROUP BY")) {
      assert.equal(params[1], "conv-a");
      assert.match(sql, /redacted_at IS NULL AND external_message_id IS NOT NULL/u);
      assert.match(sql, /status IN \('enviada','entregue','lida'\)/u);
      return { rows: [{ catalog_product_id: "earlier-filter" }, { catalog_product_id: "p1" }] };
    }
    return { rows: sql.includes("ORDER BY sequence DESC") ? (assert.equal(params[1], "conv-a"), [parent]) : rows };
  } };
  assert.deepEqual(await loadCatalogBrowseState(client, "tenant-a", "conv-a"), { filters: filters({ maxPrice: 5000 }), seenProductIds: ["p1"], presentedProductIds: ["earlier-filter", "p1"] });
  assert.equal(await loadCatalogBrowseState({ async query() { return { rows: [] }; } }, "tenant-b", "conv-a"), null);
});

test("worker propaga modo comercial, paginação e metadados até o checkpoint e envia em ordem", async () => {
  let prepared, context;
  const sent = [], seen = { filters: filters(), seenProductIds: ["p1", "p2", "p3"] };
  const data = catalog();
  const dependencies = {
    repository: {
      async statusEvent() {},
      async inboundMessage() { return { id: "in", conversationId: "conv", type: "text", text: "Quero mais opções", correlationId: "corr", senderPhone: "5511000000001", numeroWhatsappId: "number" }; },
      async catalogBrowseState(scope) { assert.deepEqual(scope, { empresaId: "tenant-a", conversationId: "conv" }); return seen; },
      async prepareReply({ reply }) { prepared = reply; return { ...reply, messages: reply.messages.map((part, i) => ({ ...part, id: String(i), status: "processando" })) }; },
      async canSendBotReply() { return true; }, async markReplySent() {},
    },
    tenantDefinitionRepository: { async load() { return { runtime: { empresaId: "tenant-a", identity: { name: "Teste" }, enabledModules: ["catalog", "ai_freeform"], menu: { text: "Menu", options: [] }, catalog: data }, ai: { enabled: true, prompt: "Atenda pelo catálogo", responseDelayEnabled: false, catalogSalesEnabled: true }, routing: { fallbackAction: "ai_freeform.reply" } }; } },
    conversationService: { async getConversation() { return { mode: "bot" }; }, async getState() { return { data: {} }; }, async saveState() {}, async recordMessage() {}, async applyMetaStatus() {} },
    aiService: { async reply(input) { context = input.context; return { ...parseCatalogSalesReply(output({ catalogAction: "more" }), input.context.catalog), source: "ai" }; } },
    metaGateway: { async sendReply(scope, part) { sent.push(part); return { id: `provider-${sent.length}` }; } },
  };
  assert.equal((await createWorkerHandlers(dependencies).process_inbound_message({ empresaId: "tenant-a" })).replied, true);
  assert.equal(context.catalog.salesMode, true);
  assert.deepEqual(context.catalog.browseState, seen);
  assert.deepEqual(prepared.catalogBrowse.priorSeenProductIds, seen.seenProductIds);
  assert.equal(sent.length, 5);
  assert.deepEqual(sent.filter((part) => part.imageUrl).map((part) => part.imageUrl), products.slice(3, 6).map((item) => item.imageUrl));
  assert.match(sent.at(-1).text, /\?$/u);
});
