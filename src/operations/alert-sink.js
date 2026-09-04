import { redactSensitive } from "../security/redaction.js";

function assertWebhookUrl(value, { allowInsecure = false } = {}) {
  const url = new URL(String(value || ""));
  if (url.username || url.password || (!allowInsecure && url.protocol !== "https:")) {
    throw new TypeError("ALERT_WEBHOOK_URL deve usar HTTPS e nao pode conter credenciais.");
  }
  return url;
}

export class WebhookAlertSink {
  constructor({ url, authorization = "", timeoutMs = 10_000, fetchImpl = fetch, allowInsecure = false } = {}) {
    this.url = assertWebhookUrl(url, { allowInsecure });
    this.authorization = String(authorization || "");
    this.timeoutMs = Number(timeoutMs);
    this.fetchImpl = fetchImpl;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new TypeError("ALERT_TIMEOUT_MS invalido.");
    }
  }

  async notify(alert) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.authorization ? { authorization: this.authorization } : {}),
        },
        body: JSON.stringify(redactSensitive({
          source: "waia",
          occurredAt: new Date().toISOString(),
          ...alert,
        })),
        signal: controller.signal,
      });
      if (!response.ok) throw Object.assign(new Error("Destino de alertas recusou o evento."), { code: "ALERT_DELIVERY_FAILED", status: response.status });
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createConfiguredAlertSink(config, options = {}) {
  if (!config?.webhookUrl) return null;
  return new WebhookAlertSink({
    url: config.webhookUrl,
    authorization: config.authorization,
    timeoutMs: config.timeoutMs,
    ...options,
  });
}
