import test from "node:test";
import assert from "node:assert/strict";
import { productMessage, availableCatalogProducts, catalogSelectionFormat, parseCatalogSelection } from "../src/modules/business/catalog-messages.js";
import { createWhatsAppReplyPayload } from "../src/modules/whatsapp/outbound.js";
import { createMetaGateway } from "../src/integrations/meta/meta-gateway.js";
import { createTenantRuntimeRouter } from "../src/modules/runtime/index.js";
const stateRepository = () => ({ async load() { return null; }, async save() {} });

const product = (extra = {}) => ({ id: "product-a", name: "Modelo aprovado", price: 4990,
  powerWatts: 1000, autonomyKm: 50, units: ["Taubaté"], description: "Detalhes confirmados.",
  imageUrl: "https://example.com/a.jpg", availability: "available", ...extra });
const catalog = (items = [product()]) => ({ source: { type: "google_sheets", status: "healthy" }, items });

test("cada ficha usa imagem e legenda somente do produto selecionado", () => {
  const reply = parseCatalogSelection(JSON.stringify({ text: "Qual deles você prefere?", productIds: ["product-b", "product-a"] }),
    catalog([product(), product({ id: "product-b", name: "Outro modelo", price: 6990, imageUrl: "https://example.com/b.jpg" })]));
  assert.equal(reply.messages.length, 3);
  assert.equal(reply.messages[0].imageUrl, "https://example.com/b.jpg");
  assert.match(reply.messages[0].text, /Outro modelo[\s\S]*6\.990,00/u);
  assert.doesNotMatch(reply.messages[0].text, /4\.990/u);
  assert.match(reply.messages[1].text, /1.*000 W|1000 W/u);
  assert.match(reply.messages[1].text, /50 km/u);
  assert.equal(reply.messages[2].imageUrl, undefined);
});

test("pedido explícito de três modelos completa uma seleção parcial sem misturar as fichas", () => {
  const data = catalog([product(), product({ id: "b", name: "Modelo B", imageUrl: "https://example.com/b.jpg" }),
    product({ id: "c", name: "Modelo C", imageUrl: "https://example.com/c.jpg" }), product({ id: "off", active: false })]);
  const output = '{"text":"","productIds":["product-a"]}';
  const reply = parseCatalogSelection(output, data, { message: "Sou de Taubaté. Pode me mostrar os três modelos disponíveis com fotos e preços?" });
  assert.deepEqual(reply.messages.map((item) => item.imageUrl), ["https://example.com/a.jpg", "https://example.com/b.jpg", "https://example.com/c.jpg"]);
  assert.match(reply.messages[1].text, /^\*Modelo B\*/u);
  assert.doesNotMatch(reply.messages[1].text, /Modelo C/u);
  assert.equal(parseCatalogSelection(output, data, { message: "Envie todos os produtos do catálogo" }).messages.length, 3);
  assert.equal(parseCatalogSelection(output, data, { message: "Mostre dois modelos, por favor" }).messages.length, 2);
});

test("completar a lista respeita cidade, filtros, perguntas prévias e limite do catálogo", () => {
  const data = catalog([product(), product({ id: "b", units: ["Outra cidade"] }), product({ id: "out", availability: "unavailable" }), product({ id: "c", units: ["Taubaté"] })]);
  const output = '{"text":"","productIds":["product-a"]}';
  assert.equal(parseCatalogSelection(output, data, { message: "Sou de Taubaté. Mostre os três modelos disponíveis" }).messages.length, 2);
  assert.equal(parseCatalogSelection(output, data, { message: "Mostre os três modelos disponíveis" }).messages.length, 2);
  for (const message of ["Não envie todos os modelos", "Mostre apenas dois modelos", "Mostre os três modelos de 2000W", "Mostre todos os modelos exceto o A", "Quero ver o Modelo B", "Gostei. Sou de Taubaté. Mostre os três modelos"]) {
    assert.equal(parseCatalogSelection(output, data, { message }).messages.length, 1);
  }
  assert.deepEqual(parseCatalogSelection('{"text":"Qual sua cidade?","productIds":[]}', data, { message: "Mostre os três modelos disponíveis" }), { text: "Qual sua cidade?" });
  assert.throws(() => parseCatalogSelection('{"text":"","productIds":["foreign"]}', data, { message: "Mostre os três modelos disponíveis" }));
});

