import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createApiApp } from "../src/bootstrap/app-runtime.js";

function runtime(calls) {
  return {
    pool: { connect() {} },
    logger: { info() {}, warn() {}, error() {} },
    health: { live: () => ({ status: "ok" }), ready: async () => ({ status: "ready" }) },
    authService: {
      async authenticate() { throw Object.assign(new Error("auth"), { status: 401 }); },
      verifyCsrf() { return false; },
    },
    adminService: { session() { return {}; } },
    metaWebhookService: {
      async verifySubscription(input) { calls.push(["verify", input]); return input.challenge; },
      async ingest(input) { calls.push(["ingest", { ...input, rawBody: input.rawBody.toString("utf8") }]); },
    },
  };
}

async function withServer(app, callback) {
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("bootstrap expõe callback Meta dinâmico e preserva webhook legado", async () => {
  const calls = [];
  const app = createApiApp({
    runtime: runtime(calls),
    config: {
      environment: "test",
      whatsapp: { verifyToken: "legacy-verify", appSecret: "", apiVersion: "v99.0" },
      security: { cookieSecure: false, sessionTtlHours: 12 },
    },
  });
  await withServer(app, async (url) => {
    const verification = await fetch(`${url}/webhook/meta/00000000-0000-4000-8000-0000000000a1?hub.mode=subscribe&hub.verify_token=verify-a&hub.challenge=challenge-a`);
    assert.equal(verification.status, 200);
    assert.equal(await verification.text(), "challenge-a");

    const document = '{"entry":[]}';
    const ingestion = await fetch(`${url}/webhook/meta/00000000-0000-4000-8000-0000000000a1`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${"a".repeat(64)}` },
      body: document,
    });
    assert.equal(ingestion.status, 200);
    assert.equal(calls[1][1].rawBody, document);

    const malformed = await fetch(`${url}/webhook/meta/00000000-0000-4000-8000-0000000000a1`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${"a".repeat(64)}` },
      body: "{invalid",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), {
      error: "INVALID_JSON",
      message: "O corpo da solicitacao deve conter JSON valido.",
    });

    const legacy = await fetch(`${url}/webhook?hub.mode=subscribe&hub.verify_token=legacy-verify&hub.challenge=legacy-challenge`);
    assert.equal(legacy.status, 200);
    assert.equal(await legacy.text(), "legacy-challenge");
  });
});

test("bootstrap YCloud encaminha assinatura e bytes brutos por callback separado", async () => {
  const calls = [];
  const rt = runtime(calls);
  rt.ycloudWebhookService = { async ingest(input) { calls.push(input); } };
  const app = createApiApp({ runtime: rt, config: {
    environment: "test", whatsapp: { verifyToken: "test", appSecret: "" }, security: { cookieSecure: false },
  } });
  await withServer(app, async (url) => {
    const document = '{ "id":"evt_test", "apiVersion":"v2" }';
    const response = await fetch(`${url}/webhook/ycloud/00000000-0000-4000-8000-0000000000a1`, {
      method: "POST", headers: { "content-type": "application/json", "ycloud-signature": "synthetic-signature" }, body: document,
    });
    assert.equal(response.status, 200);
    assert.equal(calls[0].signature, "synthetic-signature");
    assert.equal(calls[0].rawBody.toString("utf8"), document);
    assert.equal(calls[0].webhookPublicId, "00000000-0000-4000-8000-0000000000a1");
  });
});
