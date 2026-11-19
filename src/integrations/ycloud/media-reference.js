import { IntegrationError } from "../common.js";

const invalid = () => new IntegrationError("Referência de mídia YCloud inválida.", { code: "YCLOUD_MEDIA_REFERENCE_INVALID", retryable: false });

/** Private download reference from an authenticated webhook, never customer text. */
export function normalizeYCloudMediaReference(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || value.provider !== "ycloud"
    || typeof value.mediaId !== "string" || !/^[A-Za-z0-9_-]{1,512}$/u.test(value.mediaId)
    || typeof value.wabaId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.wabaId)
    || typeof value.url !== "string" || value.url.length > 8192
    || typeof value.mimeType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(value.mimeType)
    || value.sha256 != null && !/^[A-Za-z0-9+/]{43}=$/u.test(value.sha256)) throw invalid();
  let url;
  try { url = new URL(value.url); } catch { throw invalid(); }
  if (url.protocol !== "https:" || url.hostname !== "api.ycloud.com" || url.port || url.username || url.password || url.hash
    || url.pathname !== `/v2/whatsapp/media/download/${value.mediaId}`) throw invalid();
  // The provider's URL payload binds the reference to the authenticated WABA.
  try {
    const payload = JSON.parse(Buffer.from(url.searchParams.get("payload") || "", "base64url").toString("utf8"));
    if (String(payload.wabaId) !== value.wabaId || payload.mimeType !== value.mimeType
      || value.sha256 && payload.sha256 !== value.sha256) throw invalid();
  } catch { throw invalid(); }
  return { provider: "ycloud", mediaId: value.mediaId, wabaId: value.wabaId, url: value.url,
    mimeType: value.mimeType, ...(value.sha256 ? { sha256: value.sha256 } : {}) };
}
