import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createM1Fixture, enabled } from './support/m1-fixtures.js';
import { AttendanceService } from '../src/modules/attendance/attendance-service.js';
import { AccountRateLimiter } from '../src/modules/accounts/rate-limiter.js';
import { PostgresVersionedConfigurationRepository, VersionedConfigurationService,
  CAPABILITY_CATALOG_V2, actionOwnerV2, compileTenantRuntimeConfigV2, validateActionParamsV2 } from '../src/modules/configuration/index.js';
import { OnboardingService, PostgresOnboardingRepository, ReadinessService } from '../src/modules/onboarding/index.js';
import { PostgresTenantDefinitionRepository } from '../src/tenants/postgres-config-loader.js';
import { withCustomerTransaction } from '../src/infra/postgres/transaction.js';

const capabilities = ['attendance.read', 'attendance.edit', 'attendance.simulate', 'attendance.publish'];
const configuration = (name) => ({
  schemaVersion: 2,
  identity: { name, displayName: name, locale: 'pt-BR', timezone: 'America/Sao_Paulo', welcomeMessage: `Olá, ${name}.`, fallbackMessage: 'Como posso ajudar?' },
  retention: { messagesDays: 30, logsDays: 30 }, modules: ['catalog', 'ai_freeform', 'human_handoff'],
  menu: { text: 'Menu sintético', options: [{ id: 'catalogo', label: 'Catálogo', action: 'catalog.list', params: {} }] },
  routing: { greetings: ['oi'], aliases: [{ terms: ['endereço'], action: 'catalog.address', params: {} }], fallbackAction: 'ai_freeform.reply' },
  publicReplies: [{ action: 'catalog.address', text: `Endereço fictício ${name}.` }],
  ai: { enabled: true, provider: 'simulated', model: 'synthetic-model', keyMode: 'simulated', prompt: `Roteiro ${name}.` },
  humanHandoff: { channel: 'manual', message: 'Aguarde a equipe.', cooldownSeconds: 30 }, integrations: [],
});

// Technical fixtures are repository tests, never application tenant provisioning.
// No valid credential, gateway, external number or service is involved.
async function prepareTechnical(f, company, actor) {
  const suffix = randomUUID();
  const number = (await f.owner.query(`INSERT INTO numeros_whatsapp
    (empresa_id,phone_number_id,waba_id,numero_e164,numero_mascarado,status,principal)
    VALUES($1,$2,$3,'+551100000001','••••0001','ativo',true) RETURNING id`,
  [company.id, `synthetic-phone-${suffix}`, `synthetic-waba-${suffix}`])).rows[0].id;
  const credentials = (await f.owner.query(`INSERT INTO credenciais_empresa
    (empresa_id,provedor,finalidade,secret_ciphertext,secret_kdf_salt,secret_nonce,secret_tag,key_version,valor_mascarado,created_by)
    SELECT $1,'meta',purpose,decode(repeat('11',32),'hex'),decode(repeat('22',16),'hex'),
      decode(repeat('33',12),'hex'),decode(repeat('44',16),'hex'),'v1','••••synthetic',$2
    FROM unnest(ARRAY['whatsapp:'||$3::text,'meta-app-secret','meta-verify-token']) AS purpose RETURNING id,finalidade`,
  [company.id, actor.id, number])).rows;
  const byPurpose = Object.fromEntries(credentials.map((row) => [row.finalidade, row.id]));
  const application = (await f.owner.query(`INSERT INTO aplicativos_meta
    (empresa_id,nome,app_id,modo,estado,app_secret_credencial_id,verify_token_credencial_id,created_by,updated_by)
    VALUES($1,'Aplicativo sintético',$2,'proprio','ativo',$3,$4,$5,$5) RETURNING id`,
  [company.id, `synthetic-app-${suffix}`, byPurpose['meta-app-secret'], byPurpose['meta-verify-token'], actor.id])).rows[0].id;
  await f.owner.query('UPDATE numeros_whatsapp SET aplicativo_meta_id=$2,access_token_credencial_id=$3 WHERE id=$1',
    [number, application, byPurpose[`whatsapp:${number}`]]);
  return { number, application };
}

