import { IntegrationError } from "../common.js";

const GRAPH_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/u;

function graphId(value, field) {
  const id = String(value || "").trim();
  if (!GRAPH_ID_PATTERN.test(id)) throw new TypeError(`${field} inválido.`);
  return id;
}

function accessToken(value) {
  const token = String(value || "").trim();
  if (!token || token.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(token)) {
    throw new TypeError("accessToken inválido.");
  }
  return token;
}

function apiVersion(value) {
  const version = String(value || "v26.0").trim();
  if (!/^v[1-9][0-9]{0,2}\.0$/u.test(version)) throw new TypeError("apiVersion inválida.");
  return version;
}

function baseUrl(value) {
  const url = new URL(value || "https://graph.facebook.com");
  if (!new Set(["https:", "http:"]).has(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("graphBaseUrl inválida.");
  }
  return url.toString().replace(/\/$/u, "");
}

function requestError(status) {
  return new IntegrationError("A Meta recusou o teste da conexão.", {
    code: "META_HEALTH_REQUEST_FAILED",
    status,
    retryable: status === 429 || status >= 500,
  });
}

/** Cliente mínimo usado somente pelo preflight administrativo da conexão Meta. */
export class MetaGraphHealthClient {
  constructor({
    fetchImpl = globalThis.fetch,
    graphBaseUrl = "https://graph.facebook.com",
    apiVersion: version = "v26.0",
    timeoutMs = 15_000,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl é obrigatório.");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new TypeError("timeoutMs deve estar entre 1 e 60000.");
    }
    this.fetchImpl = fetchImpl;
    this.graphBaseUrl = baseUrl(graphBaseUrl);
    this.apiVersion = apiVersion(version);
    this.timeoutMs = timeoutMs;
  }

  async #identity(id, token, signal) {
    let response;
    try {
      response = await this.fetchImpl(
        `${this.graphBaseUrl}/${this.apiVersion}/${encodeURIComponent(id)}?fields=id`,
        {
          method: "GET",
          redirect: "error",
          signal,
          headers: { Authorization: `Bearer ${token}` },
        },
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new IntegrationError("A Meta excedeu o tempo limite do teste.", {
          code: "META_HEALTH_TIMEOUT",
          retryable: true,
        });
      }
      throw new IntegrationError("A Meta está indisponível para o teste.", {
        code: "META_HEALTH_UNAVAILABLE",
        retryable: true,
      });
    }
    if (!response?.ok) throw requestError(Number(response?.status) || 503);
    const document = await response.json().catch(() => null);
    return typeof document?.id === "string" ? document.id : null;
  }

  async checkConnection({ appId, wabaId, phoneNumberId, accessToken: secret } = {}) {
    const expected = {
      appId: graphId(appId, "appId"),
      wabaId: graphId(wabaId, "wabaId"),
      phoneNumberId: graphId(phoneNumberId, "phoneNumberId"),
    };
    let token = accessToken(secret);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const [resolvedAppId, resolvedWabaId, resolvedPhoneNumberId] = await Promise.all([
        this.#identity(expected.appId, token, controller.signal),
        this.#identity(expected.wabaId, token, controller.signal),
        this.#identity(expected.phoneNumberId, token, controller.signal),
      ]);
      return Object.freeze({
        appId: resolvedAppId,
        wabaId: resolvedWabaId,
        phoneNumberId: resolvedPhoneNumberId,
        tokenValid: Boolean(resolvedAppId && resolvedWabaId && resolvedPhoneNumberId),
      });
    } finally {
      clearTimeout(timeout);
      token = null;
    }
  }
}
