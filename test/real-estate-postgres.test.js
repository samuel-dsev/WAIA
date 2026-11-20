import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { RealEstateCatalogIntegration } from '../src/integrations/real-estate-catalog/integration.js';
import { compileTenantRuntimeConfigV2 } from '../src/modules/configuration/index.js';
import { PostgresTenantDefinitionRepository, loadRealEstateCatalog } from '../src/tenants/postgres-config-loader.js';
import { withTenantTransaction } from '../src/infra/postgres/transaction.js';
import { PostgresWebhookRepository } from '../src/infra/postgres/repositories/webhook-repository.js';
import { PostgresJobHandlerRepository, createWorkerHandlers } from '../src/modules/jobs/handlers.js';
import { ConversationService } from '../src/modules/conversations/conversation-service.js';
import { PostgresConversationRepository } from '../src/modules/conversations/postgres-conversation-repository.js';
import { parseCatalogSalesReply } from '../src/modules/business/catalog-sales.js';
import { EMPTY_PROPERTY_FILTERS } from '../src/modules/business/real-estate-catalog.js';
import { propertyItem, propertySnapshot } from './support/real-estate-fixtures.js';

test('PostgreSQL imobiliário: sincronização, isolamento, fila durável e revalidação antes do envio', { skip: process.env.RUN_POSTGRES_INTEGRATION !== 'true' }, async t => {
  assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/waia_v2_/u);
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, options: '-c app.is_platform_admin=true' });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const companies = []; let actorId;
  try {
    actorId = (await owner.query("INSERT INTO usuarios(email,nome,password_hash,papel_plataforma) VALUES($1,'Imóveis sintéticos','synthetic','administrador') RETURNING id", [randomUUID() + '@example.test'])).rows[0].id;
    for (let index = 0; index < 2; index++) companies.push((await owner.query("INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1,'Imóveis sintéticos','Imóveis sintéticos','ativa') RETURNING id", ['property-' + randomUUID()])).rows[0].id);
    const [empresaId, neighborId] = companies;
    const integrationId = (await owner.query("INSERT INTO integracoes(empresa_id,tipo,nome,habilitada) VALUES($1,'real_estate_catalog','Site público sintético',true) RETURNING id", [empresaId])).rows[0].id;
    const compiled = compileTenantRuntimeConfigV2({ schemaVersion: 2, identity: { name: 'Imóveis sintéticos' }, modules: ['catalog', 'ai_freeform'],
      menu: { text: 'Menu', options: [] }, ai: { enabled: true, provider: 'openai', model: 'test', prompt: 'Atenda a pergunta atual', responseDelayEnabled: false },
      integrations: [{ id: integrationId, type: 'real_estate_catalog', name: 'Site público sintético', enabled: true }] }, { empresaId, configVersion: 1, draftVersion: 1 });
    await owner.query('INSERT INTO configuracoes_revisoes(empresa_id,config_version,schema_version,compiler_version,source_draft_version,checksum,configuracao_compilada,publicada_por) VALUES($1,1,2,1,1,$2,$3::jsonb,$4)', [empresaId, compiled.checksum, JSON.stringify(compiled), actorId]);
    await owner.query("UPDATE empresas SET configuracao_runtime_modo='versionado',versao_configuracao=1,configuracao_ativa_versao=1 WHERE id=$1", [empresaId]);
    const numeroWhatsappId = (await owner.query("INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status) VALUES($1,$2,'ativo') RETURNING id", [empresaId, randomUUID()])).rows[0].id;
    const snapshot = propertySnapshot(propertyItem(1), propertyItem(2), propertyItem(3), propertyItem(4));
    const integration = new RealEstateCatalogIntegration({ pool, fetchStock: async () => structuredClone(snapshot) });
    const restore = () => owner.query("UPDATE integracoes SET cache_snapshot=$2::jsonb,status='saudavel',habilitada=true,last_success_at=clock_timestamp() WHERE id=$1", [integrationId, JSON.stringify(snapshot)]);
    const row = async () => (await owner.query('SELECT cache_snapshot,cache_version FROM integracoes WHERE id=$1', [integrationId])).rows[0];
    const loader = new PostgresTenantDefinitionRepository(pool);
    const repository = new PostgresJobHandlerRepository(pool), webhooks = new PostgresWebhookRepository(pool);
    const inbound = (text = 'Quero opções para alugar') => webhooks.withTenantTransaction({ empresaId }, tx => webhooks.insertInboundMessage(tx, {
      empresaId, numeroWhatsappId, correlationId: randomUUID(), event: { externalMessageId: 'wamid.' + randomUUID(), messageType: 'text', text, senderPhone: '5511999999999', occurredAt: new Date() },
    }));
    const filters = { ...EMPTY_PROPERTY_FILTERS, operation: 'rent', city: 'Taubaté', maxPrice: 2600 };
    const output = (action, ids = []) => JSON.stringify({ catalogAction: action, productIds: ids, filters, text: 'Algum chamou sua atenção? Podemos falar sobre uma visita com o corretor.' });
    const prepare = async (action = 'browse') => {
      const input = await inbound(), message = await repository.inboundMessage({ empresaId, messageId: input.messageId });
      const definition = await loader.load(empresaId);
      const reply = parseCatalogSalesReply(output(action, action === 'products' ? [propertyItem(2).id] : []), definition.runtime.catalog);
      const prepared = await repository.prepareReply({ empresaId, message, origin: 'ai', reply });
      return { input, message, prepared, scope: { empresaId, messageId: input.messageId, replyId: prepared.id } };
    };

    await t.test('cache atômico, versão estável sem alteração, falha preserva snapshot e RLS', async () => {
      assert.equal((await integration.syncTenant(empresaId)).productsImported, 4);
      const previous = await row();
      await integration.syncTenant(empresaId); assert.equal((await row()).cache_version, previous.cache_version);
      const failed = new RealEstateCatalogIntegration({ pool, fetchStock: async () => { throw Object.assign(Error('sensitive detail'), { code: 'PROPERTY_CATALOG_HTTP_ERROR' }); } });
      assert.equal((await failed.syncTenant(empresaId)).health, 'unavailable');
      assert.deepEqual((await row()).cache_snapshot, previous.cache_snapshot);
      assert.equal((await integration.read(empresaId)).items.length, 0);
      assert.equal((await integration.read(neighborId)).health, 'not_configured');
      const invalid = new RealEstateCatalogIntegration({ pool, fetchStock: async () => propertySnapshot(propertyItem(1, { bedrooms: -1 })) });
      assert.equal((await invalid.syncTenant(empresaId)).errorCode, 'PROPERTY_CATALOG_INVALID_SNAPSHOT');
      assert.deepEqual((await row()).cache_snapshot, previous.cache_snapshot);
      await restore();
      const read = (tenant, id) => withTenantTransaction(pool, { empresaId: tenant }, ({ client }) => loadRealEstateCatalog(client, tenant, [{ id, type: 'real_estate_catalog', enabled: true }]));
      assert.equal((await read(empresaId, integrationId)).items.length, 4);
      assert.equal((await read(neighborId, integrationId)).items.length, 0);
      assert.equal((await read(empresaId, randomUUID())).items.length, 0);
    });

    await t.test('atualização antiga concorrente não sobrescreve a mais recente', async () => {
      const started = Promise.withResolvers(), finish = Promise.withResolvers();
      const slow = new RealEstateCatalogIntegration({ pool, fetchStock: async () => { started.resolve(); return finish.promise; } });
      const pending = slow.syncTenant(empresaId); await started.promise;
      await integration.syncTenant(empresaId);
      finish.resolve(propertySnapshot(propertyItem(99)));
      assert.equal((await pending).health, 'superseded');
      assert.equal((await row()).cache_snapshot.products[0].reference, '1');
    });

    await t.test('retomada mantém legendas e fotos; cursor só avança após confirmação', async () => {
      const current = await prepare();
      const resumed = await new PostgresJobHandlerRepository(pool).preparedReply(current.scope);
      assert.equal(resumed.messages.length, 4); assert.equal(resumed.messages[0].catalogPhotoIndex, 0);
      assert.equal(resumed.messages.at(-1).catalogListFormatVersion, 3);
      assert.equal((await repository.catalogBrowseState({ empresaId, conversationId: current.input.conversationId })).seenProductIds.length, 0);
      assert.equal((await repository.claimBotDispatch(current.scope)).allowed, true);
      await repository.markReplySent({ empresaId, replyId: resumed.id, externalMessageId: 'wamid.' + randomUUID() });
      const state = await new PostgresJobHandlerRepository(pool).catalogBrowseState({ empresaId, conversationId: current.input.conversationId });
      assert.deepEqual(state.seenProductIds, [propertyItem(1).id]);
      const next = parseCatalogSalesReply(output('more'), { ...(await loader.load(empresaId)).runtime.catalog, browseState: state });
      assert.equal(next.messages[0].catalogProductId, propertyItem(2).id);
      const gallery = await prepare('products');
      const hydrated = await repository.preparedReply(gallery.scope);
      assert.equal(hydrated.messages.at(-1).websiteInteraction.step, 'gallery');
      assert.equal((await repository.claimBotDispatch(gallery.scope)).allowed, true);
      assert.ok(hydrated.messages.every(part => part.imageUrl.includes('/2/')));
    });

    await t.test('preço, foto, finalidade, cidade, remoção e expiração invalidam envio preparado', async () => {
      for (const field of ['rentPrice', 'image', 'operation', 'city', 'removed', 'stale', 'disabled']) {
        const current = await prepare(), changed = structuredClone(snapshot);
        if (field === 'rentPrice') changed.products[0].rentPrice++;
        if (field === 'image') changed.products[0].imageUrls[0] = 'https://midia.imo.etc.br/filaretti/imoveis/1/999-grande.jpg';
        if (field === 'operation') changed.products[0].operations = ['sale'];
        if (field === 'city') changed.products[0].city = 'Tremembé';
        if (field === 'removed') changed.products.shift();
        await owner.query('UPDATE integracoes SET cache_snapshot=$2::jsonb WHERE id=$1', [integrationId, JSON.stringify(changed)]);
        if (field === 'stale') await owner.query("UPDATE integracoes SET last_success_at=clock_timestamp()-interval '16 minutes' WHERE id=$1", [integrationId]);
        if (field === 'disabled') await owner.query('UPDATE integracoes SET habilitada=false WHERE id=$1', [integrationId]);
        assert.equal((await repository.claimBotDispatch(current.scope)).allowed, false, field);
        await restore();
      }
    });

    await t.test('worker envia capas e pergunta uma vez, reinício não chama IA novamente', async () => {
      const current = await inbound('Mostre as opções para alugar'), sent = []; let calls = 0;
      const dependencies = { repository: new PostgresJobHandlerRepository(pool), tenantDefinitionRepository: loader,
        conversationService: new ConversationService({ repository: new PostgresConversationRepository(pool) }), clock: () => new Date(Date.now() + 16_000), aiReplyDelayMs: () => 0,
        aiService: { async reply(input) { calls++; assert.equal(input.context.catalog.salesMode, true); assert.equal(input.context.catalog.items[0].rentPrice, 2500);
          return { source: 'ai', ...parseCatalogSalesReply(output('browse'), input.context.catalog) }; } },
        metaGateway: { async sendReply(_scope, part) { sent.push(part); return { id: 'wamid.' + randomUUID() }; } }, logger: { info() {}, warn() {} } };
      const job = { empresaId, messageId: current.messageId, conversationId: current.conversationId };
      assert.equal((await createWorkerHandlers(dependencies).process_inbound_message(job)).replied, true);
      assert.equal(sent.length, 4); assert.equal(calls, 1);
      await createWorkerHandlers({ ...dependencies, repository: new PostgresJobHandlerRepository(pool) }).process_inbound_message(job);
      assert.equal(sent.length, 4); assert.equal(calls, 1);
      assert.match(sent[0].text, /Aluguel mensal/u);
    });
  } finally {
    for (const empresaId of companies) {
      for (const table of ['outbox_jobs', 'mensagens', 'estados_conversa', 'conversas', 'contatos', 'numeros_whatsapp', 'integracoes']) await owner.query('DELETE FROM ' + table + ' WHERE empresa_id=$1', [empresaId]);
      await owner.query('DELETE FROM empresas WHERE id=$1', [empresaId]);
    }
    if (actorId) await owner.query('DELETE FROM usuarios WHERE id=$1', [actorId]);
    await pool.end(); await owner.end();
  }
});
