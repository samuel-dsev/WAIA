import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PostgresAiConfigResolver } from "../src/modules/ai/postgres-adapters.js";
import { PostgresPaymentResolver } from "../src/modules/business/payment-resolver.js";
import { PostgresGoogleSheetsConfigurationResolver } from "../src/integrations/google-sheets/postgres-adapters.js";
import { createConfiguredTenantRuntime } from "../src/tenants/configured-runtime.js";
import { PostgresTenantDefinitionRepository } from "../src/tenants/postgres-config-loader.js";
import { CAPITAO_MOR_DEMO_TENANT_ID } from "../src/tenants/capitao-mor.js";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "true";

function memoryStateRepository() {
  const states = new Map();
  const key = ({ empresaId, conversationId }) => `${empresaId}:${conversationId}`;
  return {
    async load(context) { return structuredClone(states.get(key(context)) || null); },
    async save(context, state) {
      if (state == null) states.delete(key(context));
      else states.set(key(context), structuredClone(state));
    },
  };
}

test("Capitão Mor carregado do PostgreSQL preserva jornada pública e comercial", { skip: !enabled }, async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL é obrigatória");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const paymentResolver = new PostgresPaymentResolver(pool);
    const definition = await new PostgresTenantDefinitionRepository(pool, { paymentResolver })
      .load(CAPITAO_MOR_DEMO_TENANT_ID);

    assert.ok(definition);
    assert.equal(definition.runtime.empresaId, CAPITAO_MOR_DEMO_TENANT_ID);
    assert.deepEqual(definition.runtime.menu.options.map(({ label }) => label), [
      "Comprar convites", "Endereço", "Cardápio",
    ]);
    assert.deepEqual(definition.runtime.events.items.map(({ id, price }) => ({ id, price })), [
      { id: "evento-demo-sexta", price: 25 },
      { id: "evento-demo-sabado", price: 20 },
    ]);
    assert.match(definition.runtime.identity.establishmentRules, /Vestimenta:/u);
    assert.equal(definition.runtime.payments.pix.key, "••••@exemplo.invalid");
    assert.doesNotMatch(JSON.stringify(definition), /access[_-]?token|app[_-]?secret|private[_-]?key/iu);

    const sheets = await new PostgresGoogleSheetsConfigurationResolver(pool)
      .resolveGoogleSheets({ empresaId: CAPITAO_MOR_DEMO_TENANT_ID });
    assert.equal(sheets.enabled, false);
    assert.equal(sheets.exports.orders, "Pedidos!A:G");
    assert.equal(sheets.spreadsheetId, undefined);

    const ai = await new PostgresAiConfigResolver(pool)
      .getAiConfig({ empresaId: CAPITAO_MOR_DEMO_TENANT_ID });
    assert.equal(ai.enabled, true);
    assert.equal(ai.provider, "openai");
    assert.match(ai.prompt, /nunca confirme pagamentos automaticamente/u);

    const orders = [];
    const runtime = createConfiguredTenantRuntime({
      definition,
      stateRepository: memoryStateRepository(),
      orderRepository: { async createPending(order) { orders.push(structuredClone(order)); } },
      logger: { error() {} },
    });
    const context = { conversationId: "phase8-postgres-capitao", contactId: "phase8-contact-capitao" };

    const greeting = await runtime.handle({ ...context, text: "boa noite" });
    assert.deepEqual(greeting.buttons.map(({ label }) => label), ["Comprar convites", "Endereço", "Cardápio"]);
    const agenda = await runtime.handle({ ...context, action: "events.list" });
    assert.match(agenda.text, /Sexta Rock Demo/u);
    assert.match(agenda.text, /Sábado Acústico Demo/u);

    const payment = await runtime.handle({ ...context, selectionId: "event:evento-demo-sexta" });
    assert.match(payment.text, /R\$\s*25,00/u);
    assert.match(payment.text, /PIX: ••••@exemplo\.invalid/u);
    await runtime.handle({ ...context, type: "document", mediaId: "phase8-receipt-capitao" });
    const pending = await runtime.handle({ ...context, text: "Pessoa Sintética" });
    assert.match(pending.text, /Aguardando conferência/u);
    assert.deepEqual(orders.map(({ eventId, amount, status, idempotencyKey }) => ({
      eventId, amount, status, idempotencyKey,
    })), [{
      eventId: "evento-demo-sexta",
      amount: 25,
      status: "Aguardando conferência",
      idempotencyKey: "order:phase8-postgres-capitao:phase8-receipt-capitao",
    }]);
  } finally {
    await pool.end();
  }
});
