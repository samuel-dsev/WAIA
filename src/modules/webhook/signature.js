import { createHmac, timingSafeEqual } from "node:crypto";

function normalizedSecrets(appSecret, appSecrets) {
  const candidates = [appSecret, ...(Array.isArray(appSecrets) ? appSecrets : [])];
  return [...new Set(candidates.filter((value) => typeof value === "string" && value.length > 0))];
}

function signatureDigest(signature) {
  if (typeof signature !== "string" || !/^sha256=[a-f\d]{64}$/i.test(signature)) return null;
  return Buffer.from(signature.slice(7).toLowerCase(), "hex");
}

export function createMetaSignatureVerifier({
  appSecret,
  appSecrets = [],
  allowUnsigned = false,
} = {}) {
  const secrets = normalizedSecrets(appSecret, appSecrets);
  const configured = secrets.length > 0;

  return Object.freeze({
    configured,
    allowUnsigned: Boolean(allowUnsigned),
    verify({ rawBody, signature } = {}) {
      if (!configured) return Boolean(allowUnsigned);
      if (!Buffer.isBuffer(rawBody) && typeof rawBody !== "string") return false;
      const received = signatureDigest(signature);
      if (!received) return false;
      const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
      let valid = false;
      for (const secret of secrets) {
        const expected = createHmac("sha256", secret).update(body).digest();
        valid = timingSafeEqual(received, expected) || valid;
      }
      return valid;
    },
  });
}
