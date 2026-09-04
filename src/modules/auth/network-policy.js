import { isIP } from "node:net";
import { AuthorizationDeniedError } from "./errors.js";

function ipv4Number(value) {
  if (isIP(value) !== 4) return null;
  return value.split(".").reduce((total, octet) => ((total << 8) | Number(octet)) >>> 0, 0);
}

function normalizeIp(value) {
  const ip = String(value || "").trim();
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function matcher(rule) {
  const [address, prefixText] = String(rule || "").trim().split("/");
  const normalized = normalizeIp(address);
  const family = isIP(normalized);
  if (!family) throw new TypeError(`ADMIN_NETWORK_ALLOWLIST invalida: ${rule}.`);
  if (prefixText == null) return (value) => normalizeIp(value) === normalized;
  const prefix = Number(prefixText);
  if (family !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new TypeError(`CIDR administrativo nao suportado: ${rule}.`);
  }
  const base = ipv4Number(normalized);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value) => {
    const candidate = ipv4Number(normalizeIp(value));
    return candidate != null && (candidate & mask) === (base & mask);
  };
}

export function parseAdminNetworkAllowlist(value) {
  const rules = Array.isArray(value) ? value : String(value || "").split(",");
  return Object.freeze(rules.map((item) => String(item).trim()).filter(Boolean).map(matcher));
}

export function createAdminNetworkMiddleware({ allowlist = [] } = {}) {
  const matchers = Array.isArray(allowlist) && allowlist.every((item) => typeof item === "function")
    ? allowlist
    : parseAdminNetworkAllowlist(allowlist);
  return function adminNetworkPolicy(request, _response, next) {
    if (!matchers.length || matchers.some((matches) => matches(request.ip))) return next();
    return next(new AuthorizationDeniedError());
  };
}
