import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresWebhookRepository } from "../src/infra/postgres/repositories/webhook-repository.js";
import { PostgresJobHandlerRepository, createWorkerHandlers } from "../src/modules/jobs/handlers.js";
import { ConversationService } from "../src/modules/conversations/conversation-service.js";
import { PostgresConversationRepository } from "../src/modules/conversations/postgres-conversation-repository.js";
import { websiteGalleriesReply } from "../src/modules/business/website-catalog-interaction.js";

test("PostgreSQL: turno durável reúne mensagens, invalida envio antigo e mantém pendência de simulação após fotos", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "true",
}, async () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, options: "-c app.is_platform_admin=true" });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let empresaId;
  try {
    empresaId = (await owner.query("INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1,'Turnos sintéticos','Turnos sintéticos','ativa') RETURNING id", [`turn-${randomUUID()}`])).rows[0].id;
    const numeroWhatsappId = (await owner.query("INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status) VALUES($1,$2,'ativo') RETURNING id", [empresaId, randomUUID()])).rows[0].id;
    const webhooks = new PostgresWebhookRepository(pool), handlers = new PostgresJobHandlerRepository(pool);
    const inbound = (text) => webhooks.withTenantTransaction({ empresaId }, (tx) => webhooks.insertInboundMessage(tx, {
      empresaId, numeroWhatsappId, correlationId: randomUUID(), event: { externalMessageId: `wamid.${randomUUID()}`,
        messageType: "text", text, senderPhone: "5511999999999", occurredAt: new Date() },
    }));
    const first = await inbound("Entendi"), second = await inbound("Pode sim");
    const scope = { empresaId, conversationId: first.conversationId, messageId: first.messageId };
    const turn = await handlers.inboundTurn(scope);
    assert.equal(turn.messageId, second.messageId);
    assert.deepEqual(turn.messages.map((part) => part.text), ["Entendi", "Pode sim"]);
    assert.ok(Date.parse(turn.readyAt) > Date.now());
    assert.equal(await handlers.inboundTurn({ ...scope, empresaId: randomUUID() }), null);
    const anchor = await handlers.inboundMessage({ empresaId, messageId: second.messageId });
    const prepared = await handlers.prepareReply({ empresaId, message: anchor, origin: "ai",
      reply: { text: "Lista de modelos", inboundTurnSequence: turn.sequence } });
    assert.equal(await handlers.canSendBotReply({ empresaId, messageId: second.messageId }), true);
    const third = await inbound("Tem fotos dos dois?");
    assert.equal(await handlers.canSendBotReply({ empresaId, messageId: second.messageId }), false);
    assert.equal((await handlers.claimBotDispatch({ empresaId, messageId: second.messageId, replyId: prepared.id })).allowed, false);
    assert.equal((await handlers.preparedReply({ empresaId, messageId: second.messageId })).status, "ignorada_duplicidade");
    const next = await handlers.inboundTurn(scope);
    assert.deepEqual(next.messages.map((part) => part.text), ["Entendi", "Pode sim", "Tem fotos dos dois?"]);
    const latest = await handlers.inboundMessage({ empresaId, messageId: third.messageId });
    const accepted = await handlers.prepareReply({ empresaId, message: latest, origin: "ai", reply: {
      text: "Vamos continuar a simulação quando você quiser.", inboundTurnSequence: next.sequence,
      websiteInteraction: { step: "finance_accepted", productIds: ["turim:1"] },
    } });
    await handlers.markReplySent({ empresaId, replyId: accepted.id, externalMessageId: `wamid.${randomUUID()}` });
    assert.equal(await handlers.inboundTurn(scope), null);
    const photoRequest = await inbound("Quero ver as fotos antes");
    const photoScope = { ...scope, messageId: photoRequest.messageId };
    assert.deepEqual((await handlers.inboundTurn(photoScope)).messages.map((part) => part.text), ["Quero ver as fotos antes"]);
    assert.deepEqual(await handlers.financingSession(photoScope), { productId: "turim:1", productIds: ["turim:1"], status: "pending" });
    const items = [1, 2].map((id) => ({ id: `turim:${id}`, name: `Modelo ${id}`,
      imageUrls: Array.from({ length: 100 }, (_, i) => `https://turimautos.com/storage/veiculos/car-${id}-${i}.jpg`) }));
    const gallery = await handlers.prepareReply({ empresaId, origin: "ai",
      message: await handlers.inboundMessage({ empresaId, messageId: photoRequest.messageId }), reply: websiteGalleriesReply(items) });
    assert.equal(gallery.messages.length, 200);
    assert.deepEqual(gallery.messages.filter((part) => part.imageUrl).map((part) => part.catalogProductId), [...Array(100).fill("turim:1"), ...Array(100).fill("turim:2")]);
    await handlers.markReplySent({ empresaId, replyId: gallery.messages[0].id, externalMessageId: `wamid.${randomUUID()}` });
    await handlers.markReplySent({ empresaId, replyId: gallery.messages.at(-1).id, externalMessageId: `wamid.${randomUUID()}` });
    const resume = await inbound("Pode continuar a simulação do primeiro");
    assert.deepEqual(await handlers.catalogPhotosPresented({ ...scope, messageId: resume.messageId }), ["turim:1", "turim:2"]);
    assert.deepEqual(await handlers.financingSession({ ...scope, messageId: resume.messageId }), { productId: "turim:1", productIds: ["turim:1"], status: "pending" });
    assert.deepEqual((await handlers.websiteInteraction({ ...scope, messageId: resume.messageId })).productIds, ["turim:1", "turim:2"]);
    // Execute the worker with the real repositories, including the oldest job
    // answering the newest message and restart/deduplication afterwards.
    const sent = [], generated = [];
    let now = Date.now();
    const dependencies = { repository: handlers,
      conversationService: new ConversationService({ repository: new PostgresConversationRepository(pool) }),
      tenantDefinitionRepository: { async load() { return {
        runtime: { empresaId, identity: { name: "Teste" }, enabledModules: ["ai_freeform"], menu: { text: "Menu", options: [] } },
        ai: { enabled: true, prompt: "Responda à solicitação atual", responseDelayEnabled: false },
        routing: { fallbackAction: "ai_freeform.reply" },
      }; } },
      aiService: { async reply(input) { generated.push(input); return { source: "ai", text: "Resposta do turno completo" }; } },
      metaGateway: { async sendReply(_context, reply) { sent.push(reply); return { id: `wamid.${randomUUID()}` }; } },
      clock: () => new Date(now), logger: { info() {}, warn() {} },
    };
    const last = await inbound("E gostaria de saber o horário");
    const reference = { empresaId, messageId: resume.messageId, conversationId: resume.conversationId };
    const deferred = await createWorkerHandlers(dependencies).process_inbound_message(reference);
    assert.ok(deferred.deferUntil); assert.equal(generated.length, 0);
    now = Date.parse(deferred.deferUntil);
    assert.equal((await createWorkerHandlers(dependencies).process_inbound_message(reference)).replied, true);
    assert.equal(generated.length, 1); assert.equal(sent.length, 1);
    assert.equal(generated[0].messageId, last.messageId);
    assert.deepEqual(generated[0].turnMessages.map((part) => part.text), ["Pode continuar a simulação do primeiro", "E gostaria de saber o horário"]);
    assert.equal((await createWorkerHandlers(dependencies).process_inbound_message(reference)).reason, "inbound_turn_already_answered");
    assert.equal((await createWorkerHandlers(dependencies).process_inbound_message({ ...reference, messageId: last.messageId })).resumed, true);
    assert.equal(sent.length, 1);
  } finally {
    if (empresaId) {
      for (const table of ["outbox_jobs", "mensagens", "estados_conversa", "conversas", "contatos", "numeros_whatsapp"]) await owner.query(`DELETE FROM ${table} WHERE empresa_id=$1`, [empresaId]);
      await owner.query("DELETE FROM empresas WHERE id=$1", [empresaId]);
    }
    await pool.end(); await owner.end();
  }
});
