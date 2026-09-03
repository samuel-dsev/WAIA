import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleSheetsIntegration } from "../src/integrations/index.js";
import { legacyCapitaoMorOrderRow } from "../src/integrations/google-sheets/postgres-adapters.js";
import { ConversationService, MemoryConversationRepository } from "../src/modules/conversations/index.js";
import { createWorkerHandlers } from "../src/modules/jobs/handlers.js";
import { createOutboxDispatcher } from "../src/modules/jobs/outbox-dispatcher.js";
import { loadCapitaoMorTenantConfig } from "../src/tenants/index.js";

const CAPITAO_ID = loadCapitaoMorTenantConfig().empresaId;
const OTHER_TENANT_ID = "empresa-sintetica-isolada";

function scopedOnceRepository() {
  const completed = new Map();
  return {
    async runOnce(scope, operation) {
      const key = [
        scope.empresaId,
        scope.integrationId,
        scope.operation,
        scope.idempotencyKey,
      ].join(":");
      if (completed.has(key)) {
        return { ...structuredClone(completed.get(key)), duplicate: true };
      }
      const result = await operation();
      completed.set(key, structuredClone(result));
      return { ...result, duplicate: false };
    },
  };
}

function workerHandlers({ repository, conversationService, metaGateway, googleSheetsIntegration }) {
  return createWorkerHandlers({
    repository: {
      async inboundMessage() { return null; },
      async statusEvent() { return null; },
      ...repository,
    },
    conversationService: conversationService || {
      async getConversation() { return { mode: "bot" }; },
      async recordMessage() {},
      async applyMetaStatus() {},
    },
    tenantDefinitionRepository: {
      async load() {
        assert.fail("jobs operacionais não devem carregar uma definição conversacional");
      },
    },
    metaGateway: metaGateway || {
      async sendReply() {
        assert.fail("a regressão de Sheets não deve chamar a Meta");
      },
    },
    googleSheetsIntegration,
    logger: { info() {}, warn() {}, error() {} },
  });
}

test("Capitão Mor recupera outbox após falha e não duplica exportação Sheets depois do reinício", async () => {
  const job = {
    jobId: "job-export-capitao-1",
    empresaId: CAPITAO_ID,
    conversationId: "conversa-capitao-operacao",
    messageId: null,
    statusEventId: null,
    orderId: "pedido-capitao-sintetico-1",
    type: "export_google_sheets_order",
    correlationId: "correlation-capitao-export-1",
    payloadVersion: 1,
  };
  const outbox = { state: "pending", releases: 0, publications: 0 };
  const outboxRepository = {
    async claimBatch() {
      return outbox.state === "pending" ? [structuredClone(job)] : [];
    },
    async release(reference) {
      assert.equal(reference.jobId, job.jobId);
      outbox.state = "pending";
      outbox.releases += 1;
    },
    async markPublished(reference) {
      assert.equal(reference.jobId, job.jobId);
      outbox.state = "published";
      outbox.publications += 1;
    },
  };

  const failedDispatcher = createOutboxDispatcher({
    repository: outboxRepository,
    queue: {
      async add() {
        throw Object.assign(new Error("Redis sintético indisponível"), { code: "SYNTHETIC_REDIS_DOWN" });
      },
    },
    logger: { warn() {} },
  });
  assert.deepEqual(await failedDispatcher.dispatchOnce(), [
    { jobId: job.jobId, outcome: "released" },
  ]);

  const queued = [];
  const restartedDispatcher = createOutboxDispatcher({
    repository: outboxRepository,
    queue: { async add(reference) { queued.push(structuredClone(reference)); } },
  });
  assert.deepEqual(await restartedDispatcher.dispatchOnce(), [
    { jobId: job.jobId, outcome: "published" },
  ]);
  assert.equal(outbox.releases, 1);
  assert.equal(outbox.publications, 1);
  assert.equal(outbox.state, "published");
  assert.equal(queued.length, 1);
  assert.deepEqual(Object.keys(queued[0]).sort(), [
    "conversationId",
    "correlationId",
    "empresaId",
    "jobId",
    "messageId",
    "orderId",
    "payloadVersion",
    "statusEventId",
    "type",
  ]);
  assert.doesNotMatch(JSON.stringify(queued[0]), /Pessoa Demonstração|5511|comprovante|pix/iu);

  const appendCalls = [];
  const sheets = createGoogleSheetsIntegration({
    configurationResolver: {
      async resolveGoogleSheets({ empresaId }) {
        assert.equal(empresaId, CAPITAO_ID);
        return {
          enabled: true,
          integrationId: "sheets-capitao-sintetico",
          spreadsheetId: "spreadsheet-capitao-sintetico",
          imports: { health: "Config!A1" },
          exports: { orders: "Pedidos!A:G" },
        };
      },
    },
    credentialResolver: {
      async resolveGoogleSheets({ empresaId }) {
        assert.equal(empresaId, CAPITAO_ID);
        return { syntheticCredential: true };
      },
    },
    cacheRepository: { async load() { return null; }, async save() {} },
    idempotencyRepository: scopedOnceRepository(),
    orderRowMapper: legacyCapitaoMorOrderRow,
    clientFactory: async ({ empresaId }) => ({
      async getValues() { return []; },
      async appendValues(range, row) {
        appendCalls.push({ empresaId, range, row: structuredClone(row) });
        return { updatedRows: 1 };
      },
    }),
    logger: { warn() {} },
  });
  const order = {
    id: job.orderId,
    customerName: "Pessoa Demonstração",
    customerPhone: "5511999999999",
    eventName: "Sexta Rock Demo",
    receiptId: "comprovante-sintetico-1",
    status: "Aguardando conferência",
    createdAt: "2026-09-03T12:00:00.000Z",
  };
  const integrationStatuses = [];
  const jobRepository = {
    async googleSheetsOrder({ empresaId, orderId }) {
      assert.equal(empresaId, CAPITAO_ID);
      assert.equal(orderId, order.id);
      return structuredClone(order);
    },
    async markGoogleSheetsOrder({ empresaId, orderId, status }) {
      integrationStatuses.push({ empresaId, orderId, status });
    },
  };

  const firstWorker = workerHandlers({ repository: jobRepository, googleSheetsIntegration: sheets });
  assert.deepEqual(await firstWorker.export_google_sheets_order(queued[0]), {
    exported: true,
    duplicate: false,
  });

  const restartedWorker = workerHandlers({ repository: jobRepository, googleSheetsIntegration: sheets });
  assert.deepEqual(await restartedWorker.export_google_sheets_order(queued[0]), {
    exported: true,
    duplicate: true,
  });
  assert.deepEqual(appendCalls, [{
    empresaId: CAPITAO_ID,
    range: "Pedidos!A:G",
    row: [
      order.createdAt,
      order.customerPhone,
      order.eventName,
      order.customerName,
      order.receiptId,
      "Aguardando conferência",
      "",
    ],
  }]);
  assert.equal(integrationStatuses.length, 2);
  assert.ok(integrationStatuses.every(({ empresaId, orderId, status }) => (
    empresaId === CAPITAO_ID && orderId === order.id && status === "sincronizada"
  )));
});

