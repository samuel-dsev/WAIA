import {
  IntegrationError,
  integrationHealth,
  requireTenantContext,
  safeIntegrationLog,
} from "../common.js";

function requiredText(value, field, max = 4096) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${field} é obrigatório.`);
  if (text.length > max) throw new TypeError(`${field} excede ${max} caracteres.`);
  return text;
}

function normalizeCredentials(value) {
  if (!value) return null;
  const accessToken = String(value.accessToken || "").trim();
  const phoneNumberId = String(value.phoneNumberId || "").trim();
  if (!accessToken || !phoneNumberId) return null;
  return {
    accessToken,
    phoneNumberId,
    apiVersion: String(value.apiVersion || "v26.0").trim(),
  };
}

function requireMethod(target, method, name) {
  if (typeof target?.[method] !== "function") throw new TypeError(`${name}.${method} é obrigatório.`);
}

/**
 * Meta Cloud API gateway. Credentials and phone number are resolved for every
 * operation, preventing process-global tenant state.
 */
export function createMetaGateway({
  credentialResolver,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  graphBaseUrl = "https://graph.facebook.com",
  logger = console,
} = {}) {
  requireMethod(credentialResolver, "resolveMeta", "credentialResolver");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl é obrigatório.");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs deve ser positivo.");

  async function resolve(context) {
    const tenant = requireTenantContext(context, { requireNumber: true });
    const credentials = normalizeCredentials(await credentialResolver.resolveMeta(tenant));
    return { tenant, credentials };
  }

  async function request(context, path, options = {}, resolvedScope) {
    const { tenant, credentials } = resolvedScope || await resolve(context);
    if (!credentials) {
      throw new IntegrationError("Integração Meta não configurada.", {
        code: "META_NOT_CONFIGURED",
        retryable: false,
      });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const { operation, ...fetchOptions } = options;
    try {
      const response = await fetchImpl(`${graphBaseUrl}/${credentials.apiVersion}/${path}`, {
        ...fetchOptions,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...fetchOptions.headers,
        },
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new IntegrationError("A Meta recusou a operação.", {
          code: "META_REQUEST_FAILED",
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      return data || {};
    } catch (error) {
      const normalized = error?.name === "AbortError"
        ? new IntegrationError("A Meta excedeu o tempo limite.", { code: "META_TIMEOUT" })
        : error instanceof IntegrationError
          ? error
          : new IntegrationError("A Meta está indisponível.", { code: "META_UNAVAILABLE" });
      safeIntegrationLog(logger, "warn", "meta_operation_failed", tenant, {
        integration: "meta",
        operation,
        status: normalized.status,
        errorCode: normalized.code,
      });
      throw normalized;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function sendReply(context, { to, text, buttons = [] } = {}) {
    const scoped = await resolve(context);
    const { credentials } = scoped;
    if (!credentials) throw new IntegrationError("Integração Meta não configurada.", { code: "META_NOT_CONFIGURED", retryable: false });
    const body = requiredText(text, "text");
    const recipient = requiredText(to, "to", 32);
    const normalizedButtons = Array.isArray(buttons) ? buttons.slice(0, 3).map((button, index) => ({
      id: requiredText(button.id, `buttons[${index}].id`, 256),
      title: requiredText(button.title || button.label, `buttons[${index}].title`, 20),
    })) : [];
    const message = normalizedButtons.length === 0
      ? {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        text: { preview_url: false, body },
      }
      : {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body },
          action: { buttons: normalizedButtons.map((button) => ({ type: "reply", reply: button })) },
        },
      };
    return request(context, `${credentials.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify(message),
      operation: "send_reply",
    }, scoped);
  }

  async function sendStatus(context, { messageId, status = "read" } = {}) {
    if (status !== "read") throw new TypeError("Apenas o status read pode ser enviado pela API de mensagens.");
    const scoped = await resolve(context);
    const { credentials } = scoped;
    if (!credentials) throw new IntegrationError("Integração Meta não configurada.", { code: "META_NOT_CONFIGURED", retryable: false });
    return request(context, `${credentials.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status,
        message_id: requiredText(messageId, "messageId", 300),
      }),
      operation: "send_status",
    }, scoped);
  }

  async function health(context) {
    let resolved;
    try {
      resolved = await resolve(context);
      if (!resolved.credentials) return integrationHealth("not_configured", { integration: "meta" });
      await request(context, `${resolved.credentials.phoneNumberId}?fields=id`, { operation: "health" }, resolved);
      return integrationHealth("healthy", { integration: "meta" });
    } catch (error) {
      if (error?.code === "META_NOT_CONFIGURED") return integrationHealth("not_configured", { integration: "meta" });
      return integrationHealth("unavailable", { integration: "meta", errorCode: error?.code || "META_UNAVAILABLE" });
    }
  }

  return Object.freeze({ sendReply, sendStatus, markRead: sendStatus, health });
}
