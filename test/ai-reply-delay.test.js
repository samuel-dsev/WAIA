import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerHandlers } from "../src/modules/jobs/handlers.js";
import { compileTenantRuntimeConfigV2, materializeLegacyTenantDefinition } from "../src/modules/configuration/index.js";
import { createJobProcessor, MemoryJobRepository, MemoryLockManager } from "../src/modules/jobs/index.js";

function fixture({ delayMs = 10_000, source = "ai", responseDelayEnabled, contextualServiceEnabled } = {}) {
  let now = Date.parse("2026-10-11T12:00:00Z");
  let prepared = null, aiCalls = 0, draws = 0, allowed = true, failSend = false;
  const conversation = { mode: "bot" };
  const sent = [];
  const message = { id: "inbound", conversationId: "conversation", contactId: "contact", numeroWhatsappId: "number", senderPhone: "5511000000001", type: "text", text: "Como funciona o atendimento?", correlationId: "correlation" };
  const reference = { jobId: "job", empresaId: "tenant", conversationId: message.conversationId, messageId: message.id, type: "process_inbound_message", correlationId: message.correlationId, payloadVersion: 1 };
  const definition = materializeLegacyTenantDefinition(compileTenantRuntimeConfigV2({
    schemaVersion: 2, identity: { name: "Teste" }, modules: ["catalog", "human_handoff", "ai_freeform"],
    menu: { text: "Menu", options: [{ id: "equipe", label: "Equipe", action: "human_handoff.request", params: {} }] },
    routing: { greetings: ["oi"], aliases: [], fallbackAction: "ai_freeform.reply" },
    ai: { enabled: true, provider: "simulated", model: "test", prompt: "Atenda a empresa", keyMode: "simulated", ...(responseDelayEnabled === undefined ? {} : { responseDelayEnabled }), ...(contextualServiceEnabled === undefined ? {} : { contextualServiceEnabled }) },
  }, { empresaId: "tenant", configVersion: 1, draftVersion: 1 }));
  const repository = {
    async inboundMessage() { return message; }, async statusEvent() {},
    async preparedReply() { return prepared && structuredClone(prepared); },
    async prepareReply({ reply }) { prepared = { id: "outbound", text: reply.text, buttons: reply.buttons, sendNotBefore: reply.sendNotBefore, status: "processando" }; return structuredClone(prepared); },
    async markReplySent({ externalMessageId }) { prepared.externalMessageId = externalMessageId; prepared.status = "enviada"; },
    async canSendBotReply() { return allowed; },
    async cancelPreparedReply() { if (prepared) prepared.status = "ignorada_duplicidade"; },
  };
  const dependencies = {
    repository,
    conversationService: { async getConversation() { return conversation; }, async getState() { return { data: {}, version: 1 }; }, async saveState() {}, async recordMessage() {}, async applyMetaStatus() {} },
    tenantDefinitionRepository: { async load() { return definition; } },
    aiService: { async reply() { aiCalls++; now += 2_000; return { text: "Resposta sintética", source }; } },
    metaGateway: { async sendReply(_context, reply) { if (failSend) throw new Error("Envio temporariamente indisponível"); sent.push(reply); return { id: "external" }; } },
    clock: () => new Date(now), aiReplyDelayMs: () => { draws++; return delayMs; }, logger: { info() {}, warn() {} },
  };
  return {
    reference, dependencies, conversation, message, sent,
    handler: () => createWorkerHandlers(dependencies).process_inbound_message,
    advance(ms) { now += ms; }, now: () => now,
    block() { allowed = false; }, failSend(value) { failSend = value; },
    state: () => ({ prepared, aiCalls, draws }),
    setDelayEnabled(value) { definition.ai.responseDelayEnabled = value; },
    setContextual(value) { definition.ai.contextualServiceEnabled = value; },
  };
}

