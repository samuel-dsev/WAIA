import test from "node:test";
import assert from "node:assert/strict";
import { mapProductsSnapshot, catalogFromProductsCache } from "../src/integrations/google-sheets/products-snapshot.js";
import { PostgresGoogleSheetsSnapshotMapper, PostgresGoogleSheetsConfigurationResolver } from "../src/integrations/google-sheets/postgres-adapters.js";
import { createGoogleSheetsIntegration } from "../src/integrations/google-sheets/google-sheets-integration.js";
import { compileTenantRuntimeConfigV2 } from "../src/modules/configuration/index.js";
import { PostgresTenantDefinitionRepository } from "../src/tenants/postgres-config-loader.js";
import { parseTenantRuntimeConfig } from "../src/modules/runtime/tenant-runtime-config.js";
import { allowlistedTenantContext, serializeTenantContext } from "../src/modules/ai/guardrails.js";
import { GoogleSheetsClient } from "../src/google-sheets.js";

const EMPRESA_ID = "00000000-0000-4000-8000-000000000201";
const INTEGRATION_ID = "00000000-0000-4000-8000-000000000299";
const row = (changes = {}) => Object.assign(["SKU-1", "Modelo sintético", "Scooter", "Marca", "1000", "40", "R$ 4.990,00", "Disponível", "Cidade A; Cidade B", "https://example.com/modelo.jpg", "Descrição confirmada", "Ativo"], changes);
const now = new Date("2026-10-13T12:00:00Z");
const cache = (changes = {}) => ({
  cache_snapshot: mapProductsSnapshot({ products: [row()] }), cache_version: 2,
  configuracao: { profile: "products", version: 2 }, status: "saudavel", last_success_at: now, ...changes,
});

test("produtos preservam preços pt-BR, especificações, unidades e foto no contexto da IA", () => {
  const snapshot = mapProductsSnapshot({ products: [row(), row({ 0: "SKU-2", 6: "", 7: "Sob consulta" })] });
  const config = parseTenantRuntimeConfig({ empresaId: EMPRESA_ID, identity: { name: "Teste" }, enabledModules: ["catalog"], catalog: { items: snapshot.products } });
  const context = allowlistedTenantContext({ catalog: config.catalog }, ["catalog"]);
  const item = context.catalog.items[0];
  assert.equal(item.price, 4990);
  assert.equal(item.powerWatts, 1000);
  assert.deepEqual(item.units, ["Cidade A", "Cidade B"]);
  assert.equal(item.imageUrl, "https://example.com/modelo.jpg");
  assert.equal(item.sku, "SKU-1");
  assert.equal(context.catalog.items[1].price, undefined);
  assert.equal(context.catalog.items[1].availability, "on_request");
  assert.match(serializeTenantContext(context), /4990/u);
});

test("linhas vazias, rascunhos e inativos não são produtos; indisponíveis são explicitados", () => {
  const items = mapProductsSnapshot({ products: [[], row({ 11: "" }), row({ 11: "Inativo" }), row({ 7: "Indisponível" })] }).products;
  assert.equal(items.length, 1);
  assert.equal(items[0].availability, "unavailable");
  assert.equal(items[0].active, false);
  assert.deepEqual(mapProductsSnapshot({ products: [] }).products, []);
});

