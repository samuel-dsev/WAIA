import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { compileTenantRuntimeConfigV2 } from '../src/modules/configuration/compiler.js';
import { publicationReview, parsePublication, parseSimulation } from '../src/modules/attendance/publication-contract.js';

const empresaId = '11111111-1111-4111-8111-111111111111';
const configuration = () => ({
  schemaVersion: 2,
  identity: { name: 'Aurora fictícia', welcomeMessage: 'Olá', timezone: 'America/Sao_Paulo' },
  modules: ['catalog', 'ai_freeform', 'human_handoff'],
  menu: { text: 'Menu', options: [{ id: 'catalogo', label: 'Catálogo', action: 'catalog.list', params: {} }] },
  routing: { greetings: ['oi'], aliases: [], fallbackAction: 'ai_freeform.reply' },
  ai: { enabled: true, provider: 'simulated', model: 'synthetic-model', prompt: 'Roteiro anterior', keyMode: 'simulated',
    maxOutputTokens: 123, monthlyTokenLimit: 1234, monthlyCostLimit: 12 },
  humanHandoff: { channel: 'manual', message: 'Aguarde a equipe', cooldownSeconds: 123 },
  publicReplies: [{ action: 'catalog.address', text: 'Endereço anterior' }],
});
function subject(config = configuration()) {
  const activeRevision = compileTenantRuntimeConfigV2(config, { empresaId, configVersion: 2, draftVersion: 1 });
  return { configuration: config, activeRevision, empresaId, draftVersion: 3, activeVersion: 2 };
}
const invalid = { code: 'ATTENDANCE_VALIDATION_ERROR', status: 422 };

test('M5 review permits only business content and displays a sanitized diff', () => {
  const input = subject();
  input.configuration = structuredClone(input.configuration);
  input.configuration.ai.prompt = 'Roteiro novo'; input.configuration.identity.welcomeMessage = 'Bem-vindo';
  input.configuration.publicReplies[0].text = 'Endereço novo';
  const review = publicationReview(input);
  assert.equal(review.ready, true); assert.equal(review.reason, null);
  assert.deepEqual(review.changes.map(({ key }) => key), ['greeting', 'script', 'replies.catalog.address']);
  assert.deepEqual(review.changes.find(({ key }) => key === 'script'), {
    key: 'script', label: 'Roteiro completo da IA', before: 'Roteiro anterior', after: 'Roteiro novo',
  });
  assert.match(review.reviewToken, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(review).includes('synthetic-model'), false);
  assert.equal(JSON.stringify(review).includes('monthlyTokenLimit'), false);
});

test('M5 review rejects hidden model, quotas, modules, destination and reply binding changes', () => {
  for (const change of [
    (c) => { c.ai.model = 'hidden-model'; }, (c) => { c.ai.maxOutputTokens = 999; },
    (c) => { c.ai.monthlyTokenLimit = 999; }, (c) => { c.ai.monthlyCostLimit = 999; },
    (c) => { c.ai.enabled = false; }, (c) => { c.modules = ['catalog']; },
    (c) => { c.humanHandoff.channel = 'different-channel'; },
    (c) => { c.publicReplies[0].action = 'catalog.menu'; },
    (c) => { c.routing.greetings = ['outro']; },
  ]) {
    const input = subject(); input.configuration = structuredClone(input.configuration); change(input.configuration);
    const result = publicationReview(input);
    assert.equal(result.ready, false); assert.deepEqual(result.changes, []); assert.equal(result.reviewToken, null);
    assert.equal(JSON.stringify(result).includes('hidden-model'), false);
  }
});

