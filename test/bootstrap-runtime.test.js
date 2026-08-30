import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createApiApp, probeWorkerHeartbeats } from "../src/bootstrap/app-runtime.js";
import { createWorkerHandlers } from "../src/modules/jobs/handlers.js";

const tenantDefinition = Object.freeze({
  runtime: {
    empresaId: "tenant-a",
    identity: { name: "Empresa A", welcomeMessage: "Boas-vindas" },
    enabledModules: ["catalog"],
    menu: {
      text: "Menu da Empresa A",
      options: [{ id: "produtos", label: "Produtos", module: "catalog", action: "catalog.list" }],
    },
    catalog: { items: [{ id: "item-1", name: "Item A", price: 10 }] },
    events: { items: [] },
    appointments: { services: [] },
  },
  routing: { greetings: ["oi"], aliases: [], fallbackAction: null },
});

function fakeRuntime() {
  return {
    pool: { connect() {} },
    logger: { info() {}, warn() {}, error() {} },
    health: {
      live: () => ({ status: "ok" }),
      ready: async () => ({ status: "ready" }),
    },
    authService: {
      async authenticate() {
        const error = new Error("auth required");
        error.status = 401;
        throw error;
      },
      verifyCsrf() { return false; },
    },
    adminService: {
      session() { return {}; },
    },
  };
}

async function request(app, path) {
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    return await fetch(`http://127.0.0.1:${port}${path}`);
  } finally {
    server.close();
  }
}

test("API bootstrap expoe health e verificacao do webhook sem servicos externos", async () => {
  const app = createApiApp({
    runtime: fakeRuntime(),
    config: {
      environment: "test",
      whatsapp: { verifyToken: "verify-token", appSecret: "" },
      security: { cookieSecure: false, sessionTtlHours: 12 },
    },
  });

  const health = await request(app, "/health/live");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const webhook = await request(app, "/webhook?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=abc123");
  assert.equal(webhook.status, 200);
  assert.equal(await webhook.text(), "abc123");
});

test("diagnóstico do worker percorre todo o SCAN antes de declarar heartbeat", async () => {
  const withoutHeartbeat = {
    calls: 0,
    async scan() {
      this.calls += 1;
      return this.calls === 1 ? ["42", []] : ["0", []];
    },
  };
  assert.deepEqual(await probeWorkerHeartbeats(withoutHeartbeat), { state: "unavailable" });
  assert.equal(withoutHeartbeat.calls, 2);

  const withHeartbeat = {
    calls: 0,
    async scan() {
      this.calls += 1;
      return this.calls === 1 ? ["42", []] : ["0", ["waia:worker:heartbeat:worker-1"]];
    },
  };
  assert.deepEqual(await probeWorkerHeartbeats(withHeartbeat), { state: "healthy" });
});

