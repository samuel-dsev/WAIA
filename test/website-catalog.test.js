import assert from "node:assert/strict";
import test from "node:test";
import { fetchWebsiteStock, parseWebsiteStock, WEBSITE_CATALOG_URL, websiteCatalogFromCache } from "../src/integrations/website-catalog/stock.js";
import { WebsiteCatalogIntegration } from "../src/integrations/website-catalog/integration.js";
import { catalogSalesFormat, parseCatalogSalesReply } from "../src/modules/business/catalog-sales.js";
import { loadWebsiteCatalog } from "../src/tenants/postgres-config-loader.js";
import { withTenantTransaction } from "../src/infra/postgres/transaction.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createConfiguredTenantRuntime } from "../src/tenants/configured-runtime.js";
import { createWhatsAppReplyPayload } from "../src/modules/whatsapp/outbound.js";

const car = (id, price, fields = {}) => ({ id, titulo: `Modelo ${id}`, ano: 2020, preco: price,
  modelo: `Versão ${id}`, km: 21345, cambio: "Automático", combustivel: "Flex", cor: "Prata", imagens: ["/storage/veiculos/a.jpg"], ...fields });
const page = (...vehicles) => `<html>\n<script>\n  window.VEICULOS = ${JSON.stringify(vehicles)};\n</script>\n</html>`;

test("lê a fonte fixa, mantém IDs, preços e fotos, sem avaliar o script", async () => {
  const snapshot = await fetchWebsiteStock({ fetchImpl: async (url, options) => {
    assert.equal(url, WEBSITE_CATALOG_URL);
    assert.equal(options.redirect, "error");
    return new Response(page(car(2, 0), car(1, 59_900)), { headers: { "Content-Type": "text/html; charset=UTF-8" } });
  } });
  const [onRequest, priced] = snapshot.products;
  assert.equal(onRequest.price, null);
  assert.equal(onRequest.availability, "on_request");
  assert.equal(priced.id, "turim:1");
  assert.equal(priced.model, "Versão 1");
  assert.match(priced.description, /21\.345 km · Automático/u);
  assert.equal(priced.url, "https://turimautos.com/veiculo?id=1");
  assert.equal(priced.imageUrl, "https://turimautos.com/storage/veiculos/a.jpg");
  assert.equal(priced.category, undefined);
  assert.deepEqual(parseWebsiteStock(page()).products, []);
  assert.throws(() => parseWebsiteStock(page(car(1, 123), car(1, 456))), { code: "WEBSITE_CATALOG_INVALID_STOCK" });
  assert.throws(() => parseWebsiteStock(page(car(1, 123, { imagens: ["https://example.com/a.jpg"] }))), { code: "WEBSITE_CATALOG_INVALID_IMAGE" });
  assert.throws(() => parseWebsiteStock("<p>Acesso indisponível</p>"), { code: "WEBSITE_CATALOG_STOCK_NOT_FOUND" });
});

test("catálogo comercial usa o teto pedido e ignora cache vencido", () => {
  const row = { status: "saudavel", last_success_at: new Date(), cache_snapshot: parseWebsiteStock(page(car(1, 60_000), car(2, 60_001), car(3, 0))) };
  const catalog = websiteCatalogFromCache(row);
  assert.equal(catalogSalesFormat(catalog)?.name, "catalog_sales_reply");
  const selection = { text: "", productIds: [], catalogAction: "browse", filters: { category: null, minPrice: null, maxPrice: 60_000 } };
  const reply = parseCatalogSalesReply(JSON.stringify(selection), catalog);
  assert.equal(reply.messages.some((part) => part.imageUrl), false);
  assert.deepEqual(reply.messages[0].websiteInteraction.productIds, ["turim:1"]);
  assert.doesNotMatch(reply.text, /turimautos\.com/u);
  assert.equal(catalogSalesFormat(websiteCatalogFromCache(row, Date.now() + 601_000)), null);
});

