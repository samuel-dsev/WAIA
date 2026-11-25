import assert from "node:assert/strict";
import test from "node:test";
import { vehicleFactsText } from "../src/core/vehicle-facts.js";
import { parseWebsiteStock, parseWebsiteVehicleDetails, websiteCatalogFromCache } from "../src/integrations/website-catalog/stock.js";
import { parseTenantRuntimeConfig } from "../src/modules/runtime/tenant-runtime-config.js";
import { websiteCatalogList, websiteCatalogListText } from "../src/modules/business/website-catalog-interaction.js";
import { parseCatalogSalesReply } from "../src/modules/business/catalog-sales.js";
import { websiteListFormatMetadata, replyFromRow } from "../src/modules/jobs/reply-batch.js";
import { createWhatsAppReplyPayload } from "../src/modules/whatsapp/outbound.js";
import { MemoryAiConfigResolver, MemoryAiLedger, MemoryAiSecretResolver, MemoryPricingCatalog,
  MemoryResponsesClientFactory, MultiTenantAiService } from "../src/modules/ai/index.js";

const stockCar = (id, titulo, km, ano, preco) => ({ id, titulo, km, ano, preco,
  cambio: "Automático", combustivel: "Flex", cor: "Prata", imagens: ["/storage/veiculos/test.jpg"] });
const examples = [stockCar(49, "TRACKER 2.0", 155000, 2008, 45900), stockCar(61, "FORD KA SE HA B", 99141, 2018, 47900),
  stockCar(41, "CITROËN C3 TENDANCE 1.2", 92214, 2019, 53900)];
const page = (...entries) => `<script>\nwindow.VEICULOS = ${JSON.stringify(entries)};\n</script>`;
const runtime = (catalog) => parseTenantRuntimeConfig({ empresaId: "test", identity: { name: "Teste" },
  enabledModules: ["catalog"], menu: { text: "Menu", options: [] }, catalog });
const fromCache = (snapshot) => websiteCatalogFromCache({ cache_snapshot: snapshot, status: "saudavel", last_success_at: new Date() });

test("importação, cache, runtime e lista reproduzem os três exemplos com origem por unidade", () => {
  const snapshot = parseWebsiteStock(page(...examples));
  snapshot.products = snapshot.products.map((product, i) => parseWebsiteVehicleDetails(page({ id: examples[i].id, ano: examples[i].ano,
    descricao: `<p>${product.name}</p><p>Introdução oficial.</p><p>Equipamentos</p><ul><li>Motor Flex</li></ul>` }), product));
  assert.equal(snapshot.schemaVersion, 2);
  for (const product of snapshot.products) {
    assert.deepEqual(product.vehicleFactsSources, { mileageKm: "stock.km", year: "vehicle_details.ano" });
    assert.doesNotMatch(product.description, /km|Automático|Prata/u);
  }
  const catalog = runtime(fromCache(JSON.parse(JSON.stringify(snapshot)))).catalog;
  const reply = parseCatalogSalesReply(JSON.stringify({ text: "", productIds: [], catalogAction: "browse",
    filters: { category: null, minPrice: null, maxPrice: null } }), catalog);
  const part = reply.messages[0], text = part.text.replaceAll("\u00a0", " ");
  assert.equal(text.split("\n\n").slice(0, 3).join("\n\n"),
    "*TRACKER 2.0*\n155.000 km - 2008\nValor: R$ 45.900,00\n\n*FORD KA SE HA B*\n99.141 km - 2018\nValor: R$ 47.900,00\n\n*CITROËN C3 TENDANCE 1.2*\n92.214 km - 2019\nValor: R$ 53.900,00");
  assert.equal(part.catalogListFormatVersion, 2);
  assert.deepEqual(part.websiteInteraction.productIds, ["turim:49", "turim:61", "turim:41"]);
  assert.equal(catalog.items[0].vehicleFactsSources, undefined);
  assert.equal(catalog.items[0].vehicleFactsWarnings, undefined);
});

