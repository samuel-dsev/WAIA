import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTenantRuntimeConfigV2, materializeLegacyTenantDefinition } from '../src/modules/configuration/index.js';
import { parseTenantRuntimeConfig } from '../src/modules/runtime/tenant-runtime-config.js';
import { createConfiguredTenantRuntime } from '../src/tenants/configured-runtime.js';
import { MultiTenantAiService } from '../src/modules/ai/ai-service.js';

const configuration = (name = 'Aurora', schedules = ['Segunda a sexta, 9h às 18h']) => ({
  schemaVersion: 2,
  identity: { name, timezone: 'America/Sao_Paulo', schedules, publicRules: [`Regra pública ${name}`],
    establishmentRules: `Orientação ${name}`, welcomeMessage: `Bem-vindo ${name}` },
  modules: ['catalog', 'ai_freeform'],
  menu: { text: `Menu ${name}`, options: [{ id: 'catalogo', label: 'Catálogo', action: 'catalog.list', params: {} }] },
  routing: { greetings: ['oi'], aliases: [{ terms: ['endereço'], action: 'catalog.address', params: {} }], fallbackAction: 'ai_freeform.reply' },
  publicReplies: [{ action: 'catalog.address', text: `Endereço ${name}` }],
  ai: { enabled: true, provider: 'simulated', model: 'synthetic-model', keyMode: 'simulated',
    prompt: `Roteiro ${name}`, personality: `Estilo ${name}`, followUpQuestion: 'Pergunta não deve ser anexada ao roteiro completo?' },
});
const compile = (configuration, empresaId = 'tenant-aurora') => compileTenantRuntimeConfigV2(configuration, { empresaId, configVersion: 2, draftVersion: 3 });
const stateRepository = () => {
  const states = new Map();
  return { load: async ({ empresaId, conversationId }) => states.get(`${empresaId}:${conversationId}`),
    save: async ({ empresaId, conversationId }, value) => states.set(`${empresaId}:${conversationId}`, value) };
};

test('M6 published public hours, timezone and rules reach immutable runtime identity', () => {
  const compiled = compile(configuration());
  const definition = materializeLegacyTenantDefinition(compiled);
  const runtime = parseTenantRuntimeConfig(definition.runtime);
  assert.equal(runtime.identity.timezone, 'America/Sao_Paulo');
  assert.deepEqual(runtime.identity.schedules, ['Segunda a sexta, 9h às 18h']);
  assert.deepEqual(runtime.identity.publicRules, ['Regra pública Aurora']);
  assert.equal(runtime.identity.establishmentRules, 'Orientação Aurora');
  assert.equal(Object.isFrozen(runtime.identity.schedules), true);
  definition.runtime.identity.schedules[0] = 'Outro horário';
  assert.equal(runtime.identity.schedules[0], 'Segunda a sexta, 9h às 18h');
  assert.equal(compiled.configuration.identity.schedules[0], 'Segunda a sexta, 9h às 18h');
});

test('M6 runtime public metadata remains optional for existing V1 callers and rejects malformed additions', () => {
  const definition = materializeLegacyTenantDefinition(compile(configuration()));
  delete definition.runtime.identity.timezone; delete definition.runtime.identity.schedules; delete definition.runtime.identity.publicRules;
  const old = parseTenantRuntimeConfig(definition.runtime);
  for (const key of ['timezone', 'schedules', 'publicRules']) assert.equal(Object.hasOwn(old.identity, key), false);
  for (const additions of [{ timezone: 'Invalid/Timezone' }, { schedules: 'Friday' }, { schedules: [{}] },
    { schedules: ['a'.repeat(301)] }, { schedules: Array(51).fill('Monday') }, { publicRules: [''] },
    { publicRules: Array(101).fill('Rule') }, { publicRules: ['a'.repeat(1001)] }]) {
    assert.throws(() => parseTenantRuntimeConfig({ ...definition.runtime, identity: { ...definition.runtime.identity, ...additions } }), TypeError);
  }
});

