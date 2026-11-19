import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createMetaGateway } from "../src/integrations/meta/meta-gateway.js";
import { createYCloudWebhookService } from "../src/modules/meta/ycloud-webhook-service.js";
import { normalizeYCloudMediaReference } from "../src/integrations/ycloud/media-reference.js";
import { ycloudMediaReference } from "./support/ycloud-media-fixtures.js";

const bytes = Buffer.from("synthetic private image");
const reference = ycloudMediaReference({ data: bytes });
function gateway(fetchImpl, wabaId = "waba-a") {
  return createMetaGateway({ fetchImpl, logger: { warn() {} }, credentialResolver: {
    async resolveMeta(scope) { assert.equal(scope.empresaId, "tenant-a"); return { provider: "ycloud", accessToken: "synthetic-key", phoneNumberId: "number-a", wabaId }; },
  } });
}
const scope = { empresaId: "tenant-a", numeroWhatsappId: "number-a" };

test("YCloud: imagem autenticada preserva referência privada sem trocar a identidade do webhook", async () => {
  const now = Date.now(), events = [];
  const service = createYCloudWebhookService({ clock: () => now,
    connectionResolver: { async resolveByWebhookPublicId() { return { id: "connection", empresaId: "tenant-a", mode: "ycloud", state: "active", appSecretCredentialId: "sign",
      numbers: [{ id: "number-a", phoneNumberId: "phone-a", wabaId: "waba-a", numeroE164: "+5511999990001", status: "ativo" }] }; } },
    credentialVault: { async getCredentialForUse() { return "synthetic-signing"; } },
    repository: { async recordValidWebhook() {} }, ingestionService: { async ingestEvents(value) { events.push(...value); } },
  });
  const payload = { id: "event-image", apiVersion: "v2", type: "whatsapp.inbound_message.received", whatsappInboundMessage: {
    id: "ycloud-inbound", wamid: "wamid.actual", wabaId: "waba-a", to: "+5511999990001", from: "+5511999990002", sendTime: new Date(now).toISOString(),
    type: "image", image: { id: reference.mediaId, link: reference.url, mime_type: reference.mimeType, sha256: reference.sha256, caption: "Meu carro" },
  } };
  const send = async () => { const rawBody = Buffer.from(JSON.stringify(payload)), time = Math.floor(now / 1000);
    return service.ingest({ webhookPublicId: "synthetic-public-id", rawBody,
      signature: `t=${time},s=${createHmac("sha256", "synthetic-signing").update(`${time}.`).update(rawBody).digest("hex")}` }); };
  await send();
  assert.equal(events[0].externalMessageId, "wamid.actual"); assert.equal(events[0].text, "Meu carro");
  assert.deepEqual(events[0].media.providerReference, reference);
  payload.whatsappInboundMessage.image.link = reference.url.replace("api.ycloud.com", "example.test");
  await assert.rejects(send(), { statusCode: 400, code: "YCLOUD_PAYLOAD_INVALID" });
  assert.equal(events.length, 1);
});

test("YCloud: download usa chave da conexão no host do provedor e confere MIME, bytes e hash", async () => {
  let calls = 0;
  const client = gateway(async (url, options) => {
    calls++; assert.equal(url, reference.url); assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { "X-API-Key": "synthetic-key" });
    return new Response(bytes, { headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) } });
  });
  const result = await client.downloadMedia(scope, { mediaId: reference.mediaId, providerMedia: reference, maxBytes: 1024 });
  assert.equal(calls, 1); assert.deepEqual(result.data, bytes); assert.equal(result.mimeType, "image/png");
  assert.equal(result.sizeBytes, bytes.length);
});

test("YCloud: referência ausente, outra WABA/id, URL externa e payload divergente não recebem credencial", async () => {
  const client = gateway(async () => assert.fail("Não buscar uma referência recusada"));
  await assert.rejects(client.downloadMedia(scope, { mediaId: reference.mediaId }), { code: "YCLOUD_MEDIA_REFERENCE_MISSING" });
  await assert.rejects(client.downloadMedia(scope, { mediaId: "different", providerMedia: reference }), { code: "YCLOUD_MEDIA_REFERENCE_INVALID" });
  await assert.rejects(gateway(async () => assert.fail(), "waba-b").downloadMedia(scope, { mediaId: reference.mediaId, providerMedia: reference }), { code: "YCLOUD_MEDIA_REFERENCE_INVALID" });
  for (const url of [reference.url.replace("https:", "http:"), reference.url.replace("api.ycloud.com", "api.ycloud.com.evil.test"),
    reference.url.replace("api.ycloud.com", "user@api.ycloud.com"), reference.url.replace("api.ycloud.com", "api.ycloud.com:444"),
    reference.url + "#fragment", reference.url.replace("/photo-1?", "/different?")]) {
    await assert.rejects(client.downloadMedia(scope, { mediaId: reference.mediaId, providerMedia: { ...reference, url } }), { code: "YCLOUD_MEDIA_REFERENCE_INVALID" });
  }
  assert.throws(() => normalizeYCloudMediaReference({ ...reference, wabaId: "waba-b" }), { code: "YCLOUD_MEDIA_REFERENCE_INVALID" });
});

test("YCloud: limites, MIME divergente, corrupção, redirecionamento e erro HTTP não viram imagens armazenadas", async () => {
  for (const [response, maxBytes, code] of [
    [new Response(bytes, { headers: { "Content-Type": "image/png", "Content-Length": "2048" } }), 1024, "META_MEDIA_TOO_LARGE"],
    [new Response(bytes, { headers: { "Content-Type": "image/png" } }), 1, "META_MEDIA_TOO_LARGE"],
    [new Response(bytes, { headers: { "Content-Type": "text/html" } }), 1024, "META_MEDIA_MIME_MISMATCH"],
    [new Response("corrupted", { headers: { "Content-Type": "image/png" } }), 1024, "MEDIA_INTEGRITY_FAILED"],
    [new Response(null, { status: 302, headers: { Location: "https://example.test" } }), 1024, "META_MEDIA_DOWNLOAD_FAILED"],
    [new Response(null, { status: 404 }), 1024, "META_MEDIA_DOWNLOAD_FAILED"],
  ]) await assert.rejects(gateway(async () => response).downloadMedia(scope, { mediaId: reference.mediaId, providerMedia: reference, maxBytes }), { code });
  await assert.rejects(gateway(async () => { throw Error(reference.url + " synthetic-key"); }).downloadMedia(scope, { mediaId: reference.mediaId, providerMedia: reference }), error =>
    error.code === "META_MEDIA_UNAVAILABLE" && !error.message.includes("synthetic-key") && !error.message.includes("payload="));
});
