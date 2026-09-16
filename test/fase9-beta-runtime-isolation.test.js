import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  adaptLegacyTenantDefinitionToV2,
  compileTenantRuntimeConfigV2,
  materializeLegacyTenantDefinition,
  verifyCompiledTenantRuntimeConfigV2,
} from "../src/modules/configuration/index.js";
import { createWorkerHandlers } from "../src/modules/jobs/handlers.js";
import { queueJobId } from "../src/modules/jobs/job-reference.js";
import { createMetaMultiAppWebhookService } from "../src/modules/meta/multiapp-webhook-service.js";
import { createWebhookIngestionService } from "../src/modules/webhook/ingestion-service.js";
import {
  CAPITAO_MOR_DEMO_TENANT_ID,
  capitaoMorDemoDefinition,
} from "../src/tenants/capitao-mor.js";

const BETA_TENANT_ID = "00000000-0000-4000-8000-0000000000b9";
const SHARED_CONVERSATION_ID = "conversation-repeated-after-restart";
const SHARED_CORRELATION_ID = "00000000-0000-4000-8000-000000000099";

const META = Object.freeze({
  [CAPITAO_MOR_DEMO_TENANT_ID]: Object.freeze({
    publicId: "Capitao_Webhook_Public_Id_09",
    wabaId: "waba-capitao",
    phoneNumberId: "phone-capitao",
    numberId: "number-capitao",
    secret: "synthetic-capitao-app-secret",
    token: "synthetic-capitao-access-token",
  }),
  [BETA_TENANT_ID]: Object.freeze({
    publicId: "Beta_Webhook_Public_Id_0009",
    wabaId: "waba-beta",
    phoneNumberId: "phone-beta",
    numberId: "number-beta",
    secret: "synthetic-beta-app-secret",
    token: "synthetic-beta-access-token",
  }),
});

