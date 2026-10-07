import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerHandlers } from "../src/modules/jobs/handlers.js";
import { ConversationHandoffRepository } from "../src/modules/business/repositories.js";
import { parseTenantRuntimeConfigV2, compileTenantRuntimeConfigV2, materializeLegacyTenantDefinition, verifyCompiledTenantRuntimeConfigV2 } from "../src/modules/configuration/index.js";

function configuration(seconds = 60) {
  return {
    schemaVersion: 2, identity: { name: "Empresa de teste" },
    modules: ["catalog", "human_handoff", "ai_freeform"],
    menu: { text: "Olá", options: [{ id: "equipe", label: "Equipe", action: "human_handoff.request", params: {} }] },
    routing: { greetings: [], fallbackAction: "ai_freeform.reply", aliases: [{ terms: ["falar com equipe"], action: "human_handoff.request", params: {} }] },
    humanHandoff: { message: "Aguarde a equipe", cooldownSeconds: seconds },
    ai: { enabled: true, provider: "simulated", model: "test", prompt: "Atendimento", keyMode: "simulated" },
  };
}

function fixture(seconds = 60) {
  let now = Date.parse("2026-10-07T12:00:00Z");
  let state = { flowKey: "idle", stage: "idle", data: {}, version: 1 };
  const conversation = { mode: "bot" };
  const sent = [], prepared = [], aiCalls = [];
  let message;
  const service = {
    async getConversation() { return conversation; },
    async getState() { return structuredClone(state); },
    async saveState(input) { state = { ...input, version: state.version + 1, updatedAt: new Date(now) }; return state; },
    async pauseBot() { conversation.mode = "paused"; },
    async recordMessage() {}, async applyMetaStatus() {},
  };
  const definition = materializeLegacyTenantDefinition(compileTenantRuntimeConfigV2(configuration(seconds), { empresaId: "tenant-test", configVersion: 1, draftVersion: 1 }));
  const handlers = createWorkerHandlers({
    repository: {
      async inboundMessage() { return message; }, async statusEvent() {},
      async prepareReply(input) { prepared.push(input); return { id: `out-${prepared.length}`, text: input.reply.text, buttons: input.reply.buttons }; },
      async markReplySent() {},
    },
    conversationService: service,
    tenantDefinitionRepository: { async load() { return definition; } },
    handoffRepository: new ConversationHandoffRepository(service),
    metaGateway: { async sendReply(context, reply) { sent.push(reply); return { id: `external-${sent.length}` }; } },
    aiService: { async reply(input) { aiCalls.push(input); return { text: "Atendimento retomado", buttons: [] }; } },
    clock: () => new Date(now), logger: { info() {}, warn() {} },
  });
  return {
    conversation, sent, prepared, aiCalls,
    advance(ms) { now += ms; },
    legacyState() { state = { flowKey: "human_handoff", stage: "waiting_operator", data: {}, version: 1, updatedAt: new Date(now - 120000) }; },
    async send(text) {
      message = { id: `in-${now}-${text}`, conversationId: "conversation-test", contactId: "contact-test", numeroWhatsappId: "number-test", senderPhone: "5511999999999", type: "text", text, correlationId: "correlation-test" };
      return handlers.process_inbound_message({ empresaId: "tenant-test", messageId: message.id });
    },
  };
}

test("cooldown persiste, não envia durante a espera e processa a nova mensagem no limite de 60 segundos", async () => {
  const f = fixture();
  await f.send("falar com equipe");
  assert.equal(f.sent.length, 1);
  assert.equal(f.conversation.mode, "bot");
  f.advance(59999);
  assert.deepEqual(await f.send("oi"), { skipped: true, reason: "handoff_cooldown" });
  assert.equal(f.sent.length, 1);
  assert.equal(f.prepared.length, 1);
  assert.equal(f.aiCalls.length, 0);
  f.advance(1);
  await f.send("preciso de ajuda com meu imóvel");
  assert.equal(f.sent.at(-1).text, "Atendimento retomado");
  assert.equal(f.aiCalls.at(-1).message, "preciso de ajuda com meu imóvel");
  await f.send("falar com equipe");
  f.advance(1000);
  assert.equal((await f.send("oi")).reason, "handoff_cooldown");
});

test("não retoma conversa assumida ou pausada manualmente mesmo após o prazo", async () => {
  for (const mode of ["human", "paused"]) {
    const f = fixture();
    await f.send("falar com equipe");
    f.conversation.mode = mode;
    f.advance(120000);
    assert.equal((await f.send("oi")).reason, "conversation_not_in_bot_mode");
    assert.equal(f.sent.length, 1);
    assert.equal(f.aiCalls.length, 0);
  }
});

test("zero preserva pausa indefinida dos clientes existentes", async () => {
  const f = fixture(0);
  await f.send("falar com equipe");
  assert.equal(f.conversation.mode, "paused");
  f.advance(86400000);
  assert.equal((await f.send("oi")).reason, "conversation_not_in_bot_mode");
});

test("estado antigo em modo bot retoma usando o instante persistido da espera", async () => {
  const f = fixture();
  f.legacyState();
  await f.send("oi");
  assert.equal(f.sent.at(-1).text, "Atendimento retomado");
});

test("configuração limita prazo a sete dias e preserva o valor na compilação", () => {
  for (const value of [-1, 0.5, 604801, "60"]) assert.throws(() => parseTenantRuntimeConfigV2(configuration(value)));
  assert.equal(parseTenantRuntimeConfigV2(configuration()).humanHandoff.cooldownSeconds, 60);
  const legacy = compileTenantRuntimeConfigV2({ ...configuration(), humanHandoff: {} }, { empresaId: "tenant-test", configVersion: 1 });
  assert.equal(Object.hasOwn(legacy.configuration.humanHandoff, "cooldownSeconds"), false);
  assert.equal(verifyCompiledTenantRuntimeConfigV2(legacy), true);
});
