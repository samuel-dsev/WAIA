import { redactSensitive } from "../security/redaction.js";

const ALERT_FORMATS = new Set(["generic", "discord"]);

function assertWebhookUrl(value, { allowInsecure = false } = {}) {
  const url = new URL(String(value || ""));
  if (url.username || url.password || (!allowInsecure && url.protocol !== "https:")) {
    throw new TypeError("ALERT_WEBHOOK_URL deve usar HTTPS e nao pode conter credenciais.");
  }
  return url;
}

function alertFormat(value) {
  const format = String(value || "generic").trim().toLowerCase();
  if (!ALERT_FORMATS.has(format)) throw new TypeError("ALERT_WEBHOOK_FORMAT invalido.");
  return format;
}

function discordPayload(alert) {
  const details = JSON.stringify(alert.fields && typeof alert.fields === "object" ? alert.fields : {});
  const content = [
    `WAIA | ${String(alert.severity || "info").toUpperCase()} | ${alert.eventCode || "operational_alert"}`,
    `Estado: ${alert.state || "unknown"}`,
    `Horario UTC: ${alert.occurredAt}`,
    `Detalhes: ${details}`,
  ].join("\n").slice(0, 2_000);
  return {
    username: "WAIA Monitor",
    content,
    allowed_mentions: { parse: [] },
  };
}

export class WebhookAlertSink {
  constructor({ url, authorization = "", format = "generic", timeoutMs = 10_000, fetchImpl = fetch, allowInsecure = false } = {}) {
    this.url = assertWebhookUrl(url, { allowInsecure });
    this.authorization = String(authorization || "");
    this.format = alertFormat(format);
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
      const sanitizedAlert = redactSensitive({
        source: "waia",
        occurredAt: new Date().toISOString(),
        ...alert,
      });
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.authorization ? { authorization: this.authorization } : {}),
        },
        body: JSON.stringify(this.format === "discord" ? discordPayload(sanitizedAlert) : sanitizedAlert),
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
    format: config.format,
    timeoutMs: config.timeoutMs,
    ...options,
  });
}