test("ano estruturado dos detalhes vence; falhas de ano mantêm fallback e diagnóstico sem valores brutos", () => {
  const original = parseWebsiteStock(page(examples[0])).products[0];
  const newer = parseWebsiteVehicleDetails(page({ id: 49, ano: 2009, descricao: "<p>Texto comercial de 2025, 999 km</p>" }), original);
  assert.equal(newer.year, 2009); assert.equal(newer.mileageKm, 155000);
  assert.deepEqual(newer.vehicleFactsWarnings, [{ field: "year", source: "vehicle_details.ano", code: "year_mismatch", otherSource: "stock.ano" }]);
  for (const ano of [undefined, null, "2009", "conteúdo inválido", 1885, 2101, 2009.5]) {
    const fallback = parseWebsiteVehicleDetails(page({ id: 49, ano, descricao: "<p>Ano 2025</p>" }), original);
    assert.equal(fallback.year, 2008);
    assert.equal(fallback.vehicleFactsSources.year, "stock.ano");
    assert.equal(fallback.vehicleFactsWarnings[0].source, "vehicle_details.ano");
    assert.doesNotMatch(JSON.stringify(fallback.vehicleFactsWarnings), /conteúdo|2009/u);
  }
  assert.throws(() => parseWebsiteVehicleDetails(page({ id: 61, ano: 2018 }), original), { code: "WEBSITE_CATALOG_INVALID_DETAILS" });
  const noStockYear = parseWebsiteStock(page({ ...examples[0], ano: null })).products[0];
  assert.equal(parseWebsiteVehicleDetails(page({ id: 49, ano: 2008 }), noStockYear).year, 2008);
});

test("km zero é válido e dados inválidos não zeram nem eliminam o estoque", () => {
  assert.equal(vehicleFactsText({ mileageKm: 0, year: 2026 }), "0 km - 2026");
  assert.equal(vehicleFactsText({ mileageKm: 155000 }), "155.000 km - Ano não informado");
  assert.equal(vehicleFactsText({ year: 2008 }), "Quilometragem não informada - 2008");
  assert.equal(vehicleFactsText({}), "Quilometragem e ano não informados");
  for (const km of [undefined, null, "", "155.000", -1, 10_000_000, 1.5, NaN, Infinity]) {
    const snapshot = parseWebsiteStock(page({ ...examples[0], km, ano: "2008" }));
    assert.equal(snapshot.products.length, 1);
    const product = snapshot.products[0];
    assert.equal(product.mileageKm, undefined); assert.equal(product.year, undefined);
    assert.equal(product.vehicleFactsWarnings.length, 2);
    assert.equal(vehicleFactsText(runtime(fromCache(snapshot)).catalog.items[0]), "Quilometragem e ano não informados");
  }
  for (const mileageKm of [0, 9_999_999]) {
    const product = parseWebsiteStock(page({ ...examples[0], km: mileageKm })).products[0];
    assert.equal(product.mileageKm, mileageKm);
  }
});

test("cache anterior segue legível e outros catálogos não ganham campos do site", () => {
  const snapshot = parseWebsiteStock(page(examples[0]));
  const item = snapshot.products[0];
  delete item.mileageKm; delete item.year; delete item.vehicleFactsSources;
  const catalog = runtime(fromCache(snapshot)).catalog;
  assert.equal(catalog.source.status, "healthy");
  assert.match(websiteCatalogListText(catalog.items), /Quilometragem e ano não informados/u);
  const invalid = runtime({ ...catalog, items: [{ ...item, mileageKm: "155000", year: -1 }] });
  assert.equal(invalid.catalog.items[0].mileageKm, undefined);
  const other = runtime({ items: [{ ...item, mileageKm: 155000, year: 2008 }] });
  assert.equal(other.catalog.items[0].mileageKm, undefined); assert.equal(other.catalog.items[0].year, undefined);
});

test("paginação usa o corpo completo novo, preserva ordem e respeita 4096 caracteres", () => {
  const items = Array.from({ length: 200 }, (_, index) => ({ id: `turim:${index + 1}`, name: "Modelo " + String(index).padStart(3, "0") + " x".repeat(40),
    mileageKm: 155000, year: 2008, price: 45900 }));
  const catalog = { source: { type: "website_catalog", status: "healthy" }, items };
  const selected = websiteCatalogList(items);
  assert.ok(selected.length > 1 && selected.length < items.length);
  assert.ok(websiteCatalogListText(selected).length <= 4096);
  assert.ok(websiteCatalogListText(items.slice(0, selected.length + 1)).length > 4096);
  const result = (message, browseState) => parseCatalogSalesReply(JSON.stringify({ text: "", productIds: [], catalogAction: browseState ? "more" : "browse",
    filters: { category: null, minPrice: null, maxPrice: null } }), { ...catalog, browseState }, { message });
  const first = result("Quero conhecer os modelos");
  const firstIds = first.messages[0].websiteInteraction.productIds;
  const next = result("Mais opções", { filters: first.catalogBrowse.filters, seenProductIds: firstIds });
  assert.deepEqual(firstIds, items.slice(0, 3).map(({ id }) => id));
  assert.equal(next.messages[0].websiteInteraction.productIds[0], items[3].id);
  assert.ok(next.messages[0].websiteInteraction.productIds.length <= 3);
});

