import { createHmac, timingSafeEqual } from "node:crypto";
import { parseWhatsAppWebhook } from "../whatsapp/parser.js";

export class YCloudWebhookError extends Error {
  constructor(statusCode, code) {
    super("Webhook YCloud recusado.");
    this.statusCode = statusCode;
    this.code = code;
  }
}
function reject(statusCode, code) { throw new YCloudWebhookError(statusCode, code); }
function e164(value) {
  const number = String(value || "").replace(/^\+/u, "");
  return /^[1-9]\d{7,14}$/u.test(number) ? `+${number}` : null;
}
function providerTimestamp(value) {
  if (typeof value !== "string") reject(400, "YCLOUD_PAYLOAD_INVALID");
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) reject(400, "YCLOUD_PAYLOAD_INVALID");
  return String(Math.floor(millis / 1000));
}

export function createYCloudWebhookService({ connectionResolver, credentialVault, ingestionService, repository, clock = () => Date.now() }) {
  async function ingest({ webhookPublicId, rawBody, signature, correlationId }) {
    if (typeof webhookPublicId !== "string" || !/^[A-Za-z0-9_-]{16,200}$/u.test(webhookPublicId)) reject(404, "YCLOUD_CONNECTION_NOT_FOUND");
    const connection = await connectionResolver.resolveByWebhookPublicId(webhookPublicId);
    if (!connection || connection.mode !== "ycloud" || connection.state !== "active") reject(404, "YCLOUD_CONNECTION_NOT_FOUND");
    if (!Buffer.isBuffer(rawBody) || rawBody.length > 1024 * 1024) reject(400, "YCLOUD_PAYLOAD_INVALID");
    const match = /^t=(\d{10,12}),s=([a-f0-9]{64})$/iu.exec(String(signature || ""));
    if (!match || Math.abs(clock() / 1000 - Number(match[1])) > 300) reject(401, "YCLOUD_SIGNATURE_INVALID");
    const secret = await credentialVault.getCredentialForUse({ empresaId: connection.empresaId, credentialId: connection.appSecretCredentialId });
    if (!(typeof secret === "string" && secret.length) && !(Buffer.isBuffer(secret) && secret.length)) reject(503, "YCLOUD_SECRET_UNAVAILABLE");
    const expected = createHmac("sha256", secret).update(`${match[1]}.`).update(rawBody).digest();
    if (!timingSafeEqual(expected, Buffer.from(match[2], "hex"))) reject(401, "YCLOUD_SIGNATURE_INVALID");
    let payload;
    try { payload = JSON.parse(rawBody.toString("utf8")); } catch { reject(400, "YCLOUD_PAYLOAD_INVALID"); }
    if (!payload || payload.apiVersion !== "v2" || typeof payload.id !== "string" || !payload.id || payload.id.length > 128) reject(400, "YCLOUD_PAYLOAD_INVALID");
    // History, phone-app echoes and administrative events never enter the AI queue.
    if (!["whatsapp.inbound_message.received", "whatsapp.message.updated"].includes(payload.type)) return { accepted: true, eventCount: 0 };
    const inbound = payload.type === "whatsapp.inbound_message.received";
    const message = inbound ? payload.whatsappInboundMessage : payload.whatsappMessage;
    if (!message || typeof message !== "object") reject(400, "YCLOUD_PAYLOAD_INVALID");
    const businessPhone = e164(inbound ? message.to : message.from);
    const number = connection.numbers?.find((item) => ["ativo", "active"].includes(item.status)
      && businessPhone && e164(item.numeroE164) === businessPhone && String(item.wabaId) === String(message.wabaId));
    if (!number) reject(403, "YCLOUD_CONNECTION_MISMATCH");
    let value;
    if (inbound) {
      if (message.groupId) return { accepted: true, eventCount: 0 };
      const timestamp = providerTimestamp(message.sendTime);
      value = { messages: [{ ...message, id: message.wamid || message.id, from: e164(message.from)?.slice(1), timestamp }] };
    } else {
      if (!["sent", "delivered", "read", "failed"].includes(message.status)) return { accepted: true, eventCount: 0 };
      value = { statuses: [{ id: message.wamid, recipient_id: e164(message.to)?.slice(1),
        status: message.status, timestamp: providerTimestamp(payload.createTime),
        ...(message.status === "failed" ? { errors: [{ code: String(message.errorCode || "YCLOUD_FAILED"), title: "Envio recusado pelo provedor." }] } : {}),
      }] };
    }
    let events;
    try {
      events = parseWhatsAppWebhook({ object: "whatsapp_business_account", entry: [{ id: number.wabaId,
        changes: [{ field: "messages", value: { messaging_product: "whatsapp",
          metadata: { phone_number_id: number.phoneNumberId, display_phone_number: businessPhone }, ...value,
        } }],
      }] });
    } catch { reject(400, "YCLOUD_PAYLOAD_INVALID"); }
    await ingestionService.ingestEvents(events, { correlationId });
    await repository.recordValidWebhook({ empresaId: connection.empresaId, appId: connection.id });
    return { accepted: true, eventCount: events.length };
  }
  return Object.freeze({ ingest });
}

export function createYCloudWebhookHandler({ service }) {
  return async (request, response) => {
    try {
      await service.ingest({ webhookPublicId: request.params.webhookPublicId, rawBody: request.rawBody,
        signature: request.get("ycloud-signature"), correlationId: request.context?.correlationId });
      response.sendStatus(200);
    } catch (error) { response.sendStatus(error instanceof YCloudWebhookError ? error.statusCode : 503); }
  };
}
