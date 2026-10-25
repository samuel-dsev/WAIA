import test from 'node:test';
import assert from 'node:assert/strict';
import { ATTENDANCE_FEATURES, projectAttendanceResources } from '../src/modules/attendance/feature-catalog.js';
import { mergeAttendance, projectAttendance } from '../src/modules/attendance/contract.js';

const configuration = () => ({
  schemaVersion: 2, identity: { name: 'Empresa fictícia', timezone: 'America/Sao_Paulo', schedules: ['Segunda, 9h às 17h'] },
  modules: ['catalog', 'ai_freeform', 'human_handoff'],
  ai: { enabled: true, provider: 'simulated', keyMode: 'simulated', model: 'modelo-privado', prompt: 'Roteiro fictício',
    monthlyTokenLimit: 123, leadQualificationEnabled: true, leadQualificationCriteria: 'Nome e assunto.' },
  humanHandoff: { message: 'Aguarde a equipe.', assigneeRef: 'user:destino-privado', pauseOnBusinessAppMessage: true },
  publicReplies: [{ action: 'catalog.address', text: 'Endereço público' }], integrations: [],
});
const snapshot = () => ({ environment: 'test', customerRuntimeReady: true, whatsapp: { accessTokenConfigured: true, applicationValid: true,
  primaryNumber: { primary: true, phoneNumberId: 'numero-privado', wabaId: 'conta-privada', numeroE164: '+551100000001', status: 'ativo' } },
  leadNotifications: { destinationConfigured: true }, integrations: [] });
const view = (draft, extra = {}) => projectAttendanceResources(draft, {
  companyStatus: 'ativa', capabilities: ['attendance.read', 'attendance.edit'], activeConfiguration: draft, snapshot: snapshot(), ...extra,
});

test('M6 catálogo fechado contém somente recursos de negócio, com limites e instruções funcionais', () => {
  assert.ok(Object.isFrozen(ATTENDANCE_FEATURES)); assert.ok(ATTENDANCE_FEATURES.every(Object.isFrozen));
  const draft = configuration(), output = view(draft), allowed = projectAttendance(draft).editableFields;
  assert.deepEqual(output.features.map(({ id }) => id), ['messages', 'information', 'script', 'replies', 'handoff', 'qualification', 'sales']);
  assert.deepEqual(output.features.flatMap(({ fields }) => fields).sort(), allowed.sort());
  assert.equal(output.fieldLimits.script.maxCharacters, 20000); assert.equal(output.fieldLimits.schedules.maxItems, 50);
  assert.match(output.guidance.schedules, /não criam agenda/u); assert.match(output.guidance.followUp, /próprio roteiro/u);
  const json = JSON.stringify(output);
  for (const forbidden of ['modelo-privado', 'destino-privado', 'numero-privado', 'conta-privada', 'monthlyTokenLimit', 'credentialRef', 'provider', 'modules', 'google_sheets']) assert.equal(json.includes(forbidden), false, forbidden);
  output.features[0].fields.length = 0;
  assert.equal(view(draft).features[0].fields.length, 2);
});

test('M6 módulos desabilitados/futuros não concedem campos, comportamento ou capacidades', () => {
  const draft = configuration(); draft.modules = ['catalog', 'future_internal_module'];
  const output = view(draft);
  for (const id of ['script', 'qualification', 'handoff', 'sales']) {
    const feature = output.features.find((item) => item.id === id);
    assert.equal(feature.enabled, false); assert.equal(feature.canEdit, false); assert.equal(feature.state, 'disabled'); assert.deepEqual(feature.fields, []);
  }
  assert.equal(output.fieldLimits.script, undefined); assert.equal(output.guidance.tone, undefined);
  assert.equal(JSON.stringify(output).includes('future_internal_module'), false);
  assert.throws(() => mergeAttendance(draft, { script: 'Tentativa de habilitar' }), { status: 403 });
});

test('M6 consulta, rascunho, suspensão e dependências têm estados distintos sem impedir draft autorizado', () => {
  const draft = configuration();
  assert.ok(view(draft, { capabilities: ['attendance.read'] }).features.every(({ canEdit }) => canEdit === false));
  assert.equal(view(draft).features.find(({ id }) => id === 'qualification').state, 'ready');
  assert.equal(view(draft, { snapshot: {} }).features.find(({ id }) => id === 'script').state, 'needs_admin');
  assert.ok(view(draft, { snapshot: { ...snapshot(), customerRuntimeReady: false } }).features.filter(({ state }) => state !== 'draft').every(({ state }) => state === 'needs_admin'));
  const pending = snapshot(); pending.leadNotifications.destinationConfigured = false;
  assert.equal(view(draft, { snapshot: pending }).features.find(({ id }) => id === 'qualification').state, 'needs_admin');
  assert.ok(view(draft, { companyStatus: 'suspensa' }).features.filter(({ enabled }) => enabled).every(({ state, canEdit }) => state === 'suspended' && canEdit));
  for (const extra of [{ activeConfiguration: null }, { companyStatus: 'rascunho' }]) {
    assert.ok(view(draft, extra).features.filter(({ enabled }) => enabled).every(({ state }) => state === 'draft'));
  }
});

test('M6 comportamentos são somente consulta e distinguem rascunho da revisão em uso', () => {
  const draft = configuration(), active = structuredClone(draft); active.ai.responseDelayEnabled = false;
  active.humanHandoff.pauseOnBusinessAppMessage = false;
  const output = view(draft, { activeConfiguration: active });
  const delay = output.behaviors.find(({ id }) => id === 'responseDelay');
  assert.equal(delay.draftEnabled, true); assert.equal(delay.activeEnabled, false);
  assert.ok(output.behaviors.every(({ adminManaged }) => adminManaged === true));
  assert.equal(output.features.find(({ id }) => id === 'sales').state, 'draft');
  draft.ai.leadQualificationEnabled = false; draft.ai.catalogSalesEnabled = true;
  const enabled = snapshot(); enabled.customerCatalogReady = true;
  enabled.integrations = [{ type: 'google_sheets', status: 'healthy', reference: 'integration:nao-expor' }];
  assert.equal(view(draft, { snapshot: enabled }).features.find(({ id }) => id === 'sales').state, 'ready');
  enabled.customerCatalogReady = false; enabled.integrations[0].status = 'unavailable';
  assert.equal(view(draft, { snapshot: enabled }).features.find(({ id }) => id === 'sales').state, 'needs_admin');
  assert.equal(JSON.stringify(view(draft, { snapshot: enabled })).includes('nao-expor'), false);
  draft.modules = draft.modules.filter((key) => key !== 'catalog');
  assert.equal(view(draft).behaviors.find(({ id }) => id === 'commercial').draftEnabled, false);
});

test('M6 dependência que impede carregar o runtime nunca aparece como recurso pronto', () => {
  const draft = configuration(); draft.modules.push('payments'); draft.payments = { credentialRef: 'credential:payment-private' };
  assert.equal(view(draft).features.find(({ id }) => id === 'messages').state, 'needs_admin');
  const valid = snapshot(); valid.credentials = [{ reference: 'credential:payment-private', provider: 'payment', configured: true, status: 'active' }];
  assert.equal(view(draft, { snapshot: valid }).features.find(({ id }) => id === 'messages').state, 'ready');
  assert.equal(JSON.stringify(view(draft, { snapshot: valid })).includes('payment-private'), false);
});
