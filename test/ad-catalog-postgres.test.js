import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresWebhookRepository } from "../src/infra/postgres/repositories/webhook-repository.js";
import { PostgresJobHandlerRepository } from "../src/modules/jobs/handlers.js";
import { PostgresConversationRepository } from "../src/modules/conversations/postgres-conversation-repository.js";

test("PostgreSQL real: anúncio persiste isolado; confirmação registra interesse/pausa uma vez e respeita humano/privacidade", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "true",
}, async () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let empresaId;
  try {
    empresaId = (await owner.query("INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1,'Ad sintético','Ad sintético','ativa') RETURNING id", [`ad-catalog-${randomUUID()}`])).rows[0].id;
    const numeroWhatsappId = (await owner.query("INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status) VALUES($1,$2,'ativo') RETURNING id", [empresaId, randomUUID()])).rows[0].id;
    const webhooks = new PostgresWebhookRepository(pool), handlers = new PostgresJobHandlerRepository(pool);
    const inbound = (text, adReferral) => webhooks.withTenantTransaction({ empresaId }, (tx) => webhooks.insertInboundMessage(tx, { empresaId, numeroWhatsappId, correlationId: randomUUID(), event: {
      externalMessageId: `wamid.${randomUUID()}`, messageType: "text", text, senderPhone: "5511999999999", occurredAt: new Date(), ...(adReferral ? { adReferral } : {}),
    } }));
    const first = await inbound("Olá! Posso ter mais informações sobre isso?", { body: "HARLEY — 1000W", headline: "Anúncio", source_type: "ad", image_url: "https://example.com/not-stored" });
    const scope = { empresaId, conversationId: first.conversationId, messageId: first.messageId };
    assert.deepEqual(await handlers.adReferral(scope), { body: "HARLEY — 1000W", headline: "Anúncio", source_type: "ad" });
    const followup = await inbound("Qual o valor?");
    assert.deepEqual(await new PostgresJobHandlerRepository(pool).adReferral({ ...scope, messageId: followup.messageId }), await handlers.adReferral(scope));
    assert.equal(await handlers.adReferral({ ...scope, empresaId: randomUUID() }), null);
    assert.equal(await handlers.adReferral({ ...scope, conversationId: randomUUID() }), null);
    assert.deepEqual((await handlers.inboundMessage({ empresaId, messageId: first.messageId })).adReferral, await handlers.adReferral(scope));
    // A later ad cannot leak back into an older job. It replaces the context going forward, even if unknown.
    const later = await inbound("Quero informações", { body: "Modelo sem correspondência" });
    assert.equal((await handlers.adReferral({ ...scope, messageId: later.messageId })).body, "Modelo sem correspondência");
    assert.equal((await handlers.adReferral({ ...scope, messageId: followup.messageId })).body, "HARLEY — 1000W");
    const choice = await inbound("Gostei da Harley");
    const message = await handlers.inboundMessage({ empresaId, messageId: choice.messageId });
    const input = { empresaId, message, origin: "ai", reply: { text: "Encerramento aprovado", salesInterest: { products: [{ id: "harley", name: "HARLEY" }] } } };
    const prepared = await handlers.prepareReply(input);
    assert.equal((await owner.query("SELECT modo_atendimento FROM conversas WHERE id=$1", [message.conversationId])).rows[0].modo_atendimento, "bot");
    await assert.rejects(handlers.markReplySent({ empresaId, replyId: prepared.id, externalMessageId: null }), { code: "BOT_REPLY_SEND_ID_MISSING" });
    const providerId = `wamid.${randomUUID()}`;
    await handlers.markReplySent({ empresaId, replyId: prepared.id, externalMessageId: providerId });
    assert.equal((await owner.query("SELECT modo_atendimento FROM conversas WHERE id=$1", [message.conversationId])).rows[0].modo_atendimento, "pausado");
    assert.equal(await handlers.canSendBotReply({ empresaId, messageId: message.id }), false);
    const noteCount = async () => Number((await owner.query("SELECT count(*) FROM mensagens WHERE empresa_id=$1 AND direcao='interna'", [empresaId])).rows[0].count);
    assert.equal(await noteCount(), 1);
    await Promise.all([1,2].map(() => handlers.markReplySent({ empresaId, replyId: prepared.id, externalMessageId: providerId })));
    assert.equal(await noteCount(), 1);
    await handlers.markReplySent({ empresaId: randomUUID(), replyId: prepared.id, externalMessageId: "wamid.foreign" });
    assert.equal(await noteCount(), 1);
    // Taking ownership while a close is in flight must never be overwritten by its acknowledgement.
    await owner.query("UPDATE conversas SET modo_atendimento='bot' WHERE id=$1", [message.conversationId]);
    await handlers.markReplySent({ empresaId, replyId: prepared.id, externalMessageId: providerId });
    assert.equal((await owner.query("SELECT modo_atendimento FROM conversas WHERE id=$1", [message.conversationId])).rows[0].modo_atendimento, "bot");
    const another = await inbound("Também quero Yala");
    const anotherMessage = await handlers.inboundMessage({ empresaId, messageId: another.messageId });
    const anotherReply = await handlers.prepareReply({ ...input, message: anotherMessage });
    await owner.query("UPDATE conversas SET modo_atendimento='humano' WHERE id=$1", [message.conversationId]);
    await handlers.markReplySent({ empresaId, replyId: anotherReply.id, externalMessageId: `wamid.${randomUUID()}` });
    assert.equal((await owner.query("SELECT modo_atendimento FROM conversas WHERE id=$1", [message.conversationId])).rows[0].modo_atendimento, "humano");
    assert.equal(await noteCount(), 2);
    const retention = new PostgresConversationRepository(pool);
    await retention.anonymizeMessagesBefore({ empresaId, before: new Date(Date.now() + 60_000), limit: 100, redactedAt: new Date() });
    assert.equal(await handlers.adReferral({ ...scope, messageId: later.messageId }), null);
    assert.deepEqual((await owner.query("SELECT outbound_payload FROM mensagens WHERE id=$1", [first.messageId])).rows[0].outbound_payload, {});
    assert.deepEqual((await owner.query("SELECT outbound_payload FROM mensagens WHERE id=$1", [prepared.id])).rows[0].outbound_payload, {});
  } finally {
    if (empresaId) {
      for (const table of ["mensagens", "estados_conversa", "conversas", "contatos", "numeros_whatsapp"]) await owner.query(`DELETE FROM ${table} WHERE empresa_id=$1`, [empresaId]);
      await owner.query("DELETE FROM empresas WHERE id=$1", [empresaId]);
    }
    await pool.end(); await owner.end();
  }
});
