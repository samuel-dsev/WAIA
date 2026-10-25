import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createM1Fixture, enabled } from './support/m1-fixtures.js';
import { AttendanceService } from '../src/modules/attendance/attendance-service.js';
import { PostgresVersionedConfigurationRepository, VersionedConfigurationService,
  compileTenantRuntimeConfigV2 } from '../src/modules/configuration/index.js';
import { PostgresOnboardingRepository } from '../src/modules/onboarding/index.js';

const permissions = ['attendance.read', 'attendance.edit', 'attendance.simulate', 'attendance.publish'];
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const configuration = (name) => ({
  schemaVersion: 2,
  identity: { name, displayName: name, timezone: 'America/Sao_Paulo', schedules: ['Segunda a sexta, 9h às 18h'],
    publicRules: ['Atendimento por agendamento'], welcomeMessage: 'Olá', fallbackMessage: 'Como posso ajudar?' },
  modules: ['catalog', 'ai_freeform', 'human_handoff', 'external_integrations'],
  menu: { text: 'Menu público', options: [{ id: 'catalogo', label: 'Catálogo', action: 'catalog.list', params: {} }] },
  routing: { greetings: ['oi'], aliases: [], fallbackAction: 'ai_freeform.reply' },
  publicReplies: [{ action: 'catalog.address', text: 'Endereço público' }],
  ai: { enabled: true, provider: 'simulated', model: 'private-synthetic-model', keyMode: 'simulated', prompt: `Roteiro ${name}`,
    personality: 'Objetiva', maxOutputTokens: 123, monthlyTokenLimit: 12345, monthlyCostLimit: 45,
    catalogSalesEnabled: true, responseDelayEnabled: true },
  humanHandoff: { channel: 'private-synthetic-channel', assigneeRef: 'user:private-assignee', cooldownSeconds: 123,
    pauseOnBusinessAppMessage: true, message: 'Aguarde a equipe', salesInterestMessage: 'Interesse registrado' },
  integrations: [],
});

async function technicalRows(f, company, actor) {
  const suffix = randomUUID();
  const number = (await f.owner.query(`INSERT INTO numeros_whatsapp
    (empresa_id,phone_number_id,waba_id,numero_e164,numero_mascarado,status,principal)
    VALUES($1,$2,$3,'+551100000001','••••0001','ativo',true) RETURNING id`,
  [company.id, `private-phone-${suffix}`, `private-waba-${suffix}`])).rows[0].id;
  const rows = (await f.owner.query(`INSERT INTO credenciais_empresa
    (empresa_id,provedor,finalidade,secret_ciphertext,secret_kdf_salt,secret_nonce,secret_tag,key_version,valor_mascarado,created_by)
    SELECT $1,'meta',purpose,decode(repeat('11',32),'hex'),decode(repeat('22',16),'hex'),
      decode(repeat('33',12),'hex'),decode(repeat('44',16),'hex'),'v1','••••synthetic',$2
    FROM unnest(ARRAY['whatsapp:'||$3::text,'meta-app-secret','meta-verify-token']) AS purpose RETURNING id,finalidade`,
  [company.id, actor.id, number])).rows;
  const credentials = Object.fromEntries(rows.map((row) => [row.finalidade, row.id]));
  const app = (await f.owner.query(`INSERT INTO aplicativos_meta
    (empresa_id,nome,app_id,modo,estado,app_secret_credencial_id,verify_token_credencial_id,created_by,updated_by)
    VALUES($1,'Aplicativo fictício',$2,'proprio','ativo',$3,$4,$5,$5) RETURNING id`,
  [company.id, `private-app-${suffix}`, credentials['meta-app-secret'], credentials['meta-verify-token'], actor.id])).rows[0].id;
  await f.owner.query('UPDATE numeros_whatsapp SET aplicativo_meta_id=$2,access_token_credencial_id=$3 WHERE id=$1',
    [number, app, credentials[`whatsapp:${number}`]]);
  const integration = (await f.owner.query(`INSERT INTO integracoes
    (empresa_id,tipo,nome,habilitada,obrigatoria_para_confirmacao,status,configuracao,cache_version,cache_snapshot,last_success_at)
    VALUES($1,'google_sheets','Fonte fictícia',true,false,'saudavel',$2::jsonb,1,$3::jsonb,now()) RETURNING id`,
  [company.id, JSON.stringify({ profile: 'products', version: 1, spreadsheetId: 'private-synthetic-document' }),
    JSON.stringify({ profile: 'products', schemaVersion: 1, products: [{ id: 'synthetic-product', name: 'Produto fictício', active: true, availability: 'available' }] })])).rows[0].id;
  return { number, app, integration, credentials: Object.values(credentials) };
}

