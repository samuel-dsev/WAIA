import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerHandlers } from "../src/modules/jobs/handlers.js";

function fixture() {
  let now = Date.parse("2026-10-13T12:00:00Z"), prepared, aiCalls = 0, failing = "B", allowed = true;
  const conversation = { mode: "bot" }, sent = [], calls = [];
  const parts = ["A", "B", "C"].map((text) => ({ text, buttons: [], imageUrl: `https://example.com/${text}.jpg` }));
  const message = { id: "in", conversationId: "conv", contactId: "contact", numeroWhatsappId: "number", senderPhone: "5511000000001", type: "text", text: "Quais modelos?", correlationId: "correlation" };
  const reference = { empresaId: "tenant", messageId: message.id, conversationId: message.conversationId };
  const repository = {
    async inboundMessage() { return message; }, async statusEvent() {},
    async preparedReply() { return prepared && structuredClone(prepared); },
    async prepareReply({ reply }) {
      prepared = { id: "0", status: "processando", text: reply.text, sendNotBefore: reply.sendNotBefore,
        messages: reply.messages.map((part, index) => ({ ...part, id: String(index), status: "processando" })) };
      return structuredClone(prepared);
    },
    async markReplySent({ replyId, externalMessageId }) { const part = prepared.messages.find((p) => p.id === replyId); part.externalMessageId = externalMessageId; part.status = "enviada"; if (replyId === "0") prepared.externalMessageId = externalMessageId; },
    async canSendBotReply() { return allowed; },
    async cancelPreparedReply() { for (const part of prepared.messages) if (!part.externalMessageId) part.status = "ignorada_duplicidade"; },
  };
  const dependencies = { repository,
    conversationService: { async getConversation() { return conversation; }, async getState() { return { data: {} }; }, async saveState() {}, async recordMessage() {}, async applyMetaStatus() {} },
    tenantDefinitionRepository: { async load() { return { runtime: { empresaId: "tenant", identity: { name: "Teste" }, enabledModules: ["ai_freeform"], menu: { text: "Menu", options: [] } }, ai: { enabled: true, prompt: "Atenda", provider: "simulated" }, routing: { fallbackAction: "ai_freeform.reply" } }; } },
    aiService: { async reply() { aiCalls++; return { text: "Fichas", source: "ai", messages: parts }; } },
    metaGateway: { async sendReply(scope, part) { assert.equal(scope.empresaId, "tenant"); assert.equal(scope.numeroWhatsappId, "number"); calls.push(part.text); if (part.text === failing) throw new Error("Provider temporariamente indisponível"); sent.push(part); return { messages: [{ id: `wamid-${part.text}` }] }; } },
    clock: () => new Date(now), aiReplyDelayMs: () => 30_000, logger: { info() {}, warn() {} },
  };
  return { reference, dependencies, repository, conversation, sent, calls, handler: () => createWorkerHandlers(dependencies).process_inbound_message,
    advance() { now += 30_000; }, fail(value) { failing = value; }, block() { allowed = false; }, state: () => ({ prepared, aiCalls }) };
}

test("três imagens seguem em ordem; retry retoma só o bloco não confirmado e não chama IA novamente", async () => {
  const f = fixture();
  assert.ok((await f.handler()(f.reference)).deferUntil); assert.equal(f.sent.length, 0);
  f.advance(); await assert.rejects(f.handler()(f.reference), /Provider temporariamente/u);
  assert.deepEqual(f.sent.map((p) => p.text), ["A"]);
  f.fail(null); assert.equal((await f.handler()(f.reference)).replied, true);
  assert.deepEqual(f.sent.map((p) => p.text), ["A", "B", "C"]);
  assert.deepEqual(f.calls, ["A", "B", "B", "C"]);
  assert.equal(f.sent[1].imageUrl, "https://example.com/B.jpg");
  assert.equal(f.state().aiCalls, 1);
  assert.equal((await f.handler()(f.reference)).resumed, true);
  assert.equal(f.sent.length, 3);
});

test("três imagens sem espera mantêm checkpoint, ordem e retomada após falha parcial", async () => {
  const f = fixture();
  const load = f.dependencies.tenantDefinitionRepository.load;
  f.dependencies.tenantDefinitionRepository.load = async () => { const definition = await load(); definition.ai.responseDelayEnabled = false; return definition; };
  await assert.rejects(f.handler()(f.reference), /Provider temporariamente/u);
  assert.ok(f.state().prepared.sendNotBefore);
  assert.deepEqual(f.sent.map((part) => part.text), ["A"]);
  f.fail(null);
  assert.equal((await f.handler()(f.reference)).replied, true);
  assert.deepEqual(f.sent.map((part) => part.text), ["A", "B", "C"]);
  assert.equal(f.state().aiCalls, 1);
});

test("assunção humana ou bloqueio após primeiro produto cancela os demais", async () => {
  for (const mode of ["human", "blocked"]) {
    const f = fixture(); f.fail(null);
    const send = f.dependencies.metaGateway.sendReply;
    f.dependencies.metaGateway.sendReply = async (...args) => { const result = await send(...args); if (mode === "human") f.conversation.mode = "human"; else f.block(); return result; };
    await f.handler()(f.reference); f.advance();
    assert.equal((await f.handler()(f.reference)).skipped, true);
    assert.deepEqual(f.sent.map((p) => p.text), ["A"]);
    assert.equal(f.state().prepared.messages[1].status, "ignorada_duplicidade");
  }
});

test("lease perdido entre produtos preserva os não enviados e permite retomada", async () => {
  const f = fixture(); f.fail(null); await f.handler()(f.reference); f.advance();
  await assert.rejects(f.handler()(f.reference, null, { canContinue: () => f.sent.length === 0 }), { code: "PROCESSING_LEASE_LOST" });
  assert.equal(f.sent.length, 1);
  await f.handler()(f.reference);
  assert.deepEqual(f.sent.map((p) => p.text), ["A", "B", "C"]);
});

test("lote não pode ser enviado sem checkpoint individual persistido", async () => {
  const f = fixture();
  f.repository.prepareReply = async ({ reply }) => ({ id: "bad", text: reply.text, sendNotBefore: reply.sendNotBefore });
  await assert.rejects(f.handler()(f.reference), { code: "BOT_REPLY_CHECKPOINT_REQUIRED" });
  assert.equal(f.sent.length, 0);
});

test("aceitação sem ID falha sem retry automático nem envio dos demais produtos", async () => {
  const f = fixture(); f.dependencies.metaGateway.sendReply = async (_scope, part) => { f.sent.push(part); return {}; };
  await f.handler()(f.reference); f.advance();
  await assert.rejects(f.handler()(f.reference), (error) => error.code === "BOT_REPLY_SEND_ID_MISSING" && error.retryable === false);
  assert.equal(f.sent.length, 1);
});
