import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresWebhookRepository } from "../src/infra/postgres/repositories/webhook-repository.js";
import { PostgresJobHandlerRepository } from "../src/modules/jobs/handlers.js";
import { ConversationService } from "../src/modules/conversations/conversation-service.js";
import { PostgresConversationRepository } from "../src/modules/conversations/postgres-conversation-repository.js";
import { loadConversationContext } from "../src/modules/ai/conversation-context.js";

test("PostgreSQL: 24h e novo repositório preservam conversa, modelos, dados e simulação parcialmente cancelada", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "true",
}, async () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, options: "-c app.is_platform_admin=true" });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let empresaId;
  try {
    empresaId = (await owner.query("INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1,'Referências sintéticas','Referências sintéticas','ativa') RETURNING id", ["refs-" + randomUUID()])).rows[0].id;
    const numeroWhatsappId = (await owner.query("INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status) VALUES($1,$2,'ativo') RETURNING id", [empresaId, randomUUID()])).rows[0].id;
    const webhooks = new PostgresWebhookRepository(pool);
    const inbound = (text, occurredAt = new Date()) => webhooks.withTenantTransaction({ empresaId }, (tx) => webhooks.insertInboundMessage(tx, {
      empresaId, numeroWhatsappId, correlationId: randomUUID(), event: { externalMessageId: "wamid." + randomUUID(),
        messageType: "text", text, senderPhone: "5511999999999", occurredAt },
    }));
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const first = await inbound("Quero simular ECOSPORT FREESTYLE e KA SE PLUS 1.5. Meu nome é Ana Teste.", old);
    let handlers = new PostgresJobHandlerRepository(pool);
    const scope = { empresaId, conversationId: first.conversationId };
    const send = async (anchor, text, websiteInteraction) => {
      const message = await handlers.inboundMessage({ empresaId, messageId: anchor.messageId });
      const reply = await handlers.prepareReply({ empresaId, message, origin: "ai", reply: { text, websiteInteraction } });
      await handlers.markReplySent({ empresaId, replyId: reply.id, externalMessageId: "wamid." + randomUUID() });
    };
    await send(first, "Vamos simular ambos. Qual o valor da entrada?", { step: "finance_accepted", productIds: ["turim:1", "turim:2"] });
    await owner.query("UPDATE mensagens SET created_at=$2 WHERE empresa_id=$1", [empresaId, old]);
    const second = await inbound("Quero saber mais deles primeiro");
    assert.equal(second.conversationId, first.conversationId);
    // Recreate all services: no process-local memory or provider session.
    handlers = new PostgresJobHandlerRepository(pool);
    assert.deepEqual(await handlers.financingSession({ ...scope, messageId: second.messageId }), { productIds: ["turim:1", "turim:2"], status: "pending" });
    await send(second, "ECOSPORT FREESTYLE e KA SE PLUS 1.5 continuam em análise.", { step: "discussion", productIds: ["turim:1", "turim:2"] });
    const third = await inbound("Não quero mais simular o primeiro");
    assert.deepEqual((await handlers.websiteInteraction({ ...scope, messageId: third.messageId })).productIds, ["turim:1", "turim:2"]);
    await send(third, "Vamos manter a simulação do KA SE PLUS 1.5.", { step: "declined", productIds: ["turim:1"] });
    const fourth = await inbound("Tenho 10 mil de entrada para ele");
    assert.deepEqual(await new PostgresJobHandlerRepository(pool).financingSession({ ...scope, messageId: fourth.messageId }), {
      productId: "turim:2", productIds: ["turim:2"], status: "pending",
    });
    const context = await loadConversationContext(new ConversationService({ repository: new PostgresConversationRepository(pool) }), {
      ...scope, messageId: fourth.messageId, message: "Tenho 10 mil de entrada para ele",
    }, new Date());
    assert.ok(context.input.some((item) => item.content.includes("ECOSPORT FREESTYLE e KA SE PLUS 1.5")));
    assert.ok(context.evidence.some((body) => body.includes("Ana Teste")));
    assert.equal(await handlers.financingSession({ ...scope, empresaId: randomUUID(), messageId: fourth.messageId }), null);
  } finally {
    if (empresaId) {
      for (const table of ["outbox_jobs", "mensagens", "estados_conversa", "conversas", "contatos", "numeros_whatsapp"]) await owner.query("DELETE FROM " + table + " WHERE empresa_id=$1", [empresaId]);
      await owner.query("DELETE FROM empresas WHERE id=$1", [empresaId]);
    }
    await pool.end();
    await owner.end();
  }
});