test("worker handler processa mensagem persistida por referencia e registra resposta", async () => {
  const sent = [];
  const recorded = [];
  const handlers = createWorkerHandlers({
    repository: {
      async inboundMessage() {
        return {
          id: "message-1",
          empresaId: "tenant-a",
          conversationId: "conversation-1",
          contactId: "contact-1",
          numeroWhatsappId: "number-1",
          type: "text",
          text: "produtos",
          mediaId: null,
          externalMessageId: "wamid.inbound",
          correlationId: "00000000-0000-4000-8000-000000000099",
          senderPhone: "5511999999999",
        };
      },
      async statusEvent() { return null; },
    },
    conversationService: {
      async getConversation() { return { mode: "bot" }; },
      async getState() { return { flowKey: "idle", stage: "idle", data: {}, version: 1 }; },
      async saveState() {},
      async getHistory() { return []; },
      async recordMessage(input) { recorded.push(input); },
      async applyMetaStatus() {},
    },
    tenantDefinitionRepository: { async load() { return tenantDefinition; } },
    metaGateway: {
      async markRead() {},
      async sendReply(_context, payload) {
        sent.push(payload);
        return { messages: [{ id: "wamid.outbound" }] };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const result = await handlers.process_inbound_message({
    empresaId: "tenant-a",
    jobId: "job-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    type: "process_inbound_message",
    correlationId: "00000000-0000-4000-8000-000000000099",
    payloadVersion: 1,
  });

  assert.deepEqual(result, { replied: true });
  assert.equal(sent[0].to, "5511999999999");
  assert.match(sent[0].text, /Item A/u);
  assert.equal(recorded[0].externalMessageId, "wamid.outbound");
  assert.equal(recorded[0].origin, "deterministic_flow");
});

test("worker armazena comprovante privado antes de continuar uma resposta preparada", async () => {
  const events = [];
  const stored = { storageKey: "tenant-a/message-media", mimeType: "image/jpeg", sizeBytes: 4, sha256: "a".repeat(64) };
  const handlers = createWorkerHandlers({
    repository: {
      async inboundMessage() {
        return {
          id: "message-media", empresaId: "tenant-a", conversationId: "conversation-1", contactId: "contact-1",
          numeroWhatsappId: "number-1", type: "image", text: "", mediaId: "meta-media-1", mediaStorageKey: null,
          externalMessageId: "wamid.media", correlationId: "00000000-0000-4000-8000-000000000099", senderPhone: "5511999999999",
        };
      },
      async statusEvent() { return null; },
      async markMediaStored(input) { events.push("mark"); assert.deepEqual(input.stored, stored); },
      async preparedReply() { events.push("prepared"); return { id: "reply-1", text: "Recebido", buttons: [], status: "processando" }; },
      async markReplySent() { events.push("sent-state"); },
    },
    conversationService: {
      async getConversation() { return { mode: "bot" }; },
      async recordMessage() {},
      async applyMetaStatus() {},
    },
    tenantDefinitionRepository: { async load() { assert.fail("resposta já estava preparada"); } },
    metaGateway: {
      async downloadMedia(_context, input) { events.push("download"); assert.equal(input.mediaId, "meta-media-1"); return { data: Buffer.from("test"), mimeType: "image/jpeg", sizeBytes: 4 }; },
      async sendReply() { events.push("send"); return { messages: [{ id: "wamid.out" }] }; },
    },
    mediaStore: {
      maxBytes: 1024,
      allowedMimeTypes: new Set(["image/jpeg"]),
      async put() { events.push("put"); return stored; },
      async delete() { events.push("delete"); },
    },
  });
  assert.deepEqual(await handlers.process_inbound_message({ empresaId: "tenant-a", messageId: "message-media" }), { replied: true });
  assert.deepEqual(events, ["download", "put", "mark", "prepared", "send", "sent-state"]);
});

test("worker preserva mídia privada mesmo quando a conversa está em atendimento humano", async () => {
  const events = [];
  const stored = { storageKey: "tenant-a/message-human", mimeType: "application/pdf", sizeBytes: 4, sha256: "b".repeat(64) };
  const handlers = createWorkerHandlers({
    repository: {
      async inboundMessage() {
        return {
          id: "message-human", conversationId: "conversation-1", contactId: "contact-1", numeroWhatsappId: "number-1",
          type: "document", text: "", mediaId: "meta-media-human", mediaStorageKey: null, externalMessageId: "wamid.human",
          correlationId: "00000000-0000-4000-8000-000000000099", senderPhone: "5511999999999",
        };
      },
      async statusEvent() { return null; },
      async markMediaStored(input) { events.push("mark"); assert.deepEqual(input.stored, stored); },
    },
    conversationService: {
      async getConversation() { return { mode: "human" }; },
      async recordMessage() { assert.fail("atendimento humano não deve gerar resposta automática"); },
      async applyMetaStatus() {},
    },
    tenantDefinitionRepository: { async load() { assert.fail("runtime não deve ser carregado"); } },
    metaGateway: {
      async downloadMedia() { events.push("download"); return { data: Buffer.from("test"), mimeType: "application/pdf", sizeBytes: 4 }; },
      async sendReply() { assert.fail("atendimento humano não deve enviar resposta automática"); },
    },
    mediaStore: {
      maxBytes: 1024,
      allowedMimeTypes: new Set(["application/pdf"]),
      async put() { events.push("put"); return stored; },
      async delete() { events.push("delete"); },
    },
    logger: { info() {} },
  });

  assert.deepEqual(
    await handlers.process_inbound_message({ empresaId: "tenant-a", messageId: "message-human" }),
    { skipped: true, reason: "conversation_not_in_bot_mode" },
  );
  assert.deepEqual(events, ["download", "put", "mark"]);
});

test("worker rejeita comprovante fora da política sem chamar runtime ou IA", async () => {
  let preparedText;
  const handlers = createWorkerHandlers({
    repository: {
      async inboundMessage() {
        return {
          id: "message-media", conversationId: "conversation-1", contactId: "contact-1", numeroWhatsappId: "number-1",
          type: "document", text: "", mediaId: "meta-media-1", mediaStorageKey: null, externalMessageId: "wamid.media",
          correlationId: "00000000-0000-4000-8000-000000000099", senderPhone: "5511999999999",
        };
      },
      async statusEvent() { return null; },
      async preparedReply() { return null; },
      async prepareReply({ reply }) { preparedText = reply.text; return { id: "reply-1", text: reply.text, buttons: [], status: "processando" }; },
      async markReplySent() {},
      async markMediaStored() { assert.fail("mídia inválida não deve ser persistida"); },
    },
    conversationService: { async getConversation() { return { mode: "bot" }; }, async recordMessage() {}, async applyMetaStatus() {} },
    tenantDefinitionRepository: { async load() { assert.fail("runtime não deve receber mídia recusada"); } },
    metaGateway: {
      async markRead() {},
      async downloadMedia() { throw Object.assign(new Error("grande"), { code: "META_MEDIA_TOO_LARGE", retryable: false }); },
      async sendReply(_context, payload) { assert.match(payload.text, /até 10 MB/u); return { messages: [{ id: "wamid.out" }] }; },
    },
    mediaStore: { maxBytes: 10, allowedMimeTypes: new Set(["application/pdf"]), async put() { assert.fail(); }, async delete() {} },
    aiService: { async reply() { assert.fail("IA não deve receber comprovante"); } },
    logger: { info() {}, warn() {} },
  });
  assert.deepEqual(await handlers.process_inbound_message({ empresaId: "tenant-a", messageId: "message-media" }), { replied: true });
  assert.match(preparedText, /JPEG, PNG ou WEBP/u);
});

test("worker envia resposta humana pelo número do tenant e registra o ID Meta", async () => {
  const events = [];
  const handlers = createWorkerHandlers({
    repository: {
      async inboundMessage() { return null; },
      async statusEvent() { return null; },
      async outboundHumanMessage() {
        return {
          id: "message-human", conversationId: "conversation-a", numeroWhatsappId: "number-a",
          text: "Resposta do operador", status: "processando", recipientPhone: "5511999999999",
        };
      },
      async markHumanMessageSent(input) { events.push(["marked", input]); },
    },
    conversationService: {
      async getConversation() { assert.fail("envio humano não carrega o runtime de conversa"); },
      async recordMessage() { assert.fail("mensagem já foi persistida pela API"); },
      async applyMetaStatus() {},
    },
    tenantDefinitionRepository: { async load() { assert.fail("envio humano não carrega definição do bot"); } },
    metaGateway: {
      async sendReply(context, payload) {
        events.push(["sent", context, payload]);
        return { messages: [{ id: "wamid.human.out" }] };
      },
    },
  });

  assert.deepEqual(await handlers.send_human_message({ empresaId: "tenant-a", messageId: "message-human" }), { sent: true });
  assert.deepEqual(events, [
    ["sent", { empresaId: "tenant-a", numeroWhatsappId: "number-a" }, { to: "5511999999999", text: "Resposta do operador", buttons: [] }],
    ["marked", { empresaId: "tenant-a", messageId: "message-human", externalMessageId: "wamid.human.out" }],
  ]);
});
