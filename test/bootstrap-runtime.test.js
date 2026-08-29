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