function burstFixture({ initialText, ...options } = {}) {
  const f = fixture({ responseDelayEnabled: false, ...options });
  if (initialText) f.message.text = initialText;
  const messages = [{ ...f.message, sequence: 1, at: f.now() }];
  let covered = 0;
  f.dependencies.repository.inboundMessage = async ({ messageId }) => messages.find((item) => item.id === messageId);
  f.dependencies.repository.inboundTurn = async () => {
    const pending = messages.filter((item) => item.sequence > covered);
    if (!pending.length) return null;
    return { messageId: pending.at(-1).id, sequence: pending.at(-1).sequence,
      readyAt: new Date(pending.at(-1).at + 15_000).toISOString(),
      messages: pending.map(({ id, text }) => ({ id, text })) };
  };
  const prepare = f.dependencies.repository.prepareReply;
  f.dependencies.repository.prepareReply = async (input) => {
    const result = await prepare(input);
    f.state().prepared.inboundTurnSequence = input.reply.inboundTurnSequence;
    return { ...result, inboundTurnSequence: input.reply.inboundTurnSequence };
  };
  const sent = f.dependencies.repository.markReplySent;
  f.dependencies.repository.markReplySent = async (input) => { await sent(input); covered = f.state().prepared.inboundTurnSequence; };
  const allowed = f.dependencies.repository.canSendBotReply;
  f.dependencies.repository.canSendBotReply = async () => await allowed()
    && messages.at(-1).sequence <= f.state().prepared.inboundTurnSequence;
  f.add = (text) => {
    const id = `inbound-${messages.length + 1}`;
    messages.push({ ...f.message, id, text, sequence: messages.length + 1, at: f.now() });
    return { ...f.reference, messageId: id, jobId: `job-${id}` };
  };
  return f;
}

test("turno espera 15 segundos desde a última mensagem e gera uma resposta com todas na ordem", async () => {
  const f = burstFixture();
  const calls = [];
  f.dependencies.aiService.reply = async (input) => { calls.push(input); return { text: "Lista solicitada", source: "ai" }; };
  const first = await f.handler()(f.reference);
  assert.equal(Date.parse(first.deferUntil), f.now() + 15_000);
  assert.equal(calls.length, 0);
  f.advance(10_000);
  f.add("Entendi"); const last = f.add("Pode sim");
  assert.equal(Date.parse((await f.handler()(f.reference)).deferUntil), f.now() + 15_000);
  f.advance(14_999);
  assert.ok((await f.handler()(f.reference)).deferUntil);
  assert.equal(f.sent.length, 0);
  f.advance(1);
  assert.equal((await f.handler()(f.reference)).replied, true);
  assert.deepEqual(calls[0].turnMessages.map((part) => part.text), [f.message.text, "Entendi", "Pode sim"]);
  assert.equal(calls[0].messageId, last.messageId);
  assert.equal(f.sent.length, 1);
  // Every following job shares the already answered watermark.
  assert.equal((await f.handler()(last)).resumed, true);
  assert.equal(f.sent.length, 1);
});

test("modo contextual também agrupa saudação com a pergunta e ignora notificações sem texto", async () => {
  const f = burstFixture({ contextualServiceEnabled: true, initialText: "oi" });
  const calls = [];
  f.dependencies.aiService.reply = async (input) => { calls.push(input); return { text: "Ficamos em Taubaté.", source: "ai" }; };
  f.add("Qual cidade fica a loja?");
  assert.ok((await f.handler()(f.reference)).deferUntil);
  assert.equal(calls.length, 0); f.advance(15_000);
  assert.equal((await f.handler()(f.reference)).replied, true);
  assert.deepEqual(calls[0].turnMessages.map((part) => part.text), ["oi", "Qual cidade fica a loja?"]);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].text, "Ficamos em Taubaté.");
  const notification = fixture({ contextualServiceEnabled: true });
  notification.message.type = "system"; notification.message.text = "";
  assert.deepEqual(await notification.handler()(notification.reference), { skipped: true, reason: "no_customer_content" });
  assert.equal(notification.state().aiCalls, 0); assert.equal(notification.state().prepared, null); assert.equal(notification.sent.length, 0);
});

