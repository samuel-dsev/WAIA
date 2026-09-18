import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function pepperBuffer(pepper) {
  const value = Buffer.isBuffer(pepper) ? Buffer.from(pepper) : Buffer.from(String(pepper || ""), "utf8");
  if (value.length < 32) throw new TypeError("SESSION_PEPPER deve possuir pelo menos 32 bytes.");
  return value;
}

function hmac(pepper, purpose, value) {
  return createHmac("sha256", pepper).update(`${purpose}\u0000${value}`, "utf8").digest();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createSessionTokenCodec({ pepper, random = randomBytes } = {}) {
  const key = pepperBuffer(pepper);
  return Object.freeze({
    issue() {
      const token = random(32).toString("base64url");
      return Object.freeze({
        token,
        tokenHash: hmac(key, "session", token),
        csrfToken: hmac(key, "csrf", token).toString("base64url"),
      });
    },
    hash(token) {
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,100}$/u.test(token)) return null;
      return hmac(key, "session", token);
    },
    verifyCsrf(token, csrfToken) {
      if (typeof token !== "string" || typeof csrfToken !== "string") return false;
      return safeEqual(hmac(key, "csrf", token).toString("base64url"), csrfToken);
    },
    csrf(token) { return hmac(key, "csrf", token).toString("base64url"); },
    fingerprint(value) {
      return hmac(key, "fingerprint", String(value || "")).toString("hex").slice(0, 32);
    },
  });
}