test('M5 review requires an intact approved tenant revision with matching version and checksum', () => {
  const input = subject();
  for (const replacement of [null, {}, { ...input.activeRevision, checksum: 'a'.repeat(64) },
    { ...input.activeRevision, empresaId: randomUUID() },
    { configuracao_compilada: input.activeRevision, config_version: 2, checksum: 'b'.repeat(64) }]) {
    assert.equal(publicationReview({ ...input, activeRevision: replacement }).ready, false);
  }
  assert.equal(publicationReview({ ...input, activeVersion: 1 }).ready, false);
  assert.equal(publicationReview({ ...input, activeVersion: null }).ready, false);
  assert.equal(publicationReview({ ...input, activeRevision: {
    configuracao_compilada: input.activeRevision, config_version: '2', checksum: input.activeRevision.checksum,
  } }).ready, true);
});

test('M5 review token binds the draft, active revision and company deterministically', () => {
  const input = subject(), first = publicationReview(input);
  assert.equal(publicationReview(input).reviewToken, first.reviewToken);
  assert.notEqual(publicationReview({ ...input, draftVersion: 4 }).reviewToken, first.reviewToken);
  const changed = structuredClone(input.configuration); changed.ai.prompt = 'Conteúdo diferente';
  assert.notEqual(publicationReview({ ...input, configuration: changed }).reviewToken, first.reviewToken);
  const next = compileTenantRuntimeConfigV2(input.configuration, { empresaId, configVersion: 3, draftVersion: 2 });
  assert.notEqual(publicationReview({ ...input, activeRevision: next, activeVersion: 3 }).reviewToken, first.reviewToken);
  const neighborId = randomUUID(), neighbor = compileTenantRuntimeConfigV2(input.configuration, { empresaId: neighborId, configVersion: 2, draftVersion: 1 });
  assert.notEqual(publicationReview({ ...input, empresaId: neighborId, activeRevision: neighbor }).reviewToken, first.reviewToken);
});

test('M5 review uses canonical compiler defaults and rejects malformed or disabled business content', () => {
  assert.equal(publicationReview(subject()).ready, true);
  const input = subject(); input.configuration = { schemaVersion: 2, identity: {} };
  assert.equal(publicationReview(input).ready, false);
  const disabled = configuration(); disabled.modules = ['catalog']; disabled.ai.enabled = false; delete disabled.routing.fallbackAction;
  const frozen = subject(disabled); frozen.configuration = structuredClone(disabled); frozen.configuration.ai.prompt = 'Hidden edit';
  assert.equal(publicationReview(frozen).ready, false);
});

test('M5 publication input requires explicit confirmation, UUID idempotency, version and token', () => {
  const body = { draftVersion: 2, reviewToken: 'a'.repeat(64), idempotencyKey: randomUUID(), confirmed: true };
  assert.deepEqual(parsePublication(body), body);
  for (const changed of [{ confirmed: false }, { confirmed: undefined }, { draftVersion: 0 }, { draftVersion: '2' },
    { reviewToken: 'short' }, { reviewToken: 'A'.repeat(64) }, { idempotencyKey: 'not-a-uuid' }, { activate: true },
    { configuration: {} }, { actorId: randomUUID() }]) assert.throws(() => parsePublication({ ...body, ...changed }), invalid);
});

test('M5 simulation input accepts only bounded text and version, with safe JSON', () => {
  assert.deepEqual(parseSimulation({ draftVersion: 1, message: 'Olá' }), { draftVersion: 1, message: 'Olá' });
  assert.equal(parseSimulation({ draftVersion: 1, message: 'a'.repeat(2000) }).message.length, 2000);
  for (const body of [{ draftVersion: 1, message: 'a'.repeat(2001) }, { draftVersion: 1, message: ' ' },
    { draftVersion: 1, message: '\u0000' }, { draftVersion: 0, message: 'oi' },
    { draftVersion: 1, message: { text: 'oi' } }, { draftVersion: 1, message: 'oi', model: 'injected' },
    JSON.parse('{"draftVersion":1,"message":"oi","__proto__":{}}')]) {
    assert.throws(() => parseSimulation(body), invalid);
  }
  assert.throws(() => parseSimulation(Object.defineProperty({ draftVersion: 1 }, 'message', { enumerable: true, get() { throw new Error('must not execute'); } })), invalid);
});
