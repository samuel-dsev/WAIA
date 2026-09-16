import { createHash } from "node:crypto";

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_DEPTH = 20;
const MAX_NODES = 20_000;
const MAX_BYTES = 1_048_576;

function canonicalize(value, path, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_NODES) throw new TypeError("configuration excede o limite de valores.");
  if (depth > MAX_DEPTH) throw new TypeError(`${path} excede a profundidade permitida.`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contém número não finito.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (["undefined", "bigint", "symbol", "function"].includes(typeof value)) {
    throw new TypeError(`${path} contém valor não serializável.`);
  }
  if (!value || typeof value !== "object"
    || (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype : Object.getPrototypeOf(value) !== Object.prototype)) {
    throw new TypeError(`${path} contém valor não serializável.`);
  }
  if (state.ancestors.has(value)) throw new TypeError(`${path} contém referência circular.`);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_NODES) throw new TypeError(`${path} excede o limite de itens.`);
      const symbols = Object.getOwnPropertySymbols(value);
      if (symbols.length > 0) throw new TypeError(`${path} contém propriedades simbólicas.`);
      const ownNames = Object.getOwnPropertyNames(value);
      const expectedNames = [...Array.from({ length: value.length }, (_, index) => String(index)), "length"];
      if (ownNames.length !== expectedNames.length || expectedNames.some((key) => !ownNames.includes(key))) {
        throw new TypeError(`${path} contém propriedades extras ou índices não canônicos.`);
      }
      const result = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, String(index))) throw new TypeError(`${path}[${index}] não pode ser vazio.`);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`${path}[${index}] contém accessor não permitido.`);
        result[index] = canonicalize(descriptor.value, `${path}[${index}]`, state, depth + 1);
      }
      return result;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${path} contém propriedades simbólicas.`);
    const result = Object.create(null);
    const normalizedKeys = Object.keys(value).map((key) => [key, key.normalize("NFC")]);
    normalizedKeys.sort((left, right) => (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0));
    const seenKeys = new Set();
    for (const [sourceKey, key] of normalizedKeys) {
      if (DANGEROUS_KEYS.has(key)) throw new TypeError(`${path}.${key} não é uma chave permitida.`);
      if (seenKeys.has(key)) throw new TypeError(`${path}.${key} colide após normalização Unicode.`);
      seenKeys.add(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, sourceKey);
      if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`${path}.${key} contém accessor não permitido.`);
      result[key] = canonicalize(descriptor.value, `${path}.${key}`, state, depth + 1);
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

export function stableJson(value) {
  const canonical = canonicalize(value, "configuration", { nodes: 0, ancestors: new WeakSet() });
  const serialized = JSON.stringify(canonical);
  if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) throw new TypeError("configuration excede 1 MiB.");
  return serialized;
}

export function configurationChecksum(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}