test("pedidos por faixa da Turim montam lista em texto e suprimem redirecionamentos", async () => {
  const link = "Confira em https://turimautos.com/estoque.";
  const stock = parseWebsiteStock(page(car(4, 65_000), car(1, 59_900), car(2, 60_000), car(3, 45_000, { imagens: [] })));
  const runtime = createConfiguredTenantRuntime({
    definition: {
      runtime: { empresaId: "turim", identity: { name: "Turim" }, enabledModules: ["catalog", "ai_freeform"],
        menu: { text: "Você já tem um modelo em mente?", options: [] },
        catalog: websiteCatalogFromCache({ status: "saudavel", last_success_at: new Date(), cache_snapshot: stock }) },
      publicReplies: [{ module: "catalog", action: "catalog.list", text: link }],
      routing: { greetings: ["oi"], aliases: [{ terms: ["modelos", "fotos"], action: "catalog.list" }] },
      ai: { enabled: true, prompt: "Atenda normalmente." },
    },
    stateRepository: { async load() { return null; }, async save() {} },
    async aiHandler() { return { reply: { text: link } }; },
  });
  const turn = (text, extra) => runtime.handle({ conversationId: "conversation", type: "text", text, ...extra });
  assert.equal((await turn("Oi")).text, "Você já tem um modelo em mente?");
  const catalogList = await turn("", { action: "catalog.list" });
  assert.deepEqual(catalogList.messages[0].websiteInteraction.productIds, ["turim:4", "turim:1", "turim:2", "turim:3"]);
  const budget = await turn("quais modelos até 60 mil vcs tem disponível");
  assert.deepEqual(budget.messages[0].websiteInteraction.productIds, ["turim:1", "turim:2", "turim:3"]);
  assert.equal(budget.catalogBrowse.filters.maxPrice, 60_000);
  const outgoing = createWhatsAppReplyPayload({ to: "test-recipient", ...budget.messages[0] });
  assert.equal(outgoing.type, "text");
  assert.match(outgoing.text.body, /Modelo 1\*\nModelo: Versão 1\nAno 2020 · 21\.345 km · Automático[^\n]*\nValor: R\$\s59\.900,00\n\n\*Modelo 2\*/u);
  assert.match(outgoing.text.body, /Gostou de algum\?.+fotos dele/u);
  assert.doesNotMatch(outgoing.text.body, /turimautos\.com|Modelo 4/u);
  const photoRequest = await turn("tenho em mente um Onix, tem fotos dele?");
  assert.equal(photoRequest.messages, undefined, "Alias de fotos não pode enviar outros veículos como se fossem o Onix.");
  assert.doesNotMatch(photoRequest.text, /turimautos\.com/u);
  assert.equal((await turn("procuro um carro até 60 mil")).messages, undefined);
});

test("consulta por categoria usa a carroceria publicada sem afrouxar o filtro", () => {
  const cache = parseWebsiteStock(page(car(1, 54_000, { detalhes: { categoria: "SUV" } }), car(2, 52_000, { categoria: "Hatch" })));
  const catalog = websiteCatalogFromCache({ status: "saudavel", last_success_at: new Date(), cache_snapshot: cache });
  const output = (category) => JSON.stringify({ text: "", catalogAction: "browse", productIds: [], filters: { category, minPrice: null, maxPrice: 60_000 } });
  const reply = parseCatalogSalesReply(output("SUV"), catalog, { message: "Quais SUVs até 60 mil?" });
  assert.deepEqual(reply.messages[0].websiteInteraction.productIds, ["turim:1"]);
  const unresolved = parseCatalogSalesReply(output(null), catalog, { message: "Quais sedãs até 60 mil?" });
  assert.equal(unresolved.messages, undefined);
  assert.match(unresolved.text, /confirmar essa categoria/u);
});

