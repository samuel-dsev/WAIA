import test from "node:test";
import assert from "node:assert/strict";
import { PostgresMetaCredentialResolver } from "../src/bootstrap/app-runtime.js";
import { createWorkerHandlers } from "../src/modules/jobs/handlers.js";
import { queueJobId } from "../src/modules/jobs/job-reference.js";
import { createWebhookIngestionService } from "../src/modules/webhook/ingestion-service.js";
import { CAPITAO_MOR_DEMO_TENANT_ID } from "../src/tenants/capitao-mor.js";

const TENANT_B = "00000000-0000-4000-8000-000000000002";
const SHARED_MESSAGE_ID = "message-repeated-between-tenants";
const SHARED_CONVERSATION_ID = "conversation-repeated-between-tenants";
const SHARED_CORRELATION_ID = "00000000-0000-4000-8000-000000000099";

function inbound(phoneNumberId) {
  return {
    kind: "message",
    phoneNumberId,
    senderPhone: "5511999999999",
    externalMessageId: "wamid.repeated",
    idempotencyKey: "wamid.repeated",
    messageType: "text",
    text: "Tem estacionamento?",
  };
}

function status(phoneNumberId) {
  return {
    kind: "status",
    phoneNumberId,
    externalMessageId: "wamid.repeated.outbound",
    idempotencyKey: "wamid.repeated.outbound:delivered:1",
    status: "delivered",
  };
}

test("IDs Meta repetidos deduplicam por tenant sem cruzar mensagem, status ou outbox", async () => {
  const tenants = new Map([
    ["phone-capitao", { empresaId: CAPITAO_MOR_DEMO_TENANT_ID, numeroWhatsappId: "number-capitao", status: "active" }],
    ["phone-beta", { empresaId: TENANT_B, numeroWhatsappId: "number-beta", status: "active" }],
  ]);
  const messages = new Map();
  const statuses = new Map();
  const jobs = [];
  const service = createWebhookIngestionService({
    tenantResolver: {
      async resolveByPhoneNumberId(phoneNumberId) { return tenants.get(phoneNumberId) || null; },
    },
    repository: {
      async withTenantTransaction(tenant, callback) { return callback({ empresaId: tenant.empresaId }); },
      async insertInboundMessage(_tx, input) {
        const key = `${input.empresaId}:${input.event.externalMessageId}`;
        if (messages.has(key)) return { inserted: false, ...messages.get(key) };
        const record = { messageId: SHARED_MESSAGE_ID, conversationId: SHARED_CONVERSATION_ID };
        messages.set(key, record);
        return { inserted: true, ...record };
      },
      async insertStatusEvent(_tx, input) {
        const key = `${input.empresaId}:${input.event.idempotencyKey}`;
        if (statuses.has(key)) return { inserted: false, ...statuses.get(key) };
        const record = { statusEventId: "status-repeated-between-tenants", messageId: SHARED_MESSAGE_ID };
        statuses.set(key, record);
        return { inserted: true, ...record };
      },
    },
    outbox: {
      async add(_tx, reference) { jobs.push(structuredClone(reference)); },
    },
    logger: { info() {}, warn() {} },
  });

  const first = await service.ingestEvents([
    inbound("phone-capitao"), inbound("phone-beta"),
    status("phone-capitao"), status("phone-beta"),
  ], { correlationId: SHARED_CORRELATION_ID });
  const repeated = await service.ingestEvents([
    inbound("phone-capitao"), status("phone-capitao"),
  ], { correlationId: SHARED_CORRELATION_ID });

  assert.deepEqual(first.map(({ outcome, empresaId }) => [outcome, empresaId]), [
    ["accepted", CAPITAO_MOR_DEMO_TENANT_ID],
    ["accepted", TENANT_B],
    ["accepted", CAPITAO_MOR_DEMO_TENANT_ID],
    ["accepted", TENANT_B],
  ]);
  assert.deepEqual(repeated.map(({ outcome }) => outcome), ["duplicate", "duplicate"]);
  assert.equal(messages.size, 2);
  assert.equal(statuses.size, 2);
  assert.equal(jobs.length, 4);
  assert.deepEqual(new Set(jobs.map(({ empresaId }) => empresaId)), new Set([CAPITAO_MOR_DEMO_TENANT_ID, TENANT_B]));

  const queueIds = jobs.slice(0, 2).map((job) => queueJobId({ ...job, jobId: "job-repeated" }));
  assert.deepEqual(queueIds, [
    `${CAPITAO_MOR_DEMO_TENANT_ID}__job-repeated`,
    `${TENANT_B}__job-repeated`,
  ]);
  assert.doesNotMatch(JSON.stringify(jobs), /access[_-]?token|app[_-]?secret|pix|private[_-]?key/iu);
});