test("inativos, indisponíveis e fonte expirada não são oferecidos; sob consulta permanece explícito", () => {
  const data = catalog([product({ active: false }), product({ id: "out", availability: "unavailable" }), product({ id: "ask", availability: "on_request", price: undefined, imageUrl: undefined })]);
  assert.deepEqual(availableCatalogProducts(data).map((item) => item.id), ["ask"]);
  const message = productMessage(data.items[2]);
  assert.match(message.text, /sob consulta/u);
  assert.match(message.text, /Preço: consulte/u);
  assert.equal(message.imageUrl, undefined);
  assert.equal(catalogSelectionFormat({ ...data, source: { type: "google_sheets", status: "unavailable" } }), null);
  assert.deepEqual(availableCatalogProducts({ ...data, source: { status: "unavailable" } }), []);
});

test("IDs estrangeiros, duplicados, resposta vazia e saída fora do contrato falham fechados", () => {
  for (const value of [{ text: "", productIds: ["foreign"] }, { text: "", productIds: ["product-a", "product-a"] },
    { text: "", productIds: [] }, { text: "oi", productIds: [], imageUrl: "https://example.com/foreign.jpg" }]) {
    assert.throws(() => parseCatalogSelection(JSON.stringify(value), catalog()));
  }
  assert.throws(() => parseCatalogSelection("texto sem JSON", catalog()));
  assert.deepEqual(parseCatalogSelection('{"text":"Qual sua cidade?","productIds":[]}', catalog()), { text: "Qual sua cidade?" });
});

test("legenda respeita 1024 caracteres; imagem inválida, botões e excesso são recusados", () => {
  const message = productMessage(product({ description: "🌟".repeat(1000) }));
  assert.ok([...message.text].length <= 1024);
  assert.match(message.text, /Preço:[\s\S]*4\.990/u);
  const payload = createWhatsAppReplyPayload({ to: "5511000000001", ...message });
  assert.equal(payload.type, "image");
  assert.equal(payload.image.caption, message.text);
  for (const imageUrl of ["http://example.com/a.jpg", "https://localhost/a.jpg", "https://user:password@example.com/a.jpg"]) {
    assert.throws(() => createWhatsAppReplyPayload({ to: "5511000000001", text: "Modelo", imageUrl }));
  }
  assert.throws(() => createWhatsAppReplyPayload({ to: "1", text: "x".repeat(1025), imageUrl: product().imageUrl }));
  assert.throws(() => createWhatsAppReplyPayload({ to: "1", ...message, buttons: [{ id: "x", label: "X" }] }));
});

test("Meta e YCloud enviam image.link e caption com o número e credencial do tenant", async () => {
  for (const provider of ["meta", "ycloud"]) {
    const calls = [];
    const gateway = createMetaGateway({ credentialResolver: { async resolveMeta({ empresaId, numeroWhatsappId }) {
      assert.equal(empresaId, "tenant-a"); assert.equal(numeroWhatsappId, "number-a");
      return { provider, accessToken: "synthetic-a", phoneNumberId: "phone-a", phoneNumber: "+5511000000001" };
    } }, fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => provider === "ycloud" ? { wamid: "wamid.a" } : { messages: [{ id: "wamid.a" }] } }; } });
    await gateway.sendReply({ empresaId: "tenant-a", numeroWhatsappId: "number-a" }, { to: "5511000000002", ...productMessage(product()) });
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.type, "image"); assert.equal(body.image.link, product().imageUrl);
    assert.match(body.image.caption, /Modelo aprovado/u);
    assert.equal(body.text, undefined);
    if (provider === "ycloud") { assert.equal(body.from, "+5511000000001"); assert.equal(calls[0].options.headers["X-API-Key"], "synthetic-a"); }
  }
});

test("rota determinística preserva um bloco por produto e mantém o catálogo legado textual", async () => {
  const base = { empresaId: "tenant-a", identity: { name: "Teste" }, enabledModules: ["catalog"],
    menu: { text: "Menu", options: [{ id: "products", label: "Produtos", module: "catalog", action: "catalog.list" }] } };
  const router = createTenantRuntimeRouter({ config: { ...base, catalog: catalog([product(), product({ id: "b", name: "Segundo" })]) }, stateRepository: stateRepository() });
  const reply = await router.handle({ conversationId: "a", action: "catalog.list" });
  assert.equal(reply.messages.length, 2);
  assert.match(reply.messages[0].text, /Modelo aprovado/u);
  assert.doesNotMatch(reply.messages[0].text, /Segundo/u);
  const legacy = createTenantRuntimeRouter({ config: { ...base, catalog: { items: [{ id: "a", name: "Legado", price: 1 }] } }, stateRepository: stateRepository() });
  assert.equal((await legacy.handle({ conversationId: "a", action: "catalog.list" })).messages, undefined);
});
