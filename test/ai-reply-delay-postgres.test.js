import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresJobHandlerRepository } from "../src/modules/jobs/handlers.js";
import { PostgresJobRepository } from "../src/modules/jobs/postgres-repository.js";

test("PostgreSQL real: prazo persiste, job aguarda e permissão de envio é revalidada", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "true",
}, async () => {
  assert.ok(process.env.DATABASE_URL); assert.ok(process.env.DATABASE_MIGRATOR_URL);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  let empresaId;
  try {
    empresaId = (await owner.query("INSERT INTO empresas (slug,nome,nome_exibicao,status) VALUES ($1,'Espera IA','Espera IA','ativa') RETURNING id", ["ai-delay-" + randomUUID()])).rows[0].id;
    const contactId = (await owner.query("INSERT INTO contatos (empresa_id,telefone_normalizado) VALUES ($1,'5511000000001') RETURNING id", [empresaId])).rows[0].id;
    const numberId = (await owner.query("INSERT INTO numeros_whatsapp (empresa_id,phone_number_id,status) VALUES ($1,$2,'ativo') RETURNING id", [empresaId, randomUUID()])).rows[0].id;
    const conversationId = (await owner.query("INSERT INTO conversas (empresa_id,contato_id,numero_whatsapp_id,correlation_id) VALUES ($1,$2,$3,$4) RETURNING id", [empresaId, contactId, numberId, randomUUID()])).rows[0].id;
    const messageId = (await owner.query("INSERT INTO mensagens (empresa_id,conversa_id,contato_id,numero_whatsapp_id,direcao,tipo,corpo,status,sequence,correlation_id) VALUES ($1,$2,$3,$4,'entrada','texto','Teste','processando',1,$5) RETURNING id", [empresaId, conversationId, contactId, numberId, randomUUID()])).rows[0].id;
    await owner.query("UPDATE conversas SET next_sequence=2 WHERE id=$1", [conversationId]);
    const jobId = (await owner.query("INSERT INTO outbox_jobs (empresa_id,conversa_id,mensagem_id,job_type,dedup_key,status,correlation_id) VALUES ($1,$2,$3,'process_inbound_message',$4,'em_publicacao',$5) RETURNING id", [empresaId, conversationId, messageId, randomUUID(), randomUUID()])).rows[0].id;
    const sendNotBefore = new Date(Date.now() + 45_000).toISOString();
    const handlers = new PostgresJobHandlerRepository(pool);
    const first = await handlers.prepareReply({ empresaId, message: { id: messageId, conversationId, contactId, numeroWhatsappId: numberId, correlationId: randomUUID() }, reply: { text: "Resposta pronta", sendNotBefore }, origin: "ai" });
    assert.equal(first.sendNotBefore, sendNotBefore);
    assert.equal((await new PostgresJobHandlerRepository(pool).preparedReply({ empresaId, messageId })).sendNotBefore, sendNotBefore);
    const jobs = new PostgresJobRepository(pool), reference = { empresaId, jobId, messageId, conversationId };
    await jobs.defer(reference, { until: sendNotBefore });
    assert.equal((await jobs.claim(reference)).outcome, "deferred");
    assert.equal(await handlers.canSendBotReply({ empresaId, messageId }), true);
    await owner.query("UPDATE conversas SET modo_atendimento='pausado' WHERE id=$1", [conversationId]);
    assert.equal(await handlers.canSendBotReply({ empresaId, messageId }), false);
    await handlers.cancelPreparedReply({ empresaId, messageId });
    assert.equal((await handlers.preparedReply({ empresaId, messageId })).status, "ignorada_duplicidade");
    await owner.query("UPDATE conversas SET modo_atendimento='bot' WHERE id=$1", [conversationId]);
    await owner.query("UPDATE contatos SET bot_pausado=true WHERE id=$1", [contactId]);
    assert.equal(await handlers.canSendBotReply({ empresaId, messageId }), false);
    assert.equal(await handlers.canSendBotReply({ empresaId: randomUUID(), messageId }), false);
  } finally {
    if (empresaId) {
      for (const table of ["outbox_jobs", "mensagens", "conversas", "contatos", "numeros_whatsapp"]) await owner.query(`DELETE FROM ${table} WHERE empresa_id=$1`, [empresaId]);
      await owner.query("DELETE FROM empresas WHERE id=$1", [empresaId]);
    }
    await pool.end(); await owner.end();
  }
});
