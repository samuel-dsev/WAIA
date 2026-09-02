import assert from "node:assert/strict";
import test from "node:test";
import {
  MetaMultiAppWebhookError,
  createMetaMultiAppIngestionHandler,
  createMetaMultiAppVerificationHandler,
} from "../src/modules/meta/index.js";

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    sendStatus(code) { this.statusCode = code; return this; },
  };
}

test("handlers dinâmicos encaminham identificador, bytes brutos e assinatura", async () => {
  const calls = [];
  const service = {
    async verifySubscription(input) { calls.push(["get", input]); return "challenge-a"; },
    async ingest(input) { calls.push(["post", input]); },
  };
  const get = createMetaMultiAppVerificationHandler({ service });
  const post = createMetaMultiAppIngestionHandler({ service });
  const getResponse = response();
  await get({
    params: { webhookPublicId: "public-a" },
    query: { "hub.mode": "subscribe", "hub.verify_token": "verify-a", "hub.challenge": "challenge-a" },
    context: { correlationId: "correlation-a" },
  }, getResponse);
  assert.equal(getResponse.statusCode, 200);
  assert.equal(getResponse.body, "challenge-a");

  const body = Buffer.from('{"entry":[]}');
  const postResponse = response();
  await post({
    params: { webhookPublicId: "public-a" }, rawBody: body,
    headers: { "x-hub-signature-256": "sha256=synthetic" },
    context: { correlationId: "correlation-a" },
  }, postResponse);
  assert.equal(postResponse.statusCode, 200);
  assert.equal(calls[1][1].rawBody, body);
  assert.equal(calls[1][1].signature, "sha256=synthetic");
});

test("handlers retornam somente status público do serviço", async () => {
  const service = {
    async verifySubscription() { throw new MetaMultiAppWebhookError("META_WEBHOOK_VERIFICATION_FAILED"); },
    async ingest() { throw new Error("segredo interno"); },
  };
  const getResponse = response();
  await createMetaMultiAppVerificationHandler({ service })({ params: {}, query: {} }, getResponse);
  assert.equal(getResponse.statusCode, 403);
  const postResponse = response();
  await createMetaMultiAppIngestionHandler({ service })({ params: {}, headers: {} }, postResponse);
  assert.equal(postResponse.statusCode, 503);
  assert.equal(postResponse.body, null);
});
