import { createHash } from "node:crypto";

export function ycloudMediaReference({ mediaId = "photo-1", wabaId = "waba-a", data = Buffer.from("synthetic image"), mimeType = "image/png" } = {}) {
  const sha256 = createHash("sha256").update(data).digest("base64");
  const payload = Buffer.from(JSON.stringify({ wabaId, inboundMessageId: "synthetic-inbound", mimeType, sha256 })).toString("base64url");
  return { provider: "ycloud", mediaId, wabaId, mimeType, sha256,
    url: `https://api.ycloud.com/v2/whatsapp/media/download/${mediaId}?sig=synthetic&payload=${payload}` };
}
