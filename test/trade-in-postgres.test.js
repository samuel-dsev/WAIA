import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { compileTenantRuntimeConfigV2, materializeLegacyTenantDefinition } from "../src/modules/configuration/index.js";
import { PostgresWebhookRepository } from "../src/infra/postgres/repositories/webhook-repository.js";
import { PostgresJobHandlerRepository, createWorkerHandlers } from "../src/modules/jobs/handlers.js";
import { ConversationService } from "../src/modules/conversations/conversation-service.js";
import { PostgresConversationRepository } from "../src/modules/conversations/postgres-conversation-repository.js";
import { loadConversationContext } from "../src/modules/ai/conversation-context.js";
import { notificationText } from "../src/modules/group-notifier/qualification.js";

test("PostgreSQL: fotos e textos formam um turno, contexto retoma e avaliação gera uma ficha e uma entrega", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "true",
}, async () => {
  assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/waia_v2_/u);
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, options: "-c app.is_platform_admin=true" });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let empresaId, actorId;
  try {
    actorId = (await owner.query("INSERT INTO usuarios(email,nome,password_hash,papel_plataforma) VALUES($1,'Avaliação sintética','synthetic','administrador') RETURNING id", [randomUUID() + "@example.test"])).rows[0].id;
    empresaId = (await owner.query("INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1,'Avaliação sintética','Avaliação sintética','ativa') RETURNING id", ["evaluation-" + randomUUID()])).rows[0].id;
    const compiled = compileTenantRuntimeConfigV2({ schemaVersion: 2, identity: { name: "Avaliação sintética" },
      modules: ["ai_freeform", "human_handoff"], menu: { text: "Olá", options: [] },
      ai: { enabled: true, provider: "openai", model: "test", prompt: "Atenda o pedido completo.",
        leadQualificationEnabled: true, leadQualificationCriteria: "Nome e aceite da avaliação.", tradeInEvaluationEnabled: true } },
    { empresaId, configVersion: 1, draftVersion: 1 });
    await owner.query("INSERT INTO configuracoes_revisoes(empresa_id,config_version,schema_version,compiler_version,source_draft_version,checksum,configuracao_compilada,publicada_por) VALUES($1,1,2,1,1,$2,$3::jsonb,$4)",
      [empresaId, compiled.checksum, JSON.stringify(compiled), actorId]);
    await owner.query("UPDATE empresas SET configuracao_runtime_modo='versionado',versao_configuracao=1,configuracao_ativa_versao=1 WHERE id=$1", [empresaId]);
    const numeroWhatsappId = (await owner.query("INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status) VALUES($1,$2,'ativo') RETURNING id", [empresaId, randomUUID()])).rows[0].id;
    await owner.query("INSERT INTO group_notifier_routes(empresa_id,group_id,group_name,sender_phone,enabled) VALUES($1,$2,'Grupo sintético','+5511000000001',true)",
      [empresaId, "9" + Date.now() + String(Math.random()).slice(2, 8) + "@g.us"]);
    const webhooks = new PostgresWebhookRepository(pool), repository = new PostgresJobHandlerRepository(pool);
    const inbound = (text, messageType = "text") => webhooks.withTenantTransaction({ empresaId }, (tx) => webhooks.insertInboundMessage(tx, {
      empresaId, numeroWhatsappId, correlationId: randomUUID(), event: { externalMessageId: "wamid." + randomUUID(),
        messageType, text, ...(messageType === "image" ? { media: { externalId: "media-" + randomUUID() } } : {}),
        senderPhone: "5511999999999", occurredAt: new Date() },
    }));
    const first = await inbound("Sou Ana, posso mandar fotos do HB20 cinza 2016 que vou dar na troca?");
    const photo1 = await inbound("", "image"), photo2 = await inbound("Esse é meu veículo de troca", "image");
    const scope = { empresaId, conversationId: first.conversationId, messageId: first.messageId };
    const textOnly = await repository.inboundTurn(scope);
    assert.equal(textOnly.messages.length, 1);
    const mixed = await repository.inboundTurn({ ...scope, includeImages: true });
    assert.equal(mixed.messageId, photo2.messageId);
    assert.deepEqual(mixed.messages.map((part) => part.type || "text"), ["text", "image", "image"]);
    assert.equal(mixed.messages[1].mediaStored, false);
    assert.ok(Date.parse(mixed.readyAt) > Date.now());
    assert.equal(await repository.inboundTurn({ ...scope, empresaId: randomUUID(), includeImages: true }), null);
    const sent = [], generated = [];
    const service = new ConversationService({ repository: new PostgresConversationRepository(pool) });
    const dependencies = { repository, conversationService: service,
      clock: () => new Date(Date.now() + 16_000),
      tenantDefinitionRepository: { async load() { return materializeLegacyTenantDefinition(compiled); } },
      aiService: { async reply(input) {
        generated.push(input);
        assert.equal(input.turnMessages.filter((part) => part.type === "image").length, 2);
        return { source: "ai", text: "Obrigada pelas fotos! Você já tem um modelo em mente?",
          tradeInEvaluation: { step: "collect_photos", interestName: null, interestSource: "unknown" } };
      } },
      metaGateway: { async sendReply(_scope, part) { sent.push(part); return { id: "wamid." + randomUUID() }; } },
    };
    assert.equal((await createWorkerHandlers(dependencies).process_inbound_message({ empresaId, messageId: first.messageId })).replied, true);
    assert.equal(sent.length, 1);
    assert.equal(generated.length, 1);
    assert.equal((await createWorkerHandlers(dependencies).process_inbound_message({ empresaId, messageId: first.messageId })).reason, "inbound_turn_already_answered");
    assert.equal(sent.length, 1);
    const visit = await inbound("Quero uma avaliação presencial. Sou Ana.");
    const visitScope = { ...scope, messageId: visit.messageId };
    assert.equal((await new PostgresJobHandlerRepository(pool).tradeInEvaluationSession(visitScope)).step, "collect_photos");
    const context = await loadConversationContext(service, { ...visitScope, message: "Quero uma avaliação presencial. Sou Ana." }, new Date(), { includeIncomingImages: true });
    assert.equal(context.input.filter((part) => part.content.startsWith("[Imagem recebida")).length, 2);
    const summary = "Solicita avaliação presencial. Dados coletados: troca de HB20 cinza, 2016; duas fotos recebidas.\nInteresse: Possível interesse: Onix Joy.";
    const final = await repository.prepareReply({ empresaId, origin: "ai",
      message: await repository.inboundMessage({ empresaId, messageId: visit.messageId }),
      reply: { text: "Obrigada, Ana! O vendedor combinará os detalhes da avaliação.",
        tradeInEvaluation: { step: "completed", interestName: "Onix Joy", interestSource: "ad" },
        leadQualification: { name: "Ana", summary, qualification: "Necessita avaliação presencial do veículo. Horário a combinar.", configVersion: 1 } } });
    for (let repeat = 0; repeat < 2; repeat++) await repository.markReplySent({ empresaId, replyId: final.id, externalMessageId: "wamid." + final.id });
    const leads = (await owner.query("SELECT * FROM qualified_leads WHERE empresa_id=$1", [empresaId])).rows;
    assert.equal(leads.length, 1);
    assert.equal(leads[0].summary, summary);
    assert.match(notificationText({ companyName: "Teste", ...leads[0] }), /Possível interesse: Onix Joy/u);
    assert.equal((await owner.query("SELECT count(*)::int AS count FROM group_notifier_deliveries WHERE empresa_id=$1", [empresaId])).rows[0].count, 1);
    assert.equal((await service.getConversation(visitScope)).mode, "paused");
  } finally {
    if (empresaId) {
      for (const table of ["group_notifier_deliveries", "qualified_leads", "group_notifier_routes", "outbox_jobs", "mensagens", "estados_conversa", "conversas", "contatos", "numeros_whatsapp"]) {
        await owner.query("DELETE FROM " + table + " WHERE empresa_id=$1", [empresaId]);
      }
      await owner.query("DELETE FROM empresas WHERE id=$1", [empresaId]);
    }
    if (actorId) await owner.query("DELETE FROM usuarios WHERE id=$1", [actorId]);
    await pool.end(); await owner.end();
  }
});
