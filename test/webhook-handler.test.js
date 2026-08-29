import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createWebhookHandler } from "../src/modules/webhook/handler.js";
import { createMetaSignatureVerifier } from "../src/modules/webhook/signature.js";

const secret = "segredo-de-teste";

function signedRequest(payload) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return {
    rawBody,
    body: payload,
    headers: {
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
    },
    correlationId: "correlation-handler",
  };
}

function fakeResponse() {
  return {
    statusCode: null,
    sendStatus(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
  };
}

function payload() {
  return { entry: [{ changes: [{ field: "messages", value: {
    metadata: { phone_number_id: "phone-a" },
    messages: [{
      id: "wamid.a",
      from: "551100000001",
      timestamp: "1787800000",
      type: "text",
      text: { body: "Olá" },
    }],
  } }] }] };
}

test("ACK 200 ocorre após ingestão durável e não executa negócio", async () => {
  const calls = [];
  let businessCalled = false;
  const handler = createWebhookHandler({
    signatureVerifier: createMetaSignatureVerifier({ appSecret: secret }),
    ingestionService: {
      async ingestEvents(events, context) {
        calls.push({ events, context });
      },
    },
    logger: { warn() {}, error() {} },
  });
  const response = fakeResponse();
  const startedAt = performance.now();
  await handler(signedRequest(payload()), response);
  const elapsed = performance.now() - startedAt;
  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].events[0].phoneNumberId, "phone-a");
  assert.equal(businessCalled, false);
  assert.ok(elapsed < 100, `ACK levou ${elapsed}ms com fakes locais`);
});

test("não envia ACK antes de a transação de ingestão concluir", async () => {
  let releasePersistence;
  const persistence = new Promise((resolve) => { releasePersistence = resolve; });
  const handler = createWebhookHandler({
    signatureVerifier: createMetaSignatureVerifier({ appSecret: secret }),
    ingestionService: { async ingestEvents() { await persistence; } },
    logger: { warn() {}, error() {} },
  });
  const response = fakeResponse();
  const pendingHandler = handler(signedRequest(payload()), response);
  await Promise.resolve();
  assert.equal(response.statusCode, null);
  releasePersistence();
  await pendingHandler;
  assert.equal(response.statusCode, 200);
});

test("não confirma recebimento quando a persistência falha", async () => {
  const handler = createWebhookHandler({
    signatureVerifier: createMetaSignatureVerifier({ appSecret: secret }),
    ingestionService: {
      async ingestEvents() {
        throw Object.assign(new Error("banco indisponível"), { code: "DB_UNAVAILABLE" });
      },
    },
    logger: { warn() {}, error() {} },
  });
  const response = fakeResponse();
  await handler(signedRequest(payload()), response);
  assert.equal(response.statusCode, 503);
});

test("rejeita assinatura inválida antes do parsing e da ingestão", async () => {
  let ingested = false;
  const handler = createWebhookHandler({
    signatureVerifier: createMetaSignatureVerifier({ appSecret: secret }),
    ingestionService: { async ingestEvents() { ingested = true; } },
    parser() { throw new Error("parser não deveria ser executado"); },
    logger: { warn() {}, error() {} },
  });
  const request = signedRequest(payload());
  request.headers["x-hub-signature-256"] = `sha256=${"0".repeat(64)}`;
  const response = fakeResponse();
  await handler(request, response);
  assert.equal(response.statusCode, 401);
  assert.equal(ingested, false);
});

test("payload estruturalmente inválido retorna 400 sem expor erro", async () => {
  const request = signedRequest({ entry: {} });
  const response = fakeResponse();
  const handler = createWebhookHandler({
    signatureVerifier: createMetaSignatureVerifier({ appSecret: secret }),
    ingestionService: { async ingestEvents() { throw new Error("não deveria persistir"); } },
    logger: { warn() {}, error() {} },
  });
  await handler(request, response);
  assert.equal(response.statusCode, 400);
});