test('M6 two tenant runtimes send their public hours/rules to the real AI service boundary without technical leakage', async () => {
  const configurations = new Map([
    ['tenant-aurora', compile(configuration('Aurora', ['Segunda, 9h às 18h']), 'tenant-aurora')],
    ['tenant-vale', compile(configuration('Vale', ['Sábado, 8h às 12h']), 'tenant-vale')],
  ]);
  const calls = [], ledgerCalls = [];
  const ai = new MultiTenantAiService({
    configResolver: { getAiConfig: async ({ empresaId }) => {
      const config = configurations.get(empresaId).configuration.ai;
      return { ...config, empresaId, keyType: config.keyMode, allowedContextKeys: ['identity'], version: 2 };
    } },
    conversationService: { getHistory: async () => [] },
    clientFactory: { create: async ({ empresaId }) => ({ responses: { create: async (request) => {
      calls.push({ empresaId, request });
      return { output_text: `Resposta ${empresaId}`, usage: { input_tokens: 10, output_tokens: 5 } };
    } } }) },
    secretResolver: { resolve: async () => ({ keyType: 'simulated' }) },
    ledger: { reserve: async (input) => { ledgerCalls.push(input); return { allowed: true, reservationId: 'synthetic-reservation' }; },
      finalize: async () => ({ usage: {} }) },
    pricingCatalog: { get: async () => ({ inputPerMillion: 0, outputPerMillion: 0, version: 'synthetic-v1' }) },
    logger: { warn() {}, info() {}, error() {} },
  });
  for (const [empresaId, compiled] of configurations) {
    const definition = materializeLegacyTenantDefinition(compiled);
    // The runtime parser must discard unrecognized technical identity values.
    definition.runtime.identity.credentialRef = 'credential:must-not-reach-ai';
    definition.runtime.identity.provider = 'provider-must-not-reach-ai';
    const runtime = createConfiguredTenantRuntime({ definition, stateRepository: stateRepository(),
      aiHandler: async ({ config, input }) => ({ reply: await ai.reply({ empresaId: config.empresaId,
        conversationId: input.conversationId, correlationId: `m6-${empresaId}`, message: input.text,
        context: { identity: config.identity, credentials: { value: 'hidden-credential' }, unknownModule: { value: 'hidden-module' } } }) }),
    });
    const input = { conversationId: 'synthetic-conversation', text: 'Qual é o horário e as regras?' };
    const reply = await runtime.handle(input);
    assert.equal(reply.text, `Resposta ${empresaId}`);
    assert.equal((await runtime.handle({ ...input, text: 'oi' })).text, `Menu ${compiled.configuration.identity.name}`);
    assert.equal((await runtime.handle({ ...input, text: 'endereço' })).text, `Endereço ${compiled.configuration.identity.name}`);
    assert.equal(calls.filter((entry) => entry.empresaId === empresaId).length, 1);
  }
  assert.equal(ledgerCalls.length, 2);
  for (const { empresaId, request } of calls) {
    const own = configurations.get(empresaId).configuration;
    assert.equal(request.store, false);
    assert.match(request.instructions, /REGRAS IMUTÁVEIS DA PLATAFORMA/u);
    assert.equal(request.instructions.includes(own.ai.prompt), true);
    assert.equal(request.instructions.includes(own.ai.personality), true);
    const context = request.input[0].content;
    assert.equal(context.includes(own.identity.schedules[0]), true);
    assert.equal(context.includes(own.identity.publicRules[0]), true);
    assert.equal(context.includes(own.identity.timezone), true);
    assert.equal(context.includes(own.identity.establishmentRules), true);
    for (const hidden of ['must-not-reach-ai', 'hidden-credential', 'hidden-module', 'synthetic-model', 'monthlyTokenLimit']) {
      assert.equal(context.includes(hidden), false, hidden);
    }
    const neighbor = empresaId === 'tenant-aurora' ? 'Vale' : 'Aurora';
    assert.equal(context.includes(neighbor), false);
  }
});

test('M6 public operating text never schedules or enables a disabled runtime module', async () => {
  const config = configuration('Desabilitada', ['Atendimento fechado neste momento']);
  config.modules = ['catalog']; config.ai.enabled = false; delete config.routing.fallbackAction;
  let calls = 0;
  const runtime = createConfiguredTenantRuntime({ definition: materializeLegacyTenantDefinition(compile(config)),
    stateRepository: stateRepository(), aiHandler: async () => { calls++; return { reply: { text: 'Não deve executar' } }; } });
  const result = await runtime.handle({ conversationId: 'conversation', action: 'ai_freeform.reply', text: 'olá' });
  assert.equal(result.code, 'MODULE_DISABLED'); assert.equal(calls, 0);
  assert.equal((await runtime.handle({ conversationId: 'conversation', text: 'endereço' })).text, 'Endereço Desabilitada');
  assert.deepEqual(runtime.config.identity.schedules, ['Atendimento fechado neste momento']);
});
