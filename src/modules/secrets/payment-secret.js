const PIX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PIX_EMAIL = /^[^\s@<>{}\[\]"',;:]+@[^\s@<>{}\[\]"',;:]+\.[^\s@<>{}\[\]"',;:]+$/u;

export function normalizePixKey(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 254 || /[\u0000-\u001f\u007f{}\[\]"']/u.test(text)) return null;

  const document = text.replace(/[.\-/]/gu, "");
  if (/^[\d.\-/]+$/u.test(text) && /^(?:\d{11}|\d{14})$/u.test(document)) return document;

  const phone = text.replace(/[\s().-]/gu, "");
  if (/^\+[1-9]\d{7,14}$/u.test(phone)) return phone;

  if (PIX_UUID.test(text)) return text.toLowerCase();
  if (PIX_EMAIL.test(text)) return text.toLowerCase();
  return null;
}
