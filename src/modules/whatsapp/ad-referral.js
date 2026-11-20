// Provider metadata is untrusted data. Do not retain tracking IDs or fetch ad media/URLs.
export function normalizeAdReferral(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const [key, max] of [["source_id", 200], ["headline", 300], ["body", 2000]]) {
    if (typeof value[key] === "string" && value[key].trim()) result[key] = value[key].trim().slice(0, max);
  }
  if (["ad", "post"].includes(value.source_type)) result.source_type = value.source_type;
  return Object.keys(result).length ? result : null;
}

const words = (value) => ` ${String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

export function catalogAdContext(value, catalog, { current = false } = {}) {
  const referral = normalizeAdReferral(value);
  if (!referral) return null;
  const copy = words(`${referral.headline || ""} ${referral.body || ""}`);
  const references = catalog?.source?.type === 'real_estate_catalog'
    ? [...new Set([...`${referral.headline || ''} ${referral.body || ''}`.matchAll(/\b(?:ref(?:er[eê]ncia)?|c[oó]digo|im[oó]vel)\s*[:#-]?\s*([1-9]\d*)\b/giu)].map(match => match[1]))] : [];
  if (references.length > 1) return { referral, current, match: 'ambiguous', productId: null };
  const reference = references[0];
  const matches = (catalog?.items || []).filter((item) => item.active !== false && (reference ? item.reference === reference
    : item.name && words(item.name).trim().length >= 3 && copy.includes(words(item.name))));
  return { referral, current, match: matches.length === 1 ? "unique" : matches.length ? "ambiguous" : "unknown",
    productId: matches.length === 1 ? matches[0].id : null };
}
