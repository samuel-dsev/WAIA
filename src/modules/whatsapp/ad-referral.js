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

function websiteVehicleAdMatch(item, referral, copy) {
  const named = words(item.name).trim().split(/\s+/u);
  const core = named.filter(word => word.length >= 2 && !/^\d+$/u.test(word));
  const yearText = `${referral.headline || ''} ${referral.body || ''}`;
  const year = /\bano\s*[:=-]?\s*((?:19|20)\d{2})\b/iu.exec(yearText)?.[1]
    || /\b((?:19|20)\d{2})\b/u.exec(referral.headline || '')?.[1];
  if (year && item.year && Number(year) !== Number(item.year)) return false;
  if (copy.includes(words(item.name))) return true;
  // The advert may omit engine/year suffixes and include the manufacturer.
  // Keep whole model words; equipment, price or ad IDs cannot name a car.
  return core.length >= (year ? 1 : 2) && core.every(word => copy.includes(' '+word+' '));
}

export function catalogAdContext(value, catalog, { current = false } = {}) {
  const referral = normalizeAdReferral(value);
  if (!referral) return null;
  const copy = words(`${referral.headline || ""} ${referral.body || ""}`);
  const references = catalog?.source?.type === 'real_estate_catalog'
    ? [...new Set([...`${referral.headline || ''} ${referral.body || ''}`.matchAll(/\b(?:ref(?:er[eê]ncia)?|c[oó]digo|im[oó]vel)\s*[:#-]?\s*([1-9]\d*)\b/giu)].map(match => match[1]))] : [];
  if (references.length > 1) return { referral, current, match: 'ambiguous', productId: null };
  const reference = references[0];
  const matches = (catalog?.items || []).filter((item) => item.active !== false && (reference ? item.reference === reference
    : item.name && words(item.name).trim().length >= 3 && (catalog?.source?.type === 'website_catalog'
      ? websiteVehicleAdMatch(item, referral, copy) : copy.includes(words(item.name)))));
  return { referral, current, match: matches.length === 1 ? "unique" : matches.length ? "ambiguous" : "unknown",
    productId: matches.length === 1 ? matches[0].id : null };
}
