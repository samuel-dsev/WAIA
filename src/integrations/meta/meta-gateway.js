import {
  IntegrationError,
  integrationHealth,
  requireTenantContext,
  safeIntegrationLog,
} from "../common.js";
import { createWhatsAppReplyPayload } from "../../modules/whatsapp/outbound.js";

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

function normalizedMime(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function allowedMediaUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (
      host === "graph.facebook.com"
      || host === "lookaside.fbsbx.com"
      || host.endsWith(".facebook.com")
      || host.endsWith(".fbcdn.net")
    );
  } catch {
    return false;
  }
}

async function limitedBody(response, maxBytes) {
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new IntegrationError("A mídia excede o limite permitido.", { code: "META_MEDIA_TOO_LARGE", retryable: false });
  }
  if (!response.body?.getReader) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) throw new IntegrationError("A mídia excede o limite permitido.", { code: "META_MEDIA_TOO_LARGE", retryable: false });
    return data;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new IntegrationError("A mídia excede o limite permitido.", { code: "META_MEDIA_TOO_LARGE", retryable: false });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
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
    const message = createWhatsAppReplyPayload({ to, text, buttons });
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

  async function downloadMedia(context, {
    mediaId,
    maxBytes = 10 * 1024 * 1024,
    allowedMimeTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  } = {}) {
    const scoped = await resolve(context);
    const { tenant, credentials } = scoped;
    if (!credentials) throw new IntegrationError("Integração Meta não configurada.", { code: "META_NOT_CONFIGURED", retryable: false });
    const id = requiredText(mediaId, "mediaId", 512);
    const metadata = await request(context, id, { operation: "resolve_media" }, scoped);
    const mimeType = normalizedMime(metadata.mime_type);
    const declaredSize = metadata.file_size == null ? null : Number(metadata.file_size);
    const allowed = new Set(allowedMimeTypes.map(normalizedMime));
    if (!allowed.has(mimeType)) {
      throw new IntegrationError("Tipo de mídia não permitido.", { code: "META_MEDIA_MIME_NOT_ALLOWED", retryable: false });
    }
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      throw new IntegrationError("A mídia excede o limite permitido.", { code: "META_MEDIA_TOO_LARGE", retryable: false });
    }
    if (!allowedMediaUrl(metadata.url)) {
      throw new IntegrationError("URL de mídia recusada.", { code: "META_MEDIA_URL_INVALID", retryable: false });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(metadata.url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
      });
      if (!response.ok) {
        throw new IntegrationError("A Meta recusou o download da mídia.", {
          code: "META_MEDIA_DOWNLOAD_FAILED",
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      const responseMime = normalizedMime(response.headers?.get?.("content-type"));
      if (responseMime && (responseMime !== mimeType || !allowed.has(responseMime))) {
        throw new IntegrationError("Tipo de mídia divergente.", { code: "META_MEDIA_MIME_MISMATCH", retryable: false });
      }
      const data = await limitedBody(response, maxBytes);
      if (Number.isFinite(declaredSize) && declaredSize >= 0 && data.length !== declaredSize) {
        throw new IntegrationError("Tamanho da mídia divergente.", { code: "META_MEDIA_SIZE_MISMATCH" });
      }
      return Object.freeze({ data, mimeType, sizeBytes: data.length });
    } catch (error) {
      const normalized = error?.name === "AbortError"
        ? new IntegrationError("A Meta excedeu o tempo limite da mídia.", { code: "META_MEDIA_TIMEOUT" })
        : error instanceof IntegrationError
          ? error
          : new IntegrationError("A mídia da Meta está indisponível.", { code: "META_MEDIA_UNAVAILABLE" });
      safeIntegrationLog(logger, "warn", "meta_operation_failed", tenant, {
        integration: "meta",
        operation: "download_media",
        status: normalized.status,
        errorCode: normalized.code,
      });
      throw normalized;
    } finally {
      clearTimeout(timeout);
    }
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

  return Object.freeze({ sendReply, sendStatus, markRead: sendStatus, downloadMedia, health });
}