test("handoff, resposta humana e status Meta do Capitão Mor sobrevivem ao reinício sem cruzar tenant", async () => {
  let generatedId = 0;
  const conversationRepository = new MemoryConversationRepository({
    environment: "test",
    idFactory: () => `capitao-operation-${++generatedId}`,
  });
  const firstConversationService = new ConversationService({
    repository: conversationRepository,
    clock: () => new Date("2026-09-03T12:00:00.000Z"),
  });
  const opened = await firstConversationService.openOrResume({
    empresaId: CAPITAO_ID,
    phone: "5511999999999",
    numeroWhatsappId: "numero-capitao-sintetico",
    correlationId: "correlation-capitao-human-1",
  });
  await firstConversationService.handoffToHuman({
    empresaId: CAPITAO_ID,
    conversationId: opened.conversation.id,
    operatorId: "operador-capitao-sintetico",
  });

  const restartedConversationService = new ConversationService({
    repository: conversationRepository,
    clock: () => new Date("2026-09-03T12:05:00.000Z"),
  });
  assert.deepEqual(
    await restartedConversationService.getConversation({
      empresaId: CAPITAO_ID,
      conversationId: opened.conversation.id,
    }).then(({ mode, operatorId }) => ({ mode, operatorId })),
    { mode: "human", operatorId: "operador-capitao-sintetico" },
  );

  const externalMessageId = "wamid.capitao.human.synthetic";
  const humanMessage = {
    id: "mensagem-humana-capitao-1",
    conversationId: opened.conversation.id,
    numeroWhatsappId: "numero-capitao-sintetico",
    text: "Resposta sintética do operador",
    status: "enfileirada",
    externalMessageId: null,
    correlationId: "correlation-capitao-human-1",
    recipientPhone: "5511999999999",
  };
  let activeStatusEvent = null;
  const operationalRepository = {
    async inboundMessage({ empresaId }) {
      assert.equal(empresaId, CAPITAO_ID);
      return {
        id: "mensagem-entrada-durante-handoff",
        conversationId: opened.conversation.id,
        contactId: opened.contact.id,
        numeroWhatsappId: "numero-capitao-sintetico",
        type: "text",
        text: "cardápio",
        mediaId: null,
        externalMessageId: "wamid.capitao.inbound.synthetic",
        correlationId: "correlation-capitao-human-1",
        senderPhone: "5511999999999",
      };
    },
    async outboundHumanMessage({ empresaId, messageId }) {
      assert.equal(empresaId, CAPITAO_ID);
      assert.equal(messageId, humanMessage.id);
      return structuredClone(humanMessage);
    },
    async markHumanMessageSent({ empresaId, messageId, externalMessageId: sentId }) {
      assert.equal(empresaId, CAPITAO_ID);
      assert.equal(messageId, humanMessage.id);
      humanMessage.externalMessageId = sentId;
      humanMessage.status = "enviada";
      await restartedConversationService.recordMessage({
        empresaId,
        conversationId: opened.conversation.id,
        direction: "outbound",
        type: "text",
        body: humanMessage.text,
        externalMessageId: sentId,
        status: "sent",
        origin: "operator",
        operatorId: "operador-capitao-sintetico",
        correlationId: humanMessage.correlationId,
      });
    },
    async statusEvent({ empresaId }) {
      assert.equal(empresaId, CAPITAO_ID);
      return structuredClone(activeStatusEvent);
    },
  };
  const metaCalls = [];
  const metaGateway = {
    async sendReply(context, payload) {
      metaCalls.push({ context: structuredClone(context), payload: structuredClone(payload) });
      return { messages: [{ id: externalMessageId }] };
    },
  };
  const firstWorker = workerHandlers({
    repository: operationalRepository,
    conversationService: restartedConversationService,
    metaGateway,
  });
  assert.deepEqual(await firstWorker.process_inbound_message({
    jobId: "job-inbound-handoff",
    empresaId: CAPITAO_ID,
    conversationId: opened.conversation.id,
    messageId: "mensagem-entrada-durante-handoff",
    type: "process_inbound_message",
    correlationId: "correlation-capitao-human-1",
    payloadVersion: 1,
  }), { skipped: true, reason: "conversation_not_in_bot_mode" });
  assert.equal(metaCalls.length, 0);

  const humanReference = {
    jobId: "job-human-capitao-1",
    empresaId: CAPITAO_ID,
    conversationId: opened.conversation.id,
    messageId: humanMessage.id,
    type: "send_human_message",
    correlationId: humanMessage.correlationId,
    payloadVersion: 1,
  };
  assert.deepEqual(await firstWorker.send_human_message(humanReference), { sent: true });
  assert.equal(metaCalls.length, 1);
  assert.deepEqual(metaCalls[0], {
    context: { empresaId: CAPITAO_ID, numeroWhatsappId: "numero-capitao-sintetico" },
    payload: { to: "5511999999999", text: humanMessage.text, buttons: [] },
  });

  const restartedWorker = workerHandlers({
    repository: operationalRepository,
    conversationService: restartedConversationService,
    metaGateway,
  });
  assert.deepEqual(await restartedWorker.send_human_message(humanReference), {
    sent: true,
    resumed: true,
  });
  assert.equal(metaCalls.length, 1);

  const other = await restartedConversationService.openOrResume({
    empresaId: OTHER_TENANT_ID,
    phone: "5511999999999",
    numeroWhatsappId: "numero-outro-tenant",
    correlationId: "correlation-other-1",
  });
  await restartedConversationService.recordMessage({
    empresaId: OTHER_TENANT_ID,
    conversationId: other.conversation.id,
    direction: "outbound",
    type: "text",
    body: "Mensagem isolada do outro tenant",
    externalMessageId,
    status: "sent",
    origin: "operator",
    correlationId: "correlation-other-1",
  });

  for (const [index, status] of ["delivered", "read", "failed"].entries()) {
    activeStatusEvent = {
      id: `status-capitao-${status}`,
      messageId: humanMessage.id,
      externalMessageId,
      status,
      occurredAt: new Date(`2026-09-03T12:1${index}:00.000Z`),
      errorCode: status === "failed" ? "SYNTHETIC_LATE_FAILURE" : null,
    };
    assert.deepEqual(await restartedWorker.apply_whatsapp_status({
      jobId: `job-status-capitao-${status}`,
      empresaId: CAPITAO_ID,
      statusEventId: activeStatusEvent.id,
      type: "apply_whatsapp_status",
      correlationId: "correlation-capitao-human-1",
      payloadVersion: 1,
    }), { applied: true, status });
  }

  const capitaoHistory = await restartedConversationService.getHistory({
    empresaId: CAPITAO_ID,
    conversationId: opened.conversation.id,
  });
  const otherHistory = await restartedConversationService.getHistory({
    empresaId: OTHER_TENANT_ID,
    conversationId: other.conversation.id,
  });
  assert.equal(capitaoHistory.at(-1).status, "read");
  assert.equal(capitaoHistory.at(-1).errorCode, null);
  assert.equal(otherHistory.at(-1).status, "sent");
  assert.doesNotMatch(JSON.stringify(otherHistory), /Resposta sintética do operador/u);
});
