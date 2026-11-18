import assert from "node:assert/strict";
import test from "node:test";
import { websiteVehicleDescription } from "../src/integrations/website-catalog/description.js";
import { fetchWebsiteStock, parseWebsiteStock, parseWebsiteVehicleDetails, websiteCatalogFromCache } from "../src/integrations/website-catalog/stock.js";
import { websiteGalleryReply, matchesWebsiteGalleryPart } from "../src/modules/business/website-catalog-interaction.js";
import { parseCatalogSalesReply } from "../src/modules/business/catalog-sales.js";
import { createWhatsAppReplyPayload } from "../src/modules/whatsapp/outbound.js";

const introduction = "🚗 *HYUNDAI HB20 COMFORT 1.0 FLEX 2017*\n\nO Hyundai HB20 Comfort 1.0 é uma excelente opção para quem busca economia, conforto e praticidade no dia a dia.";
const description = "<p>🚗 <strong>HYUNDAI HB20 COMFORT 1.0 FLEX 2017</strong></p>"
  + "<p>O Hyundai HB20 Comfort 1.0 é uma excelente opção para quem busca economia, conforto e praticidade no dia a dia.</p>"
  + "<p><strong>Principais equipamentos e opcionais:</strong></p><ul><li>Motor 1.0 Flex</li><li>Câmbio manual</li><li>Ar-condicionado</li></ul>"
  + "<p><strong>Diferenciais:</strong></p><ul><li><strong>1 ANO DE GARANTIA</strong></li></ul>"
  + "<p>💰 <strong>VALOR: R$ 54.900,00</strong></p><p>📲 <strong>Entre em contato:</strong></p>"
  + "<p>WhatsApp: (00) 00000-0000</p><p>📍 Localização:</p><p>Av. Exemplo, 30</p>";
const vehicle = (id) => ({ id, titulo: "HB20 COMFORT 1.0 2017", modelo: "HB20", ano: 2017, preco: 54_900,
  km: 101260, cambio: "Automático", combustivel: "Flex", cor: "Não informado", imagens: ["/storage/veiculos/a.jpg", "/storage/veiculos/b.jpg"] });
const page = (...rows) => `<script>\nwindow.VEICULOS = ${JSON.stringify(rows)};\n</script>`;

test("descrição do anúncio separa a introdução da primeira foto e os detalhes, sem resumo ou rodapé comercial", () => {
  const product = parseWebsiteStock(page(vehicle(66))).products[0];
  const item = parseWebsiteVehicleDetails(page({ id: 66, descricao: description, opcionais: ["Dado adicional ignorado"] }), product);
  assert.equal(item.introduction, introduction);
  assert.match(item.details, /\*Principais equipamentos e opcionais:\*\n\n- Motor 1.0 Flex\n- Câmbio manual\n- Ar-condicionado/u);
  assert.match(item.details, /\*1 ANO DE GARANTIA\*/u);
  assert.match(item.details, /54\.900,00/u);
  assert.doesNotMatch(item.description, /101\.260|Automático|Não informado|Av\. Exemplo|00000|Localização|Dado adicional/u);
  assert.equal(item.price, 54_900, "Preço estruturado continua disponível para filtros, sem ir à legenda inicial.");
  const reply = websiteGalleryReply(item);
  const first = createWhatsAppReplyPayload({ to: "synthetic", ...reply.messages[0] });
  assert.equal(first.image.caption, introduction);
  assert.equal(matchesWebsiteGalleryPart(item, 0, reply.messages[0]), true);
  assert.doesNotMatch(first.image.caption, /equipamentos|GARANTIA|54\.900|Estoque|Preço/u);
  assert.match(reply.messages.at(-1).text, /simulação/u);
});

test("informações adicionais são texto sem reenviar fotos, inclusive com classificação antiga products", () => {
  const item = parseWebsiteVehicleDetails(page({ id: 66, descricao: description }), parseWebsiteStock(page(vehicle(66))).products[0]);
  const catalog = { source: { type: "website_catalog", status: "healthy" }, items: [item] };
  for (const action of ["details", "products"]) {
    const reply = parseCatalogSalesReply(JSON.stringify({ text: action === "details" ? item.details : "", catalogAction: action,
      productIds: [item.id], filters: { category: null, minPrice: null, maxPrice: null } }), catalog,
    { message: "Quero mais informações sobre ele" });
    assert.equal(reply.messages, undefined);
    assert.equal(reply.imageUrl, undefined);
    assert.match(reply.text, /Câmbio manual/u);
    assert.match(reply.text, /1 ANO DE GARANTIA/u);
    assert.match(reply.text, /54\.900,00/u);
    assert.doesNotMatch(reply.text, /Localização|Av\. Exemplo/u);
  }
});