test("checkpoint reconhece lista legada e versão 2, rejeita versão inválida e não expõe metadados ao WhatsApp", () => {
  const items = parseWebsiteStock(page(examples[0])).products;
  const interaction = { step: "list", productIds: [items[0].id] };
  const legacy = websiteCatalogListText(items, { formatVersion: 1 });
  assert.match(legacy, /Modelo: TRACKER 2\.0/u); assert.doesNotMatch(legacy, /155\.000 km/u);
  assert.deepEqual(websiteListFormatMetadata({ websiteInteraction: interaction }), {});
  for (const catalogListFormatVersion of [1, 2]) {
    const payload = { catalogListFormatVersion, websiteInteraction: interaction };
    const part = replyFromRow({ id: "test", corpo: "Lista", outbound_payload: payload, status: "processando" });
    assert.equal(part.catalogListFormatVersion, catalogListFormatVersion);
    const outgoing = createWhatsAppReplyPayload({ to: "test", ...part });
    assert.equal(outgoing.text.body, "Lista"); assert.doesNotMatch(JSON.stringify(outgoing), /catalogListFormatVersion|websiteInteraction/u);
  }
  for (const value of [0, 3, null, "2", NaN]) assert.throws(() => websiteListFormatMetadata({ catalogListFormatVersion: value, websiteInteraction: interaction }), { code: "BOT_REPLY_BATCH_INVALID" });
  for (const part of [{}, { websiteInteraction: { step: "gallery", productIds: [items[0].id] } }, { websiteInteraction: interaction, imageUrl: "https://example.test/test.jpg" }]) {
    assert.throws(() => websiteListFormatMetadata({ ...part, catalogListFormatVersion: 2 }), { code: "BOT_REPLY_BATCH_INVALID" });
  }
  assert.throws(() => websiteCatalogListText(items, { formatVersion: 3 }), TypeError);
});

test("IA recebe km/ano oficiais sem diagnósticos internos e devolve lista determinística", async () => {
  const catalog = { ...fromCache(parseWebsiteStock(page(...examples))), salesMode: true };
  const factory = new MemoryResponsesClientFactory(async () => ({ output_text: JSON.stringify({ text: "texto livre descartado", catalogAction: "browse", productIds: [],
    filters: { category: null, minPrice: null, maxPrice: null } }), usage: { input_tokens: 10, output_tokens: 10 } }));
  const service = new MultiTenantAiService({ configResolver: new MemoryAiConfigResolver([{ empresaId: "test", enabled: true, provider: "openai", model: "test",
    prompt: "Atenda o pedido atual", keyType: "shared", maxOutputTokens: 800, allowedContextKeys: ["catalog"], version: 1 }]),
    conversationService: { async getHistory() { return []; } },
    clientFactory: factory, secretResolver: new MemoryAiSecretResolver({ sharedSecret: "fake" }), ledger: new MemoryAiLedger(),
    pricingCatalog: new MemoryPricingCatalog({ test: { inputPerMillion: 1, outputPerMillion: 1, version: "test" } }), logger: { warn() {} } });
  const reply = await service.reply({ empresaId: "test", conversationId: "chat", messageId: "current", correlationId: "test",
    message: "Quais modelos estão disponíveis?", context: { catalog } });
  assert.equal(reply.source, "ai");
  const request = factory.requests[0].request;
  assert.match(request.input[0].content, /"mileageKm":\s*155000/u);
  assert.match(request.input[0].content, /"year":\s*2008/u);
  assert.doesNotMatch(JSON.stringify(request.input), /vehicleFactsSources|vehicleFactsWarnings/u);
  assert.match(request.instructions, /mileageKm/u);
  assert.match(reply.messages[0].text, /155\.000 km - 2008/u);
  assert.doesNotMatch(reply.messages[0].text, /texto livre/u);
});