test("PostgreSQL: troca de estoque, indisponibilidade, isolamento e tentativa concorrente", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "true",
}, async () => {
  assert.ok(process.env.DATABASE_URL && process.env.DATABASE_MIGRATOR_URL);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  const company = { id: randomUUID() }, neighbor = { id: randomUUID() };
  try {
    await owner.query("INSERT INTO empresas (id, slug, nome, nome_exibicao, status) SELECT id, id::text, 'Teste', 'Teste', 'ativa' FROM unnest($1::uuid[]) id",
      [[company.id, neighbor.id]]);
    const { rows: [binding] } = await owner.query(
      `INSERT INTO integracoes (empresa_id, tipo, nome, habilitada)
       VALUES ($1, 'website_catalog', 'Fonte de teste', true) RETURNING id`, [company.id],
    );
    let next = async () => parseWebsiteStock(page(car(1, 59_900), car(2, 95_000)));
    const integration = new WebsiteCatalogIntegration({ pool, fetchStock: () => next() });
    const readRuntime = (empresaId) => withTenantTransaction(pool, { empresaId }, ({ client }) => loadWebsiteCatalog(client, empresaId));
    assert.equal((await integration.syncTenant(company.id)).productsImported, 2);
    assert.equal((await integration.read(company.id)).items.length, 2);
    assert.equal((await integration.syncTenant(neighbor.id)).health, "not_configured");
    assert.equal(await readRuntime(neighbor.id), null);
    await owner.query("UPDATE integracoes SET habilitada=false WHERE id=$1", [binding.id]);
    assert.equal(await readRuntime(company.id), null);
    await owner.query("UPDATE integracoes SET habilitada=true WHERE id=$1", [binding.id]);

    next = async () => parseWebsiteStock(page(car(1, 55_000)));
    await integration.syncTenant(company.id);
    assert.deepEqual((await readRuntime(company.id)).items.map(({ id, price }) => [id, price]), [["turim:1", 55_000]]);
    next = async () => parseWebsiteStock("<p>Falha do site</p>");
    assert.equal((await integration.syncTenant(company.id)).health, "unavailable");
    assert.equal((await readRuntime(company.id)).source.status, "unavailable");
    assert.equal((await owner.query("SELECT cache_snapshot FROM integracoes WHERE id = $1", [binding.id])).rows[0].cache_snapshot.products.length, 1);

    const started = Promise.withResolvers();
    const oldStock = Promise.withResolvers();
    next = () => { started.resolve(); return oldStock.promise; };
    const firstSync = integration.syncTenant(company.id);
    await started.promise;
    next = async () => parseWebsiteStock(page());
    assert.deepEqual(await integration.syncTenant(company.id), { health: "healthy", productsImported: 0 });
    oldStock.resolve(parseWebsiteStock(page(car(1, 59_900))));
    assert.equal((await firstSync).health, "superseded");
    const current = await readRuntime(company.id);
    assert.equal(current.source.status, "healthy");
    assert.deepEqual(current.items, []);
  } finally {
    try {
      await owner.query("DELETE FROM integracoes WHERE empresa_id = ANY($1::uuid[])", [[company.id, neighbor.id]]);
      await owner.query("DELETE FROM empresas WHERE id = ANY($1::uuid[])", [[company.id, neighbor.id]]);
    } finally { await Promise.all([pool.end(), owner.end()]); }
  }
});

test("alias de endereço não elimina a pergunta sobre troca no mesmo turno", async () => {
  let received;
  const runtime = createConfiguredTenantRuntime({
    definition: {
      runtime: { empresaId: "turim", identity: { name: "Turim" }, enabledModules: ["catalog", "ai_freeform"],
        menu: { text: "Menu", options: [] },
        catalog: websiteCatalogFromCache({ status: "saudavel", last_success_at: new Date(), cache_snapshot: parseWebsiteStock(page(car(1, 59_900))) }) },
      publicReplies: [{ module: "catalog", action: "catalog.address", text: "ENDEREÇO FIXO ISOLADO" }],
      routing: { aliases: [{ terms: ["onde fica", "endereço"], action: "catalog.address" }] },
      ai: { enabled: true, prompt: "Responda todas as perguntas." },
    }, stateRepository: { async load() { return null; }, async save() {} },
    async aiHandler({ input }) { received = input.text; return { reply: { source: "ai", text: "Aceitamos avaliar a troca. Ficamos em Taubaté. Gostaria de solicitar uma avaliação?" } }; },
  });
  const reply = await runtime.handle({ conversationId: "chat", type: "text", text: "Aceita veículo na troca?\nOnde fica a loja?" });
  assert.equal(received, "Aceita veículo na troca?\nOnde fica a loja?");
  assert.equal(reply.module, "ai_freeform");
  assert.match(reply.text, /troca.*Taubaté/u);
  assert.equal(reply.messages, undefined);
});
