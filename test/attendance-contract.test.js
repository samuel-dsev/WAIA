import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FIELD_DEFINITIONS, parseAttendancePatch, projectAttendance, mergeAttendance } from '../src/modules/attendance/contract.js';

const configuration = () => ({
  schemaVersion: 2,
  identity: { name: 'Aurora Demo', timezone: 'America/Sao_Paulo', welcomeMessage: 'Olá', schedules: ['Segunda a sexta, 9h–18h'] },
  modules: ['catalog', 'events', 'ai_freeform', 'human_handoff'],
  ai: { enabled: true, provider: 'provider-synthetic', model: 'synthetic-model', maxOutputTokens: 555, monthlyTokenLimit: 12345,
    monthlyCostLimit: 67, keyMode: 'own', credentialRef: 'credential:synthetic-key', prompt: 'Roteiro anterior',
    responseDelayEnabled: true, catalogSalesEnabled: false, leadQualificationEnabled: true, leadQualificationCriteria: 'Nome e relato' },
  humanHandoff: { message: 'Aguarde a equipe', channel: 'Canal administrativo', assigneeRef: 'user:internal', cooldownSeconds: 100, pauseOnBusinessAppMessage: true },
  publicReplies: [{ action: 'catalog.address', text: 'Rua Demo' }, { action: 'events.birthday_rule', text: 'Consulte a equipe' },
    { action: 'human_handoff.request', text: 'Resposta operacional restrita' }],
  routing: { aliases: [{ terms: ['endereço'], action: 'catalog.address', params: {} }], fallbackAction: 'ai_freeform.reply' },
  integrations: [{ id: 'synthetic-integration', type: 'synthetic', name: 'Admin only', enabled: false, credentialRefs: ['credential:connector'] }],
});
const patch = (changes, draftVersion = 7) => ({ draftVersion, changes });
const invalid = { code: 'ATTENDANCE_VALIDATION_ERROR', status: 422 };
const denied = { code: 'ATTENDANCE_FIELD_UNAVAILABLE', status: 403 };
const checksum = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('M4 contrato congela caminhos exatos e não usa prefixos administrativos', () => {
  assert.deepEqual(FIELD_DEFINITIONS.map(({ key, path }) => [key, path.join('.')]), [
    ['greeting', 'identity.welcomeMessage'], ['fallbackMessage', 'identity.fallbackMessage'], ['timezone', 'identity.timezone'],
    ['schedules', 'identity.schedules'], ['publicRules', 'identity.publicRules'], ['establishmentRules', 'identity.establishmentRules'],
    ['script', 'ai.prompt'], ['tone', 'ai.personality'], ['aiFallback', 'ai.fallbackMessage'], ['followUp', 'ai.followUpQuestion'],
    ['qualificationCriteria', 'ai.leadQualificationCriteria'], ['qualificationClosing', 'ai.leadQualificationClosing'],
    ['handoffMessage', 'humanHandoff.message'], ['salesInterestMessage', 'humanHandoff.salesInterestMessage'],
  ]);
  assert.equal(Object.isFrozen(FIELD_DEFINITIONS), true);
  assert.equal(FIELD_DEFINITIONS.every((definition) => Object.isFrozen(definition) && Object.isFrozen(definition.path)), true);
});

test('M4 projeção contém apenas conteúdo liberado e respostas informativas existentes', () => {
  const base = configuration();
  const view = projectAttendance(base);
  assert.deepEqual(Object.keys(view), ['fields', 'editableFields', 'replies']);
  assert.equal(view.fields.script, 'Roteiro anterior');
  assert.deepEqual(view.replies.map(({ key }) => key), ['catalog.address', 'events.birthday_rule']);
  for (const forbidden of ['synthetic-model', 'provider-synthetic', 'synthetic-key', 'connector', 'maxOutputTokens',
    'monthlyTokenLimit', 'monthlyCostLimit', 'internal', 'cooldownSeconds', 'human_handoff.request', 'Resposta operacional restrita']) {
    assert.equal(JSON.stringify(view).includes(forbidden), false, forbidden);
  }
  view.fields.schedules.push('Não pode alterar a origem');
  assert.equal(base.identity.schedules.length, 1);
});

