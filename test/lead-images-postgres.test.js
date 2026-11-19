import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { compileTenantRuntimeConfigV2, materializeLegacyTenantDefinition } from "../src/modules/configuration/index.js";
import { PrivateMediaStore } from "../src/infra/media/private-media-store.js";
import { PostgresWebhookRepository } from "../src/infra/postgres/repositories/webhook-repository.js";
import { PostgresJobHandlerRepository, createWorkerHandlers } from "../src/modules/jobs/handlers.js";
import { ConversationService } from "../src/modules/conversations/conversation-service.js";
import { PostgresConversationRepository } from "../src/modules/conversations/postgres-conversation-repository.js";
import { PostgresAiConfigResolver } from "../src/modules/ai/postgres-adapters.js";
import { MemoryAiLedger, MemoryAiSecretResolver, MemoryPricingCatalog, MemoryResponsesClientFactory, MultiTenantAiService } from "../src/modules/ai/index.js";
import { PostgresGroupNotifierRepository } from "../src/modules/group-notifier/postgres-repository.js";
import { createGroupNotifierWorker } from "../src/modules/group-notifier/worker.js";
import { withTenantTransaction } from "../src/infra/postgres/transaction.js";

test("PostgreSQL: fotos reconhecidas, nome obrigatório, ficha com anexos e fotos posteriores sem reativar bot", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "true",
}, async (t) => {
  assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/waia_v2_/u);
  const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, options: "-c app.is_platform_admin=true" });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const owner = await adminPool.connect();
  const root = await mkdtemp(path.join(os.tmpdir(), "waia-lead-images-"));
  const mediaStore = new PrivateMediaStore({ root });
  let empresaId, actorId, notifier, connectionSaved = false;
  try {
    await owner.query("CREATE TEMP TABLE lead_images_connection_before AS TABLE group_notifier_connection"); connectionSaved = true;
    assert.equal((await owner.query("SELECT 1 FROM group_notifier_connection WHERE lease_until>now() AND lease_owner IS NOT NULL")).rowCount, 0, "Não interromper um remetente ativo.");
    await owner.query("UPDATE group_notifier_connection SET desired=true,phone='+5511000000099',epoch=epoch+1,phase='connected',lease_owner=NULL,lease_until=NULL");
    actorId = (await owner.query("INSERT INTO usuarios(email,nome,password_hash,papel_plataforma) VALUES($1,'Fotos sintéticas','synthetic','administrador') RETURNING id", [randomUUID() + "@example.test"])).rows[0].id;
    empresaId = (await owner.query("INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1,'Loja sintética','Loja sintética','ativa') RETURNING id", ["lead-images-" + randomUUID()])).rows[0].id;
    const compiled = compileTenantRuntimeConfigV2({ schemaVersion: 2, identity: { name: "Loja sintética" }, modules: ["ai_freeform", "human_handoff"],
      menu: { text: "Saudação de referência", options: [] }, ai: { enabled: true, provider: "openai", model: "test", maxOutputTokens: 1000,
        prompt: "Use os modelos do roteiro. Ao receber fotos para avaliação, reconheça e peça nome se faltar; com nome e fotos encerre para retorno de vendedor.",
        contextualServiceEnabled: true, tradeInEvaluationEnabled: true, leadImageHandoffEnabled: true,
        leadQualificationEnabled: true, leadQualificationCriteria: "Nome e fotos para avaliação recebidas." } }, { empresaId, configVersion: 1, draftVersion: 1 });
    await owner.query("INSERT INTO configuracoes_revisoes(empresa_id,config_version,schema_version,compiler_version,source_draft_version,checksum,configuracao_compilada,publicada_por) VALUES($1,1,2,1,1,$2,$3::jsonb,$4)", [empresaId, compiled.checksum, JSON.stringify(compiled), actorId]);
    await owner.query("UPDATE empresas SET configuracao_runtime_modo='versionado',versao_configuracao=1,configuracao_ativa_versao=1 WHERE id=$1", [empresaId]);
    const numberId = (await owner.query("INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status) VALUES($1,$2,'ativo') RETURNING id", [empresaId, randomUUID()])).rows[0].id;
    const groupId = "9" + Date.now() + String(Math.random()).slice(2, 8) + "@g.us";
    await owner.query("INSERT INTO group_notifier_routes(empresa_id,group_id,group_name,sender_phone,enabled) VALUES($1,$2,'Grupo sintético','+5511000000099',true)", [empresaId, groupId]);
    const webhooks = new PostgresWebhookRepository(pool), repository = new PostgresJobHandlerRepository(pool);
    const inbound = (text, type = "text", mediaId) => webhooks.withTenantTransaction({ empresaId }, (tx) => webhooks.insertInboundMessage(tx, {
      empresaId, numeroWhatsappId: numberId, correlationId: randomUUID(), event: { externalMessageId: "wamid." + randomUUID(), senderPhone: "5511000000001",
        occurredAt: new Date(), messageType: type, text, ...(mediaId ? { media: { externalId: mediaId } } : {}) },
    }));
    const first = await inbound("Quero uma avaliação por fotos do meu HB20 2016.");
    const initialMessage = await repository.inboundMessage({ empresaId, messageId: first.messageId });
    const offer = await repository.prepareReply({ empresaId, message: initialMessage, origin: "ai", reply: {
      text: "Ótimo! Por favor, envie fotos do veículo que deseja oferecer na troca.",
      tradeInEvaluation: { step: "collect_photos", interestName: null, interestSource: "unknown" },
    } });
    await repository.markReplySent({ empresaId, replyId: offer.id, externalMessageId: "wamid." + offer.id });
    const source = new Map([1, 2, 3, 4].map((n) => ["photo-" + n, Buffer.from("imagem sintética " + n)]));
    const downloads = [], botMessages = [], groupMessages = [];
    let aiCalls = 0;
    const conversationService = new ConversationService({ repository: new PostgresConversationRepository(pool) });
    const closing = "Obrigado pelas informações, logo um de nossos vendedores vai entrar em contato com o retorno da avaliação e dará continuidade no seu atendimento.";
    const aiService = new MultiTenantAiService({ configResolver: new PostgresAiConfigResolver(pool), conversationService,
      clientFactory: new MemoryResponsesClientFactory(async (call) => {
        aiCalls++;
        const named = call.input.some((part) => part.role === "user" && part.content === "Ana Teste");
        return { output_text: JSON.stringify({ text: named ? closing : "Recebi as duas fotos! Para finalizar, como posso te chamar?",
          tradeInEvaluation: { step: "photos_received", interestName: null, interestSource: "unknown" },
          leadQualification: named ? { status: "qualified", name: "Ana Teste", summary: "Ana Teste enviou duas fotos para avaliação do HB20 2016 oferecido na troca.", qualification: "Aguarda retorno da avaliação por fotos." }
            : { status: "collecting", name: null, summary: null, qualification: null } }), usage: { input_tokens: 10, output_tokens: 10 } };
      }), secretResolver: new MemoryAiSecretResolver({ sharedSecret: "fake" }), ledger: new MemoryAiLedger(),
      pricingCatalog: new MemoryPricingCatalog({ test: { inputPerMillion: 1, outputPerMillion: 1, version: "test" } }), logger: { info() {}, warn() {} } });
    const dependencies = { repository, conversationService, tenantDefinitionRepository: { async load() { return materializeLegacyTenantDefinition(compiled); } },
      aiService, mediaStore, clock: () => new Date(Date.now() + 16_000), logger: { info() {}, warn() {} },
      metaGateway: { async downloadMedia(_scope, { mediaId }) { downloads.push(mediaId); return { data: source.get(mediaId), mimeType: "image/png" }; },
        async sendReply(_scope, part) { botMessages.push(part); return { id: "wamid." + randomUUID() }; } } };
    const job = (messageId) => ({ empresaId, messageId, conversationId: first.conversationId });
    const photo1 = await inbound("", "image", "photo-1"), photo2 = await inbound("Meu carro", "image", "photo-2");
    await t.test("todo o lote é armazenado e reconhecido, mas não encaminhado antes do nome", async () => {
      assert.equal((await createWorkerHandlers(dependencies).process_inbound_message(job(photo1.messageId))).replied, true);
      assert.deepEqual(downloads, ["photo-1", "photo-2"]);
      assert.equal(aiCalls, 1); assert.equal(botMessages.length, 1); assert.match(botMessages[0].text, /Recebi as duas fotos/u);
      assert.equal((await owner.query("SELECT 1 FROM qualified_leads WHERE empresa_id=$1", [empresaId])).rowCount, 0);
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM mensagens WHERE empresa_id=$1 AND tipo='imagem' AND media_storage_key IS NOT NULL", [empresaId])).rows[0].n, 2);
    });
    let named, deliveryId;
    await t.test("nome conclui, pausa e registra ficha, resumo e duas imagens na ordem sem duplicar", async () => {
      named = await inbound("Ana Teste");
      assert.equal((await createWorkerHandlers(dependencies).process_inbound_message(job(named.messageId))).replied, true);
      assert.equal(botMessages.at(-1).text, closing); assert.equal(aiCalls, 2);
      const lead = (await owner.query("SELECT * FROM qualified_leads WHERE empresa_id=$1", [empresaId])).rows;
      assert.equal(lead.length, 1); assert.equal(lead[0].name, "Ana Teste"); assert.match(lead[0].summary, /Imagens recebidas do cliente: 2/u);
      assert.equal((await conversationService.getConversation({ empresaId, conversationId: first.conversationId })).mode, "paused");
      deliveryId = (await owner.query("SELECT id FROM group_notifier_deliveries WHERE empresa_id=$1", [empresaId])).rows[0].id;
      const parts = (await owner.query("SELECT kind,source_message_id FROM group_notifier_delivery_parts WHERE empresa_id=$1 ORDER BY position", [empresaId])).rows;
      assert.deepEqual(parts.map((part) => part.kind), ["summary", "image", "image"]);
      assert.deepEqual(parts.slice(1).map((part) => part.source_message_id), [photo1.messageId, photo2.messageId]);
      await createWorkerHandlers(dependencies).process_inbound_message(job(named.messageId));
      assert.equal((await owner.query("SELECT 1 FROM group_notifier_delivery_parts WHERE empresa_id=$1", [empresaId])).rowCount, 3);
    });
    const notifierRepo = new PostgresGroupNotifierRepository(pool, null);
    const wrapped = Object.create(notifierRepo); wrapped.cacheGroups = async () => {};
    let revokeOnRead = false;
    const readStore = { async read(input) {
      const data = await mediaStore.read(input);
      if (revokeOnRead) await owner.query("UPDATE contatos SET bloqueado=true WHERE empresa_id=$1", [empresaId]);
      return data;
    } };
    const sessionFactory = () => ({ snapshot: () => ({ phase: "connected" }), async connect() {}, close() {}, async flushAuth() {},
      async listGroups() { return []; }, async groupMetadata(id) { assert.equal(id, groupId); },
      async sendText(id, text) { groupMessages.push({ id, text }); return { messageId: "group." + randomUUID() }; },
      async sendImage(id, image) { groupMessages.push({ id, ...image }); return { messageId: "group." + randomUUID() }; } });
    await t.test("notificador envia resumo antes dos bytes das imagens e restart não repete o lote", async () => {
      notifier = createGroupNotifierWorker({ repository: wrapped, mediaStore: readStore, sessionFactory });
      await notifier.tick(); assert.equal(groupMessages.length, 3);
      assert.match(groupMessages[0].text, /Ana Teste/u); assert.equal(groupMessages[0].data, undefined);
      assert.deepEqual(groupMessages[1].data, source.get("photo-1")); assert.deepEqual(groupMessages[2].data, source.get("photo-2"));
      assert.ok(groupMessages.every((part) => part.id === groupId));
      assert.ok(groupMessages.slice(1).every((part) => part.caption.includes("Ana Teste")));
      assert.equal((await owner.query("SELECT status FROM group_notifier_deliveries WHERE id=$1", [deliveryId])).rows[0].status, "accepted");
      await notifier.close(); notifier = createGroupNotifierWorker({ repository: wrapped, mediaStore: readStore, sessionFactory });
      await notifier.tick(); assert.equal(groupMessages.length, 3);
    });
    await t.test("foto adicional após pausa segue com resumo, sem nova IA, ficha ou resposta ao cliente", async () => {
      const late = await inbound("Mais uma foto", "image", "photo-3");
      await createWorkerHandlers(dependencies).process_inbound_message(job(late.messageId));
      assert.equal(aiCalls, 2); assert.equal(botMessages.length, 2);
      await notifier.tick(); assert.equal(groupMessages.length, 5);
      assert.match(groupMessages[3].text, /Ana Teste/u); assert.deepEqual(groupMessages[4].data, source.get("photo-3"));
      await createWorkerHandlers(dependencies).process_inbound_message(job(late.messageId)); await notifier.tick();
      assert.equal(groupMessages.length, 5); assert.equal((await owner.query("SELECT 1 FROM qualified_leads WHERE empresa_id=$1", [empresaId])).rowCount, 1);
      assert.equal((await conversationService.getConversation({ empresaId, conversationId: first.conversationId })).mode, "paused");
    });
    await t.test("RLS isola os anexos e revogação entre leitura e envio bloqueia a imagem", async () => {
      const foreign = randomUUID();
      assert.equal(await withTenantTransaction(pool, { empresaId: foreign }, async ({ client }) => (await client.query("SELECT 1 FROM group_notifier_delivery_parts")).rowCount), 0);
      assert.deepEqual(await repository.queueLeadImages({ empresaId: foreign, conversationId: first.conversationId, messageId: named.messageId }), { queued: 0 });
      const late = await inbound("Outra foto", "image", "photo-4");
      await createWorkerHandlers(dependencies).process_inbound_message(job(late.messageId));
      revokeOnRead = true; const before = groupMessages.filter((part) => part.data).length;
      await notifier.tick();
      assert.equal(groupMessages.filter((part) => part.data).length, before);
      await notifier.tick(); assert.equal(groupMessages.filter((part) => part.data).length, before);
      assert.equal((await owner.query("SELECT status FROM group_notifier_deliveries WHERE id=$1", [deliveryId])).rows[0].status, "unconfirmed");
    });
  } finally {
    await notifier?.close();
    if (empresaId) {
      for (const table of ["group_notifier_deliveries", "qualified_leads", "group_notifier_routes", "outbox_jobs", "mensagens", "estados_conversa", "conversas", "contatos", "numeros_whatsapp"]) await owner.query("DELETE FROM " + table + " WHERE empresa_id=$1", [empresaId]);
      await owner.query("DELETE FROM empresas WHERE id=$1", [empresaId]);
    }
    if (actorId) await owner.query("DELETE FROM usuarios WHERE id=$1", [actorId]);
    if (connectionSaved) await owner.query(`UPDATE group_notifier_connection SET
      (desired,phone,epoch,phase,error_code,heartbeat_at,lease_until,lease_owner,qr_envelope,qr_expires_at,updated_at)=
      (SELECT desired,phone,epoch,phase,error_code,heartbeat_at,lease_until,lease_owner,qr_envelope,qr_expires_at,updated_at FROM lead_images_connection_before)`);
    owner.release(); await pool.end(); await adminPool.end();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("waia-lead-images-"));
    await rm(root, { recursive: true, force: true });
  }
});