test("mensagem recebida durante inferência descarta o resultado e reprocessa o turno inteiro", async () => {
  const f = burstFixture(), calls = [];
  f.advance(15_000);
  f.dependencies.aiService.reply = async (input) => {
    calls.push(input);
    if (calls.length === 1) f.add("Tem fotos dos dois modelos?");
    return { text: "Resposta atualizada", source: "ai" };
  };
  assert.ok((await f.handler()(f.reference)).deferUntil);
  assert.equal(f.state().prepared, null);
  assert.equal(f.sent.length, 0);
  f.advance(15_000);
  assert.equal((await f.handler()(f.reference)).replied, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].turnMessages.map((part) => part.text), [f.message.text, "Tem fotos dos dois modelos?"]);
  assert.equal(f.sent.length, 1);
});

test("agrupamento libera o lock e o slot sem consumir tentativas, inclusive com espera legada desabilitada", async () => {
  const f = burstFixture();
  const jobs = new MemoryJobRepository({ now: f.now }); jobs.seed(f.reference);
  const locks = new MemoryLockManager({ now: f.now });
  const processor = createJobProcessor({ repository: jobs, lockManager: locks,
    handlers: { process_inbound_message: f.handler() }, logger: { warn() {} } });
  assert.equal((await processor.process(f.reference, { maxAttempts: 1 })).outcome, "deferred");
  assert.equal(locks.locks.size, 0);
  assert.equal(f.state().aiCalls, 0);
  f.advance(15_000);
  assert.equal((await processor.process(f.reference, { maxAttempts: 1 })).outcome, "completed");
  assert.equal(jobs.failed.size, 0);
});

test("IA termina, salva a resposta e aguarda 10 ou 15 segundos sem enviar antes", async () => {
  for (const delayMs of [10_000, 15_000]) {
    const f = fixture({ delayMs });
    const start = f.now();
    const first = await f.handler()(f.reference);
    assert.equal(Date.parse(first.deferUntil), start + 2_000 + delayMs);
    assert.equal(f.sent.length, 0);
    f.advance(delayMs - 1);
    assert.equal((await f.handler()(f.reference)).deferUntil, first.deferUntil);
    assert.equal(f.state().aiCalls, 1);
    f.advance(1);
    assert.deepEqual(await f.handler()(f.reference), { replied: true });
    assert.equal(f.sent.length, 1);
    assert.equal(f.state().draws, 1);
    assert.deepEqual(await f.handler()(f.reference), { replied: true, resumed: true });
    assert.equal(f.sent.length, 1);
  }
});

test("empresa com espera desabilitada persiste e envia imediatamente sem alterar outras empresas", async () => {
  const immediate = fixture({ responseDelayEnabled: false });
  assert.deepEqual(await immediate.handler()(immediate.reference), { replied: true });
  assert.equal(immediate.sent.length, 1);
  assert.equal(immediate.state().draws, 0);
  assert.equal(Date.parse(immediate.state().prepared.sendNotBefore), immediate.now());
  assert.equal((await immediate.handler()(immediate.reference)).resumed, true);
  assert.equal(immediate.state().aiCalls, 1);
  const delayed = fixture();
  assert.ok((await delayed.handler()(delayed.reference)).deferUntil);
  assert.equal(delayed.sent.length, 0);
});

test("sem espera, pausa ou bloqueio durante a geração ainda impede o envio", async () => {
  for (const blocked of [false, true]) {
    const f = fixture({ responseDelayEnabled: false });
    const generate = f.dependencies.aiService.reply;
    f.dependencies.aiService.reply = async () => { const result = await generate(); if (blocked) f.block(); else f.conversation.mode = "human"; return result; };
    assert.equal((await f.handler()(f.reference)).skipped, true);
    assert.equal(f.sent.length, 0);
    assert.equal(f.state().prepared.status, "ignorada_duplicidade");
  }
});

test("trocar configuração não altera o prazo de uma resposta já persistida", async () => {
  const f = fixture();
  const first = await f.handler()(f.reference);
  f.setDelayEnabled(false);
  assert.equal((await f.handler()(f.reference)).deferUntil, first.deferUntil);
  assert.equal(f.state().aiCalls, 1);
  assert.equal(f.state().draws, 1);
});

