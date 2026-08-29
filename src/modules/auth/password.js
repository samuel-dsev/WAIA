import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(nodeScrypt);
const DEFAULTS = Object.freeze({ cost: 65_536, blockSize: 8, parallelization: 1, keyLength: 64 });
export const DUMMY_PASSWORD_HASH = "$scrypt$65536$8$1$bm9ib2R5LWxvZ2luLXRpbWluZy1zYWx0LXYx$cgnW3FXExmkPcbL9AO9CZAo0VTex_ZMeCltv7mYnLAxe5LEpgM73wQ9I-rlWwoVt58S9J_lqEkMZfNy0dtVhUw";

function passwordText(value, { enforcePolicy = false } = {}) {
  if (typeof value !== "string" || value.length > 1_024 || value.includes("\u0000")) {
    throw new TypeError("Senha inválida.");
  }
  const normalized = value.normalize("NFKC");
  if (enforcePolicy && (normalized.length < 12 || normalized.length > 256)) {
    throw new TypeError("A senha deve possuir entre 12 e 256 caracteres.");
  }
  return normalized;
}

function parameters(options = {}) {
  const values = {
    cost: Number(options.cost ?? DEFAULTS.cost),
    blockSize: Number(options.blockSize ?? DEFAULTS.blockSize),
    parallelization: Number(options.parallelization ?? DEFAULTS.parallelization),
    keyLength: Number(options.keyLength ?? DEFAULTS.keyLength),
  };
  if (!Number.isInteger(values.cost) || values.cost < 1_024 || (values.cost & (values.cost - 1)) !== 0) {
    throw new TypeError("Custo scrypt inválido.");
  }
  if (!Number.isInteger(values.blockSize) || values.blockSize < 1 || values.blockSize > 32
      || !Number.isInteger(values.parallelization) || values.parallelization < 1 || values.parallelization > 16
      || values.keyLength !== 64) {
    throw new TypeError("Parâmetros scrypt inválidos.");
  }
  return values;
}

async function derive(password, salt, values) {
  const minimumMemory = 128 * values.cost * values.blockSize;
  return scrypt(password, salt, values.keyLength, {
    N: values.cost,
    r: values.blockSize,
    p: values.parallelization,
    maxmem: Math.max(32 * 1024 * 1024, minimumMemory + (16 * 1024 * 1024)),
  });
}

export async function hashPassword(password, options = {}) {
  const normalized = passwordText(password, { enforcePolicy: true });
  const values = parameters(options);
  const salt = options.salt ? Buffer.from(options.salt) : randomBytes(24);
  if (salt.length < 16 || salt.length > 64) throw new TypeError("Salt scrypt inválido.");
  const hash = await derive(normalized, salt, values);
  return `$scrypt$${values.cost}$${values.blockSize}$${values.parallelization}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function parseHash(encoded) {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 7 || parts[0] !== "" || parts[1] !== "scrypt") throw new TypeError("Hash de senha inválido.");
  const values = parameters({ cost: Number(parts[2]), blockSize: Number(parts[3]), parallelization: Number(parts[4]) });
  const salt = Buffer.from(parts[5], "base64url");
  const expected = Buffer.from(parts[6], "base64url");
  if (salt.length < 16 || salt.length > 64 || expected.length !== values.keyLength) {
    throw new TypeError("Hash de senha inválido.");
  }
  return { values, salt, expected };
}

export async function verifyPassword(password, encoded) {
  try {
    const normalized = passwordText(password);
    const { values, salt, expected } = parseHash(encoded);
    const actual = await derive(normalized, salt, values);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
