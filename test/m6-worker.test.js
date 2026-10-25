import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerHandlers } from '../src/modules/jobs/handlers.js';
import { compileTenantRuntimeConfigV2, materializeLegacyTenantDefinition } from '../src/modules/configuration/index.js';
import { ConversationHandoffRepository } from '../src/modules/business/repositories.js';

function fixture({ ai = false, handoff = false, source = 'ai', mutate = () => {} } = {}) {
  const state = { companyActive: true, contactAllowed: true, conversation: { mode: 'bot', version: 1, operatorId: null } };
  const sent = []; let prepared = null, generationCalls = 0, guardCalls = 0, failSend = false;
  const message = { id: 'incoming', conversationId: 'conversation', contactId: 'contact', numeroWhatsappId: 'number',
    senderPhone: '5511000000001', type: 'text', text: handoff ? 'equipe' : ai ? 'Uma dúvida' : 'oi' };
  const definition = materializeLegacyTenantDefinition(compileTenantRuntimeConfigV2({
    schemaVersion: 2, identity: { name: 'Empresa sintética', welcomeMessage: 'Olá' },
    modules: ['catalog', 'ai_freeform', 'human_handoff'],
    menu: { text: 'Menu sintético', options: [{ id: 'equipe', label: 'Equipe', action: 'human_handoff.request', params: {} }] },
    routing: { greetings: ['oi'], aliases: [], fallbackAction: 'ai_freeform.reply' },
    humanHandoff: { message: 'A equipe continuará o atendimento.', cooldownSeconds: 0 },
    ai: { enabled: true, provider: 'simulated', model: 'test', keyMode: 'simulated', prompt: 'Atenda a empresa.', responseDelayEnabled: false },
  }, { empresaId: 'tenant', configVersion: 1, draftVersion: 1 }));
  const conversationService = {
    async getConversation() { return structuredClone(state.conversation); },
    async getState() { return { data: {}, version: 1 }; }, async saveState() {},
    async recordMessage() {}, async applyMetaStatus() {},
    async pauseBot(input) {
      if (input.expectedVersion !== state.conversation.version || state.conversation.mode !== 'bot') throw Error('CAS_CONFLICT');
      state.conversation = { ...state.conversation, mode: 'paused', operatorId: null, version: state.conversation.version + 1 };
      return structuredClone(state.conversation);
    },
  };
  const repository = {
    async inboundMessage() { return message; }, async statusEvent() {},
    async preparedReply() { return prepared && structuredClone(prepared); },
    async prepareReply({ reply }) {
      prepared = { id: 'outgoing', ...structuredClone(reply), status: 'processando' };
      mutate(state); return structuredClone(prepared);
    },
    async canSendBotReply({ handoffPauseVersion }) {
      guardCalls++;
      return state.companyActive && state.contactAllowed && (state.conversation.mode === 'bot'
        || (state.conversation.mode === 'paused' && state.conversation.operatorId == null
          && prepared?.handoffPauseVersion === handoffPauseVersion && state.conversation.version === handoffPauseVersion));
    },
    async cancelPreparedReply() { if (prepared) prepared.status = 'ignorada_duplicidade'; },
    async markReplySent({ externalMessageId }) { prepared.externalMessageId = externalMessageId; prepared.status = 'enviada'; },
  };
  const dependencies = { repository, conversationService, tenantDefinitionRepository: { async load() { return definition; } },
    aiService: { async reply() { generationCalls++; return { text: 'Resposta sintética', source }; } },
    handoffRepository: new ConversationHandoffRepository(conversationService),
    metaGateway: { async sendReply(_context, reply) { if (failSend) throw Error('Provider unavailable'); sent.push(reply); return { id: 'provider-accepted' }; } },
    logger: { info() {}, warn() {} },
  };
  return { state, sent, dependencies, repository,
    failSend(value) { failSend = value; },
    prepared: () => prepared, calls: () => ({ generationCalls, guardCalls }),
    run: () => createWorkerHandlers(dependencies).process_inbound_message({ empresaId: 'tenant', messageId: message.id }),
  };
}

