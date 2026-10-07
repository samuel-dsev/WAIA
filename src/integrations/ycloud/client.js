import { IntegrationError } from "../common.js";
import { createWhatsAppReplyPayload } from "../../modules/whatsapp/outbound.js";

export function createYCloudClient({ fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  async function request(apiKey, path, body, signal) {
    if (typeof apiKey !== "string" || !apiKey || /[\r\n]/u.test(apiKey)) {
      throw new IntegrationError("Credencial YCloud indisponível.", { code: "YCLOUD_NOT_CONFIGURED", retryable: false });
    }
    try {
      const response = await fetchImpl(`https://api.ycloud.com/v2/${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        headers: { "X-API-Key": apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new IntegrationError("A YCloud recusou a operação.", {
        code: "YCLOUD_REQUEST_FAILED", status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
      return await response.json().catch(() => ({}));
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError("YCloud indisponível.", { code: "YCLOUD_UNAVAILABLE" });
    }
  }
  function phone(value) {
    const normalized = `+${String(value || "").replace(/^\+/u, "")}`;
    if (!/^\+[1-9]\d{7,14}$/u.test(normalized)) throw new TypeError("Número internacional inválido.");
    return normalized;
  }
  async function checkConnection({ appId, wabaId, phoneNumberId, phoneNumber, accessToken, signal }) {
    const sender = phone(phoneNumber);
    const data = await request(accessToken, `whatsapp/phoneNumbers/${encodeURIComponent(wabaId)}/${encodeURIComponent(sender)}`, undefined, signal);
    if (String(data.id) !== String(phoneNumberId) || String(data.wabaId) !== String(wabaId)
      || phone(data.phoneNumber) !== sender || !["CONNECTED", "connected"].includes(data.status)) {
      throw new IntegrationError("Identidade ou estado do número YCloud divergente.", { code: "YCLOUD_CONNECTION_MISMATCH", retryable: false });
    }
    return { appId, wabaId, phoneNumberId, tokenValid: true };
  }
  async function sendReply(credentials, input) {
    const message = createWhatsAppReplyPayload(input);
    const { messaging_product, recipient_type, to, ...content } = message;
    const data = await request(credentials.accessToken, "whatsapp/messages/sendDirectly", {
      from: phone(credentials.phoneNumber), to: phone(to), ...content,
    });
    if (data.error || data.status === "failed") {
      throw new IntegrationError("Envio recusado pela YCloud.", { code: "YCLOUD_SEND_REJECTED", retryable: false });
    }
    if (typeof data.wamid !== "string" || !data.wamid) {
      throw new IntegrationError("Resposta de envio YCloud inválida.", { code: "YCLOUD_SEND_RESPONSE_INVALID", retryable: false });
    }
    return { messages: [{ id: data.wamid }] };
  }
  async function markRead(credentials, { messageId, status = "read" }) {
    if (status !== "read" || typeof messageId !== "string" || !messageId || messageId.length > 512) throw new TypeError("Status de leitura inválido.");
    return request(credentials.accessToken, `whatsapp/inboundMessages/${encodeURIComponent(messageId)}/markAsRead`, {});
  }
  return Object.freeze({ checkConnection, sendReply, markRead });
}