test("erros de produto são sanitizados e não aceitam dados ambíguos", () => {
  for (const [changes, code] of [
    [{ 0: "" }, "GOOGLE_INVALID_PRODUCT_TEXT"], [{ 1: "" }, "GOOGLE_INVALID_PRODUCT_TEXT"],
    [{ 6: "-10" }, "GOOGLE_INVALID_PRODUCT_NUMBER"], [{ 4: "1000 W" }, "GOOGLE_INVALID_PRODUCT_NUMBER"],
    [{ 7: "Talvez" }, "GOOGLE_INVALID_PRODUCT_AVAILABILITY"], [{ 11: "Sim" }, "GOOGLE_INVALID_PRODUCT_STATUS"],
    [{ 9: "http://example.com/foto" }, "GOOGLE_INVALID_PRODUCT_IMAGE"],
    [{ 9: "https://usuario:segredo@example.com/foto" }, "GOOGLE_INVALID_PRODUCT_IMAGE"],
    [{ 9: "https://127.0.0.1/foto" }, "GOOGLE_INVALID_PRODUCT_IMAGE"],
  ]) assert.throws(() => mapProductsSnapshot({ products: [row(changes)] }), (error) => error.code === code && !error.message.includes("segredo"));
  assert.throws(() => mapProductsSnapshot({ products: [row(), row({ 0: "sku-1" })] }), { code: "GOOGLE_DUPLICATE_PRODUCT_CODE" });
});

test("limite garante que nenhum produto importado seja truncado pelo contexto da IA", () => {
  const products = Array.from({ length: 100 }, (_, index) => row({ 0: `SKU-${index}` }));
  assert.equal(mapProductsSnapshot({ products }).products.length, 100);
  assert.throws(() => mapProductsSnapshot({ products: [...products, row({ 0: "SKU-101" })] }), { code: "GOOGLE_PRODUCT_LIMIT_EXCEEDED" });
});

test("IDs estáveis independem da posição e da edição do nome", () => {
  const first = mapProductsSnapshot({ products: [row()] }).products[0].id;
  const changed = mapProductsSnapshot({ products: [[], row({ 0: "sku-1", 1: "Outro nome" })] }).products[0].id;
  assert.equal(first, changed);
});

test("valores numéricos não dependem da formatação visual e a leitura legada é preservada", async () => {
  const requests = [];
  const client = new GoogleSheetsClient({ spreadsheetId: "sheet", fetchImpl: async (url) => {
    requests.push(url);
    return { ok: true, async json() { return { values: [row({ 4: 1000, 6: 4990 })] }; } };
  } });
  client.authorize = async () => "token-sintetico";
  await client.getValues("Agenda!A2:I");
  const values = await client.getValues("Produtos!A2:L1000", { valueRenderOption: "UNFORMATTED_VALUE" });
  assert.equal(new URL(requests[0]).searchParams.has("valueRenderOption"), false);
  assert.equal(new URL(requests[1]).searchParams.get("valueRenderOption"), "UNFORMATTED_VALUE");
  assert.equal(mapProductsSnapshot({ products: values }).products[0].powerWatts, 1000);
  assert.equal(mapProductsSnapshot({ products: values }).products[0].price, 4990);
});

test("perfil de produtos nunca escreve na agenda nem exporta pedidos", async () => {
  const mapper = new PostgresGoogleSheetsSnapshotMapper({ connect() { assert.fail("não pode escrever agenda"); } });
  assert.equal((await mapper.map({ products: [row()] }, { profile: "products" }, { empresaId: EMPRESA_ID })).products.length, 1);
  const pool = fakePool(() => ({ rows: [{ id: INTEGRATION_ID, habilitada: true, configuracao: { profile: "products", spreadsheetId: "sheet", version: 2 }, cache_version: 2 }] }));
  const config = await new PostgresGoogleSheetsConfigurationResolver(pool).resolveGoogleSheets({ empresaId: EMPRESA_ID });
  assert.deepEqual(config.imports, { products: "Produtos!A2:L1000" });
  assert.deepEqual(config.exports, {});
  assert.equal(config.healthRange, "Produtos!A1:L1");
});

test("cache antigo, falho ou de versão diferente não oferece preços ao cliente", () => {
  assert.equal(catalogFromProductsCache(cache(), { now }).items[0].price, 4990);
  for (const changes of [
    { status: "indisponivel" }, { last_success_at: new Date(now.getTime() - 600_001) },
    { cache_version: 1 }, { cache_snapshot: { events: [] } }, { last_success_at: null },
  ]) {
    const catalog = catalogFromProductsCache(cache(changes), { now });
    assert.deepEqual(catalog.items, []);
    assert.equal(catalog.source.status, "unavailable");
  }
});

