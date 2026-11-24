import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { compileTenantRuntimeConfigV2 } from "../src/modules/configuration/index.js";
import { PostgresTenantDefinitionRepository } from "../src/tenants/postgres-config-loader.js";
import { WebsiteCatalogIntegration } from "../src/integrations/website-catalog/integration.js";
import { fetchWebsiteStock } from "../src/integrations/website-catalog/stock.js";
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
import { createMetaGateway } from "../src/integrations/meta/meta-gateway.js";
import { createYCloudWebhookService } from "../src/modules/meta/ycloud-webhook-service.js";
import { ycloudMediaReference } from "./support/ycloud-media-fixtures.js";

for (const property of [false,true]) test(`PostgreSQL: fotos de ${property ? 'captação imobiliária sem avaliação automotiva' : 'avaliação automotiva'}, ficha com anexos e fotos posteriores sem reativar bot`, {
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
    const integrationId = property ? null : (await owner.query("INSERT INTO integracoes(empresa_id,tipo,nome,habilitada) VALUES($1,'website_catalog','Site sintético',true) RETURNING id", [empresaId])).rows[0].id;
    const compiled = compileTenantRuntimeConfigV2({ schemaVersion: 2, identity: { name: "Loja sintética" }, modules: [...(property ? [] : ['catalog']), "ai_freeform", "human_handoff"],
      menu: { text: "Saudação de referência", options: [] }, ai: { enabled: true, provider: "openai", model: "test", maxOutputTokens: 1000,
        prompt: property ? 'Capte imóvel para locação com fotos, localização, valor esperado e nome, conforme o contexto.' : "Use os modelos do roteiro. Ao receber fotos para avaliação, reconheça e peça nome se faltar; com nome e fotos encerre para retorno de vendedor.",
        contextualServiceEnabled: true, tradeInEvaluationEnabled: !property, leadImageHandoffEnabled: true,
        leadQualificationEnabled: true, leadQualificationCriteria: property ? 'Intenção, fotos, localização, expectativa de locação e nome.' : "Nome e fotos para avaliação recebidas." },
      integrations: property ? [] : [{ id: integrationId, type: "website_catalog", name: "Site sintético", enabled: true }] }, { empresaId, configVersion: 1, draftVersion: 1 });
    await owner.query("INSERT INTO configuracoes_revisoes(empresa_id,config_version,schema_version,compiler_version,source_draft_version,checksum,configuracao_compilada,publicada_por) VALUES($1,1,2,1,1,$2,$3::jsonb,$4)", [empresaId, compiled.checksum, JSON.stringify(compiled), actorId]);
    await owner.query("UPDATE empresas SET configuracao_runtime_modo='versionado',versao_configuracao=1,configuracao_ativa_versao=1 WHERE id=$1", [empresaId]);
    const fakeStock = `<script>\nwindow.VEICULOS = ${JSON.stringify([{ id: 49, titulo: "ONIX JOY", modelo: "ONIX JOY", ano: 2019, km: 73000, preco: 55900, cambio: "Manual", combustivel: "Flex", cor: "Prata",
      descricao: "<p>ONIX JOY</p><p>Veículo sintético para o teste de atendimento.</p>", imagens: ["/storage/veiculos/test.jpg"] }])};\n</script>`;
    const integration = new WebsiteCatalogIntegration({ pool, fetchStock: () => fetchWebsiteStock({ fetchImpl: async () => new Response(fakeStock, { headers: { "Content-Type": "text/html" } }) }) });
    if(!property){const synchronized = await integration.syncTenant(empresaId);
      assert.equal(synchronized.health, "healthy", JSON.stringify(synchronized));}
    const numberId = (await owner.query("INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status) VALUES($1,$2,'ativo') RETURNING id", [empresaId, randomUUID()])).rows[0].id;
    const groupId = "9" + Date.now() + String(Math.random()).slice(2, 8) + "@g.us";
    await owner.query("INSERT INTO group_notifier_routes(empresa_id,group_id,group_name,sender_phone,enabled) VALUES($1,$2,'Grupo sintético','+5511000000099',true)", [empresaId, groupId]);
    const webhooks = new PostgresWebhookRepository(pool), repository = new PostgresJobHandlerRepository(pool);
    const source = new Map([1, 2, 3, 4].map((n) => ["photo-" + n, Buffer.from("imagem sintética " + n)]));
    const insert = (event) => webhooks.withTenantTransaction({ empresaId }, (tx) => webhooks.insertInboundMessage(tx, {
      empresaId, numeroWhatsappId: numberId, correlationId: randomUUID(), event,
    }));
    const inbound = async (text, type = "text", mediaId) => {
      const event = { externalMessageId: "wamid." + randomUUID(), senderPhone: "5511000000001", occurredAt: new Date(), messageType: type, text };
      if (type !== "image") return insert(event);
      let stored;
      const now = Date.now(), reference = ycloudMediaReference({ mediaId, data: source.get(mediaId) });
      const ingress = createYCloudWebhookService({ clock: () => now,
        connectionResolver: { async resolveByWebhookPublicId() { return { id: "synthetic-connection", empresaId, mode: "ycloud", state: "active", appSecretCredentialId: "synthetic-sign",
          numbers: [{ id: numberId, phoneNumberId: "synthetic-number", wabaId: "waba-a", numeroE164: "+5511000000002", status: "ativo" }] }; } },
        credentialVault: { async getCredentialForUse() { return "synthetic-signing"; } }, repository: { async recordValidWebhook() {} },
        ingestionService: { async ingestEvents(events) { stored = await insert(events[0]); } },
      });
      const rawBody = Buffer.from(JSON.stringify({ id: "event-" + randomUUID(), apiVersion: "v2", type: "whatsapp.inbound_message.received",
        whatsappInboundMessage: { id: "ycloud-" + randomUUID(), wamid: event.externalMessageId, wabaId: "waba-a", from: "+5511000000001", to: "+5511000000002",
          sendTime: new Date(now).toISOString(), type: "image", image: { id: mediaId, link: reference.url, mime_type: reference.mimeType, sha256: reference.sha256, caption: text } } }));
      const timestamp = Math.floor(now / 1000);
      await ingress.ingest({ webhookPublicId: "synthetic-webhook-public-id", rawBody,
        signature: `t=${timestamp},s=${createHmac("sha256", "synthetic-signing").update(`${timestamp}.`).update(rawBody).digest("hex")}` });
      return stored;
    };
    const tradeRequest = property ? 'Quero colocar meu apartamento para locação. Fica na Rua Sintética 20, bairro Exemplo, Taubaté. Espero 1500 com condomínio incluso. Vou mandar as fotos.' : "Quero saber quanto oferecem no meu HB20 2016 como parte do pagamento do Onix. Vou mandar as fotos.";
    const first = await inbound(tradeRequest);
    const downloads = [], botMessages = [], groupMessages = [];
    const gateway = createMetaGateway({ logger: { warn() {} }, credentialResolver: { async resolveMeta(scope) {
      assert.equal(scope.empresaId, empresaId); assert.equal(scope.numeroWhatsappId, numberId);
      return { provider: "ycloud", accessToken: "synthetic-key", phoneNumberId: "synthetic-number", wabaId: "waba-a" };
    } }, fetchImpl: async (url, options) => {
      const id = new URL(url).pathname.split("/").at(-1); downloads.push(id);
      assert.deepEqual(options.headers, { "X-API-Key": "synthetic-key" }); assert.equal(options.redirect, "error");
      return new Response(source.get(id), { headers: { "Content-Type": "image/png" } });
    } });
    let aiCalls = 0;
    const conversationService = new ConversationService({ repository: new PostgresConversationRepository(pool) });
    const closing = property ? 'Obrigada pelas informações, Ana Teste! Um de nossos corretores entrará em contato para continuar o atendimento do seu imóvel.' : "Obrigado pelas informações, logo um de nossos vendedores vai entrar em contato com o retorno da avaliação e dará continuidade no seu atendimento.";
    const aiService = new MultiTenantAiService({ configResolver: new PostgresAiConfigResolver(pool), conversationService,
      clientFactory: new MemoryResponsesClientFactory(async (call) => {
        aiCalls++;
        const named = call.input.some((part) => part.role === "user" && part.content === "Ana Teste, nossa desculpa não me apresentei.");
        return { output_text: JSON.stringify({ text: named ? closing : "Recebi as duas fotos! Para finalizar, como posso te chamar?",
          ...(call.text.format.schema.properties.turnIntent ? { turnIntent: "answer" } : {}),
          ...(!property ? {catalogAction: "none", productIds: [], filters: { category: null, minPrice: null, maxPrice: null },
          customerService: { downPayment: { status: "not_informed", amount: null, evidence: null },
            warranty: { status: "none", requestEvidence: null, offerEvidence: null, consentEvidence: null },
            tradeInRequest: { status: "photo_appraisal_requested", requestEvidence: tradeRequest } },
          tradeInEvaluation: { step: "photos_received", interestName: "Onix", interestSource: "customer" }} : {}),
          leadQualification: named ? { status: "qualified", name: "Ana Teste", summary: property ? 'Ana Teste quer disponibilizar apartamento na Rua Sintética 20, bairro Exemplo, Taubaté, para locação por 1500 com condomínio incluso; duas fotos recebidas.' : "Ana Teste enviou duas fotos para avaliação do HB20 2016 oferecido na troca.", qualification: property ? 'Captação para locação.' : "Aguarda retorno da avaliação por fotos." }
            : { status: "collecting", name: null, summary: null, qualification: null } }), usage: { input_tokens: 10, output_tokens: 10 } };
      }), secretResolver: new MemoryAiSecretResolver({ sharedSecret: "fake" }), ledger: new MemoryAiLedger(),
      pricingCatalog: new MemoryPricingCatalog({ test: { inputPerMillion: 1, outputPerMillion: 1, version: "test" } }), logger: { info() {}, warn() {} } });
    const dependencies = { repository, conversationService, tenantDefinitionRepository: new PostgresTenantDefinitionRepository(pool),
      aiService, mediaStore, clock: () => new Date(Date.now() + 16_000), logger: { info() {}, warn() {} },
      metaGateway: { downloadMedia: gateway.downloadMedia,
        async sendReply(_scope, part) { botMessages.push(part); return { id: "wamid." + randomUUID() }; } } };
    const job = (messageId) => ({ empresaId, messageId, conversationId: first.conversationId });
    const photo1 = await inbound("", "image", "photo-1"), photo2 = await inbound(property ? 'Meu imóvel' : "Meu carro", "image", "photo-2");
    await t.test("todo o lote é armazenado e reconhecido, mas não encaminhado antes do nome", async () => {
      assert.equal((await createWorkerHandlers(dependencies).process_inbound_message(job(photo1.messageId))).replied, true);
      assert.deepEqual(downloads, ["photo-1", "photo-2"]);
      assert.equal(aiCalls, 1); assert.equal(botMessages.length, 1); assert.match(botMessages[0].text, /Recebi as duas fotos/u);
      assert.equal((await owner.query("SELECT 1 FROM qualified_leads WHERE empresa_id=$1", [empresaId])).rowCount, 0);
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM mensagens WHERE empresa_id=$1 AND tipo='imagem' AND media_storage_key IS NOT NULL", [empresaId])).rows[0].n, 2);
      assert.equal((await owner.query("SELECT 1 FROM mensagens WHERE empresa_id=$1 AND outbound_payload ? 'providerMedia'", [empresaId])).rowCount, 0, "Remover a URL privada após armazenar os bytes.");
    });
    let named, deliveryId;
    await t.test("nome conclui, pausa e registra ficha, resumo e duas imagens na ordem sem duplicar", async () => {
      named = await inbound("Ana Teste, nossa desculpa não me apresentei.");
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
      for (const table of ["group_notifier_deliveries", "qualified_leads", "group_notifier_routes", "outbox_jobs", "mensagens", "estados_conversa", "conversas", "contatos", "numeros_whatsapp", "integracoes"]) await owner.query("DELETE FROM " + table + " WHERE empresa_id=$1", [empresaId]);
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
