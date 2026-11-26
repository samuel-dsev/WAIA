import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProviderUsage, addProviderUsage } from "../src/modules/ai/usage.js";
import { normalizePricing, calculateCost, calculateCacheAdjustedCost } from "../src/modules/ai/pricing.js";
import { MemoryAiConfigResolver, MemoryAiLedger, MemoryAiSecretResolver, MemoryPricingCatalog,
  MemoryResponsesClientFactory, MultiTenantAiService } from "../src/modules/ai/index.js";
import { VersionedPricingCatalog } from "../src/modules/ai/postgres-adapters.js";
import { formatAiCost } from "../panel/ai-usage.js";

const pricing = normalizePricing({ inputPerMillion: 0.4, cachedInputPerMillion: 0.1, outputPerMillion: 1.6, version: "synthetic" }, "test");
const responseUsage = (cached = 8000) => ({ input_tokens: 10000, output_tokens: 1000, input_tokens_details: { cached_tokens: cached } });
const request = { empresaId: "tenant-a", conversationId: "conversation-a", messageId: "message-a", correlationId: "correlation-a",
  message: "Qual é o horário?", context: { identity: { name: "Empresa sintética" } } };

function fixture(responder, changes = {}) {
  const config = { empresaId: "tenant-a", enabled: true, provider: "openai", model: "test", keyType: "shared", version: 1,
    prompt: "Roteiro completo. Responda com as informações publicadas.", maxOutputTokens: 1000,
    monthlyTokenLimit: 100000, monthlyCostLimit: 1, allowedContextKeys: ["identity", "catalog"], ...changes };
  const ledger = new MemoryAiLedger();
  const clients = new MemoryResponsesClientFactory(responder);
  const service = new MultiTenantAiService({ configResolver: new MemoryAiConfigResolver([config]), ledger,
    clientFactory: clients, secretResolver: new MemoryAiSecretResolver({ sharedSecret: "synthetic" }),
    pricingCatalog: new MemoryPricingCatalog({ test: pricing }), conversationService: { async getHistory() { return []; } },
    logger: { warn() {}, info() {} }, timeoutMs: 1000 });
  return { service, ledger, clients };
}

test("cache: medição mantém roteiro, histórico, resposta, tokens e quota idênticos", async () => {
  const uncached = fixture(async () => ({ output_text: "Resposta atual.", usage: responseUsage(0) }));
  const cached = fixture(async () => ({ output_text: "Resposta atual.", usage: responseUsage() }));
  const a = await uncached.service.reply(request), b = await cached.service.reply(request);
  assert.deepEqual(cached.clients.requests[0].request, uncached.clients.requests[0].request);
  assert.equal(b.text, a.text);
  assert.deepEqual(b.quota, a.quota);
  assert.equal(b.usage.totalTokens, 11000);
  assert.equal(b.usage.cost, 0.0056);
  assert.equal(b.usage.cacheAdjustedCost, 0.0032);
  assert.equal(cached.ledger.events[0].cachedInputTokens, 8000);
  assert.equal(cached.ledger.events[0].cacheAdjustedCost, 0.0032);
});

test("cache: ausência de medição, zero informado e metadados inválidos são distintos", () => {
  const unknown = normalizeProviderUsage({ usage: { input_tokens: 10000, output_tokens: 1000 } });
  assert.equal(unknown.cachedInputTokens, null);
  assert.equal(calculateCacheAdjustedCost(pricing, unknown), null);
  const zero = normalizeProviderUsage({ usage: responseUsage(0) });
  assert.equal(zero.cachedInputTokens, 0);
  assert.equal(calculateCacheAdjustedCost(pricing, zero), calculateCost(pricing, zero));
  for (const invalid of [-1, 10001, 0.5, Infinity, true, "invalid"]) {
    const usage = normalizeProviderUsage({ usage: responseUsage(invalid) });
    assert.equal(usage.cachedInputTokens, null, String(invalid));
    assert.equal(calculateCacheAdjustedCost(pricing, usage), null);
  }
  const overlap = normalizeProviderUsage({ usage: { ...responseUsage(), input_tokens_details: { cached_tokens: 8000, cache_write_tokens: 3000 } } });
  assert.equal(overlap.cachedInputTokens, null);
  assert.equal(overlap.cacheWriteInputTokens, null);
});