test('M6: suspensão, opt-out e pausa durante geração bloqueiam todo tipo de resposta', async () => {
  for (const flavor of [{}, { ai: true }, { ai: true, source: 'fallback' }, { ai: true, source: 'guardrail' }]) {
    for (const mutate of [(s) => { s.companyActive = false; }, (s) => { s.contactAllowed = false; },
      (s) => { s.conversation.mode = 'paused'; }, (s) => { s.conversation.mode = 'human'; }]) {
      const f = fixture({ ...flavor, mutate });
      assert.deepEqual(await f.run(), { skipped: true, reason: 'bot_reply_cancelled' });
      assert.equal(f.sent.length, 0); assert.equal(f.prepared().status, 'ignorada_duplicidade');
    }
  }
});

test('M6: guarda ausente, erro ou resultado indefinido falham fechado sem enviar', async () => {
  const absent = fixture(); delete absent.repository.canSendBotReply;
  await assert.rejects(absent.run(), { code: 'BOT_REPLY_SEND_GUARD_REQUIRED', retryable: false });
  assert.equal(absent.sent.length, 0);
  const unavailable = fixture(); unavailable.repository.canSendBotReply = async () => { throw Error('DB unavailable'); };
  await assert.rejects(unavailable.run(), /DB unavailable/); assert.equal(unavailable.sent.length, 0);
  const unknown = fixture(); unknown.repository.canSendBotReply = async () => undefined;
  assert.equal((await unknown.run()).skipped, true); assert.equal(unknown.sent.length, 0);
});

test('M6: confirmação da própria pausa CAS tem checkpoint e retry sem gerar outra resposta', async () => {
  const f = fixture({ handoff: true }); f.failSend(true);
  await assert.rejects(f.run(), /Provider unavailable/);
  assert.equal(f.state.conversation.mode, 'paused'); assert.equal(f.prepared().handoffPauseVersion, 2);
  f.failSend(false); assert.deepEqual(await f.run(), { replied: true }); assert.equal(f.sent.length, 1);
  assert.equal(f.prepared().externalMessageId, 'provider-accepted');
  assert.deepEqual(await f.run(), { replied: true, resumed: true }); assert.equal(f.sent.length, 1);
});

test('M6: nova pausa, humano, opt-out ou suspensão invalidam a confirmação própria', async () => {
  for (const mutate of [(s) => { s.conversation.version++; },
    (s) => { s.conversation.mode = 'human'; s.conversation.version++; },
    (s) => { s.conversation.mode = 'bot'; s.conversation.version++; },
    (s) => { s.contactAllowed = false; }, (s) => { s.companyActive = false; }]) {
    const f = fixture({ handoff: true, mutate });
    assert.equal((await f.run()).skipped, true); assert.equal(f.sent.length, 0);
  }
});

test('M6: CAS de pausa não sobrescreve atendimento humano concorrente', async () => {
  const f = fixture({ handoff: true });
  const request = f.dependencies.handoffRepository.request.bind(f.dependencies.handoffRepository);
  f.dependencies.handoffRepository.request = async (input) => {
    f.state.conversation.mode = 'human'; f.state.conversation.operatorId = 'operator'; f.state.conversation.version++;
    return request(input);
  };
  await assert.rejects(f.run(), /CAS_CONFLICT/);
  assert.equal(f.state.conversation.mode, 'human'); assert.equal(f.state.conversation.operatorId, 'operator');
  assert.equal(f.sent.length, 0);
});

test('M6: saída da IA não cria autorização de confirmação em conversa pausada', async () => {
  const f = fixture({ ai: true, mutate: (s) => { s.conversation.mode = 'paused'; } });
  f.dependencies.aiService.reply = async () => ({ text: 'Resposta', source: 'ai', handoffPauseVersion: 1 });
  assert.equal((await f.run()).skipped, true); assert.equal(f.prepared().handoffPauseVersion, undefined); assert.equal(f.sent.length, 0);
});