test('M4 habilitação administrativa governa leitura e escrita por campo', () => {
  const base = configuration(); base.modules = [];
  const view = projectAttendance(base);
  assert.deepEqual(view.editableFields, FIELD_DEFINITIONS.filter(({ path }) => path[0] === 'identity').map(({ key }) => key));
  assert.deepEqual(view.replies, []);
  for (const changes of [{ script: 'Novo' }, { qualificationCriteria: 'Novo' }, { handoffMessage: 'Novo' },
    { replies: [{ key: 'catalog.address', text: 'Novo' }] }]) assert.throws(() => mergeAttendance(base, changes), denied);
  base.modules = ['ai_freeform']; base.ai.enabled = false;
  assert.equal(Object.hasOwn(projectAttendance(base).fields, 'script'), false);
  assert.throws(() => mergeAttendance(base, { script: 'Novo' }), denied);
  base.ai.enabled = true; base.ai.leadQualificationEnabled = false;
  assert.equal(Object.hasOwn(projectAttendance(base).fields, 'qualificationCriteria'), false);
  assert.throws(() => mergeAttendance(base, { qualificationCriteria: 'Novo' }), denied);
  assert.equal(mergeAttendance(base, { script: 'Novo' }).ai.prompt, 'Novo');
});

test('M4 merge altera somente caminhos pedidos e preserva técnico por hash e origem imutável', () => {
  const base = configuration(); const original = structuredClone(base);
  // Non-NFC technical string proves the parser's normalized output is not persisted.
  base.ai.model = 'Modelo e\u0301'; original.ai.model = base.ai.model;
  const changes = { script: 'Novo roteiro', greeting: 'Bem-vindo', schedules: ['Sábados 9h–12h'],
    qualificationClosing: 'Encaminhado à equipe', replies: [{ key: 'catalog.address', text: 'Novo endereço' }] };
  const merged = mergeAttendance(base, parseAttendancePatch(patch(changes)).changes);
  assert.deepEqual(base, original);
  assert.equal(merged.ai.prompt, 'Novo roteiro'); assert.equal(merged.identity.welcomeMessage, 'Bem-vindo');
  assert.equal(merged.publicReplies[0].text, 'Novo endereço');
  const expected = structuredClone(original);
  expected.ai.prompt = changes.script; expected.identity.welcomeMessage = changes.greeting; expected.identity.schedules = changes.schedules;
  expected.ai.leadQualificationClosing = changes.qualificationClosing; expected.publicReplies[0].text = 'Novo endereço';
  assert.equal(checksum(merged), checksum(expected));
  assert.deepEqual(merged.integrations, base.integrations); assert.deepEqual(merged.humanHandoff, base.humanHandoff);
  assert.deepEqual(merged.routing, base.routing);
});