function metaPayload({ wabaId, phoneNumberId, text = "oi" }) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: wabaId,
      changes: [{
        field: "messages",
        value: {
          metadata: { display_phone_number: "5511999999999", phone_number_id: phoneNumberId },
          messages: [{
            id: "wamid.repeated-between-capitao-and-beta",
            from: "5511888888888",
            timestamp: "1788350400",
            type: "text",
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

function signature(secret, rawBody) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

test("callbacks Meta repetidos do Capitão Mor e da Beta preservam segredo, tenant, deduplicação e fila", async () => {
  const messages = new Map();
  const jobs = [];
  const vaultCalls = [];
  const tenantsByPhone = new Map(Object.entries(META).map(([empresaId, meta]) => [
    meta.phoneNumberId,
    { empresaId, numeroWhatsappId: meta.numberId, status: "active", numberStatus: "active" },
  ]));
  const ingestionService = createWebhookIngestionService({
    tenantResolver: {
      async resolveByPhoneNumberId(phoneNumberId) {
        return tenantsByPhone.get(phoneNumberId) || null;
      },
    },
    repository: {
      async withTenantTransaction(tenant, callback) {
        return callback({ empresaId: tenant.empresaId });
      },
      async insertInboundMessage(_transaction, input) {
        const key = `${input.empresaId}:${input.event.externalMessageId}`;
        const existing = messages.get(key);
        if (existing) return { inserted: false, ...existing };
        const persisted = {
          messageId: "message-repeated-between-tenants",
          conversationId: SHARED_CONVERSATION_ID,
        };
        messages.set(key, persisted);
        return { inserted: true, ...persisted };
      },
      async insertStatusEvent() {
        assert.fail("esta jornada envia somente mensagens de entrada");
      },
    },
    outbox: {
      async add(_transaction, reference) {
        jobs.push(structuredClone(reference));
      },
    },
    logger: { info() {}, warn() {} },
  });
  const connectionByPublicId = new Map(Object.entries(META).map(([empresaId, meta]) => [
    meta.publicId,
    {
      id: `meta-app:${empresaId}`,
      empresaId,
      status: "active",
      wabaId: meta.wabaId,
      numbers: [{
        numeroWhatsappId: meta.numberId,
        phoneNumberId: meta.phoneNumberId,
        status: "active",
      }],
      appSecretCredentialId: "credential-app-secret-repeated",
      verifyTokenCredentialId: "credential-verify-repeated",
    },
  ]));
  const webhookService = createMetaMultiAppWebhookService({
    connectionResolver: {
      async resolveByWebhookPublicId(publicId) {
        return connectionByPublicId.get(publicId) || null;
      },
    },
    credentialVault: {
      async getCredentialForUse(input) {
        vaultCalls.push(structuredClone(input));
        return META[input.empresaId]?.secret;
      },
    },
    ingestionService,
    logger: { warn() {}, error() {} },
  });

  const requests = Object.entries(META).map(([empresaId, meta]) => {
    const rawBody = Buffer.from(JSON.stringify(metaPayload(meta)));
    return {
      empresaId,
      request: {
        webhookPublicId: meta.publicId,
        rawBody,
        signature: signature(meta.secret, rawBody),
        correlationId: SHARED_CORRELATION_ID,
      },
    };
  });
  const first = await Promise.all(requests.map(({ request }) => webhookService.ingest(request)));
  const repeated = await Promise.all(requests.map(({ request }) => webhookService.ingest(request)));

  assert.deepEqual(first, [
    { accepted: true, eventCount: 1 },
    { accepted: true, eventCount: 1 },
  ]);
  assert.deepEqual(repeated, first);
  assert.equal(messages.size, 2);
  assert.equal(jobs.length, 2);
  assert.deepEqual(new Set(jobs.map(({ empresaId }) => empresaId)), new Set([
    CAPITAO_MOR_DEMO_TENANT_ID,
    BETA_TENANT_ID,
  ]));
  assert.deepEqual(jobs.map((job) => queueJobId({ ...job, jobId: "job-repeated" })), [
    `${CAPITAO_MOR_DEMO_TENANT_ID}__job-repeated`,
    `${BETA_TENANT_ID}__job-repeated`,
  ]);
  assert.deepEqual(vaultCalls, [
    { empresaId: CAPITAO_MOR_DEMO_TENANT_ID, credentialId: "credential-app-secret-repeated" },
    { empresaId: BETA_TENANT_ID, credentialId: "credential-app-secret-repeated" },
    { empresaId: CAPITAO_MOR_DEMO_TENANT_ID, credentialId: "credential-app-secret-repeated" },
    { empresaId: BETA_TENANT_ID, credentialId: "credential-app-secret-repeated" },
  ]);
  assert.doesNotMatch(JSON.stringify(jobs), /app-secret|access-token|credential-app-secret/iu);
});

function betaPublishedDefinition() {
  const compiled = compileTenantRuntimeConfigV2({
    schemaVersion: 2,
    identity: {
      name: "Empresa Beta Sintética",
      displayName: "Beta Sintética",
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
      welcomeMessage: "Bem-vindo à Empresa Beta Sintética.",
      fallbackMessage: "Escolha uma opção da Beta.",
    },
    retention: { messagesDays: 30, logsDays: 30 },
    modules: ["catalog", "appointments", "ai_freeform"],
    menu: {
      text: "Menu exclusivo da Empresa Beta Sintética",
      options: [
        { id: "catalogo-beta", label: "Catálogo Beta", action: "catalog.list", params: {} },
        { id: "agenda-beta", label: "Agendar na Beta", action: "appointments.start", params: {} },
      ],
    },
    routing: {
      greetings: ["oi"],
      aliases: [{ terms: ["agendar"], action: "appointments.start", params: {} }],
      fallbackAction: "ai_freeform.reply",
    },
    catalog: {
      items: [{ id: "item-beta", name: "Serviço público Beta", price: 42, active: true }],
    },
    appointments: {
      services: [{
        id: "consulta-beta",
        name: "Consulta Beta",
        active: true,
        slots: [{
          id: "seg-09-beta",
          label: "Segunda às 09h",
          startsAt: "2026-09-07T09:00:00-03:00",
          available: true,
        }],
      }],
    },
    ai: {
      enabled: true,
      provider: "simulated",
      model: "beta-simulated-v1",
      prompt: "Use somente informações públicas da Empresa Beta Sintética.",
      keyMode: "own",
      credentialRef: "credential:beta-ai-simulated",
      fallbackMessage: "IA simulada da Beta indisponível.",
    },
  }, {
    empresaId: BETA_TENANT_ID,
    configVersion: 1,
    draftVersion: 10,
  });
  assert.equal(verifyCompiledTenantRuntimeConfigV2(compiled), true);
  return { compiled, definition: materializeLegacyTenantDefinition(compiled) };
}

function capitaoPublishedDefinition() {
  const configuration = adaptLegacyTenantDefinitionToV2(capitaoMorDemoDefinition);
  const compiled = compileTenantRuntimeConfigV2(configuration, {
    empresaId: CAPITAO_MOR_DEMO_TENANT_ID,
    configVersion: capitaoMorDemoDefinition.runtime.version,
    draftVersion: 1,
  });
  assert.equal(verifyCompiledTenantRuntimeConfigV2(compiled), true);
  return {
    compiled,
    definition: materializeLegacyTenantDefinition(compiled, {
      payment: capitaoMorDemoDefinition.runtime.payments.pix,
    }),
  };
}

function durableConversationService() {
  const states = new Map([
    [`${CAPITAO_MOR_DEMO_TENANT_ID}:${SHARED_CONVERSATION_ID}`, {
      flowKey: "idle", stage: "idle", data: {}, version: 1,
    }],
    [`${BETA_TENANT_ID}:${SHARED_CONVERSATION_ID}`, {
      flowKey: "idle", stage: "idle", data: {}, version: 1,
    }],
  ]);
  const recorded = [];
  const key = ({ empresaId, conversationId }) => `${empresaId}:${conversationId}`;
  return {
    states,
    recorded,
    async getConversation(input) {
      assert.ok(states.has(key(input)), "a conversa precisa pertencer ao tenant");
      return { id: input.conversationId, empresaId: input.empresaId, mode: "bot" };
    },
    async getState(input) {
      return structuredClone(states.get(key(input)));
    },
    async saveState(input) {
      const current = states.get(key(input));
      assert.equal(input.expectedVersion, current.version);
      const next = {
        flowKey: input.flowKey,
        stage: input.stage,
        data: structuredClone(input.data),
        version: current.version + 1,
      };
      states.set(key(input), next);
      return structuredClone(next);
    },
    async recordMessage(input) {
      recorded.push(structuredClone(input));
    },
    async applyMetaStatus() {},
  };
}

function workerHarness() {
  const capitao = capitaoPublishedDefinition();
  const beta = betaPublishedDefinition();
  const activeRevisions = new Map([
    [CAPITAO_MOR_DEMO_TENANT_ID, capitao],
    [BETA_TENANT_ID, beta],
  ]);
  const messages = new Map();
  const conversationService = durableConversationService();
  const sends = [];
  const vaultCalls = [];
  const repository = {
    async inboundMessage({ empresaId, messageId }) {
      return structuredClone(messages.get(`${empresaId}:${messageId}`) || null);
    },
    async statusEvent() {
      return null;
    },
  };
  const dependencies = {
    repository,
    conversationService,
    tenantDefinitionRepository: {
      async load(empresaId) {
        return structuredClone(activeRevisions.get(empresaId)?.definition || null);
      },
    },
    metaGateway: {
      async markRead() {},
      async sendReply(context, payload) {
        const meta = META[context.empresaId];
        assert.equal(context.numeroWhatsappId, meta.numberId);
        const credentialId = "credential-access-token-repeated";
        vaultCalls.push({ empresaId: context.empresaId, credentialId });
        const accessToken = META[context.empresaId].token;
        sends.push({
          empresaId: context.empresaId,
          numeroWhatsappId: context.numeroWhatsappId,
          credentialId,
          accessToken,
          payload: structuredClone(payload),
        });
        return { messages: [{ id: "wamid.outbound-repeated-between-tenants" }] };
      },
    },
    aiService: {
      async reply() {
        assert.fail("os estados determinísticos desta regressão não devem chamar IA");
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  return {
    activeRevisions,
    messages,
    conversationService,
    sends,
    vaultCalls,
    createWorker: () => createWorkerHandlers(dependencies),
  };
}

function inboundMessage({ empresaId, messageId, type, text }) {
  return {
    id: messageId,
    empresaId,
    conversationId: SHARED_CONVERSATION_ID,
    contactId: "contact-repeated-between-tenants",
    numeroWhatsappId: META[empresaId].numberId,
    type,
    text,
    mediaId: null,
    externalMessageId: "wamid.repeated-between-capitao-and-beta",
    correlationId: SHARED_CORRELATION_ID,
    senderPhone: "5511888888888",
  };
}

function jobReference(empresaId, messageId) {
  return {
    empresaId,
    jobId: "job-repeated",
    conversationId: SHARED_CONVERSATION_ID,
    messageId,
    type: "process_inbound_message",
    correlationId: SHARED_CORRELATION_ID,
    payloadVersion: 1,
  };
}

test("worker recriado continua Capitão Mor e Beta simultâneos sem cruzar runtime, conversa, estado ou token", async () => {
  const harness = workerHarness();
  const firstMessageId = "message-repeated-wave-1";
  harness.messages.set(`${CAPITAO_MOR_DEMO_TENANT_ID}:${firstMessageId}`, inboundMessage({
    empresaId: CAPITAO_MOR_DEMO_TENANT_ID,
    messageId: firstMessageId,
    type: "interactive",
    text: "event:evento-demo-sexta",
  }));
  harness.messages.set(`${BETA_TENANT_ID}:${firstMessageId}`, inboundMessage({
    empresaId: BETA_TENANT_ID,
    messageId: firstMessageId,
    type: "interactive",
    text: "appointment:consulta-beta",
  }));

  const firstWorker = harness.createWorker();
  await Promise.all([
    firstWorker.process_inbound_message(jobReference(CAPITAO_MOR_DEMO_TENANT_ID, firstMessageId)),
    firstWorker.process_inbound_message(jobReference(BETA_TENANT_ID, firstMessageId)),
  ]);

  assert.deepEqual(harness.conversationService.states.get(
    `${CAPITAO_MOR_DEMO_TENANT_ID}:${SHARED_CONVERSATION_ID}`,
  ), {
    flowKey: "orders",
    stage: "awaiting_receipt",
    data: { eventId: "evento-demo-sexta" },
    version: 2,
  });
  assert.deepEqual(harness.conversationService.states.get(
    `${BETA_TENANT_ID}:${SHARED_CONVERSATION_ID}`,
  ), {
    flowKey: "appointments",
    stage: "awaiting_slot",
    data: { serviceId: "consulta-beta" },
    version: 2,
  });

  const secondMessageId = "message-repeated-wave-2";
  harness.messages.set(`${CAPITAO_MOR_DEMO_TENANT_ID}:${secondMessageId}`, inboundMessage({
    empresaId: CAPITAO_MOR_DEMO_TENANT_ID,
    messageId: secondMessageId,
    type: "text",
    text: "já fiz o PIX",
  }));
  harness.messages.set(`${BETA_TENANT_ID}:${secondMessageId}`, inboundMessage({
    empresaId: BETA_TENANT_ID,
    messageId: secondMessageId,
    type: "interactive",
    text: "slot:seg-09-beta",
  }));

  // Simula o reinício lógico de API/worker: os handlers são recriados, mas os
  // repositórios duráveis, as revisões publicadas e os estados permanecem.
  const restartedWorker = harness.createWorker();
  await Promise.all([
    restartedWorker.process_inbound_message(jobReference(CAPITAO_MOR_DEMO_TENANT_ID, secondMessageId)),
    restartedWorker.process_inbound_message(jobReference(BETA_TENANT_ID, secondMessageId)),
  ]);

  const capitaoState = harness.conversationService.states.get(
    `${CAPITAO_MOR_DEMO_TENANT_ID}:${SHARED_CONVERSATION_ID}`,
  );
  const betaState = harness.conversationService.states.get(
    `${BETA_TENANT_ID}:${SHARED_CONVERSATION_ID}`,
  );
  assert.deepEqual(capitaoState, {
    flowKey: "orders",
    stage: "awaiting_receipt",
    data: { eventId: "evento-demo-sexta" },
    version: 3,
  });
  assert.deepEqual(betaState, {
    flowKey: "appointments",
    stage: "awaiting_name",
    data: { serviceId: "consulta-beta", slotId: "seg-09-beta" },
    version: 3,
  });
  assert.notDeepEqual(capitaoState, betaState);

  const capitaoReplies = harness.sends.filter(({ empresaId }) => empresaId === CAPITAO_MOR_DEMO_TENANT_ID);
  const betaReplies = harness.sends.filter(({ empresaId }) => empresaId === BETA_TENANT_ID);
  assert.equal(capitaoReplies.length, 2);
  assert.equal(betaReplies.length, 2);
  assert.match(capitaoReplies[0].payload.text, /Capitão Mor|PIX|comprovante/iu);
  assert.match(capitaoReplies[1].payload.text, /comprovante/iu);
  assert.doesNotMatch(capitaoReplies.map(({ payload }) => payload.text).join("\n"), /Consulta Beta|Empresa Beta/iu);
  assert.match(betaReplies[0].payload.buttons[0].label, /Segunda às 09h/u);
  assert.match(betaReplies[1].payload.text, /nome completo/iu);
  assert.doesNotMatch(betaReplies.map(({ payload }) => payload.text).join("\n"), /PIX|Capitão Mor/iu);

  assert.deepEqual(new Set(harness.vaultCalls.map(({ empresaId }) => empresaId)), new Set([
    CAPITAO_MOR_DEMO_TENANT_ID,
    BETA_TENANT_ID,
  ]));
  for (const reply of harness.sends) {
    assert.equal(reply.credentialId, "credential-access-token-repeated");
    assert.equal(reply.accessToken, META[reply.empresaId].token);
    assert.equal(reply.numeroWhatsappId, META[reply.empresaId].numberId);
  }
  assert.equal(harness.activeRevisions.get(CAPITAO_MOR_DEMO_TENANT_ID).compiled.configVersion, 1);
  assert.equal(harness.activeRevisions.get(BETA_TENANT_ID).compiled.configVersion, 1);
  assert.deepEqual(new Set(harness.conversationService.recorded.map(({ empresaId }) => empresaId)), new Set([
    CAPITAO_MOR_DEMO_TENANT_ID,
    BETA_TENANT_ID,
  ]));
});
