import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createM1Fixture, enabled } from './support/m1-fixtures.js';
import { AttendanceService } from '../src/modules/attendance/attendance-service.js';
import { PostgresVersionedConfigurationRepository, VersionedConfigurationService,
  compileTenantRuntimeConfigV2 } from '../src/modules/configuration/index.js';
import { PostgresOnboardingRepository } from '../src/modules/onboarding/index.js';

const optionalCapabilities = ['conversations.read', 'conversations.reply', 'conversations.pause', 'leads.read'];
const optionalResources = { conversations: false, leads: false, media: false, humanActions: false };
const configuration = (name) => ({
  schemaVersion: 2,
  identity: { name, displayName: name, timezone: 'America/Sao_Paulo', welcomeMessage: 'Olá, conteúdo fictício privado.',
    fallbackMessage: 'Como posso ajudar?' },
  modules: ['catalog', 'ai_freeform', 'human_handoff'],
  menu: { text: 'Menu fictício privado', options: [{ id: 'catalogo', label: 'Catálogo', action: 'catalog.list', params: {} }] },
  routing: { greetings: ['oi'], aliases: [], fallbackAction: 'ai_freeform.reply' },
  ai: { enabled: true, provider: 'simulated', model: 'm7-private-model', keyMode: 'simulated',
    prompt: 'm7-private-script', maxOutputTokens: 123, monthlyTokenLimit: 12345 },
  humanHandoff: { channel: 'm7-private-channel', assigneeRef: 'user:m7-private-assignee', message: 'Aguarde a equipe.' },
  integrations: [],
});
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('M7 PostgreSQL: visão geral sanitizada, ausência de opcionais e revogação', { skip: !enabled }, async (t) => {
  const f = await createM1Fixture('m7-overview');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const service = new AttendanceService({ pool, clock: f.clock, environment: 'test' });
  f.service.attendance = service;
  const admin = new VersionedConfigurationService(new PostgresVersionedConfigurationRepository(pool), { clock: f.clock });
  const publicationRepository = new PostgresOnboardingRepository(pool, { environment: 'test' });
  const raw = async (id) => (await f.owner.query('SELECT draft_version,configuracao FROM configuracoes_rascunho WHERE empresa_id=$1', [id])).rows[0];
  let reader, editor, noRead, outsider, administrator, company, neighbor, unprepared;
  const baseline = async (document, version) => {
    const draft = await raw(company.id);
    // This is a repository fixture of an intact published revision, without
    // claiming provider readiness, activation or a real customer publication.
    await publicationRepository.withActivationTransaction({ empresaId: company.id, actorId: administrator.id }, async (transaction) => {
      await publicationRepository.lockActivationState({ empresaId: company.id, transaction });
      const compiled = compileTenantRuntimeConfigV2(document, { empresaId: company.id,
        configVersion: version, draftVersion: Number(draft.draft_version) });
      await publicationRepository.insertPublishedRevision({ empresaId: company.id, compiled, actorId: administrator.id,
        publishedAt: f.clock(), transaction });
      await publicationRepository.setActiveRevision({ empresaId: company.id, configVersion: version,
        publishedAt: f.clock(), transaction });
    });
  };
  try {
    reader = await f.makeUser('reader'); editor = await f.makeUser('editor');
    noRead = await f.makeUser('no-read'); outsider = await f.makeUser('outsider');
    administrator = await f.makeUser('admin', { platform: true, login: false });
    company = await f.makeCompany('company'); neighbor = await f.makeCompany('neighbor'); unprepared = await f.makeCompany('unprepared');
    await f.link(reader, company, { role: 'administrador', permissions: ['attendance.read', ...optionalCapabilities, '*'] });
    await f.link(reader, unprepared, { permissions: ['attendance.read'] });
    await f.link(editor, company, { permissions: ['attendance.read', 'attendance.edit'] });
    await f.link(noRead, company, { permissions: ['attendance.edit', ...optionalCapabilities] });
    await f.link(outsider, neighbor);
    for (const item of [company, neighbor]) await admin.saveDraft({ empresaId: item.id, actorId: administrator.id,
      expectedDraftVersion: 0, configuration: configuration(item.name) });

    await t.test('resumo HTTP tem contrato fechado, cache desativado e não contém textos, técnica ou autores', async () => {
      const dto = await service.overview(reader.auth, company.id);
      assert.deepEqual(Object.keys(dto).sort(), ['company', 'draftVersion', 'activeVersion', 'savedAt', 'publishedAt',
        'hasDraft', 'publication', 'optionalResources'].sort());
      assert.deepEqual(dto.company, { id: company.id, name: company.name, status: 'ativa' });
      assert.equal(dto.hasDraft, true); assert.equal(dto.draftVersion, 1); assert.equal(dto.activeVersion, null);
      assert.equal(dto.publication.state, 'unpublished'); assert.equal(dto.publication.changeCount, null);
      assert.deepEqual(dto.optionalResources, optionalResources);
      assert.ok(dto.savedAt); assert.equal(dto.publishedAt, null);
      const response = await f.request(`/app/companies/${company.id}/overview`, { issued: reader.issued });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(response.body, JSON.parse(JSON.stringify(dto)));
      const json = JSON.stringify(response.body);
      for (const forbidden of ['m7-private', 'conteúdo fictício privado', 'monthlyTokenLimit', 'maxOutputTokens',
        'credentialRef', 'reviewToken', 'fields', 'changes', 'configuration', reader.id, administrator.id, neighbor.id, neighbor.name]) {
        assert.equal(json.includes(forbidden), false, forbidden);
      }
    });
    await t.test('empresa autorizada sem base administrativa tem resumo em preparação, sem criar rascunho', async () => {
      const dto = await service.overview(reader.auth, unprepared.id);
      assert.equal(dto.hasDraft, false); assert.equal(dto.draftVersion, null); assert.equal(dto.activeVersion, null);
      assert.equal(dto.savedAt, null); assert.equal(dto.publishedAt, null); assert.equal(dto.publication.state, 'preparing');
      assert.deepEqual(dto.optionalResources, optionalResources);
      assert.equal(await raw(unprepared.id), undefined);
      assert.equal((await f.request(`/app/companies/${unprepared.id}/overview`, { issued: reader.issued })).status, 200);
      await assert.rejects(service.read(reader.auth, unprepared.id), { status: 409 });
    });
    await t.test('resumo publicado e alterações de negócio são diferentes de pendência administrativa', async () => {
      const original = (await raw(company.id)).configuracao;
      await baseline(original, 1);
      const published = await service.overview(reader.auth, company.id);
      assert.equal(published.publication.state, 'published'); assert.equal(published.publication.changeCount, 0);
      assert.equal(published.activeVersion, 1); assert.ok(published.publishedAt);
      await service.save(editor.auth, company.id, { draftVersion: 1, changes: { greeting: 'Saudação alterada no rascunho.' } });
      const changed = await service.overview(reader.auth, company.id);
      assert.equal(changed.publication.state, 'changes_pending'); assert.ok(changed.publication.changeCount > 0);
      const current = await raw(company.id), technical = structuredClone(current.configuracao);
      technical.ai.model = 'm7-private-changed-model';
      await admin.saveDraft({ empresaId: company.id, actorId: administrator.id,
        expectedDraftVersion: Number(current.draft_version), configuration: technical });
      const pending = await service.overview(reader.auth, company.id);
      assert.equal(pending.publication.state, 'administrative_pending'); assert.equal(pending.publication.changeCount, null);
      assert.equal(JSON.stringify(pending).includes('m7-private'), false);
    });
    await t.test('empresa alheia, ID inválido, audience e capacidade são revalidados no serviço e HTTP', async () => {
      for (const id of [neighbor.id, randomUUID(), 'not-a-company']) {
        await assert.rejects(service.overview(reader.auth, id), { status: 404 });
        assert.equal((await f.request(`/app/companies/${id}/overview`, { issued: reader.issued })).status, 404);
      }
      await assert.rejects(service.overview(noRead.auth, company.id), { status: 403 });
      assert.equal((await f.request(`/app/companies/${company.id}/overview`, { issued: noRead.issued })).status, 403);
      await assert.rejects(service.overview({ ...reader.auth, audience: 'admin' }, company.id), { status: 403 });
      assert.equal((await f.request(`/app/companies/${company.id}/overview`)).status, 401);
    });
    await t.test('suspensão administrativa permite resumo autorizado sem reativação nem alteração do vizinho', async () => {
      const before = hash(await raw(neighbor.id));
      await f.owner.query("UPDATE empresas SET status='suspensa' WHERE id=$1", [company.id]);
      const dto = await service.overview(reader.auth, company.id);
      assert.equal(dto.company.status, 'suspensa'); assert.deepEqual(dto.optionalResources, optionalResources);
      assert.equal((await f.owner.query('SELECT status FROM empresas WHERE id=$1', [company.id])).rows[0].status, 'suspensa');
      assert.equal(hash(await raw(neighbor.id)), before);
      await f.owner.query("UPDATE empresas SET status='ativa' WHERE id=$1", [company.id]);
    });
    await t.test('grants opcionais e papel administrativo do vínculo não abrem rotas de dados, mídia, streams ou ações', async () => {
      assert.deepEqual((await f.service.company(reader.auth, company.id)).effectiveCapabilities, ['attendance.read']);
      const child = randomUUID();
      for (const [method, suffix] of [['GET', 'conversations'], ['GET', `conversations/${child}`],
        ['GET', `conversations/${child}/messages`], ['GET', `conversations/${child}/stream`], ['GET', 'leads'],
        ['GET', `messages/${child}/media`], ['GET', 'stream'], ['GET', 'exports'],
        ['POST', `conversations/${child}/messages`], ['POST', `conversations/${child}/pause`],
        ['POST', `conversations/${child}/resume`], ['POST', `conversations/${child}/assume`]]) {
        const response = await f.request(`/app/companies/${company.id}/${suffix}`, { method, issued: reader.issued,
          ...(method === 'POST' ? { body: { text: 'Não enviar.' } } : {}) });
        assert.equal(response.status, 404, `${method} ${suffix}`);
        assert.equal(JSON.stringify(response.body).includes('m7-private'), false);
      }
    });
    await t.test('redução e revogação do vínculo impedem próxima leitura da sessão existente', async () => {
      await f.owner.query('UPDATE usuarios_empresas SET permissoes=$3 WHERE empresa_id=$1 AND usuario_id=$2',
        [company.id, reader.id, optionalCapabilities]);
      await assert.rejects(service.overview(reader.auth, company.id), { status: 403 });
      await f.owner.query("UPDATE usuarios_empresas SET permissoes=ARRAY['attendance.read'],status='suspenso' WHERE empresa_id=$1 AND usuario_id=$2",
        [company.id, reader.id]);
      assert.equal((await f.request(`/app/companies/${company.id}/overview`, { issued: reader.issued })).status, 404);
      await assert.rejects(service.overview(reader.auth, company.id), { status: 404 });
    });
    await t.test('sessão encerrada bloqueia contexto anteriormente autenticado e HTTP sem retornar resumo antigo', async () => {
      await f.service.logout(editor.auth);
      await assert.rejects(service.overview(editor.auth, company.id), { status: 401 });
      const response = await f.request(`/app/companies/${company.id}/overview`, { issued: editor.issued });
      assert.equal(response.status, 401); assert.equal(response.body.company, undefined);
    });
    await t.test('papel real sem bypass e contextos transacionais não persistem após sucesso ou negação', async () => {
      assert.deepEqual((await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],
        { rolsuper: false, rolbypassrls: false });
      const gucs = (await pool.query("SELECT current_setting('app.usuario_id',true) identity,current_setting('app.empresa_id',true) tenant,current_setting('app.audience',true) audience,current_setting('app.is_platform_admin',true) admin")).rows[0];
      assert.equal(Object.values(gucs).every((value) => !value), true);
      assert.equal((await pool.query('SELECT 1 FROM configuracoes_rascunho')).rowCount, 0);
    });
  } finally {
    await f.owner.query('UPDATE empresas SET configuracao_ativa_versao=NULL WHERE id=ANY($1::uuid[])', [f.companies]);
    await f.owner.query('DELETE FROM logs_auditoria WHERE empresa_id=ANY($1::uuid[])', [f.companies]);
    await pool.end(); await f.close();
  }
});
