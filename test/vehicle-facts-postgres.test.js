import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { compileTenantRuntimeConfigV2 } from "../src/modules/configuration/index.js";
import { fetchWebsiteStock } from "../src/integrations/website-catalog/stock.js";
import { WebsiteCatalogIntegration } from "../src/integrations/website-catalog/integration.js";
import { PostgresTenantDefinitionRepository } from "../src/tenants/postgres-config-loader.js";
import { PostgresWebhookRepository } from "../src/infra/postgres/repositories/webhook-repository.js";
import { PostgresJobHandlerRepository, createWorkerHandlers } from "../src/modules/jobs/handlers.js";
import { ConversationService } from "../src/modules/conversations/conversation-service.js";
import { PostgresConversationRepository } from "../src/modules/conversations/postgres-conversation-repository.js";
import { websiteCatalogPage, parseCatalogSalesReply } from "../src/modules/business/catalog-sales.js";
import { websiteCatalogListText } from "../src/modules/business/website-catalog-interaction.js";

const page = (...entries) => `<script>\nwindow.VEICULOS = ${JSON.stringify(entries)};\n</script>`;

test("PostgreSQL: fatos do site atravessam sincronização, runtime, fila, retomada e guarda de envio", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "true",
}, async (t) => {
  assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/waia_v2_/u);
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, options: "-c app.is_platform_admin=true" });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let empresaId, actorId;
  try {
    actorId = (await owner.query("INSERT INTO usuarios(email,nome,password_hash,papel_plataforma) VALUES($1,'Catálogo sintético','synthetic','administrador') RETURNING id", [randomUUID() + "@example.test"])).rows[0].id;
    empresaId = (await owner.query("INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1,'Catálogo sintético','Catálogo sintético','ativa') RETURNING id", ["facts-" + randomUUID()])).rows[0].id;
    const integrationId = (await owner.query("INSERT INTO integracoes(empresa_id,tipo,nome,habilitada) VALUES($1,'website_catalog','Site sintético',true) RETURNING id", [empresaId])).rows[0].id;
    const compiled = compileTenantRuntimeConfigV2({ schemaVersion: 2, identity: { name: "Catálogo sintético" }, modules: ["catalog", "ai_freeform"],
      menu: { text: "Menu", options: [] }, ai: { enabled: true, provider: "openai", model: "test", prompt: "Atenda o pedido atual", responseDelayEnabled: false },
      integrations: [{ id: integrationId, type: "website_catalog", name: "Site sintético", enabled: true }] },
    { empresaId, configVersion: 1, draftVersion: 1 });
    await owner.query("INSERT INTO configuracoes_revisoes(empresa_id,config_version,schema_version,compiler_version,source_draft_version,checksum,configuracao_compilada,publicada_por) VALUES($1,1,2,1,1,$2,$3::jsonb,$4)",
      [empresaId, compiled.checksum, JSON.stringify(compiled), actorId]);
    await owner.query("UPDATE empresas SET configuracao_runtime_modo='versionado',versao_configuracao=1,configuracao_ativa_versao=1 WHERE id=$1", [empresaId]);
    const numeroWhatsappId = (await owner.query("INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status) VALUES($1,$2,'ativo') RETURNING id", [empresaId, randomUUID()])).rows[0].id;
    const integration = new WebsiteCatalogIntegration({ pool, fetchStock: () => fetchWebsiteStock({ fetchImpl: async (url) => {
      const detail = new URL(url).searchParams.has("id");
      return new Response(detail ? page({ id: 49, ano: 2008,
        descricao: `<p>TRACKER 2.0</p><p>${"Introdução oficial extensa. ".repeat(200)}</p><p>Equipamentos</p><ul><li>Ar-condicionado</li></ul>` })
        : page({ id: 49, titulo: "TRACKER 2.0", modelo: "Versão oficial", ano: 2007, km: 155000, preco: 45900, cambio: "Automático", combustivel: "Flex", cor: "Prata", imagens: ["/storage/veiculos/test.jpg"] }),
      { headers: { "Content-Type": "text/html" } });
    } }) });
    assert.equal((await integration.syncTenant(empresaId)).health, "healthy");
    const cached = await integration.read(empresaId), item = cached.items[0];
    assert.equal(item.mileageKm, 155000); assert.equal(item.year, 2008);
    assert.equal(item.vehicleFactsWarnings[0].code, "year_mismatch");
    const loader = new PostgresTenantDefinitionRepository(pool);
    const definition = await loader.load(empresaId);
    assert.equal(definition.runtime.catalog.items[0].year, 2008);
    const snapshot = (await owner.query("SELECT cache_snapshot FROM integracoes WHERE id=$1", [integrationId])).rows[0].cache_snapshot;
    const restore = () => owner.query("UPDATE integracoes SET cache_snapshot=$2::jsonb,status='saudavel',last_success_at=clock_timestamp() WHERE id=$1", [integrationId, JSON.stringify(snapshot)]);
    const repository = new PostgresJobHandlerRepository(pool), webhooks = new PostgresWebhookRepository(pool);
    const inbound = () => webhooks.withTenantTransaction({ empresaId }, (tx) => webhooks.insertInboundMessage(tx, {
      empresaId, numeroWhatsappId, correlationId: randomUUID(), event: { externalMessageId: "wamid." + randomUUID(),
        messageType: "text", text: "Quero conhecer os veículos disponíveis", senderPhone: "5511999999999", occurredAt: new Date() },
    }));
    const prepare = async ({ version = 2, single = false } = {}) => {
      const input = await inbound(), message = await repository.inboundMessage({ empresaId, messageId: input.messageId });
      const reply = websiteCatalogPage(definition.runtime.catalog);
      if (version !== 2) {
        reply.text = reply.messages[0].text = websiteCatalogListText([item], { formatVersion: 1 });
        if (version === undefined || version === "absent") delete reply.messages[0].catalogListFormatVersion;
        else reply.messages[0].catalogListFormatVersion = version;
      }
      const result = await repository.prepareReply({ empresaId, message, origin: "ai", reply: single ? reply.messages[0] : reply });
      return { input, message, result, scope: { empresaId, messageId: input.messageId, replyId: result.id } };
    };
    await t.test("versões nova e antiga persistem e retomam sem regenerar o corpo", async () => {
      for (const version of [2, 1, "absent"]) {
        const current = await prepare({ version });
        const replay = await new PostgresJobHandlerRepository(pool).preparedReply(current.scope);
        const part = replay.messages[0];
        assert.equal(part.catalogListFormatVersion, version === "absent" ? undefined : version);
        assert.equal(part.text, current.result.text);
        const repeated = await repository.prepareReply({ empresaId, message: current.message, origin: "ai", reply: websiteCatalogPage(definition.runtime.catalog) });
        assert.equal(repeated.text, current.result.text);
        assert.equal(repeated.messages[0].catalogListFormatVersion, part.catalogListFormatVersion);
        assert.equal((await repository.claimBotDispatch(current.scope)).allowed, true);
        await repository.markReplySent({ empresaId, replyId: replay.id, externalMessageId: "wamid." + randomUUID() });
        assert.equal((await new PostgresJobHandlerRepository(pool).preparedReply(current.scope)).messages[0].status, "enviada");
        assert.equal((await repository.claimBotDispatch(current.scope)).allowed, false);
      }
      const single = await prepare({ single: true });
      assert.equal(single.result.catalogListFormatVersion, 2);
      assert.equal((await repository.preparedReply(single.scope)).catalogListFormatVersion, 2);
      assert.equal((await repository.claimBotDispatch(single.scope)).allowed, true);
      await repository.markReplySent({ empresaId, replyId: single.result.id, externalMessageId: "wamid." + randomUUID() });
    });
    await t.test("lista contextual e legenda final persistem a redação da IA e validam os fatos no envio", async () => {
      const continuation = "Qual dessas opções combina mais com o que procura?";
      const output = (action, ids) => JSON.stringify({ text: continuation, catalogAction: action, productIds: ids,
        filters: { category: null, minPrice: null, maxPrice: null } });
      for (const action of ["browse", "products"]) {
        const input = await inbound(), message = await repository.inboundMessage({ empresaId, messageId: input.messageId });
        const reply = parseCatalogSalesReply(output(action, action === "products" ? [item.id] : []), definition.runtime.catalog,
          { contextualServiceEnabled: true, message: action === "products" ? "Envie fotos da Tracker" : "Mostre as opções" });
        const prepared = await repository.prepareReply({ empresaId, message, origin: "ai", reply });
        const scope = { empresaId, messageId: input.messageId, replyId: prepared.id };
        const resumed = await new PostgresJobHandlerRepository(pool).preparedReply(scope);
        const last = resumed.messages.at(-1);
        assert.equal(last.catalogContinuation, continuation);
        assert.equal(last.text, prepared.messages.at(-1).text);
        if (action === "browse") assert.equal(last.catalogListFormatVersion, 3);
        assert.equal((await repository.claimBotDispatch(scope)).allowed, true);
        await repository.markReplySent({ empresaId, replyId: prepared.id, externalMessageId: "wamid." + randomUUID() });
        assert.equal((await repository.claimBotDispatch(scope)).allowed, false);
      }
      const input = await inbound(), message = await repository.inboundMessage({ empresaId, messageId: input.messageId });
      const reply = websiteCatalogPage(definition.runtime.catalog, undefined, [], { continuation });
      const prepared = await repository.prepareReply({ empresaId, message, origin: "ai", reply });
      await owner.query("UPDATE mensagens SET outbound_payload=outbound_payload-'catalogContinuation' WHERE id=$1", [prepared.id]);
      assert.equal((await repository.claimBotDispatch({ empresaId, messageId: input.messageId, replyId: prepared.id })).allowed, false);
    });
    await t.test("escolha de fotos e simulação persiste na última imagem e retoma a coleta após envio", async () => {
      const input = await inbound(), message = await repository.inboundMessage({ empresaId, messageId: input.messageId });
      const continuation = "Para a simulação aceita, informe CPF e data de nascimento, por favor.";
      const reply = parseCatalogSalesReply(JSON.stringify({ text: continuation, catalogAction: "products", productIds: [item.id],
        filters: { category: null, minPrice: null, maxPrice: null } }), definition.runtime.catalog,
      { contextualServiceEnabled: true, message: "Quero fotos e simulação" });
      reply.messages.at(-1).websiteInteraction = { step: "finance_accepted", productIds: [item.id] };
      const prepared = await repository.prepareReply({ empresaId, message, origin: "ai", reply });
      const scope = { empresaId, messageId: input.messageId, replyId: prepared.id };
      const resumed = await new PostgresJobHandlerRepository(pool).preparedReply(scope);
      assert.equal(resumed.messages.at(-1).websiteInteraction.step, "finance_accepted");
      assert.equal(resumed.messages.at(-1).catalogContinuation, continuation);
      assert.equal((await repository.claimBotDispatch(scope)).allowed, true);
      await repository.markReplySent({ empresaId, replyId: prepared.id, externalMessageId: "wamid." + randomUUID() });
      const next = await inbound();
      const state = await new PostgresJobHandlerRepository(pool).financingSession({ empresaId, conversationId: next.conversationId, messageId: next.messageId });
      assert.deepEqual(state.productIds, [item.id]);
      assert.equal(state.status, "pending");
      assert.equal((await repository.claimBotDispatch(scope)).allowed, false);
    });
    await t.test("alterar km, ano, preço ou remover a unidade impede o envio preparado", async () => {
      for (const field of ["mileageKm", "year", "price", "removed"]) {
        const current = await prepare(), changed = structuredClone(snapshot);
        if (field === "removed") changed.products = [];
        else changed.products[0][field]++;
        await owner.query("UPDATE integracoes SET cache_snapshot=$2::jsonb WHERE id=$1", [integrationId, JSON.stringify(changed)]);
        assert.equal((await repository.claimBotDispatch(current.scope)).allowed, false, field);
        assert.equal((await repository.preparedReply(current.scope)).status, "ignorada_duplicidade");
        await restore();
      }
    });
    await t.test("texto arbitrário, metadado inválido, versão ausente em lista nova e cache vencido são bloqueados", async () => {
      for (const change of ["body", "unknown", "wrong-step", "missing-version", "stale"]) {
        const current = await prepare();
        if (change === "body") await owner.query("UPDATE mensagens SET corpo='Texto arbitrário' WHERE id=$1", [current.result.id]);
        if (change === "unknown") await owner.query("UPDATE mensagens SET outbound_payload=jsonb_set(outbound_payload,'{catalogListFormatVersion}','99') WHERE id=$1", [current.result.id]);
        if (change === "wrong-step") await owner.query("UPDATE mensagens SET outbound_payload=jsonb_set(outbound_payload,'{websiteInteraction,step}','\"discussion\"') WHERE id=$1", [current.result.id]);
        if (change === "missing-version") await owner.query("UPDATE mensagens SET outbound_payload=outbound_payload-'catalogListFormatVersion' WHERE id=$1", [current.result.id]);
        if (change === "stale") await owner.query("UPDATE integracoes SET last_success_at=clock_timestamp()-interval '11 minutes' WHERE id=$1", [integrationId]);
        assert.equal((await repository.claimBotDispatch(current.scope)).allowed, false, change);
        await restore();
      }
      const paused = await prepare();
      await owner.query("UPDATE conversas SET modo_atendimento='pausado' WHERE id=$1", [paused.input.conversationId]);
      assert.equal((await repository.claimBotDispatch(paused.scope)).allowed, false);
      await owner.query("UPDATE conversas SET modo_atendimento='bot' WHERE id=$1", [paused.input.conversationId]);
    });
    await t.test("worker usa runtime completo, envia a versão 2 uma vez e retoma após restart sem chamar IA", async () => {
      const current = await inbound(), sent = [];
      let calls = 0;
      const dependencies = { repository: new PostgresJobHandlerRepository(pool), tenantDefinitionRepository: loader,
        conversationService: new ConversationService({ repository: new PostgresConversationRepository(pool) }),
        clock: () => new Date(Date.now() + 16_000), aiReplyDelayMs: () => 0,
        aiService: { async reply(input) {
          calls++;
          const product = input.context.catalog.items[0];
          assert.equal(product.mileageKm, 155000); assert.equal(product.year, 2008);
          assert.ok(product.description.length > 5000); assert.match(product.introduction, /Introdução oficial/u);
          assert.match(product.details, /Ar-condicionado/u);
          assert.equal(product.vehicleFactsSources, undefined);
          return { source: "ai", ...parseCatalogSalesReply(JSON.stringify({ text: "", productIds: [], catalogAction: "browse",
            filters: { category: null, minPrice: null, maxPrice: null } }), input.context.catalog) };
        } },
        metaGateway: { async sendReply(_scope, part) { sent.push(part); return { id: "wamid." + randomUUID() }; } },
        logger: { info() {}, warn() {} } };
      const job = { empresaId, messageId: current.messageId, conversationId: current.conversationId };
      assert.equal((await createWorkerHandlers(dependencies).process_inbound_message(job)).replied, true);
      assert.equal(sent.length, 1); assert.equal(calls, 1);
      assert.equal(sent[0].catalogListFormatVersion, undefined, "Metadado interno não pertence ao payload do gateway.");
      assert.match(sent[0].text, /155\.000 km - 2008/u);
      await createWorkerHandlers({ ...dependencies, repository: new PostgresJobHandlerRepository(pool) }).process_inbound_message(job);
      assert.equal(sent.length, 1); assert.equal(calls, 1);
      const rows = (await owner.query("SELECT corpo,outbound_payload,status FROM mensagens WHERE empresa_id=$1 AND source_message_id=$2", [empresaId, current.messageId])).rows;
      assert.equal(rows.length, 1); assert.equal(rows[0].outbound_payload.catalogListFormatVersion, 2);
      assert.equal(rows[0].corpo, sent[0].text); assert.equal(rows[0].status, "enviada");
    });
  } finally {
    if (empresaId) {
      for (const table of ["outbox_jobs", "mensagens", "estados_conversa", "conversas", "contatos", "numeros_whatsapp", "integracoes"]) await owner.query("DELETE FROM " + table + " WHERE empresa_id=$1", [empresaId]);
      await owner.query("DELETE FROM empresas WHERE id=$1", [empresaId]);
    }
    if (actorId) await owner.query("DELETE FROM usuarios WHERE id=$1", [actorId]);
    await pool.end(); await owner.end();
  }
});