test("falha de leitura preserva último snapshot mas marca sincronização indisponível", async () => {
  let saved; let failure; let fail = false;
  const integration = createGoogleSheetsIntegration({
    configurationResolver: { async resolveGoogleSheets() { return { enabled: true, profile: "products", integrationId: INTEGRATION_ID, spreadsheetId: "sheet", imports: { products: "Produtos!A2:L1000" }, version: 2 }; } },
    credentialResolver: { async resolveGoogleSheets() { return { clientEmail: "sintetico", privateKey: "sintetica" }; } },
    clientFactory: async () => ({ async getValues(_range, options) { assert.equal(options.valueRenderOption, "UNFORMATTED_VALUE"); if (fail) throw new Error("fora"); return [row()]; }, async appendValues() { assert.fail("não exporta"); } }),
    cacheRepository: { async save(_scope, value) { saved = value; }, async load() { return saved; }, async markFailure(_scope, code) { failure = code; } },
    idempotencyRepository: { async runOnce() {} }, snapshotMapper: mapProductsSnapshot, logger: { warn() {} },
  });
  assert.equal((await integration.syncTenant({ empresaId: EMPRESA_ID })).health, "healthy");
  fail = true;
  const result = await integration.syncTenant({ empresaId: EMPRESA_ID });
  assert.equal(result.health, "unavailable");
  assert.equal(result.stale, true);
  assert.equal(result.snapshot.products[0].price, 4990);
  assert.equal(failure, "GOOGLE_SYNC_FAILED");
});

function fakePool(resolveQuery) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config('app.empresa_id'")) return { rows: [] };
      return resolveQuery(sql, params);
    }, release() {},
  };
  return { queries, async connect() { return client; } };
}

test("runtime só lê catálogo do vínculo publicado e habilitado dentro do tenant", async () => {
  for (const enabled of [true, false]) {
    const compiled = compileTenantRuntimeConfigV2({
      schemaVersion: 2, identity: { name: "Empresa sintética" }, modules: ["catalog", "events"],
      menu: { text: "Produtos", options: [{ id: "produtos", label: "Produtos", action: "catalog.list", params: {} }] },
      events: { items: [{ id: "evento-manual", name: "Evento manual", startsAt: "2026-12-01T12:00:00Z", price: 10 }] },
      integrations: [{ id: `integration:${INTEGRATION_ID}`, type: "google_sheets", name: "Produtos", enabled, required: false, credentialRefs: [] }],
    }, { empresaId: EMPRESA_ID, configVersion: 7, draftVersion: 3 });
    const pool = fakePool((sql, params) => {
      if (sql.includes("FROM empresas")) return { rows: [{ id: EMPRESA_ID, configuracao_runtime_modo: "versionado", configuracao_ativa_versao: 7, versao_configuracao: 7 }] };
      if (sql.includes("FROM configuracoes_revisoes")) return { rows: [{ config_version: 7, checksum: compiled.checksum, configuracao_compilada: compiled }] };
      if (sql.includes("FROM integracoes")) {
        assert.equal(enabled, true);
        assert.deepEqual(params, [EMPRESA_ID, [INTEGRATION_ID]]);
        assert.match(sql, /empresa_id = \$1[^]*habilitada[^]*deleted_at IS NULL[^]*profile[^]*id::text = ANY/u);
        return { rows: [cache({ last_success_at: new Date() })] };
      }
      assert.fail(sql);
    });
    const definition = await new PostgresTenantDefinitionRepository(pool).load(EMPRESA_ID);
    const runtime = parseTenantRuntimeConfig(definition.runtime);
    assert.equal(runtime.catalog.items.length, enabled ? 1 : 0);
    assert.equal(runtime.events.items[0].id, "evento-manual");
    if (enabled) assert.equal(runtime.catalog.source.status, "healthy");
    else assert.equal(pool.queries.some(({ sql }) => sql.includes("FROM integracoes")), false);
  }
});