test("cache: tarifa desconhecida e gravação de cache não geram desconto presumido", () => {
  const usage = normalizeProviderUsage({ usage: responseUsage() });
  const withoutCachePrice = normalizePricing({ inputPerMillion: 1, outputPerMillion: 2 }, "custom");
  assert.equal(calculateCacheAdjustedCost(withoutCachePrice, usage), null);
  for (const invalid of [-1, Infinity, "invalid"]) {
    const malformed = normalizePricing({ inputPerMillion: 0.4, outputPerMillion: 1.6, cachedInputPerMillion: invalid }, "custom");
    assert.equal(calculateCacheAdjustedCost(malformed, usage), null);
    assert.equal(calculateCost(malformed, usage), 0.0056);
  }
  const writes = normalizeProviderUsage({ usage: { ...responseUsage(), input_tokens_details: { cached_tokens: 8000, cache_write_tokens: 1000 } } });
  assert.equal(writes.cacheWriteInputTokens, 1000);
  assert.equal(calculateCacheAdjustedCost(pricing, writes), null);
  assert.equal(calculateCost(pricing, writes), 0.0056);
});

test("cache: reavaliação soma chamadas e mantém desconhecido se uma delas não informou cache", async () => {
  for (const complete of [true, false]) {
    let calls = 0;
    const f = fixture(async () => ({ output_text: JSON.stringify({ text: ++calls === 1 ? "" : "O modelo tem câmbio automático. Quer mais detalhes?",
      catalogAction: "details", productIds: ["vehicle-1"], filters: { category: null, minPrice: null, maxPrice: null },
      leadQualification: { status: "collecting", name: null, summary: null, qualification: null } }),
      usage: calls === 2 && !complete ? { input_tokens: 10000, output_tokens: 1000 } : responseUsage() }),
    { leadQualificationEnabled: true, leadQualificationCriteria: "Nome e aceite de simulação." });
    const result = await f.service.reply({ ...request, message: "Quero saber mais sobre o modelo", context: { catalog: {
      source: { type: "website_catalog", status: "healthy" }, salesMode: true, items: [{ id: "vehicle-1", name: "Modelo sintético" }],
      interaction: { step: "gallery", productIds: ["vehicle-1"], direct: true } } } });
    assert.equal(calls, 2);
    assert.equal(result.source, "ai");
    assert.equal(f.ledger.events[0].inputTokens, 20000);
    assert.equal(f.ledger.events[0].cachedInputTokens, complete ? 16000 : null);
    assert.equal(f.ledger.events[0].cacheAdjustedCost, complete ? 0.0064 : null);
  }
  const one = normalizeProviderUsage({ usage: responseUsage() });
  assert.equal(addProviderUsage(one, one).totalTokens, 22000);
});

test("cache: falha de validação preserva o consumo conhecido e não altera contingência", async () => {
  const f = fixture(async () => ({ status: "incomplete", output_text: "Resposta truncada", usage: responseUsage() }));
  const reply = await f.service.reply(request);
  assert.equal(reply.source, "fallback");
  assert.equal(f.ledger.events[0].success, false);
  assert.equal(f.ledger.events[0].cachedInputTokens, 8000);
  assert.equal(f.ledger.events[0].cacheAdjustedCost, 0.0032);
  assert.equal(f.ledger.usage("tenant-a").tokens, 11000);
});

test("cache: follow-up mede a mesma tarifa e conserva prompt e bloqueio mensal", async () => {
  const f = fixture(async () => ({ output_text: JSON.stringify({ text: "Quer retomar a conversa?", summary: "Cliente pediu informações sobre o horário." }), usage: responseUsage() }));
  const input = { ...request, slot: 0, company: "Empresa sintética", messages: [{ direcao: "entrada", corpo: request.message }] };
  await f.service.draftFollowUp(input);
  const event = f.ledger.events[0];
  assert.equal(event.cachedInputTokens, 8000);
  assert.equal(event.cacheAdjustedCost, 0.0032);
  assert.equal(event.cost, 0.0056);
  assert.equal(f.clients.requests[0].request.instructions.includes("Roteiro completo."), false);
  const blocked = fixture(async () => { assert.fail("Não deve chamar o provedor."); }, { monthlyCostLimit: 0 });
  await assert.rejects(blocked.service.draftFollowUp(input), /FOLLOW_UP_AI_BUDGET/u);
  assert.equal(blocked.ledger.events.length, 0);
});

test("cache: catálogo padrão registra tarifa verificada e sobrescrita não herda desconto", async () => {
  const defaults = await new VersionedPricingCatalog().get({ model: "gpt-4.1-mini" });
  assert.equal(defaults.cachedInputPerMillion, 0.1);
  const custom = await new VersionedPricingCatalog({ "gpt-4.1-mini": { inputPerMillion: 4, outputPerMillion: 8, version: "custom" } }).get({ model: "gpt-4.1-mini" });
  assert.equal(custom.cachedInputPerMillion, undefined);
});

test("cache: painel mostra US$, precisão de custo pequeno e medição ausente", () => {
  assert.equal(formatAiCost(null), "—");
  assert.match(formatAiCost(0), /US\$\s*0,0000/u);
  assert.match(formatAiCost("0.00000032"), /0,00000032/u);
  assert.doesNotMatch(formatAiCost(0.0032), /R\$/u);
});
