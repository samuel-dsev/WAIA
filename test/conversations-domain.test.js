import test from "node:test";
import assert from "node:assert/strict";
import {
  ConversationService,
  MemoryConversationRepository,
} from "../src/modules/conversations/index.js";

function setup({ now = "2026-08-27T12:00:00.000Z" } = {}) {
  let id = 0;
  let current = new Date(now);
  const repository = new MemoryConversationRepository({
    environment: "test",
    idFactory: () => `id-${++id}`,
  });
  const service = new ConversationService({ repository, clock: () => new Date(current) });
  return {
    repository,
    service,
    setNow(value) {
      current = new Date(value);
    },
  };
}

async function open(service, empresaId, phone = "5511999999999", numeroWhatsappId = "number-1") {
  const result = await service.openOrResume({
    empresaId,
    phone,
    numeroWhatsappId,
    correlationId: `correlation-${empresaId}`,
  });
  return result.conversation;
}

async function record(service, conversation, overrides = {}) {
  return service.recordMessage({
    empresaId: conversation.empresaId,
    conversationId: conversation.id,
    direction: "inbound",
    type: "text",
    body: "mensagem",
    status: "received",
    correlationId: `correlation-${conversation.empresaId}`,
    ...overrides,
  });
}

test("mesmo telefone permanece isolado em duas empresas", async () => {
  const { service } = setup();
  const tenantA = await service.openOrResume({
    empresaId: "tenant-a",
    phone: "+55 (11) 99999-9999",
    numeroWhatsappId: "number-a",
    correlationId: "correlation-a",
  });
  const tenantB = await service.openOrResume({
    empresaId: "tenant-b",
    phone: "+55 (11) 99999-9999",
    numeroWhatsappId: "number-b",
    correlationId: "correlation-b",
  });

  assert.notEqual(tenantA.contact.id, tenantB.contact.id);
  assert.notEqual(tenantA.conversation.id, tenantB.conversation.id);
  assert.equal(tenantA.contact.phone, tenantB.contact.phone);

  await record(service, tenantA.conversation, { body: "segredo da empresa A" });
  await record(service, tenantB.conversation, { body: "conteúdo da empresa B" });
  assert.deepEqual((await service.getHistory({
    empresaId: "tenant-a",
    conversationId: tenantA.conversation.id,
  })).map(({ body }) => body), ["segredo da empresa A"]);
});

test("mensagens e estado sobrevivem à reinstanciação do serviço sobre repositório persistente", async () => {
  const { repository, service } = setup();
  const conversation = await open(service, "tenant-a");
  await record(service, conversation, { body: "primeira" });
  const state = await service.getState({ empresaId: "tenant-a", conversationId: conversation.id });
  await service.saveState({
    empresaId: "tenant-a",
    conversationId: conversation.id,
    expectedVersion: state.version,
    flowKey: "ticket_purchase",
    stage: "awaiting_receipt",
    data: { eventId: "event-1" },
  });

  const restarted = new ConversationService({
    repository,
    clock: () => new Date("2026-08-27T12:05:00.000Z"),
  });
  assert.equal((await restarted.getHistory({
    empresaId: "tenant-a",
    conversationId: conversation.id,
  }))[0].body, "primeira");
  const restoredState = await restarted.getState({
    empresaId: "tenant-a",
    conversationId: conversation.id,
  });
  assert.equal(restoredState.flowKey, "ticket_purchase");
  assert.equal(restoredState.stage, "awaiting_receipt");
  assert.deepEqual(restoredState.data, { eventId: "event-1" });
  assert.equal(restoredState.version, 2);
  await assert.rejects(
    restarted.saveState({
      empresaId: "tenant-a",
      conversationId: conversation.id,
      expectedVersion: 1,
      flowKey: "stale_flow",
      stage: "stale_stage",
    }),
    ({ code }) => code === "CONVERSATION_STATE_CONFLICT",
  );
});

