import test from "node:test";
import assert from "node:assert/strict";
import { createWebhookIngestionService } from "../src/modules/webhook/ingestion-service.js";

function message(phoneNumberId, externalMessageId) {
  return {
    kind: "message",
    phoneNumberId,
    externalMessageId,
    idempotencyKey: externalMessageId,
  };
}

function status(phoneNumberId, externalMessageId) {
  return {
    kind: "status",
    phoneNumberId,
    externalMessageId,
    idempotencyKey: `${externalMessageId}:delivered:1`,
    status: "delivered",
  };
}

function dependencies({ tenants, duplicateIds = new Set(), failTransaction = false } = {}) {
  const inserted = [];
  const statusEvents = [];
  const jobs = [];
  const resolutions = [];
  const repository = {
    async withTenantTransaction(tenant, callback) {
      if (failTransaction) throw Object.assign(new Error("banco indisponível"), { code: "DB_UNAVAILABLE" });
      return callback({ empresaId: tenant.empresaId });
    },
    async insertInboundMessage(_transaction, input) {
      if (duplicateIds.has(input.event.externalMessageId)) {
        return { inserted: false, messageId: `existing-${input.event.externalMessageId}` };
      }
      inserted.push(input);
      return {
        inserted: true,
        messageId: `message-${input.event.externalMessageId}`,
        conversationId: `conversation-${input.empresaId}`,
      };
    },
    async insertStatusEvent(_transaction, input) {
      statusEvents.push(input);
      return { inserted: true, statusEventId: "status-1", messageId: "outbound-1" };
    },
  };
  const service = createWebhookIngestionService({
    tenantResolver: {
      async resolveByPhoneNumberId(phoneNumberId) {
        resolutions.push(phoneNumberId);
        return tenants?.[phoneNumberId] ?? null;
      },
    },
    repository,
    outbox: { async add(_transaction, job) { jobs.push(job); } },
    logger: { warn() {}, info() {} },
  });
  return { service, inserted, statusEvents, jobs, resolutions };
}

test("resolve e persiste duas empresas pelo phone_number_id correto", async () => {
  const setup = dependencies({ tenants: {
    "phone-a": { empresaId: "tenant-a", numeroWhatsappId: "number-a", status: "active" },
    "phone-b": { empresaId: "tenant-b", numeroWhatsappId: "number-b", status: "active" },
  } });
  const results = await setup.service.ingestEvents([
    message("phone-a", "wamid.a"),
    message("phone-b", "wamid.b"),
  ], { correlationId: "correlation-1" });

  assert.deepEqual(results.map(({ outcome, empresaId }) => [outcome, empresaId]), [
    ["accepted", "tenant-a"],
    ["accepted", "tenant-b"],
  ]);
  assert.deepEqual(setup.inserted.map(({ empresaId }) => empresaId), ["tenant-a", "tenant-b"]);
  assert.deepEqual(setup.jobs.map(({ empresaId, type }) => [empresaId, type]), [
    ["tenant-a", "process_inbound_message"],
    ["tenant-b", "process_inbound_message"],
  ]);
  assert.equal("event" in setup.jobs[0], false);
});

test("número desconhecido e empresa suspensa não persistem nem enfileiram", async () => {
  const setup = dependencies({ tenants: {
    suspended: { empresaId: "tenant-s", numeroWhatsappId: "number-s", status: "suspended" },
  } });
  const results = await setup.service.ingestEvents([
    message("unknown", "wamid.unknown"),
    message("suspended", "wamid.suspended"),
  ], { correlationId: "correlation-2" });
  assert.deepEqual(results.map(({ outcome }) => outcome), ["unknown_number", "inactive_tenant"]);
  assert.equal(setup.inserted.length, 0);
  assert.equal(setup.jobs.length, 0);
  assert.deepEqual(setup.resolutions, ["unknown", "suspended"]);
});

test("mensagem duplicada não cria segundo job", async () => {
  const setup = dependencies({
    tenants: { phone: { empresaId: "tenant", numeroWhatsappId: "number", status: "active" } },
    duplicateIds: new Set(["wamid.duplicate"]),
  });
  const [result] = await setup.service.ingestEvents([
    message("phone", "wamid.duplicate"),
  ], { correlationId: "correlation-3" });
  assert.equal(result.outcome, "duplicate");
  assert.equal(setup.jobs.length, 0);
});

test("status é persistido e gera somente referência no outbox", async () => {
  const setup = dependencies({
    tenants: { phone: { empresaId: "tenant", numeroWhatsappId: "number", status: "active" } },
  });
  const [result] = await setup.service.ingestEvents([
    status("phone", "wamid.outbound"),
  ], { correlationId: "correlation-4" });
  assert.equal(result.outcome, "accepted");
  assert.equal(setup.statusEvents.length, 1);
  assert.deepEqual(setup.jobs[0], {
    type: "apply_whatsapp_status",
    payloadVersion: 1,
    empresaId: "tenant",
    messageId: "outbound-1",
    statusEventId: "status-1",
    correlationId: "correlation-4",
  });
});