test("formatos antigos sem parágrafo introdutório usam só o título, sem promover checklist ou endereço a apresentação", () => {
  const parsed = websiteVehicleDescription("<p>🚗 <em>TURIM AUTOS</em> 🚗</p><pre>*CARRO TESTE 2020*\r\n</pre>"
    + "<p>👉🏼 Motorização 1.0</p><p>👉🏼 Câmbio manual</p><p>💰 R$ 40.000,00</p><p>📍 Avenida Exemplo, 30</p><p>Centro</p>", "Carro Teste");
  assert.equal(parsed.introduction, "*CARRO TESTE 2020*");
  assert.match(parsed.details, /Motorização 1\.0/u);
  assert.doesNotMatch(parsed.description, /Avenida Exemplo|Centro|TURIM AUTOS/u);
  assert.deepEqual(websiteVehicleDescription(null, "Modelo sem descrição"), { description: "🚗 *Modelo sem descrição*", introduction: "🚗 *Modelo sem descrição*", details: "" });
});

test("conversão mantém acentos, listas e emojis sem executar HTML ou decodificar script como instrução", () => {
  const result = websiteVehicleDescription("<p><b>Carro &amp; Conforto &#x1F697;</b></p><p>Economia&nbsp;e conforto.</p>"
    + "<script>globalThis.websiteDescriptionExecuted = true</script><style>.secret{display:none}</style>"
    + "<p>Equipamentos</p><ul><li>ABS</li><li>Ar-condicionado</li></ul>", "Carro");
  assert.match(result.introduction, /Carro & Conforto 🚗/u);
  assert.match(result.details, /- ABS\n- Ar-condicionado/u);
  assert.doesNotMatch(result.description, /script|secret|Executed/u);
  assert.equal(globalThis.websiteDescriptionExecuted, undefined);
});

test("sincronização consulta cada página individual, preserva ordem e não aceita descrição de outra unidade", async () => {
  let inFlight = 0, maxInFlight = 0;
  const requested = [];
  const snapshot = await fetchWebsiteStock({ fetchImpl: async (url, options) => {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    const id = new URL(url).searchParams.get("id");
    if (!id) return new Response(page(...[1, 2, 3, 4, 5, 6].map(vehicle)), { headers: { "Content-Type": "text/html" } });
    requested.push(Number(id)); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setImmediate(resolve)); inFlight--;
    return new Response(page({ id: Number(id), descricao: `<p>Modelo ${id}</p><p>Apresentação ${id}</p>` }), { headers: { "Content-Type": "text/html" } });
  } });
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(maxInFlight, 4);
  assert.deepEqual(snapshot.products.map(item => item.id), [1, 2, 3, 4, 5, 6].map(id => `turim:${id}`));
  assert.deepEqual(requested.sort(), [1, 2, 3, 4, 5, 6]);
  assert.ok(snapshot.products.every((item, index) => item.description.includes(`Apresentação ${index + 1}`)));
  assert.throws(() => parseWebsiteVehicleDetails(page({ id: 2, descricao: description }), snapshot.products[0]), { code: "WEBSITE_CATALOG_INVALID_DETAILS" });
  assert.throws(() => parseWebsiteVehicleDetails(page({ id: 1, descricao: "x".repeat(20_001) }), snapshot.products[0]), { code: "WEBSITE_CATALOG_INVALID_DETAILS" });
  assert.equal(websiteCatalogFromCache({ status: "saudavel", last_success_at: new Date(), cache_snapshot: { ...snapshot, schemaVersion: 1 } }).source.status, "unavailable");
  assert.equal(websiteCatalogFromCache({ status: "saudavel", last_success_at: new Date(), cache_snapshot: snapshot }).source.status, "healthy");
});