test("sequência é crescente e histórico é limitado mantendo ordem cronológica", async () => {
  const { service, setNow } = setup();
  const conversation = await open(service, "tenant-a");
  const messages = [];
  for (let index = 1; index <= 5; index += 1) {
    setNow(`2026-08-27T12:0${index}:00.000Z`);
    messages.push(await record(service, conversation, { body: `message-${index}` }));
  }
  assert.deepEqual(messages.map(({ sequence }) => sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual((await service.getHistory({
    empresaId: "tenant-a",
    conversationId: conversation.id,
    limit: 3,
  })).map(({ body }) => body), ["message-3", "message-4", "message-5"]);
  assert.deepEqual((await service.getHistory({
    empresaId: "tenant-a",
    conversationId: conversation.id,
    limit: 2,
    beforeSequence: 4,
  })).map(({ sequence }) => sequence), [2, 3]);
});

test("status Meta avança sem regressão e é isolado por empresa", async () => {
  const { service } = setup();
  const tenantA = await open(service, "tenant-a", "5511999999999", "number-a");
  const tenantB = await open(service, "tenant-b", "5511999999999", "number-b");
  await record(service, tenantA, {
    direction: "outbound",
    status: "sent",
    externalMessageId: "wamid.shared",
    body: "resposta A",
  });
  await record(service, tenantB, {
    direction: "outbound",
    status: "sent",
    externalMessageId: "wamid.shared",
    body: "resposta B",
  });

  assert.equal((await service.applyMetaStatus({
    empresaId: "tenant-a",
    externalMessageId: "wamid.shared",
    status: "delivered",
    occurredAt: "2026-08-27T12:01:00.000Z",
  })).status, "delivered");
  const regression = await service.applyMetaStatus({
    empresaId: "tenant-a",
    externalMessageId: "wamid.shared",
    status: "sent",
    occurredAt: "2026-08-27T12:02:00.000Z",
  });
  assert.equal(regression.changed, false);
  assert.equal(regression.status, "delivered");
  await service.applyMetaStatus({
    empresaId: "tenant-a",
    externalMessageId: "wamid.shared",
    status: "read",
    occurredAt: "2026-08-27T12:03:00.000Z",
  });
  const lateFailure = await service.applyMetaStatus({
    empresaId: "tenant-a",
    externalMessageId: "wamid.shared",
    status: "failed",
    occurredAt: "2026-08-27T12:04:00.000Z",
    errorSanitized: "falha tardia",
  });
  assert.equal(lateFailure.status, "read");
  assert.equal(lateFailure.changed, false);
  assert.equal((await service.getHistory({
    empresaId: "tenant-b",
    conversationId: tenantB.id,
  }))[0].status, "sent");
});

test("IDs de outro tenant não contornam o escopo do serviço ou repositório", async () => {
  const { repository, service } = setup();
  const conversation = await open(service, "tenant-a");
  await assert.rejects(
    service.getConversation({ empresaId: "tenant-b", conversationId: conversation.id }),
    ({ code }) => code === "CONVERSATION_NOT_FOUND",
  );
  assert.equal(await repository.findConversation({
    empresaId: "tenant-b",
    conversationId: conversation.id,
  }), null);
  await assert.rejects(
    service.getHistory({ empresaId: "tenant-b", conversationId: conversation.id }),
    ({ code }) => code === "CONVERSATION_NOT_FOUND",
  );
  await assert.rejects(
    service.getConversation({ conversationId: conversation.id }),
    ({ code }) => code === "TENANT_REQUIRED",
  );
});

test("retenção anonimiza em batches somente conteúdo vencido da empresa selecionada", async () => {
  const { service, setNow } = setup({ now: "2026-01-01T00:00:00.000Z" });
  const tenantA = await open(service, "tenant-a", "5511999999999", "number-a");
  const tenantB = await open(service, "tenant-b", "5511999999999", "number-b");
  for (const [index, date] of [
    [1, "2026-01-01T00:00:00.000Z"],
    [2, "2026-01-02T00:00:00.000Z"],
    [3, "2026-01-03T00:00:00.000Z"],
  ]) {
    await record(service, tenantA, { body: `old-a-${index}`, createdAt: date });
  }
  await record(service, tenantB, { body: "old-b", createdAt: "2026-01-01T00:00:00.000Z" });
  await record(service, tenantA, { body: "recent-a", createdAt: "2026-08-20T00:00:00.000Z" });
  setNow("2026-08-27T00:00:00.000Z");

  assert.equal((await service.anonymizeExpired({
    empresaId: "tenant-a",
    retentionDays: 30,
    batchSize: 2,
  })).anonymized, 2);
  let tenantAHistory = await service.getHistory({
    empresaId: "tenant-a",
    conversationId: tenantA.id,
    limit: 10,
  });
  assert.deepEqual(tenantAHistory.map(({ body }) => body), [null, null, "old-a-3", "recent-a"]);
  assert.equal((await service.anonymizeExpired({
    empresaId: "tenant-a",
    retentionDays: 30,
    batchSize: 2,
  })).anonymized, 1);
  tenantAHistory = await service.getHistory({
    empresaId: "tenant-a",
    conversationId: tenantA.id,
    limit: 10,
  });
  assert.equal(tenantAHistory.at(-1).body, "recent-a");
  assert.equal((await service.getHistory({
    empresaId: "tenant-b",
    conversationId: tenantB.id,
  }))[0].body, "old-b");
});

test("handoff, pausa e retomada do bot persistem operador e modo", async () => {
  const { service } = setup();
  const conversation = await open(service, "tenant-a");
  assert.equal((await service.handoffToHuman({
    empresaId: "tenant-a",
    conversationId: conversation.id,
    operatorId: "operator-1",
  })).mode, "human");
  assert.equal((await service.pauseBot({
    empresaId: "tenant-a",
    conversationId: conversation.id,
    operatorId: "operator-1",
  })).mode, "paused");
  const resumed = await service.resumeBot({ empresaId: "tenant-a", conversationId: conversation.id });
  assert.equal(resumed.mode, "bot");
  assert.equal(resumed.operatorId, null);
});

test("adaptador em memória falha fechado fora de desenvolvimento e testes", () => {
  assert.throws(
    () => new MemoryConversationRepository({ environment: "production" }),
    /apenas em development ou test/u,
  );
});