function tenantDefinition({ empresaId, name, publicMarker, privatePix }) {
  return {
    runtime: {
      empresaId,
      version: 8,
      identity: {
        name,
        welcomeMessage: `Bem-vindo a ${name}`,
        establishmentRules: `Regra publica ${publicMarker}`,
      },
      enabledModules: ["catalog", "payments", "ai_freeform"],
      menu: {
        text: `Menu ${publicMarker}`,
        options: [{ id: "endereco", label: "Endereco", module: "catalog", action: "catalog.address" }],
      },
      catalog: { items: [{ id: "public-item", name: `Item ${publicMarker}`, active: true }] },
      events: { items: [] },
      payments: { pix: { key: privatePix, recipient: `Favorecido ${privatePix}` } },
      appointments: { services: [] },
    },
    publicReplies: [
      { module: "catalog", action: "catalog.address", text: `Endereco publico ${publicMarker}` },
      { module: "payments", action: "payments.private_instructions", text: `PIX ${privatePix}` },
    ],
    routing: { greetings: ["oi"], aliases: [], fallbackAction: "ai_freeform.reply" },
  };
}

test("worker isola runtime e IA mesmo com IDs internos iguais e nunca envia PIX ao modelo", async () => {
  const definitions = new Map([
    [CAPITAO_MOR_DEMO_TENANT_ID, tenantDefinition({
      empresaId: CAPITAO_MOR_DEMO_TENANT_ID,
      name: "Bar Capitao Mor",
      publicMarker: "PUBLICO_CAPITAO",
      privatePix: "PIX_PRIVADO_CAPITAO",
    })],
    [TENANT_B, tenantDefinition({
      empresaId: TENANT_B,
      name: "Empresa sintetica B",
      publicMarker: "PUBLICO_BETA",
      privatePix: "PIX_PRIVADO_BETA",
    })],
  ]);
  const aiRequests = [];
  const sends = [];
  const records = [];
  const handlers = createWorkerHandlers({
    repository: {
      async inboundMessage({ empresaId }) {
        return {
          id: SHARED_MESSAGE_ID,
          empresaId,
          conversationId: SHARED_CONVERSATION_ID,
          contactId: "contact-repeated-between-tenants",
          numeroWhatsappId: empresaId === CAPITAO_MOR_DEMO_TENANT_ID ? "number-capitao" : "number-beta",
          type: "text",
          text: "Tem estacionamento?",
          mediaId: null,
          externalMessageId: "wamid.repeated",
          correlationId: SHARED_CORRELATION_ID,
          senderPhone: "5511999999999",
        };
      },
      async statusEvent() { return null; },
    },
    conversationService: {
      async getConversation() { return { mode: "bot" }; },
      async getState() { return { flowKey: "idle", stage: "idle", data: {}, version: 1 }; },
      async saveState() {},
      async recordMessage(input) { records.push(structuredClone(input)); },
      async applyMetaStatus() {},
    },
    tenantDefinitionRepository: {
      async load(empresaId) { return structuredClone(definitions.get(empresaId)); },
    },
    metaGateway: {
      async markRead() {},
      async sendReply(context, payload) {
        sends.push({ context: structuredClone(context), payload: structuredClone(payload) });
        return { messages: [{ id: `wamid.reply.${context.empresaId}` }] };
      },
    },
    aiService: {
      async reply(input) {
        aiRequests.push(structuredClone(input));
        return { text: `Resposta publica para ${input.empresaId}`, source: "ai" };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  await Promise.all([CAPITAO_MOR_DEMO_TENANT_ID, TENANT_B].map((empresaId) => (
    handlers.process_inbound_message({
      empresaId,
      jobId: "job-repeated",
      conversationId: SHARED_CONVERSATION_ID,
      messageId: SHARED_MESSAGE_ID,
      type: "process_inbound_message",
      correlationId: SHARED_CORRELATION_ID,
      payloadVersion: 1,
    })
  )));

  assert.equal(aiRequests.length, 2);
  for (const request of aiRequests) {
    const serialized = JSON.stringify(request.context);
    assert.doesNotMatch(serialized, /PIX_PRIVADO_CAPITAO|PIX_PRIVADO_BETA/u);
    if (request.empresaId === CAPITAO_MOR_DEMO_TENANT_ID) {
      assert.match(serialized, /PUBLICO_CAPITAO/u);
      assert.doesNotMatch(serialized, /PUBLICO_BETA/u);
    } else {
      assert.match(serialized, /PUBLICO_BETA/u);
      assert.doesNotMatch(serialized, /PUBLICO_CAPITAO/u);
    }
  }
  assert.deepEqual(new Set(sends.map(({ context }) => context.empresaId)), new Set([CAPITAO_MOR_DEMO_TENANT_ID, TENANT_B]));
  assert.deepEqual(new Set(records.map(({ empresaId }) => empresaId)), new Set([CAPITAO_MOR_DEMO_TENANT_ID, TENANT_B]));
  assert.ok(sends.every(({ context, payload }) => payload.text.includes(context.empresaId)));
});

test("token Meta e numero permanecem tenant-scoped mesmo com IDs de credencial repetidos", async () => {
  const vaultCalls = [];
  const numbers = new Map([
    [CAPITAO_MOR_DEMO_TENANT_ID, { phone_number_id: "phone-capitao", aplicativo_meta_id: "app-capitao", access_token_credencial_id: "credential-repeated", aplicativo_estado: "ativo" }],
    [TENANT_B, { phone_number_id: "phone-beta", aplicativo_meta_id: "app-beta", access_token_credencial_id: "credential-repeated", aplicativo_estado: "ativo" }],
  ]);
  const resolver = new PostgresMetaCredentialResolver({
    pool: {},
    apiVersion: "v99.0",
    credentialVault: {
      async getCredentialForUse(input) {
        vaultCalls.push(structuredClone(input));
        return `token:${input.empresaId}:${input.credentialId}`;
      },
    },
    transactionRunner: async (_pool, context, callback) => callback({
      client: {
        async query(sql, params) {
          assert.match(sql, /WHERE nw\.empresa_id = \$1 AND nw\.id = \$2/u);
          assert.equal(params[1], "number-repeated");
          return { rows: [numbers.get(context.empresaId)] };
        },
      },
      tenantId: context.empresaId,
    }),
  });

  const [capitao, beta] = await Promise.all([
    resolver.resolveMeta({ empresaId: CAPITAO_MOR_DEMO_TENANT_ID, numeroWhatsappId: "number-repeated" }),
    resolver.resolveMeta({ empresaId: TENANT_B, numeroWhatsappId: "number-repeated" }),
  ]);

  assert.equal(capitao.phoneNumberId, "phone-capitao");
  assert.equal(beta.phoneNumberId, "phone-beta");
  assert.equal(capitao.accessToken, `token:${CAPITAO_MOR_DEMO_TENANT_ID}:credential-repeated`);
  assert.equal(beta.accessToken, `token:${TENANT_B}:credential-repeated`);
  assert.deepEqual(vaultCalls, [
    { empresaId: CAPITAO_MOR_DEMO_TENANT_ID, credentialId: "credential-repeated" },
    { empresaId: TENANT_B, credentialId: "credential-repeated" },
  ]);
});
