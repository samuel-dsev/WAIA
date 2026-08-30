import { config } from "./config.js";
import { createWhatsAppReplyPayload } from "./modules/whatsapp/outbound.js";

function requireWhatsAppCredentials() {
  const { accessToken, phoneNumberId } = config.legacyCapitaoMorWhatsapp;
  const { apiVersion } = config.whatsapp;
  if (!accessToken || !phoneNumberId) {
    throw new Error("Credenciais do WhatsApp ainda não foram configuradas.");
  }
  return { accessToken, phoneNumberId, apiVersion };
}

async function graphRequest(path, options = {}) {
  const { accessToken, apiVersion } = requireWhatsAppCredentials();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.whatsapp.requestTimeoutMs);

  try {
    const response = await fetch(`https://graph.facebook.com/${apiVersion}/${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = data?.error?.message || `HTTP ${response.status}`;
      const error = new Error(`WhatsApp retornou ${response.status}: ${message}`);
      error.status = response.status;
      error.details = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendWhatsAppText(to, body) {
  const { phoneNumberId } = requireWhatsAppCredentials();

  return graphRequest(`${phoneNumberId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    }),
  });
}

export async function sendWhatsAppReply(to, reply) {
  if (!reply.buttons?.length) return sendWhatsAppText(to, reply.text);
  const { phoneNumberId } = requireWhatsAppCredentials();

  return graphRequest(`${phoneNumberId}/messages`, {
    method: "POST",
    body: JSON.stringify(createWhatsAppReplyPayload({ to, text: reply.text, buttons: reply.buttons })),
  });
}

export async function markWhatsAppMessageRead(messageId) {
  const { phoneNumberId } = requireWhatsAppCredentials();
  return graphRequest(`${phoneNumberId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    }),
  });
}

export async function checkWhatsAppConnection() {
  const { phoneNumberId } = requireWhatsAppCredentials();
  return graphRequest(`${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);
}

export function whatsappReadiness() {
  return {
    credentialsConfigured: Boolean(
      config.legacyCapitaoMorWhatsapp.accessToken && config.legacyCapitaoMorWhatsapp.phoneNumberId,
    ),
    verifyTokenConfigured: Boolean(config.whatsapp.verifyToken),
    signatureValidationEnabled: Boolean(config.whatsapp.appSecret),
  };
}

export function extractMessages(payload) {
  return (payload.entry ?? []).flatMap((entry) =>
    (entry.changes ?? []).flatMap((change) =>
      (change.value?.messages ?? [])
        .filter((message) => ["text", "interactive", "button", "image"].includes(message.type))
        .map((message) => ({
          id: message.id,
          phone: message.from,
          type: message.type,
          text: message.type === "interactive"
            ? message.interactive?.button_reply?.id
              || message.interactive?.button_reply?.title
              || message.interactive?.list_reply?.id
              || message.interactive?.list_reply?.title
              || "menu"
            : message.type === "button"
              ? message.button?.payload || message.button?.text || "menu"
            : message.type === "image"
              ? message.image?.caption || ""
              : message.text.body,
          mediaId: message.image?.id,
        })),
    ),
  );
}
