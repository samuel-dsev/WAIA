import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresAiLedger } from "../src/modules/ai/postgres-adapters.js";
import { PostgresAdminRepository } from "../src/modules/admin/postgres-admin-repository.js";
import { withTenantTransaction } from "../src/infra/postgres/transaction.js";

test("PostgreSQL: cache persiste sem alterar quota, histórico, isolamento ou idempotência", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "true",
}, async () => {
  assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/waia_v2_/u);
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, options: "-c app.is_platform_admin=true" });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const tenants = [];
  try {
    for (let i = 0; i < 2; i++) {
      const empresaId = (await owner.query("INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1,'Cache sintético','Cache sintético','ativa') RETURNING id", ["cache-" + randomUUID()])).rows[0].id;
      tenants.push(empresaId);
    }
    const empresaId = tenants[0];
    const numberId = (await owner.query("INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status) VALUES($1,$2,'ativo') RETURNING id", [empresaId, randomUUID()])).rows[0].id;
    const contactId = (await owner.query("INSERT INTO contatos(empresa_id,telefone_normalizado) VALUES($1,'5511000000001') RETURNING id", [empresaId])).rows[0].id;
    const conversationId = (await owner.query("INSERT INTO conversas(empresa_id,contato_id,numero_whatsapp_id) VALUES($1,$2,$3) RETURNING id", [empresaId, contactId, numberId])).rows[0].id;
    // Existing integrations that omit the new fields keep unknown cache usage.
    const legacyId = (await owner.query("INSERT INTO uso_ia(empresa_id,conversa_id,provedor,modelo,tipo_chave,input_tokens,output_tokens,total_tokens,custo_estimado,sucesso,correlation_id) VALUES($1,$2,'openai','test','compartilhada',10,1,11,0.001,true,$3) RETURNING id", [empresaId, conversationId, randomUUID()])).rows[0].id;
    const legacy = (await owner.query("SELECT cached_input_tokens,cache_write_input_tokens,cache_adjusted_cost FROM uso_ia WHERE id=$1", [legacyId])).rows[0];
    assert.deepEqual(legacy, { cached_input_tokens: null, cache_write_input_tokens: null, cache_adjusted_cost: null });
    const ledger = new PostgresAiLedger(pool);
    const reservation = await ledger.reserve({ empresaId, estimatedTokens: 20000, estimatedCost: 0.01, tokenLimit: 100000, costLimit: 1, alertPercent: 80 });
    const event = { empresaId, reservationId: reservation.reservationId, conversationId, correlationId: randomUUID(), provider: "openai", model: "test", keyType: "shared",
      inputTokens: 10000, outputTokens: 1000, cachedInputTokens: 8000, cacheWriteInputTokens: 0, cacheAdjustedCost: 0.0032,
      cost: 0.0056, pricingVersion: "synthetic-cache", configVersion: 1, success: true };
    const finalized = await ledger.finalize(event);
    assert.equal(finalized.usage.tokens, 11000);
    assert.equal(finalized.usage.cost, 0.0056);
    const repeated = await ledger.finalize({ ...event, cachedInputTokens: 0, cacheAdjustedCost: 0.0056 });
    assert.deepEqual(repeated.usage, finalized.usage);
    await assert.rejects(ledger.finalize({ ...event, empresaId: tenants[1] }), /Reserva de IA não encontrada/u);
    const rows = (await owner.query("SELECT * FROM uso_ia WHERE empresa_id=$1 AND reservation_id=$2", [empresaId, reservation.reservationId])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cached_input_tokens, 8000);
    assert.equal(Number(rows[0].cache_adjusted_cost), 0.0032);
    const page = await new PostgresAdminRepository(pool).list({ resource: "ai-usage", empresaId, filters: { conversationId } });
    const record = page.items.find(row => row.id === rows[0].id);
    assert.equal(record.cachedInputTokens, 8000);
    assert.equal(record.cacheWriteInputTokens, 0);
    assert.equal(Number(record.cacheAdjustedCost), 0.0032);
    const isolated = await new PostgresAdminRepository(pool).list({ resource: "ai-usage", empresaId: tenants[1], filters: { conversationId } });
    assert.equal(isolated.items.length, 0);
    await withTenantTransaction(pool, { empresaId: tenants[1] }, async ({ client }) => {
      assert.equal((await client.query("SELECT id FROM uso_ia WHERE empresa_id=$1", [empresaId])).rowCount, 0);
    });
    await assert.rejects(owner.query("UPDATE uso_ia SET cached_input_tokens=10001 WHERE id=$1", [rows[0].id]), error => error.code === "23514");
    await assert.rejects(owner.query("UPDATE uso_ia SET cache_write_input_tokens=3000 WHERE id=$1", [rows[0].id]), error => error.code === "23514");
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM mensagens WHERE empresa_id=$1", [empresaId])).rows[0].n, 0);
  } finally {
    for (const empresaId of tenants) {
      for (const table of ["uso_ia", "ai_quota_reservations", "ai_quota_accounts", "conversas", "contatos", "numeros_whatsapp"]) {
        await owner.query(`DELETE FROM ${table} WHERE empresa_id=$1`, [empresaId]);
      }
      await owner.query("DELETE FROM empresas WHERE id=$1", [empresaId]);
    }
    await pool.end();
    await owner.end();
  }
});