test('M4 valores respeitam tipos, limites, fuso e versões inteiras', () => {
  for (const definition of FIELD_DEFINITIONS) {
    assert.throws(() => parseAttendancePatch(patch({ [definition.key]: null })), invalid);
    if (definition.kind === 'lines') {
      assert.throws(() => parseAttendancePatch(patch({ [definition.key]: Array(definition.maxItems + 1).fill('Linha') })), invalid);
      assert.throws(() => parseAttendancePatch(patch({ [definition.key]: ['x'.repeat(definition.maxLength + 1)] })), invalid);
      assert.throws(() => parseAttendancePatch(patch({ [definition.key]: ['   '] })), invalid);
      assert.deepEqual(parseAttendancePatch(patch({ [definition.key]: [] })).changes[definition.key], []);
    } else {
      assert.throws(() => parseAttendancePatch(patch({ [definition.key]: 'x'.repeat(definition.maxLength + 1) })), invalid);
      assert.throws(() => parseAttendancePatch(patch({ [definition.key]: {} })), invalid);
      if (definition.kind !== 'timezone' && !['script', 'qualificationCriteria'].includes(definition.key)) {
        assert.equal(parseAttendancePatch(patch({ [definition.key]: '' })).changes[definition.key], '');
      }
    }
  }
  assert.equal(parseAttendancePatch(patch({ timezone: 'America/Sao_Paulo' })).changes.timezone, 'America/Sao_Paulo');
  for (const value of ['Not/A_Zone', '', {}, null, 5]) assert.throws(() => parseAttendancePatch(patch({ timezone: value })), invalid);
  for (const version of [0, -1, 1.5, '7', null, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parseAttendancePatch(patch({ greeting: 'Olá' }, version)), invalid);
});

test('M4 qualificação habilitada exige critérios de negócio não vazios', () => {
  const base = configuration();
  for (const value of ['', '   ', '\n\t']) {
    assert.throws(() => parseAttendancePatch(patch({ qualificationCriteria: value })), invalid);
    assert.throws(() => mergeAttendance(base, { qualificationCriteria: value }), invalid);
  }
  assert.equal(mergeAttendance(base, { qualificationCriteria: 'Nome e breve relato' }).ai.leadQualificationCriteria,
    'Nome e breve relato');
});

test('M4 roteiro de IA habilitada não pode ser apagado nem criado em recurso desabilitado', () => {
  const base = configuration();
  for (const value of ['', '   ', '\n\t']) {
    assert.throws(() => parseAttendancePatch(patch({ script: value })), invalid);
    assert.throws(() => mergeAttendance(base, { script: value }), invalid);
  }
  base.ai.enabled = false;
  assert.equal(Object.hasOwn(projectAttendance(base).fields, 'script'), false);
  assert.throws(() => mergeAttendance(base, { script: 'Novo roteiro' }), denied);
});

test('M4 rejeita mass assignment aninhado, caminho técnico e payload desconhecido', () => {
  for (const changes of [{}, { replies: [] }, { ai: { model: 'owned' } }, { 'ai.prompt': 'Novo' }, { '/ai/prompt': 'Novo' },
    { model: 'owned' }, { modules: ['ai_freeform'] }, { credentialRef: 'credential:owned' }, { script: { value: 'Texto' } },
    { schedules: [{ text: 'Linha', destination: 'outro' }] }, { publish: true }, { draftVersion: 7 }]) {
    assert.throws(() => parseAttendancePatch(patch(changes)), invalid);
    assert.throws(() => mergeAttendance(configuration(), changes), invalid);
  }
  for (const extra of [{ actorId: 'other' }, { companyId: 'other' }, { configuration: configuration() }, { expectedDraftVersion: 7 }]) {
    assert.throws(() => parseAttendancePatch({ ...patch({ greeting: 'Olá' }), ...extra }), invalid);
  }
});

test('M4 rejeita objetos especiais, protótipo, accessors, símbolos e ciclos sem executar getter', () => {
  let executed = false;
  const accessor = { draftVersion: 7, changes: {} };
  Object.defineProperty(accessor.changes, 'greeting', { enumerable: true, get() { executed = true; return 'Olá'; } });
  const inherited = Object.assign(Object.create({ model: 'owned' }), { greeting: 'Olá' });
  const cyclic = { greeting: 'Olá' }; cyclic.loop = cyclic;
  const symbol = { greeting: 'Olá', [Symbol('hidden')]: 'owned' };
  for (const body of [accessor, patch(inherited), patch(cyclic), patch(symbol), patch(new Map()),
    JSON.parse('{"draftVersion":7,"changes":{"__proto__":{"model":"owned"}}}'),
    JSON.parse('{"draftVersion":7,"changes":{"constructor":{"prototype":{"model":"owned"}}}}')]) {
    assert.throws(() => parseAttendancePatch(body), invalid);
  }
  assert.equal(executed, false);
  assert.equal(Object.prototype.model, undefined);
});

test('M4 segredo em texto é recusado sem refletir material ou configuração técnica', () => {
  for (const secret of ['sk-' + 'a'.repeat(20), 'Bearer ' + 'a'.repeat(24), '-----BEGIN PRIVATE KEY-----']) {
    assert.throws(() => mergeAttendance(configuration(), { script: secret }), (error) => {
      assert.equal(error.status, 422); assert.equal(error.message.includes(secret), false);
      assert.doesNotMatch(error.message, /model|credential|provider|stack|ai\.prompt/); return true;
    });
  }
});

test('M4 predefinições só atualizam textos de vínculos permitidos existentes', () => {
  const base = configuration();
  for (const replies of [[{ key: 'catalog.menu', text: 'Adicionar é proibido' }],
    [{ key: 'catalog.address', text: 'Primeiro' }, { key: 'catalog.address', text: 'Segundo' }],
    [{ key: 'catalog.address', text: '' }], [{ key: 'catalog.address', text: 'x'.repeat(2001) }],
    [{ key: 'catalog.address', text: 'Novo', action: 'payments.instructions' }],
    [{ key: 'human_handoff.request', text: 'Sem pausa' }], [{ key: 'external_integrations.run', text: 'Executar' }]]) {
    assert.throws(() => mergeAttendance(base, { replies }), (error) => [403, 422].includes(error.status));
  }
  const merged = mergeAttendance(base, { replies: [{ key: 'catalog.address', text: 'Novo endereço' }] });
  assert.deepEqual(merged.publicReplies.map(({ action }) => action), base.publicReplies.map(({ action }) => action));
  assert.equal(merged.publicReplies[1].text, base.publicReplies[1].text);
  const view = projectAttendance(base); assert.equal(view.replies.length, 2);
  base.modules = ['catalog']; assert.deepEqual(projectAttendance(base).replies.map(({ key }) => key), ['catalog.address']);
});

test('M4 permite preparar rascunho administrativo incompleto sem adicionar defaults técnicos', () => {
  const base = { schemaVersion: 2, identity: { name: 'Aurora' }, modules: [], ai: { enabled: false }, integrations: [] };
  const result = mergeAttendance(base, { greeting: 'Olá', schedules: ['Dias úteis, 9h–18h'] });
  assert.deepEqual(result.ai, { enabled: false }); assert.deepEqual(result.modules, []);
  assert.equal(Object.hasOwn(result, 'retention'), false); assert.equal(Object.hasOwn(result, 'menu'), false);
});

test('M4 erros conhecidos explicam rótulos e limites sem refletir chave ou valor injetado', () => {
  for (const [changes, label, guidance] of [
    [{ script: '' }, 'Roteiro completo da IA', 'não vazio'],
    [{ qualificationCriteria: '  ' }, 'Critérios de qualificação', '2000'],
    [{ timezone: 'invalid-provider-secret-zone' }, 'Fuso horário', 'IANA'],
    [{ schedules: ['x'.repeat(301)] }, 'Horários de atendimento', '50 linhas'],
    [{ publicRules: [''] }, 'Regras públicas', '1000 caracteres'],
    [{ greeting: 12 }, 'Saudação', '1000 caracteres'],
    [{ replies: [{ key: 'catalog.address', text: '' }] }, 'Respostas predefinidas', '2000 caracteres'],
  ]) {
    for (const operation of [() => parseAttendancePatch(patch(changes)), () => mergeAttendance(configuration(), changes)]) {
      assert.throws(operation, (error) => {
        assert.equal(error.status, 422); assert.equal(error.message.includes(label), true);
        assert.equal(error.message.includes(guidance), true);
        assert.doesNotMatch(error.message, /invalid-provider-secret-zone|ai\.prompt|\/changes\/|stack/);
        return true;
      });
    }
  }
  for (const changes of [{ injectedCredentialSecretName: 'body-secret-value' },
    { replies: [{ key: 'catalog.address', text: 'Novo', injectedCredentialSecretName: 'body-secret-value' }] }]) {
    for (const operation of [() => parseAttendancePatch(patch(changes)), () => mergeAttendance(configuration(), changes)]) {
      assert.throws(operation, (error) => {
        assert.equal(error.status, 422);
        assert.doesNotMatch(error.message, /injectedCredentialSecretName|body-secret-value|catalog\.address/);
        assert.equal(error.message, 'Confira os campos de atendimento e seus limites antes de salvar.');
        return true;
      });
    }
  }
});
