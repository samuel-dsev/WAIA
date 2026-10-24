import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { createM1Fixture, enabled } from './support/m1-fixtures.js';
import { withCustomerTransaction } from '../src/infra/postgres/transaction.js';
import { AttendanceService } from '../src/modules/attendance/attendance-service.js';
import { PostgresVersionedConfigurationRepository } from '../src/modules/configuration/postgres-versioned-configuration-repository.js';
import { VersionedConfigurationService } from '../src/modules/configuration/versioned-configuration-service.js';

const configuration = (name) => ({
  schemaVersion: 2,
  identity: { name, timezone: 'America/Sao_Paulo', welcomeMessage: 'Bem-vindo.', fallbackMessage: 'Como posso ajudar?',
    schedules: ['Segunda a sexta, das 9h às 18h'], publicRules: ['Atendimento por agendamento'], establishmentRules: 'Regras públicas.' },
  modules: ['catalog', 'events', 'ai_freeform', 'human_handoff', 'external_integrations'],
  menu: { text: 'Escolha uma opção', options: [{ id: 'catalogo', label: 'Catálogo', action: 'catalog.list', params: {} }] },
  routing: { greetings: ['oi'], aliases: [], fallbackAction: 'ai_freeform.reply' },
  publicReplies: [{ action: 'catalog.address', text: 'Endereço inicial.' }, { action: 'events.birthday_rule', text: 'Regra inicial.' }],
  catalog: { items: [{ id: 'synthetic-product', name: 'Produto fictício', price: 12, active: true }] },
  ai: { enabled: true, provider: 'openai', model: 'synthetic-model', credentialRef: 'credential:synthetic-ai',
    keyMode: 'own', maxOutputTokens: 123, monthlyTokenLimit: 12345, monthlyCostLimit: 45,
    prompt: 'Roteiro original.', personality: 'Objetiva.', fallbackMessage: 'Posso encaminhar à equipe.', followUpQuestion: 'Como posso ajudar?',
    leadQualificationEnabled: true, leadQualificationCriteria: 'Nome e relato suficiente.', leadQualificationClosing: 'A equipe continuará o atendimento.' },
  humanHandoff: { channel: 'manual', assigneeRef: 'user:synthetic-assignee', cooldownSeconds: 70,
    pauseOnBusinessAppMessage: true, message: 'Aguarde a equipe.', salesInterestMessage: 'Interesse registrado.' },
  integrations: [{ id: 'synthetic-connector', type: 'google_sheets', name: 'Conector fictício', enabled: false, required: false,
    credentialRefs: ['credential:synthetic-sheet'] }],
});
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('M4 PostgreSQL: DTO, edição transacional, RLS e concorrência do atendimento', { skip: !enabled }, async (t) => {
  const f = await createM1Fixture('attendance');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const service = new AttendanceService({ pool, clock: f.clock });
  const admin = new VersionedConfigurationService(new PostgresVersionedConfigurationRepository(pool), { clock: f.clock });
  let ana, bia, caio, noRead, administrator, aurora, horizonte, vale, unprepared;
  const readRaw = async (id) => (await f.owner.query('SELECT * FROM configuracoes_rascunho WHERE empresa_id=$1', [id])).rows[0];
  const context = (user, company, callback, permission = 'attendance.edit') => withCustomerTransaction(pool, {
    usuarioId: user.id, sessionId: user.auth.sessionId, empresaId: company.id, permission, now: f.clock(),
  }, async (tx) => {
    await tx.client.query("SELECT set_config('app.attendance_session_id',$1,true)", [user.auth.sessionId]);
    return callback(tx.client);
  });
  try {
    ana = await f.makeUser('ana'); bia = await f.makeUser('bia'); caio = await f.makeUser('caio'); noRead = await f.makeUser('no-read');
    administrator = await f.makeUser('administrative-writer', { platform: true, login: false });
    aurora = await f.makeCompany('aurora'); horizonte = await f.makeCompany('horizonte');
    vale = await f.makeCompany('vale'); unprepared = await f.makeCompany('unprepared');
    await f.link(ana, aurora, { permissions: ['attendance.read', 'attendance.edit'] });
    await f.link(ana, horizonte, { permissions: ['attendance.read', 'attendance.edit'] });
    await f.link(ana, unprepared, { permissions: ['attendance.read', 'attendance.edit'] });
    await f.link(bia, aurora, { role: 'administrador', permissions: ['attendance.read', '*', 'credentials.manage'] });
    await f.link(caio, vale, { permissions: ['attendance.read', 'attendance.edit'] });
    await f.link(noRead, aurora, { permissions: ['attendance.edit'] });
    for (const company of [aurora, horizonte, vale]) await admin.saveDraft({ empresaId: company.id,
      actorId: ana.id, expectedDraftVersion: 0, configuration: configuration(company.name) });
    const rawTechnical = (await readRaw(aurora.id)).configuracao;
    rawTechnical.ai.model = 'synthetic-cafe\u0301-model';
    await f.owner.query('UPDATE configuracoes_rascunho SET configuracao=$2::jsonb WHERE empresa_id=$1', [aurora.id, JSON.stringify(rawTechnical)]);

    await t.test('projeção não expõe técnico, referências, permissões internas ou IDs de autor', async () => {
      await assert.rejects(service.read(ana.auth, '00000000-0000-7000-8000-000000000001'), { status: 404 });
      const dto = await service.read(ana.auth, aurora.id);
      assert.equal(dto.draftVersion, 1); assert.equal(dto.activeVersion, null); assert.equal(dto.canEdit, true);
      assert.equal(dto.savedBy, 'M1 ana'); assert.equal(dto.company.id, aurora.id);
      assert.equal(dto.fields.script, 'Roteiro original.'); assert.equal(dto.replies.length, 2);
      const json = JSON.stringify(dto);
      for (const technical of ['synthetic-cafe', 'synthetic-ai', 'synthetic-assignee', 'synthetic-sheet', 'credentialRef', 'monthlyTokenLimit', 'maxOutputTokens', 'integrations', 'provider']) assert.equal(json.includes(technical), false, technical);
      assert.equal(json.includes(ana.id), false);
      assert.equal((await service.read(bia.auth, aurora.id)).canEdit, false);
      assert.equal((await service.read(bia.auth, aurora.id)).savedBy, 'Outro acesso autorizado');
      await assert.rejects(service.read(caio.auth, aurora.id), { status: 404 });
      await assert.rejects(service.read(ana.auth, 'not-a-company'), { status: 404 });
      await assert.rejects(service.read(noRead.auth, aurora.id), { status: 403 });
      await assert.rejects(service.read(ana.auth, unprepared.id), { status: 409, code: 'ATTENDANCE_BASE_REQUIRED' });
      await assert.rejects(service.read({ ...ana.auth, audience: 'admin' }, aurora.id), { status: 403 });
    });
    await t.test('salva somente o patch permitido, preserva técnico/vizinho e não publica nem ativa', async () => {
      const before = await readRaw(aurora.id), neighbor = await readRaw(horizonte.id);
      const result = await service.save(ana.auth, aurora.id, { draftVersion: 1, changes: {
        script: 'Roteiro novo.', greeting: 'Olá, como posso ajudar?', schedules: ['Segunda, das 10h às 16h'],
        qualificationCriteria: 'Nome e situação relatada.', replies: [{ key: 'catalog.address', text: 'Novo endereço público.' }],
      } });
      assert.equal(result.draftVersion, 2); assert.equal(result.savedBy, 'M1 ana');
      const after = await readRaw(aurora.id);
      assert.equal(after.configuracao.ai.prompt, 'Roteiro novo.');
      assert.equal(after.configuracao.publicReplies[0].text, 'Novo endereço público.');
      for (const key of ['provider','model','credentialRef','keyMode','maxOutputTokens','monthlyTokenLimit','monthlyCostLimit','enabled','leadQualificationEnabled']) assert.deepEqual(after.configuracao.ai[key], before.configuracao.ai[key]);
      assert.equal(after.configuracao.ai.model, 'synthetic-cafe\u0301-model');
      for (const key of ['integrations','modules','menu','routing','catalog']) assert.equal(hash(after.configuracao[key]), hash(before.configuracao[key]));
      assert.deepEqual(after.configuracao.humanHandoff, before.configuracao.humanHandoff);
      assert.equal(hash((await readRaw(horizonte.id)).configuracao), hash(neighbor.configuracao));
      const tenantState = (await f.owner.query('SELECT status,configuracao_ativa_versao,versao_configuracao FROM empresas WHERE id=$1', [aurora.id])).rows[0];
      tenantState.versao_configuracao = Number(tenantState.versao_configuracao);
      assert.deepEqual(tenantState,
        { status: 'ativa', configuracao_ativa_versao: null, versao_configuracao: 1 });
      assert.equal((await f.owner.query('SELECT 1 FROM configuracoes_revisoes WHERE empresa_id=$1', [aurora.id])).rowCount, 0);
    });
    await t.test('somente leitura e edição sem leitura não concedem escrita', async () => {
      await assert.rejects(service.save(bia.auth, aurora.id, { draftVersion: 2, changes: { greeting: 'Negado' } }), { status: 403 });
      await assert.rejects(service.save(noRead.auth, aurora.id, { draftVersion: 2, changes: { greeting: 'Negado' } }), { status: 403 });
      assert.equal(Number((await readRaw(aurora.id)).draft_version), 2);
    });
    await t.test('RLS impede alteração técnica, troca de vínculo e metadados de autoria/versão', async () => {
      const raw = await readRaw(aurora.id);
      for (const change of [
        "configuracao=jsonb_set(configuracao,'{ai,model}','\"injected\"'::jsonb)",
        "configuracao=jsonb_set(configuracao,'{ai,credentialRef}','\"credential:injected\"'::jsonb)",
        "configuracao=jsonb_set(configuracao,'{modules}','[]'::jsonb)",
        "configuracao=jsonb_set(configuracao,'{publicReplies,0,action}','\"catalog.menu\"'::jsonb)",
        `created_by='${bia.id}'::uuid`, 'schema_version=1',
      ]) await assert.rejects(context(ana, aurora, (client) => client.query(
        `UPDATE configuracoes_rascunho SET ${change},draft_version=draft_version+1,updated_by=$2 WHERE empresa_id=$1`, [aurora.id, ana.id])), { code: '42501' });
      await assert.rejects(context(ana, aurora, (client) => client.query(
        "UPDATE configuracoes_rascunho SET configuracao=jsonb_set(configuracao,'{identity,welcomeMessage}','\"Permitido\"'::jsonb),updated_by=$2 WHERE empresa_id=$1", [aurora.id, ana.id])), { code: '42501' });
      assert.deepEqual((await readRaw(aurora.id)).configuracao, raw.configuracao);
      await context(ana, aurora, async (client) => {
        assert.equal((await client.query('SELECT 1 FROM configuracoes_rascunho WHERE empresa_id=$1', [vale.id])).rowCount, 0);
        assert.equal((await client.query('DELETE FROM configuracoes_rascunho WHERE empresa_id=$1', [aurora.id])).rowCount, 0);
        assert.equal((await client.query('SELECT * FROM logs_auditoria')).rowCount, 0);
        assert.equal((await client.query('SELECT * FROM configuracoes_revisoes')).rowCount, 0);
        assert.equal((await client.query('SELECT * FROM credenciais_empresa')).rowCount, 0);
      });
    });
    await t.test('campo sem módulo permanece bloqueado também no banco', async () => {
      const original = await readRaw(horizonte.id);
      const disabled = structuredClone(original.configuracao); disabled.modules = ['catalog'];
      await admin.saveDraft({ empresaId: horizonte.id, actorId: ana.id, expectedDraftVersion: Number(original.draft_version), configuration: disabled });
      await assert.rejects(service.save(ana.auth, horizonte.id, { draftVersion: 2, changes: { script: 'Não habilitado' } }), { status: 403 });
      await assert.rejects(context(ana, horizonte, (client) => client.query(
        "UPDATE configuracoes_rascunho SET configuracao=jsonb_set(configuracao,'{ai,prompt}','\"injected\"'::jsonb),draft_version=draft_version+1,updated_by=$2 WHERE empresa_id=$1", [horizonte.id, ana.id])), { code: '42501' });
      assert.equal((await service.read(ana.auth, horizonte.id)).fields.script, undefined);
      const incomplete = (await readRaw(horizonte.id)).configuracao;
      incomplete.modules = ['catalog', 'human_handoff']; delete incomplete.humanHandoff;
      await admin.saveDraft({ empresaId: horizonte.id, actorId: administrator.id, expectedDraftVersion: 2, configuration: incomplete });
      await assert.rejects(service.save(ana.auth, horizonte.id, { draftVersion: 3, changes: { handoffMessage: 'Base ainda ausente' } }),
        { status: 409, code: 'ATTENDANCE_BASE_REQUIRED' });
      assert.equal((await readRaw(horizonte.id)).configuracao.humanHandoff, undefined);
    });
    await t.test('dois clientes e cliente/admin com versão igual têm somente um vencedor', async () => {
      await f.owner.query("UPDATE usuarios_empresas SET permissoes=ARRAY['attendance.read','attendance.edit'] WHERE empresa_id=$1 AND usuario_id=$2", [aurora.id, bia.id]);
      let version = Number((await readRaw(aurora.id)).draft_version);
      let outcomes = await Promise.allSettled([
        service.save(ana.auth, aurora.id, { draftVersion: version, changes: { greeting: 'Cliente Ana' } }),
        service.save(bia.auth, aurora.id, { draftVersion: version, changes: { greeting: 'Cliente Bia' } }),
      ]);
      assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter((x) => x.status === 'rejected' && x.reason.status === 409).length, 1);
      const current = await readRaw(aurora.id); version = Number(current.draft_version);
      const administrative = structuredClone(current.configuracao); administrative.ai.model = 'new-administrative-model';
      outcomes = await Promise.allSettled([
        service.save(ana.auth, aurora.id, { draftVersion: version, changes: { greeting: 'Cliente em concorrência' } }),
        admin.saveDraft({ empresaId: aurora.id, actorId: ana.id, expectedDraftVersion: version, configuration: administrative }),
      ]);
      assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter((x) => x.status === 'rejected' && x.reason.status === 409).length, 1);
      const after = await readRaw(aurora.id);
      assert.ok(['synthetic-cafe\u0301-model','new-administrative-model'].includes(after.configuracao.ai.model));
      const separateActorConfig = structuredClone(after.configuracao); separateActorConfig.ai.maxOutputTokens = 456;
      outcomes = await Promise.allSettled([
        service.save(ana.auth, aurora.id, { draftVersion: Number(after.draft_version), changes: { greeting: 'Cliente e outro administrador' } }),
        admin.saveDraft({ empresaId: aurora.id, actorId: administrator.id, expectedDraftVersion: Number(after.draft_version), configuration: separateActorConfig }),
      ]);
      assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter((x) => x.status === 'rejected' && x.reason.status === 409).length, 1);
    });
    await t.test('falha de auditoria reverte conteúdo e versão sem expor diagnóstico', async () => {
      const before = await readRaw(aurora.id);
      const audits = (await f.owner.query('SELECT count(*)::int n FROM logs_auditoria WHERE empresa_id=$1', [aurora.id])).rows[0].n;
      await assert.rejects(service.save(ana.auth, aurora.id, { draftVersion: Number(before.draft_version), changes: { greeting: 'Deve reverter' } }, 'not-a-valid-uuid'),
        (error) => error.message === 'Attendance operation unavailable.' && !JSON.stringify(error).includes('uuid'));
      const after = await readRaw(aurora.id); assert.deepEqual(after.configuracao, before.configuracao); assert.equal(after.draft_version, before.draft_version);
      assert.equal((await f.owner.query('SELECT count(*)::int n FROM logs_auditoria WHERE empresa_id=$1', [aurora.id])).rows[0].n, audits);
    });
    await t.test('empresa suspensa permite salvar sem reativar e versão antiga retorna conflito', async () => {
      await f.owner.query("UPDATE empresas SET status='suspensa' WHERE id=$1", [aurora.id]);
      const before = await service.read(ana.auth, aurora.id);
      const saved = await service.save(ana.auth, aurora.id, { draftVersion: before.draftVersion, changes: { greeting: 'Rascunho na suspensão' } });
      assert.equal(saved.company.status, 'suspensa'); assert.equal(saved.draftVersion, before.draftVersion + 1);
      await assert.rejects(service.save(ana.auth, aurora.id, { draftVersion: before.draftVersion, changes: { greeting: 'Antigo' } }), { status: 409 });
      assert.equal((await f.owner.query('SELECT status FROM empresas WHERE id=$1', [aurora.id])).rows[0].status, 'suspensa');
    });
    await t.test('revogação de vínculo, suspensão de identidade e logout bloqueiam nova operação', async () => {
      await f.owner.query("UPDATE usuarios_empresas SET status='suspenso' WHERE empresa_id=$1 AND usuario_id=$2", [aurora.id, bia.id]);
      await assert.rejects(service.read(bia.auth, aurora.id), { status: 404 });
      await f.owner.query("UPDATE usuarios SET status='bloqueado' WHERE id=$1", [noRead.id]);
      await assert.rejects(service.read(noRead.auth, aurora.id), { status: 401 });
      await f.service.logout(caio.auth);
      await assert.rejects(service.read(caio.auth, vale.id), { status: 401 });
    });
    await t.test('commit/rollback não deixam identidade, empresa, audience ou sessão no pool', async () => {
      const clients = await Promise.all([pool.connect(),pool.connect(),pool.connect(),pool.connect()]);
      try { for (const client of clients) {
        const values = (await client.query("SELECT current_setting('app.usuario_id',true) identity,current_setting('app.empresa_id',true) tenant,current_setting('app.audience',true) audience,current_setting('app.attendance_session_id',true) session")).rows[0];
        assert.ok(Object.values(values).every((value) => !value));
        assert.equal((await client.query('SELECT 1 FROM configuracoes_rascunho')).rowCount, 0);
      } } finally { clients.forEach((client) => client.release()); }
    });
  } finally {
    await f.owner.query('DELETE FROM logs_auditoria WHERE empresa_id=ANY($1::uuid[])', [f.companies]);
    await pool.end(); await f.close();
  }
});