test("reinício e retry de envio reutilizam o prazo e a resposta sem chamar IA novamente", async () => {
  const f = fixture();
  await f.handler()(f.reference);
  f.advance(10_000);
  f.failSend(true);
  await assert.rejects(f.handler()(f.reference), /Envio temporariamente/u);
  f.failSend(false);
  assert.equal((await f.handler()(f.reference)).replied, true);
  assert.equal(f.state().aiCalls, 1);
  assert.equal(f.state().draws, 1);
});

test("pausa, atendimento humano e bloqueio cancelam resposta pendente", async () => {
  for (const mode of ["paused", "human", "blocked"]) {
    const f = fixture();
    await f.handler()(f.reference);
    f.advance(10_000);
    if (mode === "blocked") f.block(); else f.conversation.mode = mode;
    assert.equal((await f.handler()(f.reference)).skipped, true);
    assert.equal(f.sent.length, 0);
    assert.equal(f.state().prepared.status, "ignorada_duplicidade");
    f.conversation.mode = "bot";
    assert.equal((await f.handler()(f.reference)).skipped, true);
    assert.equal(f.sent.length, 0);
  }
});

test("resposta determinística e contingência não recebem espera de IA", async () => {
  for (const source of ["fallback", "guardrail"]) {
    const f = fixture({ source });
    assert.equal((await f.handler()(f.reference)).replied, true);
    assert.equal(f.state().draws, 0);
  }
  const f = fixture(); f.message.text = "oi";
  assert.equal((await f.handler()(f.reference)).replied, true);
  assert.equal(f.state().aiCalls, 0);
  assert.equal(f.state().draws, 0);
});

test("worker libera lock e slot durante a espera, preservando ordem sem consumir falhas", async () => {
  const f = fixture();
  const repository = new MemoryJobRepository({ now: f.now }); repository.seed(f.reference);
  const next = { ...f.reference, jobId: "next", messageId: "next-message" }; repository.seed(next);
  const locks = new MemoryLockManager({ now: f.now });
  let active = 0, calls = 0;
  const processor = createJobProcessor({ repository, lockManager: locks, tenantLimiter: { async acquire() { active++; return async () => { active--; }; } },
    handlers: { process_inbound_message: async (reference, record, context) => { calls++; return f.handler()(reference, record, context); } }, logger: { warn() {} },
  });
  const first = await processor.process(f.reference);
  assert.equal(first.outcome, "deferred");
  assert.equal(active, 0); assert.equal(locks.locks.size, 0);
  for (let i = 0; i < 8; i++) assert.equal((await processor.process(next, { attempt: 1, maxAttempts: 1 })).outcome, "deferred");
  assert.equal(calls, 1); assert.equal(repository.failed.size, 0);
  f.advance(10_000);
  assert.equal((await processor.process(f.reference)).outcome, "completed");
  assert.equal(f.sent.length, 1);
});

test("contato excluído durante a espera encerra o job sem enviar", async () => {
  const f = fixture(); const repository = new MemoryJobRepository({ now: f.now }); repository.seed(f.reference);
  const processor = createJobProcessor({ repository, handlers: { process_inbound_message: f.handler() }, logger: { warn() {} } });
  assert.equal((await processor.process(f.reference)).outcome, "deferred");
  await repository.complete(f.reference); f.advance(10_000);
  assert.equal((await processor.process(f.reference)).outcome, "duplicate");
  assert.equal(f.sent.length, 0);
});

test("lease perdido antes do envio bloqueia resposta e prazo inválido falha fechado", async () => {
  const f = fixture(); await f.handler()(f.reference); f.advance(10_000);
  await assert.rejects(f.handler()(f.reference, null, { canContinue: () => false }), (error) => error.code === "PROCESSING_LEASE_LOST");
  assert.equal(f.sent.length, 0);
  f.state().prepared.sendNotBefore = "data inválida";
  await assert.rejects(f.handler()(f.reference), (error) => error.code === "BOT_REPLY_SCHEDULE_INVALID");
});
