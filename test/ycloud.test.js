import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createYCloudClient } from "../src/integrations/ycloud/client.js";
import { createMetaGateway } from "../src/integrations/meta/meta-gateway.js";
import { createYCloudWebhookService, createYCloudWebhookHandler } from "../src/modules/meta/ycloud-webhook-service.js";
import { MetaHealthService } from "../src/modules/meta/meta-health-service.js";

const NOW = Date.parse("2026-10-07T15:00:00Z");
const PUBLIC_ID = "10000000-0000-4000-8000-000000000001";
const BUSINESS = "+5511999990001";
const VISITOR = "+5511999990002";
const SECRET = "synthetic-signing-secret";
function envelope(overrides = {}) {
  return { id: "evt_synthetic", apiVersion: "v2", createTime: new Date(NOW).toISOString(),
    type: "whatsapp.inbound_message.received", whatsappInboundMessage: {
      id: "inbound-synthetic", wabaId: "waba-a", from: VISITOR, to: BUSINESS,
      sendTime: new Date(NOW).toISOString(), type: "text", text: { body: "Horário de atendimento?" },
    }, ...overrides };
}
function signed(payload, timestamp = NOW / 1000, secret = SECRET) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return { webhookPublicId: PUBLIC_ID, rawBody, signature: `t=${timestamp},s=${digest}` };
}
function fixture() {
  const events = [], vaultCalls = [], records = [];
  const connection = { id: "app-a", empresaId: "tenant-a", mode: "ycloud", state: "active", appSecretCredentialId: "sign-a",
    numbers: [{ id: "number-a", phoneNumberId: "phone-a", wabaId: "waba-a", numeroE164: BUSINESS, status: "ativo" }] };
  const service = createYCloudWebhookService({
    connectionResolver: { resolveByWebhookPublicId: async () => connection },
    credentialVault: { getCredentialForUse: async (input) => { vaultCalls.push(input); return SECRET; } },
    ingestionService: { ingestEvents: async (input) => events.push(...input) },
    repository: { recordValidWebhook: async (input) => records.push(input) }, clock: () => NOW,
  });
  return { service, events, vaultCalls, records, connection };
}
test("YCloud autentica bytes brutos e normaliza entrada para a fila existente", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.ingest(signed(envelope())), { accepted: true, eventCount: 1 });
  assert.equal(f.events[0].phoneNumberId, "phone-a");
  assert.equal(f.events[0].externalMessageId, "inbound-synthetic");
  assert.equal(f.events[0].text, "Horário de atendimento?");
  assert.equal(f.events[0].senderPhone, VISITOR.slice(1));
  assert.deepEqual(f.vaultCalls, [{ empresaId: "tenant-a", credentialId: "sign-a" }]);
  assert.deepEqual(f.records, [{ empresaId: "tenant-a", appId: "app-a" }]);
});
test("YCloud recusa replay, assinatura de outra conta e corpo alterado", async () => {
  for (const input of [signed(envelope(), NOW / 1000 - 301), signed(envelope(), NOW / 1000 + 301),
    signed(envelope(), NOW / 1000, "other-secret"), { ...signed(envelope()), rawBody: Buffer.from("{}") }]) {
    const f = fixture();
    await assert.rejects(f.service.ingest(input), { statusCode: 401 });
    assert.equal(f.events.length, 0);
  }
});
test("YCloud recusa outro número/WABA e conexão Meta, inativa ou revogada", async () => {
  for (const changes of [{ to: "+5511999990003" }, { wabaId: "waba-b" }]) {
    const f = fixture(), payload = envelope(); Object.assign(payload.whatsappInboundMessage, changes);
    await assert.rejects(f.service.ingest(signed(payload)), { statusCode: 403 });
    assert.equal(f.events.length, 0);
  }
  for (const changes of [{ mode: "own" }, { state: "inactive" }, { state: "revoked" }]) {
    const f = fixture(); Object.assign(f.connection, changes);
    await assert.rejects(f.service.ingest(signed(envelope())), { statusCode: 404 });
    assert.equal(f.vaultCalls.length, 0);
  }
});
test("YCloud não envia eco, histórico ou grupos para IA", async () => {
  for (const type of ["whatsapp.smb.message_echoes", "whatsapp.history", "contact.created"]) {
    const f = fixture(); await f.service.ingest(signed(envelope({ type })));
    assert.equal(f.events.length, 0);
  }
  const f = fixture(), payload = envelope(); payload.whatsappInboundMessage.groupId = "synthetic-group";
  await f.service.ingest(signed(payload)); assert.equal(f.events.length, 0);
});
test("YCloud status preserva wamid e rejeita JSON inválido e mensagem sem identidade", async () => {
  const f = fixture();
  await f.service.ingest(signed(envelope({ type: "whatsapp.message.updated", whatsappMessage: {
    wamid: "wamid.synthetic", wabaId: "waba-a", from: BUSINESS, to: VISITOR, status: "delivered",
  } })));
  assert.equal(f.events[0].kind, "status"); assert.equal(f.events[0].externalMessageId, "wamid.synthetic");
  const payload = envelope(); delete payload.whatsappInboundMessage.id;
  await assert.rejects(f.service.ingest(signed(payload)), { statusCode: 400 });
});
test("YCloud gateway envia texto/botões e leitura com chaves resolvidas por empresa", async () => {
  const calls = [];
  const gateway = createMetaGateway({
    credentialResolver: { resolveMeta: async ({ empresaId }) => ({ provider: "ycloud", accessToken: `key-${empresaId}`,
      phoneNumberId: `phone-${empresaId}`, phoneNumber: empresaId === "a" ? BUSINESS : "+5511999990003", wabaId: `waba-${empresaId}` }) },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ wamid: "wamid.sent" }) }; },
  });
  for (const empresaId of ["a", "b"]) {
    const result = await gateway.sendReply({ empresaId, numeroWhatsappId: "number" }, { to: VISITOR, text: "Olá", buttons: [{ id: "faq", title: "Dúvidas" }] });
    assert.equal(result.messages[0].id, "wamid.sent");
  }
  assert.equal(calls[0].options.headers["X-API-Key"], "key-a");
  assert.equal(calls[1].options.headers["X-API-Key"], "key-b");
  assert.equal(JSON.parse(calls[0].options.body).from, BUSINESS);
  assert.equal(JSON.parse(calls[1].options.body).from, "+5511999990003");
  assert.equal(JSON.parse(calls[0].options.body).interactive.type, "button");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  await gateway.markRead({ empresaId: "a", numeroWhatsappId: "number" }, { messageId: "wamid.inbound" });
  assert.match(calls[2].url, /inboundMessages\/wamid.inbound\/markAsRead$/u);
});
test("YCloud erros sanitizados e resposta de envio sem wamid não provocam retry cego", async () => {
  const credentials = { accessToken: "secret-not-in-error", phoneNumber: BUSINESS };
  const client = createYCloudClient({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ secret: credentials.accessToken }) }) });
  await assert.rejects(client.sendReply(credentials, { to: VISITOR, text: "Olá" }), (error) => error.code === "YCLOUD_REQUEST_FAILED" && !error.retryable && !JSON.stringify(error).includes(credentials.accessToken));
  const missing = createYCloudClient({ fetchImpl: async () => ({ ok: true, json: async () => ({ id: "queued" }) }) });
  await assert.rejects(missing.sendReply(credentials, { to: VISITOR, text: "Olá" }), { code: "YCLOUD_SEND_RESPONSE_INVALID", retryable: false });
});
test("YCloud preflight valida número/WABA/estado sem enviar mensagens", async () => {
  const client = createYCloudClient({ fetchImpl: async (url, options) => {
    assert.equal(options.method, "GET"); assert.match(url, /phoneNumbers/u);
    return { ok: true, json: async () => ({ id: "phone-a", wabaId: "waba-a", phoneNumber: BUSINESS, status: "CONNECTED" }) };
  } });
  const input = { appId: "company-a", wabaId: "waba-a", phoneNumberId: "phone-a", phoneNumber: BUSINESS, accessToken: "synthetic-api-key" };
  assert.equal((await client.checkConnection(input)).tokenValid, true);
  await assert.rejects(client.checkConnection({ ...input, phoneNumberId: "phone-b" }), { code: "YCLOUD_CONNECTION_MISMATCH" });
});
test("preflight YCloud usa seu cliente e dispensa verify token da Meta", async () => {
  const recorded = [];
  const service = new MetaHealthService({
    repository: { findAppById: async () => ({ id: "app", empresaId: "tenant", mode: "ycloud", state: "pending", appId: "company", webhookPublicId: PUBLIC_ID, appSecretCredentialId: "secret", revision: 1 }),
      findNumberBinding: async () => ({ id: "number", empresaId: "tenant", status: "ativo", phoneNumberId: "phone", wabaId: "waba", numeroE164: BUSINESS, metaAppId: "app", accessTokenCredentialId: "key" }),
      recordHealthCheck: async (input) => recorded.push(input) },
    credentialVault: { getCredentialMetadata: async () => ({ status: "active", configured: true }), getCredentialForUse: async () => "synthetic-key" },
    client: { checkConnection: () => assert.fail("Não deve chamar Graph") },
    ycloudClient: { checkConnection: async (input) => { assert.equal(input.phoneNumber, BUSINESS); return { ...input, tokenValid: true }; } },
  });
  const result = await service.run({ empresaId: "tenant", appId: "app", numberId: "number" });
  assert.equal(result.success, true); assert.equal(recorded[0].state, "active");
});
test("handler YCloud só confirma após persistência e não expõe erros", async () => {
  let done = false, status;
  const handler = createYCloudWebhookHandler({ service: { ingest: async () => { done = true; } } });
  await handler({ params: { webhookPublicId: PUBLIC_ID }, rawBody: Buffer.from("{}"), get: () => "signature" }, { sendStatus: (code) => { assert.ok(done); status = code; } });
  assert.equal(status, 200);
  await createYCloudWebhookHandler({ service: { ingest: async () => { throw new Error("secret"); } } })({ params: {}, get: () => null }, { sendStatus: (code) => { status = code; } });
  assert.equal(status, 503);
});