test('M5 PostgreSQL: publication authorization, concurrency, rollback and runtime', { skip: !enabled }, async (t) => {
  const f = await createM1Fixture('publication');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  const readinessService = new ReadinessService({ compiler: compileTenantRuntimeConfigV2,
    capabilityCatalog: CAPABILITY_CATALOG_V2, actionOwner: actionOwnerV2, validateActionParams: validateActionParamsV2 });
  const admin = new VersionedConfigurationService(new PostgresVersionedConfigurationRepository(pool), { clock: f.clock });
  const onboarding = new OnboardingService({ repository: new PostgresOnboardingRepository(pool, { environment: 'test' }),
    configurationService: admin, readinessService, clock: f.clock });
  const limiter = new AccountRateLimiter({ environment: 'test' });
  const passedPreflight = async () => ({ state: 'passed', summary: { failedCount: 0 } });
  const service = new AttendanceService({ pool, clock: f.clock, environment: 'test', readinessService, limiter, preflight: passedPreflight });
  const runtime = new PostgresTenantDefinitionRepository(pool);
  let ana, bia, outsider, administrator, aurora, neighbor, technical, successfulConfirmation;
  const state = async (id) => (await f.owner.query(`SELECT status,configuracao_ativa_versao,versao_configuracao,
    (SELECT count(*)::int FROM configuracoes_revisoes r WHERE r.empresa_id=e.id) revisions,
    (SELECT count(*)::int FROM attendance_publications p WHERE p.empresa_id=e.id) receipts,
    (SELECT count(*)::int FROM logs_auditoria a WHERE a.empresa_id=e.id AND a.acao='configuration.publish') publications
    FROM empresas e WHERE id=$1`, [id])).rows[0];
  const raw = async (id) => (await f.owner.query('SELECT draft_version,configuracao FROM configuracoes_rascunho WHERE empresa_id=$1', [id])).rows[0];
  const confirmation = (dto, key = randomUUID()) => ({ draftVersion: dto.draftVersion, reviewToken: dto.publication.reviewToken, idempotencyKey: key, confirmed: true });
  const edit = async (text) => {
    const dto = await service.read(ana.auth, aurora.id);
    return service.save(ana.auth, aurora.id, { draftVersion: dto.draftVersion, changes: { script: text, greeting: `Olá ${text}` } });
  };
  try {
    ana = await f.makeUser('ana'); bia = await f.makeUser('bia'); outsider = await f.makeUser('outsider');
    administrator = await f.makeUser('admin', { platform: true, login: false });
    aurora = await f.makeCompany('aurora'); neighbor = await f.makeCompany('horizonte');
    for (const company of [aurora, neighbor]) {
      await f.link(ana, company, { role: 'administrador', permissions: capabilities });
      await admin.saveDraft({ empresaId: company.id, actorId: administrator.id, expectedDraftVersion: 0, configuration: configuration(company.name) });
    }
    await f.link(bia, aurora, { permissions: capabilities });
    await t.test('a draft without an administrative published base cannot simulate or publish', async () => {
      const dto = await service.read(ana.auth, aurora.id);
      assert.equal(dto.publication.ready, false); assert.equal(dto.publication.reviewToken, null);
      await assert.rejects(service.simulate(ana.auth, aurora.id, { draftVersion: 1, message: 'oi' }), { status: 409 });
      await assert.rejects(service.publish(ana.auth, aurora.id, { draftVersion: 1, reviewToken: 'a'.repeat(64), idempotencyKey: randomUUID(), confirmed: true }), { status: 409 });
      assert.equal((await state(aurora.id)).revisions, 0);
    });
    for (const company of [aurora, neighbor]) {
      const prepared = await prepareTechnical(f, company, administrator); if (company === aurora) technical = prepared;
      assert.equal((await onboarding.readiness({ empresaId: company.id })).ready, true);
      await onboarding.publish({ empresaId: company.id, actorId: administrator.id, expectedDraftVersion: 1 });
    }
    await t.test('save stays draft; simulation is synthetic; only publication changes its tenant runtime', async () => {
      const neighborBefore = await state(neighbor.id), before = await state(aurora.id);
      const dto = await edit('Roteiro M5 publicado');
      assert.equal(dto.publication.ready, true); assert.ok(dto.publication.changes.some((change) => change.key === 'script'));
      assert.deepEqual(await state(aurora.id), before);
      assert.notEqual((await runtime.load(aurora.id)).ai.prompt, 'Roteiro M5 publicado');
      const simulated = await service.simulate(ana.auth, aurora.id.toUpperCase(), { draftVersion: dto.draftVersion, message: 'oi' });
      // The configured greeting route opens the deterministic menu before AI.
      assert.equal(simulated.reply, 'Menu sintético');
      assert.deepEqual(Object.keys(simulated).sort(), ['draftVersion', 'message', 'reply']);
      const result = await service.publish(ana.auth, aurora.id.toUpperCase(), confirmation(dto));
      assert.equal(result.activeVersion, Number(before.configuracao_ativa_versao) + 1);
      assert.equal((await runtime.load(aurora.id)).ai.prompt, 'Roteiro M5 publicado');
      assert.equal((await runtime.load(aurora.id)).runtime.version, result.activeVersion);
      assert.equal((await runtime.load(aurora.id)).runtime.identity.welcomeMessage, 'Olá Roteiro M5 publicado');
      assert.deepEqual(await state(neighbor.id), neighborBefore);
      assert.equal((await state(aurora.id)).status, 'ativa');
    });
    await t.test('idempotent retries return one revision and changed payload conflicts', async () => {
      const dto = await edit('Roteiro idempotente'), body = confirmation(dto), before = await state(aurora.id);
      const results = await Promise.all([service.publish(ana.auth, aurora.id, body), service.publish(ana.auth, aurora.id, body)]);
      successfulConfirmation = body;
      assert.deepEqual(results[0], results[1]);
      const after = await state(aurora.id); assert.equal(after.revisions, before.revisions + 1); assert.equal(after.receipts, before.receipts + 1);
      assert.deepEqual(await service.publish(ana.auth, aurora.id, body), results[0]);
      await assert.rejects(service.publish(ana.auth, aurora.id, { ...body, reviewToken: 'b'.repeat(64) }), { status: 409, code: 'ATTENDANCE_PUBLICATION_CONFLICT' });
    });
    await t.test('stale draft and stale review token preserve the active revision', async () => {
      const old = await service.read(ana.auth, aurora.id); await edit('Nova edição concorrente');
      const before = await state(aurora.id);
      await assert.rejects(service.publish(ana.auth, aurora.id, confirmation(old)), { status: 409 });
      const current = await service.read(ana.auth, aurora.id);
      await assert.rejects(service.publish(ana.auth, aurora.id, { ...confirmation(current), reviewToken: 'c'.repeat(64) }), { status: 409 });
      assert.deepEqual(await state(aurora.id), before);
    });
    await t.test('hidden administrative changes block customer publication and simulation', async () => {
      const current = await raw(aurora.id), changed = structuredClone(current.configuracao); changed.ai.model = 'hidden-administrative-model';
      await admin.saveDraft({ empresaId: aurora.id, actorId: administrator.id, expectedDraftVersion: Number(current.draft_version), configuration: changed });
      const dto = await service.read(ana.auth, aurora.id), before = await state(aurora.id);
      assert.equal(dto.publication.ready, false); assert.equal(JSON.stringify(dto).includes('hidden-administrative-model'), false);
      await assert.rejects(service.simulate(ana.auth, aurora.id, { draftVersion: dto.draftVersion, message: 'oi' }), { status: 409 });
      await assert.rejects(service.publish(ana.auth, aurora.id, { ...confirmation(dto), reviewToken: 'd'.repeat(64) }), { status: 409 });
      assert.deepEqual(await state(aurora.id), before);
      changed.ai.model = 'synthetic-model';
      await admin.saveDraft({ empresaId: aurora.id, actorId: administrator.id, expectedDraftVersion: dto.draftVersion, configuration: changed });
    });
    await t.test('real readiness dependency failure retains the previous runtime and zero new receipt', async () => {
      const dto = await edit('Dependência deve bloquear'), before = await state(aurora.id), previous = await runtime.load(aurora.id);
      await f.owner.query("UPDATE numeros_whatsapp SET status='pendente' WHERE id=$1", [technical.number]);
      await assert.rejects(service.publish(ana.auth, aurora.id, confirmation(dto)), { status: 409, code: 'ATTENDANCE_NOT_READY' });
      assert.deepEqual(await state(aurora.id), before); assert.deepEqual(await runtime.load(aurora.id), previous);
      await f.owner.query("UPDATE numeros_whatsapp SET status='ativo' WHERE id=$1", [technical.number]);
    });
    await t.test('audit failure rolls back revision, active pointer and receipt atomically', async () => {
      const dto = await service.read(ana.auth, aurora.id), before = await state(aurora.id), previous = await runtime.load(aurora.id);
      await assert.rejects(service.publish(ana.auth, aurora.id, confirmation(dto), 'invalid-correlation-uuid'),
        (error) => error.message === 'Attendance operation unavailable.' && !JSON.stringify(error).includes('uuid'));
      assert.deepEqual(await state(aurora.id), before); assert.deepEqual(await runtime.load(aurora.id), previous);
    });
    await t.test('two customer confirmations against one review produce one winner and one conflict', async () => {
      const dto = await service.read(ana.auth, aurora.id), before = await state(aurora.id);
      const outcomes = await Promise.allSettled([service.publish(ana.auth, aurora.id, confirmation(dto)), service.publish(bia.auth, aurora.id, confirmation(dto))]);
      assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter((entry) => entry.status === 'rejected' && entry.reason.status === 409).length, 1);
      assert.equal((await state(aurora.id)).revisions, before.revisions + 1);
    });
    await t.test('administrative draft concurrency cannot publish hidden technical changes', async () => {
      const dto = await edit('Corrida com administrador'), current = await raw(aurora.id), changed = structuredClone(current.configuracao);
      changed.ai.model = 'admin-race-model'; const before = await state(aurora.id);
      const outcomes = await Promise.allSettled([
        service.publish(ana.auth, aurora.id, confirmation(dto)),
        admin.saveDraft({ empresaId: aurora.id, actorId: administrator.id, expectedDraftVersion: dto.draftVersion, configuration: changed }),
      ]);
      assert.equal(outcomes[1].status, 'fulfilled');
      if (outcomes[0].status === 'rejected') { assert.equal(outcomes[0].reason.status, 409); assert.deepEqual(await state(aurora.id), before); }
      else assert.equal((await state(aurora.id)).revisions, before.revisions + 1);
      const active = await runtime.load(aurora.id); assert.equal(active.ai.prompt, outcomes[0].status === 'fulfilled' ? 'Corrida com administrador' : 'Dependência deve bloquear');
      const stored = (await f.owner.query('SELECT configuracao_compilada FROM configuracoes_revisoes WHERE empresa_id=$1 AND config_version=$2',
        [aurora.id, (await state(aurora.id)).configuracao_ativa_versao])).rows[0].configuracao_compilada;
      assert.equal(stored.configuration.ai.model, 'synthetic-model');
      const pending = await raw(aurora.id); pending.configuracao.ai.model = 'synthetic-model';
      await admin.saveDraft({ empresaId: aurora.id, actorId: administrator.id, expectedDraftVersion: Number(pending.draft_version), configuration: pending.configuracao });
    });
    await t.test('capabilities, foreign tenant and customer RLS deny publication metadata and technical revisions', async () => {
      const dto = await service.read(ana.auth, aurora.id);
      await assert.rejects(service.publish(outsider.auth, aurora.id, confirmation(dto)), { status: 404 });
      await f.owner.query("UPDATE usuarios_empresas SET permissoes=ARRAY['attendance.read','attendance.edit'] WHERE empresa_id=$1 AND usuario_id=$2", [aurora.id, bia.id]);
      await assert.rejects(service.publish(bia.auth, aurora.id, confirmation(dto)), { status: 403 });
      await assert.rejects(service.simulate(bia.auth, aurora.id, { draftVersion: dto.draftVersion, message: 'oi' }), { status: 403 });
      await withCustomerTransaction(pool, { usuarioId: ana.id, sessionId: ana.auth.sessionId, empresaId: aurora.id, permission: 'attendance.read', now: f.clock() }, async ({ client }) => {
        assert.equal((await client.query('SELECT * FROM attendance_publications')).rowCount, 0);
        assert.equal((await client.query('SELECT * FROM configuracoes_revisoes')).rowCount, 0);
      });
    });
    await t.test('Redis failure and simulation budget fail closed before running the preview', async () => {
      const dto = await service.read(ana.auth, aurora.id);
      const broken = new AttendanceService({ pool, clock: f.clock, readinessService, environment: 'test', limiter: { consume: async () => { throw new Error('private redis diagnostic'); } } });
      await assert.rejects(broken.simulate(ana.auth, aurora.id, { draftVersion: dto.draftVersion, message: 'oi' }), { status: 503, code: 'ATTENDANCE_UNAVAILABLE' });
      const exhausted = new AttendanceService({ pool, clock: f.clock, readinessService, environment: 'test', limiter: { consume: async () => ({ allowed: false }) } });
      await assert.rejects(exhausted.simulate(ana.auth, aurora.id, { draftVersion: dto.draftVersion, message: 'oi' }), { status: 429 });
    });
    await t.test('failed preflight preserves the previous revision with a sanitized error', async () => {
      const dto = await service.read(ana.auth, aurora.id), before = await state(aurora.id);
      const failed = new AttendanceService({ pool, clock: f.clock, environment: 'test', readinessService, limiter,
        preflight: async () => ({ state: 'failed', summary: { failedCount: 1 }, checks: [{ private: 'technical-provider-diagnostic' }] }) });
      await assert.rejects(failed.publish(ana.auth, aurora.id, confirmation(dto)),
        (error) => error.status === 409 && error.code === 'ATTENDANCE_NOT_READY' && !JSON.stringify(error).includes('technical-provider'));
      assert.deepEqual(await state(aurora.id), before);
    });
    await t.test('preflight gap revalidates draft, administrative base, company status and membership', async () => {
      const scenarios = [
        { status: 409, change: async () => { await edit('Editado durante preflight'); }, restore: async () => {} },
        { status: 409, change: async () => {
          const draft = await raw(aurora.id); draft.configuracao.ai.model = 'pending-during-preflight';
          await admin.saveDraft({ empresaId: aurora.id, actorId: administrator.id, expectedDraftVersion: Number(draft.draft_version), configuration: draft.configuracao });
        }, restore: async () => {
          const draft = await raw(aurora.id); draft.configuracao.ai.model = 'synthetic-model';
          await admin.saveDraft({ empresaId: aurora.id, actorId: administrator.id, expectedDraftVersion: Number(draft.draft_version), configuration: draft.configuracao });
        } },
        { status: 403, change: () => f.owner.query("UPDATE empresas SET status='suspensa' WHERE id=$1", [aurora.id]),
          restore: () => f.owner.query("UPDATE empresas SET status='ativa' WHERE id=$1", [aurora.id]) },
        { status: 404, change: () => f.owner.query("UPDATE usuarios_empresas SET status='suspenso' WHERE empresa_id=$1 AND usuario_id=$2", [aurora.id, ana.id]),
          restore: () => f.owner.query("UPDATE usuarios_empresas SET status='ativo' WHERE empresa_id=$1 AND usuario_id=$2", [aurora.id, ana.id]) },
      ];
      for (const scenario of scenarios) {
        const dto = await service.read(ana.auth, aurora.id), before = await state(aurora.id);
        const race = new AttendanceService({ pool, clock: f.clock, environment: 'test', readinessService, limiter,
          preflight: async () => { await scenario.change(); return passedPreflight(); } });
        try { await assert.rejects(race.publish(ana.auth, aurora.id, confirmation(dto)), { status: scenario.status }); }
        finally { await scenario.restore(); }
        const after = await state(aurora.id);
        assert.equal(after.revisions, before.revisions); assert.equal(after.receipts, before.receipts);
        assert.equal(after.configuracao_ativa_versao, before.configuracao_ativa_versao);
      }
    });
    await t.test('company suspension permits draft only; link/session revocation denies even retries', async () => {
      const dto = await service.read(ana.auth, aurora.id), body = confirmation(dto);
      await f.owner.query("UPDATE empresas SET status='suspensa' WHERE id=$1", [aurora.id]);
      const suspended = await service.save(ana.auth, aurora.id, { draftVersion: dto.draftVersion, changes: { greeting: 'Rascunho suspenso' } });
      assert.equal(suspended.company.status, 'suspensa');
      await assert.rejects(service.publish(ana.auth, aurora.id, body), { status: 403 });
      await assert.rejects(service.publish(ana.auth, aurora.id, successfulConfirmation), { status: 403 });
      await assert.rejects(service.simulate(ana.auth, aurora.id, { draftVersion: suspended.draftVersion, message: 'oi' }), { status: 403 });
      assert.equal((await state(aurora.id)).status, 'suspensa');
      await f.owner.query("UPDATE usuarios_empresas SET status='suspenso' WHERE empresa_id=$1 AND usuario_id=$2", [aurora.id, bia.id]);
      await assert.rejects(service.read(bia.auth, aurora.id), { status: 404 });
      await f.service.logout(ana.auth); await assert.rejects(service.read(ana.auth, aurora.id), { status: 401 });
      await assert.rejects(service.publish(ana.auth, aurora.id, successfulConfirmation), { status: 401 });
      const clients = await Promise.all(Array.from({ length: 5 }, () => pool.connect()));
      try {
        for (const client of clients) {
          const context = (await client.query(`SELECT current_setting('app.is_platform_admin',true) AS admin,
            current_setting('app.audience',true) AS audience,current_setting('app.empresa_id',true) AS company,
            current_setting('app.usuario_id',true) AS actor,current_setting('app.attendance_session_id',true) AS session`)).rows[0];
          assert.ok(Object.values(context).every((value) => !value));
        }
      } finally { clients.forEach((client) => client.release()); }
    });
  } finally {
    await f.owner.query('UPDATE empresas SET configuracao_ativa_versao=NULL WHERE id=ANY($1::uuid[])', [f.companies]);
    // Published revisions are append-only; fixture company deletion cascades
    // them after the active pointer and restrictive dependencies are removed.
    for (const table of ['attendance_publications', 'logs_auditoria', 'numeros_whatsapp', 'aplicativos_meta', 'credenciais_empresa']) {
      await f.owner.query(`DELETE FROM ${table} WHERE empresa_id=ANY($1::uuid[])`, [f.companies]);
    }
    await pool.end(); await f.close();
  }
});