test('M6 PostgreSQL: business resources, administrative limits and tenant isolation', { skip: !enabled }, async (t) => {
  const f = await createM1Fixture('features');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const service = new AttendanceService({ pool, clock: f.clock, environment: 'test' });
  f.service.attendance = service;
  const admin = new VersionedConfigurationService(new PostgresVersionedConfigurationRepository(pool), { clock: f.clock });
  const publicationRepository = new PostgresOnboardingRepository(pool, { environment: 'test' });
  let ana, readonly, noRead, outsider, administrator, aurora, neighbor, technical;
  const raw = async (id) => (await f.owner.query('SELECT draft_version,configuracao FROM configuracoes_rascunho WHERE empresa_id=$1', [id])).rows[0];
  const feature = (resources, id) => resources.features.find((entry) => entry.id === id);
  const installBaseline = async (company, document, version) => {
    const draft = await raw(company.id);
    // Repository fixture only: this installs an intact active revision for
    // projection tests, without claiming the publish/preflight gate was run.
    await publicationRepository.withActivationTransaction({ empresaId: company.id, actorId: administrator.id }, async (transaction) => {
      await publicationRepository.lockActivationState({ empresaId: company.id, transaction });
      const compiled = compileTenantRuntimeConfigV2(document, { empresaId: company.id, configVersion: version, draftVersion: Number(draft.draft_version) });
      await publicationRepository.insertPublishedRevision({ empresaId: company.id, compiled, actorId: administrator.id, publishedAt: f.clock(), transaction });
      await publicationRepository.setActiveRevision({ empresaId: company.id, configVersion: version, publishedAt: f.clock(), transaction });
    });
  };
  try {
    ana = await f.makeUser('ana'); readonly = await f.makeUser('readonly'); noRead = await f.makeUser('no-read');
    outsider = await f.makeUser('outsider'); administrator = await f.makeUser('admin', { platform: true, login: false });
    aurora = await f.makeCompany('aurora'); neighbor = await f.makeCompany('neighbor');
    await f.link(ana, aurora, { permissions }); await f.link(ana, neighbor, { permissions });
    await f.link(readonly, aurora, { permissions: ['attendance.read'] }); await f.link(noRead, aurora, { permissions: ['attendance.edit'] });
    technical = await technicalRows(f, aurora, administrator);
    const main = configuration(aurora.name);
    main.integrations = [{ id: technical.integration, type: 'google_sheets', name: 'Fonte fictícia', enabled: true, required: false, credentialRefs: [] }];
    for (const [company, document] of [[aurora, main], [neighbor, configuration(neighbor.name)]]) {
      await admin.saveDraft({ empresaId: company.id, actorId: administrator.id, expectedDraftVersion: 0, configuration: document });
    }
    await installBaseline(aurora, main, 2);
    await t.test('GET capabilities matches attendance resources with business limits and no technical metadata', async () => {
      const dto = await service.read(ana.auth, aurora.id), resources = await service.capabilities(ana.auth, aurora.id);
      assert.equal(resources.companyId, aurora.id); assert.deepEqual(resources.effectiveCapabilities, permissions);
      const { companyId: _companyId, effectiveCapabilities: _caps, ...catalog } = resources;
      assert.deepEqual(dto.resources, catalog);
      const endpoint = await f.request(`/app/companies/${aurora.id}/capabilities`, { issued: ana.issued });
      assert.equal(endpoint.status, 200); assert.equal(endpoint.headers.get('cache-control'), 'no-store');
      assert.deepEqual(endpoint.body, resources);
      assert.equal(resources.fieldLimits.script.maxCharacters, 20000);
      assert.equal(resources.fieldLimits.schedules.maxItems, 50); assert.equal(resources.fieldLimits.schedules.maxCharacters, 300);
      assert.equal(feature(resources, 'script').state, 'ready'); assert.equal(feature(resources, 'sales').state, 'ready');
      assert.equal(resources.behaviors.every((entry) => entry.adminManaged === true), true);
      const json = JSON.stringify(resources);
      for (const forbidden of ['private-', technical.number, technical.app, technical.integration, ...technical.credentials,
        'monthlyTokenLimit', 'monthlyCostLimit', 'maxOutputTokens', 'credentialRef', 'phone_number_id', 'group_notifier', 'google_sheets']) {
        assert.equal(json.includes(forbidden), false, forbidden);
      }
    });
    await t.test('read-only access cannot edit; missing read and foreign membership are denied', async () => {
      const dto = await service.capabilities(readonly.auth, aurora.id);
      assert.equal(dto.features.every((entry) => entry.canEdit === false), true);
      await assert.rejects(service.save(readonly.auth, aurora.id, { draftVersion: 1, changes: { script: 'Negado' } }), { status: 403 });
      await assert.rejects(service.capabilities(noRead.auth, aurora.id), { status: 403 });
      await assert.rejects(service.capabilities(outsider.auth, aurora.id), { status: 404 });
      assert.equal((await f.request(`/app/companies/${aurora.id}/capabilities`, { issued: outsider.issued })).status, 404);
      assert.equal((await f.request(`/app/companies/${aurora.id}/capabilities`, { issued: noRead.issued })).status, 403);
    });
    await t.test('content edits preserve technical projection, administrative rows and neighbor by hash', async () => {
      const before = await raw(aurora.id), other = await raw(neighbor.id);
      const protectedBefore = (await f.owner.query('SELECT customer_attendance_technical_projection(configuracao,configuracao) value FROM configuracoes_rascunho WHERE empresa_id=$1', [aurora.id])).rows[0].value;
      const channelBefore = (await f.owner.query('SELECT to_jsonb(n) value FROM numeros_whatsapp n WHERE id=$1', [technical.number])).rows[0].value;
      const saved = await service.save(ana.auth, aurora.id, { draftVersion: Number(before.draft_version), changes: {
        script: 'Roteiro editado por Ana', tone: 'Profissional', schedules: ['Sábado, 8h às 12h'], publicRules: ['Somente com agendamento'],
      } });
      assert.equal(saved.fields.script, 'Roteiro editado por Ana'); assert.equal(saved.resources.fieldLimits.script.maxCharacters, 20000);
      const protectedAfter = (await f.owner.query('SELECT customer_attendance_technical_projection(configuracao,configuracao) value FROM configuracoes_rascunho WHERE empresa_id=$1', [aurora.id])).rows[0].value;
      assert.equal(hash(protectedAfter), hash(protectedBefore)); assert.equal(hash(await raw(neighbor.id)), hash(other));
      assert.deepEqual((await f.owner.query('SELECT to_jsonb(n) value FROM numeros_whatsapp n WHERE id=$1', [technical.number])).rows[0].value, channelBefore);
    });
    await t.test('healthy integration metadata does not override stale, wrong-profile, mismatched or unpublished catalog cache', async () => {
      const update = (clause) => f.owner.query(`UPDATE integracoes SET ${clause} WHERE id=$1`, [technical.integration]);
      const restore = () => update("configuracao=jsonb_set(configuracao,'{profile}','\"products\"'::jsonb),cache_version=1,last_success_at=now()");
      for (const clause of ["last_success_at=now()-interval '11 minutes'", 'cache_version=999',
        "configuracao=jsonb_set(configuracao,'{profile}','\"other\"'::jsonb)"]) {
        await update(clause);
        assert.equal(feature(await service.capabilities(ana.auth, aurora.id), 'sales').state, 'needs_admin');
        await restore(); assert.equal(feature(await service.capabilities(ana.auth, aurora.id), 'sales').state, 'ready');
      }
      const noBinding = structuredClone((await raw(aurora.id)).configuracao); noBinding.integrations = [];
      await installBaseline(aurora, noBinding, 3);
      assert.equal(feature(await service.capabilities(ana.auth, aurora.id), 'sales').state, 'needs_admin');
      await installBaseline(aurora, (await raw(aurora.id)).configuracao, 4);
      assert.equal(feature(await service.capabilities(ana.auth, aurora.id), 'sales').state, 'ready');
    });
    await t.test('inconsistent runtime pointer and valid legacy mode cannot advertise ready resources or publication', async () => {
      const before = (await f.owner.query('SELECT configuracao_runtime_modo,configuracao_ativa_versao,versao_configuracao FROM empresas WHERE id=$1', [aurora.id])).rows[0];
      try {
        await f.owner.query('UPDATE empresas SET versao_configuracao=versao_configuracao+1 WHERE id=$1', [aurora.id]);
        const resources = await service.capabilities(ana.auth, aurora.id);
        assert.equal(feature(resources, 'messages').state, 'needs_admin');
        assert.equal(feature(resources, 'script').state, 'needs_admin');
        assert.equal((await service.read(ana.auth, aurora.id)).publication.ready, false);
        await f.owner.query("UPDATE empresas SET configuracao_runtime_modo='legado',configuracao_ativa_versao=NULL WHERE id=$1", [aurora.id]);
        assert.equal((await service.capabilities(ana.auth, aurora.id)).features.some(({ state }) => state === 'ready'), false);
        assert.equal((await service.read(ana.auth, aurora.id)).publication.ready, false);
      } finally {
        await f.owner.query('UPDATE empresas SET configuracao_runtime_modo=$2,configuracao_ativa_versao=$3,versao_configuracao=$4 WHERE id=$1',
          [aurora.id, before.configuracao_runtime_modo, before.configuracao_ativa_versao, before.versao_configuracao]);
      }
    });
    await t.test('administratively disabled fields disappear from values, limits and guidance and PATCH is denied', async () => {
      const current = await raw(aurora.id), disabled = structuredClone(current.configuracao);
      disabled.modules = ['catalog']; disabled.ai.enabled = false; disabled.integrations = []; delete disabled.routing.fallbackAction;
      await admin.saveDraft({ empresaId: aurora.id, actorId: administrator.id, expectedDraftVersion: Number(current.draft_version), configuration: disabled });
      const dto = await service.read(ana.auth, aurora.id), catalog = await service.capabilities(ana.auth, aurora.id);
      assert.equal(feature(catalog, 'script').state, 'disabled'); assert.equal(feature(catalog, 'handoff').state, 'disabled');
      assert.equal(feature(catalog, 'script').canEdit, false); assert.deepEqual(feature(catalog, 'script').fields, []);
      for (const key of ['script', 'tone', 'aiFallback', 'followUp', 'handoffMessage', 'salesInterestMessage']) {
        assert.equal(Object.hasOwn(dto.fields, key), false); assert.equal(Object.hasOwn(catalog.fieldLimits, key), false);
        assert.equal(Object.hasOwn(catalog.guidance, key), false);
      }
      await assert.rejects(service.save(ana.auth, aurora.id, { draftVersion: dto.draftVersion, changes: { script: 'Não habilitar' } }), { status: 403 });
      await assert.rejects(async () => service.save(ana.auth, aurora.id, { draftVersion: dto.draftVersion, changes: { futureModule: true } }), { status: 422 });
      assert.equal(Number((await raw(aurora.id)).draft_version), dto.draftVersion);
    });
    await t.test('company suspension permits authorized draft and denies operational capabilities', async () => {
      await f.owner.query("UPDATE empresas SET status='suspensa' WHERE id=$1", [aurora.id]);
      const catalog = await service.capabilities(ana.auth, aurora.id);
      assert.deepEqual(catalog.effectiveCapabilities, ['attendance.read', 'attendance.edit']);
      assert.equal(feature(catalog, 'messages').state, 'suspended');
      const current = await raw(aurora.id);
      const saved = await service.save(ana.auth, aurora.id, { draftVersion: Number(current.draft_version), changes: { greeting: 'Preparado durante suspensão' } });
      assert.equal(saved.company.status, 'suspensa'); assert.equal(saved.canSimulate, false); assert.equal(saved.canPublish, false);
      await assert.rejects(service.simulate(ana.auth, aurora.id, { draftVersion: saved.draftVersion, message: 'oi' }), { status: 403 });
      await assert.rejects(service.publish(ana.auth, aurora.id, { draftVersion: saved.draftVersion, reviewToken: 'a'.repeat(64), idempotencyKey: randomUUID(), confirmed: true }), { status: 403 });
    });
    await t.test('membership revocation blocks the next resources request without exposing previous state', async () => {
      await f.owner.query("UPDATE usuarios_empresas SET status='suspenso' WHERE empresa_id=$1 AND usuario_id=$2", [aurora.id, readonly.id]);
      await assert.rejects(service.capabilities(readonly.auth, aurora.id), { status: 404 });
      assert.equal((await f.request(`/app/companies/${aurora.id}/capabilities`, { issued: readonly.issued })).status, 404);
    });
    await t.test('success and denied requests leave no administrative, identity, tenant or audience GUC in the pool', async () => {
      const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
      try {
        for (const client of clients) {
          const gucs = (await client.query("SELECT current_setting('app.usuario_id',true) identity,current_setting('app.empresa_id',true) tenant,current_setting('app.audience',true) audience,current_setting('app.is_platform_admin',true) admin,current_setting('app.attendance_session_id',true) session")).rows[0];
          assert.equal(Object.values(gucs).every((value) => !value), true);
          assert.equal((await client.query('SELECT 1 FROM configuracoes_rascunho')).rowCount, 0);
          assert.equal((await client.query('SELECT 1 FROM credenciais_empresa')).rowCount, 0);
        }
      } finally { clients.forEach((client) => client.release()); }
    });
  } finally {
    await f.owner.query('UPDATE empresas SET configuracao_ativa_versao=NULL WHERE id=ANY($1::uuid[])', [f.companies]);
    for (const table of ['logs_auditoria', 'numeros_whatsapp', 'aplicativos_meta', 'credenciais_empresa', 'integracoes']) {
      await f.owner.query(`DELETE FROM ${table} WHERE empresa_id=ANY($1::uuid[])`, [f.companies]);
    }
    await pool.end(); await f.close();
  }
});
