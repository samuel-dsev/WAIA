const MAX_DEPTH = 16;
const MAX_NODES = 20_000;
const MAX_STRING_LENGTH = 100_000;
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class SafeJsonError extends TypeError {
  constructor(code, path, message) {
    super(message);
    this.name = "SafeJsonError";
    this.code = code;
    this.path = path;
  }
}

export function pointer(path, key) {
  const encoded = String(key).replace(/~/gu, "~0").replace(/\//gu, "~1");
  return `${path}/${encoded}`;
}

function fail(code, path, message) {
  throw new SafeJsonError(code, path || "/", message);
}

function clone(value, path, depth, counter) {
  counter.nodes += 1;
  if (counter.nodes > MAX_NODES) fail("FLOW_JSON_TOO_LARGE", path, "O valor excede o limite de itens permitido.");
  if (depth > MAX_DEPTH) fail("FLOW_JSON_TOO_DEEP", path, "O valor excede a profundidade permitida.");

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) fail("FLOW_STRING_TOO_LONG", path, "O texto excede o limite permitido.");
    return value.normalize("NFC");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("FLOW_JSON_INVALID_NUMBER", path, "O valor numérico deve ser finito.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") fail("FLOW_JSON_UNSAFE_VALUE", path, "Somente valores JSON seguros são permitidos.");

  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) fail("FLOW_JSON_UNSAFE_ARRAY", path, "A lista deve ser um Array simples.");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || (key !== "length" && !ARRAY_INDEX_PATTERN.test(key))) {
        fail("FLOW_JSON_EXTRA_ARRAY_PROPERTY", pointer(path, key), "A lista contém uma propriedade não permitida.");
      }
      const descriptor = descriptors[key];
      if (key !== "length" && (typeof descriptor.get === "function" || typeof descriptor.set === "function")) {
        fail("FLOW_JSON_ACCESSOR_FORBIDDEN", pointer(path, key), "Accessors não são permitidos.");
      }
    }
    if (value.length > 5_000) fail("FLOW_JSON_TOO_LARGE", path, "A lista excede o limite permitido.");
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(descriptors, index)) fail("FLOW_JSON_SPARSE_ARRAY", pointer(path, index), "Listas esparsas não são permitidas.");
      result.push(clone(descriptors[index].value, pointer(path, index), depth + 1, counter));
    }
    return result;
  }

  if (prototype !== Object.prototype && prototype !== null) {
    fail("FLOW_JSON_UNSAFE_OBJECT", path, "O valor deve ser um objeto simples.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > 1_000) fail("FLOW_JSON_TOO_LARGE", path, "O objeto excede o limite de propriedades permitido.");
  const result = {};
  for (const key of keys.sort((left, right) => String(left).localeCompare(String(right), "en"))) {
    if (typeof key !== "string" || FORBIDDEN_KEYS.has(key)) {
      fail("FLOW_JSON_UNSAFE_KEY", pointer(path, key), "A propriedade não é permitida.");
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || typeof descriptor.get === "function" || typeof descriptor.set === "function") {
      fail("FLOW_JSON_ACCESSOR_FORBIDDEN", pointer(path, key), "Somente propriedades de dados enumeráveis são permitidas.");
    }
    result[key] = clone(descriptor.value, pointer(path, key), depth + 1, counter);
  }
  return result;
}

export function cloneSafeJson(value, { path = "" } = {}) {
  return clone(value, path, 0, { nodes: 0 });
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
