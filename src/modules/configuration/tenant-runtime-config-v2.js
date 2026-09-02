import {
  CAPABILITY_KEYS_V2,
  TENANT_RUNTIME_CONFIG_V2_SCHEMA_VERSION,
  actionOwnerV2,
  capabilityDefinitionV2,
  validateActionParamsV2,
} from "./action-catalog.js";
import { configurationChecksum, stableJson } from "./stable-json.js";
import { FlowDefinitionValidationError, parseFlowDefinition } from "../flows/index.js";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u;
const ACTION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const REFERENCE_PATTERN = /^[a-z][a-z0-9_-]{1,31}:[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,191}$/u;
const FLOW_STEP_TYPES = new Set([
  "message",
  "single_choice",
  "text",
  "name",
  "email",
  "phone",
  "date",
  "consent",
  "document",
  "service_selection",
  "schedule_selection",
  "handoff",
  "completion",
  "condition",
]);
const FORBIDDEN_FIELD_FRAGMENTS = [
  "secret",
  "password",
  "passwd",
  "accesstoken",
  "verifytoken",
  "authtoken",
  "apikey",
  "privatekey",
  "clientsecret",
  "appsecret",
  "pixkey",
];
const FORBIDDEN_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\bBearer\s+[a-zA-Z0-9._~-]{16,}/u,
  /\bsk-[a-zA-Z0-9_-]{16,}/u,
  /\bEAA[a-zA-Z0-9]{20,}/u,
];

function issue(code, path, message) {
  return Object.freeze({ code, path, severity: "error", message });
}

export class ConfigurationValidationError extends TypeError {
  constructor(issues) {
    const normalized = Object.freeze([...(Array.isArray(issues) ? issues : [issues])]);
    super(normalized[0]?.message || "Configuração inválida.");
    this.name = "ConfigurationValidationError";
    this.code = "CONFIGURATION_INVALID";
    this.status = 422;
    this.issues = normalized;
  }
}

function fail(code, path, message) {
  throw new ConfigurationValidationError(issue(code, path, message));
}

function pointer(path, key) {
  const encoded = String(key).replace(/~/gu, "~0").replace(/\//gu, "~1");
  return `${path}/${encoded}`;
}

function plainObject(value, path, { optional = false } = {}) {
  if (optional && value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("INVALID_OBJECT", path, "Este campo deve ser um objeto.");
  }
  return value;
}

function rejectForbiddenFields(value, path = "", depth = 0) {
  if (depth > 12) fail("MAX_DEPTH_EXCEEDED", path || "/", "A configuração excede a profundidade permitida.");
  if (typeof value === "string" && FORBIDDEN_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    fail("SECRET_VALUE_FORBIDDEN", path || "/", "Um valor com formato de segredo não pode fazer parte da configuração.");
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = pointer(path, key);
    const normalized = key.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/gu, "");
    if (FORBIDDEN_FIELD_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
      fail("SECRET_FIELD_FORBIDDEN", childPath, "Segredos não podem fazer parte da configuração; use uma referência opaca.");
    }
    rejectForbiddenFields(child, childPath, depth + 1);
  }
}

function allowedKeys(value, path, keys) {
  const known = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) fail("UNKNOWN_FIELD", pointer(path, key), "Este campo não pertence ao schema V2.");
  }
}

const DRAFT_OBJECT_SCHEMAS = Object.freeze([
  [ /^$/u, [
    "schemaVersion", "identity", "retention", "modules", "menu", "routing",
    "publicReplies", "catalog", "events", "appointments", "payments", "orders",
    "humanHandoff", "ai", "flows", "integrations",
  ] ],
  [ /^\/identity$/u, [
    "name", "displayName", "publicIdentity", "segment", "locale", "timezone",
    "welcomeMessage", "fallbackMessage", "address", "schedules", "publicRules",
    "establishmentRules", "privacyPolicy", "consentText",
  ] ],
  [ /^\/retention$/u, ["messagesDays", "logsDays"] ],
  [ /^\/menu$/u, ["text", "options"] ],
  [ /^\/menu\/options\/\d+$/u, ["id", "label", "action", "params"] ],
  [ /^\/routing$/u, ["greetings", "aliases", "fallbackAction"] ],
  [ /^\/routing\/aliases\/\d+$/u, ["terms", "action", "params"] ],
  [ /^\/publicReplies\/\d+$/u, ["action", "text"] ],
  [ /^\/catalog$/u, ["items"] ],
  [ /^\/catalog\/items\/\d+$/u, ["id", "name", "description", "price", "active"] ],
  [ /^\/events$/u, ["items", "presentation"] ],
  [ /^\/events\/items\/\d+$/u, [
    "id", "name", "startsAt", "timezone", "attractions", "description",
    "vipRule", "birthdayRule", "location", "price", "active",
  ] ],
  [ /^\/events\/presentation$/u, ["intro", "emptyMessage", "includeDescription"] ],
  [ /^\/appointments$/u, ["services"] ],
  [ /^\/appointments\/services\/\d+$/u, ["id", "name", "description", "active", "slots"] ],
  [ /^\/appointments\/services\/\d+\/slots\/\d+$/u, ["id", "label", "startsAt", "available"] ],
  [ /^\/payments$/u, ["credentialRef", "integrationRef"] ],
  [ /^\/orders$/u, [
    "pendingStatus", "selectionPrompt", "paymentPrompt", "receiptPrompt", "namePrompt", "successMessage",
  ] ],
  [ /^\/humanHandoff$/u, ["message", "channel", "assigneeRef"] ],
  [ /^\/ai$/u, [
    "enabled", "provider", "model", "personality", "prompt", "maxOutputTokens",
    "monthlyTokenLimit", "monthlyCostLimit", "keyMode", "credentialRef", "fallbackMessage", "followUpQuestion",
  ] ],
  [ /^\/flows$/u, ["definitions"] ],
  [ /^\/flows\/definitions\/\d+$/u, ["key", "name", "version", "startStepId", "steps"] ],
  [ /^\/flows\/definitions\/\d+\/steps\/\d+$/u, [
    "id", "type", "message", "field", "required", "options", "nextStepId",
    "condition", "whenTrueStepId", "whenFalseStepId",
  ] ],
  [ /^\/flows\/definitions\/\d+\/steps\/\d+\/options\/\d+$/u, ["id", "label", "nextStepId"] ],
  [ /^\/flows\/definitions\/\d+\/steps\/\d+\/condition$/u, ["field", "operator", "value"] ],
  [ /^\/integrations\/\d+$/u, ["id", "type", "name", "enabled", "required", "credentialRefs"] ],
]);

const DRAFT_FREEFORM_PATHS = Object.freeze([
  /^\/menu\/options\/\d+\/params(?:\/.*)?$/u,
  /^\/routing\/aliases\/\d+\/params(?:\/.*)?$/u,
]);

function validateDraftShape(value, path = "") {
  if (!value || typeof value !== "object") return;
  if (DRAFT_FREEFORM_PATHS.some((pattern) => pattern.test(path))) return;
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) validateDraftShape(child, pointer(path, index));
    return;
  }
  const schema = DRAFT_OBJECT_SCHEMAS.find(([pattern]) => pattern.test(path));
  if (!schema) fail("UNKNOWN_FIELD", path || "/", "Este objeto não pertence ao schema V2.");
  allowedKeys(value, path, schema[1]);
  for (const [key, child] of Object.entries(value)) validateDraftShape(child, pointer(path, key));
}

export function parseTenantRuntimeConfigV2Draft(input) {
  let normalized;
  try {
    normalized = JSON.parse(stableJson(input));
  } catch {
    fail("INVALID_JSON", "/", "O rascunho deve conter somente JSON seguro e sem ciclos.");
  }
  rejectForbiddenFields(normalized);
  const object = plainObject(normalized, "");
  validateDraftShape(object);
  if (object.schemaVersion !== undefined && object.schemaVersion !== TENANT_RUNTIME_CONFIG_V2_SCHEMA_VERSION) {
    fail("UNSUPPORTED_SCHEMA_VERSION", "/schemaVersion", `schemaVersion deve ser ${TENANT_RUNTIME_CONFIG_V2_SCHEMA_VERSION}.`);
  }
  return deepFreeze({ ...object, schemaVersion: TENANT_RUNTIME_CONFIG_V2_SCHEMA_VERSION });
}

function text(value, path, { max = 1_000, optional = false } = {}) {
  if (optional && (value == null || value === "")) return undefined;
  if (typeof value !== "string") fail("INVALID_STRING", path, "Este campo deve ser um texto.");
  const normalized = value.trim();
  if (!normalized) fail("REQUIRED", path, "Este campo é obrigatório.");
  if (normalized.length > max) fail("MAX_LENGTH", path, `Este campo excede ${max} caracteres.`);
  return normalized;
}

function boolean(value, path, fallback) {
  if (value == null && fallback !== undefined) return fallback;
  if (typeof value !== "boolean") fail("INVALID_BOOLEAN", path, "Este campo deve ser verdadeiro ou falso.");
  return value;
}

function integer(value, path, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value == null && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("INVALID_INTEGER", path, `Este campo deve ser um inteiro entre ${min} e ${max}.`);
  }
  return value;
}

function amount(value, path, { optional = false } = {}) {
  if (optional && value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("INVALID_AMOUNT", path, "Este campo deve ser um número não negativo.");
  }
  return value;
}

function id(value, path) {
  const normalized = text(value, path, { max: 128 });
  if (!ID_PATTERN.test(normalized)) fail("INVALID_ID", path, "Este identificador possui formato inválido.");
  return normalized;
}

function reference(value, path, { optional = false, type } = {}) {
  const normalized = text(value, path, { max: 224, optional });
  if (normalized === undefined) return undefined;
  if (!REFERENCE_PATTERN.test(normalized)) {
    fail("INVALID_REFERENCE", path, "Use uma referência opaca no formato tipo:identificador.");
  }
  if (type && !normalized.startsWith(`${type}:`)) {
    fail("INVALID_REFERENCE_TYPE", path, `Esta referência deve ser do tipo ${type}.`);
  }
  return normalized;
}

function array(value, path, mapper, { optional = false, max = 1_000, min = 0 } = {}) {
  if (optional && value == null) return [];
  if (!Array.isArray(value)) fail("INVALID_ARRAY", path, "Este campo deve ser uma lista.");
  if (value.length < min) fail("MIN_ITEMS", path, `Esta lista deve conter ao menos ${min} item(ns).`);
  if (value.length > max) fail("MAX_ITEMS", path, `Esta lista excede ${max} itens.`);
  return value.map((item, index) => mapper(item, pointer(path, index)));
}

function unique(items, selector, path) {
  const seen = new Set();
  for (const item of items) {
    const key = selector(item);
    if (seen.has(key)) fail("DUPLICATE_VALUE", path, "Esta lista contém um valor duplicado.");
    seen.add(key);
  }
}

function parseLocale(value, path) {
  const normalized = text(value, path, { max: 40 });
  try {
    return Intl.getCanonicalLocales(normalized)[0];
  } catch {
    fail("INVALID_LOCALE", path, "O idioma deve usar uma localidade BCP 47 válida.");
  }
}

function parseTimezone(value, path) {
  const normalized = text(value, path, { max: 80 });
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: normalized }).format();
    return normalized;
  } catch {
    fail("INVALID_TIMEZONE", path, "O fuso horário deve usar um identificador IANA válido.");
  }
}

function safeJson(value, path, depth = 0) {
  if (depth > 6) fail("MAX_DEPTH_EXCEEDED", path, "Os parâmetros excedem a profundidade permitida.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) {
    if (value.length > 50) fail("MAX_ITEMS", path, "Os parâmetros excedem 50 itens.");
    return value.map((item, index) => safeJson(item, pointer(path, index), depth + 1));
  }
  const object = plainObject(value, path);
  const keys = Object.keys(object);
  if (keys.length > 50) fail("MAX_PROPERTIES", path, "Os parâmetros excedem 50 propriedades.");
  return Object.fromEntries(keys.sort().map((key) => [key, safeJson(object[key], pointer(path, key), depth + 1)]));
}

function optionalTexts(value, path, { maxItems = 100, maxText = 500 } = {}) {
  return array(value, path, (item, itemPath) => text(item, itemPath, { max: maxText }), { optional: true, max: maxItems });
}

function parseIdentity(value, path) {
  const object = plainObject(value, path);
  allowedKeys(object, path, [
    "name", "displayName", "publicIdentity", "segment", "locale", "timezone",
    "welcomeMessage", "fallbackMessage", "address", "schedules", "publicRules",
    "establishmentRules", "privacyPolicy", "consentText",
  ]);
  return {
    name: text(object.name, pointer(path, "name"), { max: 160 }),
    displayName: text(object.displayName ?? object.name, pointer(path, "displayName"), { max: 160 }),
    publicIdentity: text(object.publicIdentity, pointer(path, "publicIdentity"), { max: 1_000, optional: true }),
    segment: text(object.segment, pointer(path, "segment"), { max: 100, optional: true }),
    locale: parseLocale(object.locale ?? "pt-BR", pointer(path, "locale")),
    timezone: parseTimezone(object.timezone ?? "America/Sao_Paulo", pointer(path, "timezone")),
    welcomeMessage: text(object.welcomeMessage, pointer(path, "welcomeMessage"), { max: 1_000, optional: true }),
    fallbackMessage: text(object.fallbackMessage, pointer(path, "fallbackMessage"), { max: 1_000, optional: true }),
    address: text(object.address, pointer(path, "address"), { max: 500, optional: true }),
    schedules: optionalTexts(object.schedules, pointer(path, "schedules"), { maxItems: 50, maxText: 300 }),
    publicRules: optionalTexts(object.publicRules, pointer(path, "publicRules"), { maxItems: 100, maxText: 1_000 }),
    establishmentRules: text(object.establishmentRules, pointer(path, "establishmentRules"), { max: 10_000, optional: true }),
    privacyPolicy: text(object.privacyPolicy, pointer(path, "privacyPolicy"), { max: 10_000, optional: true }),
    consentText: text(object.consentText, pointer(path, "consentText"), { max: 2_000, optional: true }),
  };
}

function parseRetention(value, path) {
  const object = plainObject(value, path, { optional: true });
  allowedKeys(object, path, ["messagesDays", "logsDays"]);
  return {
    messagesDays: integer(object.messagesDays, pointer(path, "messagesDays"), { min: 1, max: 3_650, fallback: 365 }),
    logsDays: integer(object.logsDays, pointer(path, "logsDays"), { min: 1, max: 3_650, fallback: 90 }),
  };
}

function parseModules(value, path) {
  const modules = array(value, path, (item, itemPath) => {
    const key = text(item, itemPath, { max: 50 });
    if (!CAPABILITY_KEYS_V2.includes(key)) fail("UNKNOWN_CAPABILITY", itemPath, "Esta capacidade não existe no catálogo V2.");
    return key;
  }, { min: 1, max: CAPABILITY_KEYS_V2.length });
  unique(modules, (key) => key, path);
  const enabled = new Set(modules);
  for (const key of modules) {
    for (const dependency of capabilityDefinitionV2(key).dependencies) {
      if (!enabled.has(dependency)) {
        fail("CAPABILITY_DEPENDENCY_MISSING", path, `A capacidade ${key} requer ${dependency}.`);
      }
    }
  }
  return CAPABILITY_KEYS_V2.filter((key) => enabled.has(key));
}

function parseMenu(value, path, enabled) {
  const object = plainObject(value, path);
  allowedKeys(object, path, ["text", "options"]);
  const options = array(object.options, pointer(path, "options"), (entry, entryPath) => {
    const option = plainObject(entry, entryPath);
    allowedKeys(option, entryPath, ["id", "label", "action", "params", "transportId"]);
    const action = text(option.action, pointer(entryPath, "action"), { max: 100 });
    const owner = actionOwnerV2(action);
    if (!owner) fail("UNKNOWN_ACTION", pointer(entryPath, "action"), "Selecione uma ação existente no catálogo.");
    if (!enabled.has(owner)) fail("ACTION_CAPABILITY_DISABLED", pointer(entryPath, "action"), "A capacidade desta ação não está habilitada.");
    const params = option.params == null ? {} : safeJson(option.params, pointer(entryPath, "params"));
    const paramsValidation = validateActionParamsV2(action, params, { context: "menu" });
    if (!paramsValidation.valid) {
      fail(paramsValidation.code, paramsValidation.field ? pointer(pointer(entryPath, "params"), paramsValidation.field) : pointer(entryPath, "action"), "Os parâmetros ou o contexto desta ação são inválidos.");
    }
    return {
      id: id(option.id, pointer(entryPath, "id")),
      label: text(option.label, pointer(entryPath, "label"), { max: 80 }),
      action,
      params,
      transportId: `cfg:${configurationChecksum({ action, params, position: Number(entryPath.split("/").at(-1)) }).slice(0, 24)}`,
    };
  }, { min: 1, max: 30 });
  unique(options, (option) => option.id, pointer(path, "options"));
  return {
    text: text(object.text, pointer(path, "text"), { max: 1_000, optional: true }),
    options,
  };
}

function parseRouting(value, path, enabled) {
  const object = plainObject(value, path, { optional: true });
  allowedKeys(object, path, ["greetings", "aliases", "fallbackAction"]);
  const greetings = optionalTexts(object.greetings, pointer(path, "greetings"), { maxItems: 100, maxText: 160 });
  unique(greetings.map((item) => item.toLocaleLowerCase("pt-BR")), (item) => item, pointer(path, "greetings"));
  const aliases = array(object.aliases, pointer(path, "aliases"), (entry, entryPath) => {
    const alias = plainObject(entry, entryPath);
    allowedKeys(alias, entryPath, ["terms", "action", "params"]);
    const action = text(alias.action, pointer(entryPath, "action"), { max: 100 });
    const owner = actionOwnerV2(action);
    if (!owner) fail("UNKNOWN_ACTION", pointer(entryPath, "action"), "Selecione uma ação existente no catálogo.");
    if (!enabled.has(owner)) fail("ACTION_CAPABILITY_DISABLED", pointer(entryPath, "action"), "A capacidade desta ação não está habilitada.");
    const rawTerms = optionalTexts(alias.terms, pointer(entryPath, "terms"), { maxItems: 50, maxText: 160 });
    const ownTerms = new Set();
    const terms = rawTerms.filter((term) => {
      const normalized = term.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
      if (ownTerms.has(normalized)) return false;
      ownTerms.add(normalized);
      return true;
    });
    if (terms.length === 0) fail("MIN_ITEMS", pointer(entryPath, "terms"), "Informe ao menos um termo.");
    const params = alias.params == null ? {} : safeJson(alias.params, pointer(entryPath, "params"));
    const paramsValidation = validateActionParamsV2(action, params, { context: "alias" });
    if (!paramsValidation.valid) {
      fail(paramsValidation.code, paramsValidation.field ? pointer(pointer(entryPath, "params"), paramsValidation.field) : pointer(entryPath, "action"), "Os parâmetros ou o contexto desta ação são inválidos.");
    }
    return {
      terms,
      action,
      params,
    };
  }, { optional: true, max: 200 });
  const claimedTerms = new Set(greetings.map((item) => item.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR")));
  for (const alias of aliases) {
    for (const term of alias.terms) {
      const normalized = term.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
      if (claimedTerms.has(normalized)) fail("AMBIGUOUS_ALIAS", pointer(path, "aliases"), "Um termo está duplicado ou conflita com uma saudação.");
      claimedTerms.add(normalized);
    }
  }
  let fallbackAction = null;
  if (object.fallbackAction != null && object.fallbackAction !== "") {
    fallbackAction = text(object.fallbackAction, pointer(path, "fallbackAction"), { max: 100 });
    const owner = actionOwnerV2(fallbackAction);
    if (!owner) fail("UNKNOWN_ACTION", pointer(path, "fallbackAction"), "Selecione uma ação existente no catálogo.");
    if (!enabled.has(owner)) fail("ACTION_CAPABILITY_DISABLED", pointer(path, "fallbackAction"), "A capacidade desta ação não está habilitada.");
    const contextValidation = validateActionParamsV2(fallbackAction, {}, { context: "fallback" });
    if (!contextValidation.valid) fail("ACTION_CONTEXT_FORBIDDEN", pointer(path, "fallbackAction"), "Esta ação não pode ser usada como fallback.");
  }
  return { greetings, aliases, fallbackAction };
}

function parsePublicReplies(value, path, enabled) {
  const replies = array(value, path, (entry, entryPath) => {
    const reply = plainObject(entry, entryPath);
    allowedKeys(reply, entryPath, ["action", "text"]);
    const action = text(reply.action, pointer(entryPath, "action"), { max: 100 });
    if (!ACTION_PATTERN.test(action)) fail("INVALID_ACTION", pointer(entryPath, "action"), "A ação possui formato inválido.");
    const owner = actionOwnerV2(action);
    if (!owner) fail("UNKNOWN_ACTION", pointer(entryPath, "action"), "A resposta deve usar uma ação existente no catálogo.");
    if (!enabled.has(owner)) fail("ACTION_CAPABILITY_DISABLED", pointer(entryPath, "action"), "A capacidade desta ação não está habilitada.");
    return { action, text: text(reply.text, pointer(entryPath, "text"), { max: 2_000 }) };
  }, { optional: true, max: 200 });
  unique(replies, (reply) => reply.action, path);
  return replies;
}

function parseCatalog(value, path) {
  const object = plainObject(value, path, { optional: true });
  allowedKeys(object, path, ["items"]);
  const items = array(object.items, pointer(path, "items"), (entry, entryPath) => {
    const item = plainObject(entry, entryPath);
    allowedKeys(item, entryPath, ["id", "name", "description", "price", "active"]);
    return {
      id: id(item.id, pointer(entryPath, "id")),
      name: text(item.name, pointer(entryPath, "name"), { max: 160 }),
      description: text(item.description, pointer(entryPath, "description"), { max: 500, optional: true }),
      price: amount(item.price, pointer(entryPath, "price"), { optional: true }),
      active: boolean(item.active, pointer(entryPath, "active"), true),
    };
  }, { optional: true });
  unique(items, (item) => item.id, pointer(path, "items"));
  return { items };
}

function parseEvents(value, path) {
  const object = plainObject(value, path, { optional: true });
  allowedKeys(object, path, ["items", "presentation"]);
  const items = array(object.items, pointer(path, "items"), (entry, entryPath) => {
    const item = plainObject(entry, entryPath);
    allowedKeys(item, entryPath, [
      "id", "name", "startsAt", "timezone", "attractions", "description",
      "vipRule", "birthdayRule", "location", "price", "active",
    ]);
    return {
      id: id(item.id, pointer(entryPath, "id")),
      name: text(item.name, pointer(entryPath, "name"), { max: 160 }),
      startsAt: text(item.startsAt, pointer(entryPath, "startsAt"), { max: 80 }),
      timezone: item.timezone == null ? undefined : parseTimezone(item.timezone, pointer(entryPath, "timezone")),
      attractions: text(item.attractions, pointer(entryPath, "attractions"), { max: 1_000, optional: true }),
      description: text(item.description, pointer(entryPath, "description"), { max: 500, optional: true }),
      vipRule: text(item.vipRule, pointer(entryPath, "vipRule"), { max: 1_000, optional: true }),
      birthdayRule: text(item.birthdayRule, pointer(entryPath, "birthdayRule"), { max: 1_000, optional: true }),
      location: text(item.location, pointer(entryPath, "location"), { max: 500, optional: true }),
      price: amount(item.price, pointer(entryPath, "price")),
      active: boolean(item.active, pointer(entryPath, "active"), true),
    };
  }, { optional: true });
  unique(items, (item) => item.id, pointer(path, "items"));
  const presentationInput = plainObject(object.presentation, pointer(path, "presentation"), { optional: true });
  allowedKeys(presentationInput, pointer(path, "presentation"), ["intro", "emptyMessage", "includeDescription"]);
  return {
    items,
    presentation: {
      intro: text(presentationInput.intro, pointer(pointer(path, "presentation"), "intro"), { max: 1_000, optional: true }),
      emptyMessage: text(presentationInput.emptyMessage, pointer(pointer(path, "presentation"), "emptyMessage"), { max: 1_000, optional: true }),
      includeDescription: boolean(presentationInput.includeDescription, pointer(pointer(path, "presentation"), "includeDescription"), false),
    },
  };
}

function parseAppointments(value, path) {
  const object = plainObject(value, path, { optional: true });
  allowedKeys(object, path, ["services"]);
  const services = array(object.services, pointer(path, "services"), (entry, entryPath) => {
    const service = plainObject(entry, entryPath);
    allowedKeys(service, entryPath, ["id", "name", "description", "active", "slots"]);
    const slots = array(service.slots, pointer(entryPath, "slots"), (slotEntry, slotPath) => {
      const slot = plainObject(slotEntry, slotPath);
      allowedKeys(slot, slotPath, ["id", "label", "startsAt", "available"]);
      return {
        id: id(slot.id, pointer(slotPath, "id")),
        label: text(slot.label, pointer(slotPath, "label"), { max: 120 }),
        startsAt: text(slot.startsAt, pointer(slotPath, "startsAt"), { max: 80, optional: true }),
        available: boolean(slot.available, pointer(slotPath, "available"), true),
      };
    }, { optional: true });
    unique(slots, (slot) => slot.id, pointer(entryPath, "slots"));
    return {
      id: id(service.id, pointer(entryPath, "id")),
      name: text(service.name, pointer(entryPath, "name"), { max: 160 }),
      description: text(service.description, pointer(entryPath, "description"), { max: 500, optional: true }),
      active: boolean(service.active, pointer(entryPath, "active"), true),
      slots,
    };
  }, { optional: true });
  unique(services, (service) => service.id, pointer(path, "services"));
  return { services };
}

function parsePayments(value, path) {
  const object = plainObject(value, path, { optional: true });
  allowedKeys(object, path, ["credentialRef", "integrationRef"]);
  return {
    credentialRef: reference(object.credentialRef, pointer(path, "credentialRef"), { optional: true, type: "credential" }),
    integrationRef: reference(object.integrationRef, pointer(path, "integrationRef"), { optional: true, type: "integration" }),
  };
}

function parseOrders(value, path) {
  const object = plainObject(value, path, { optional: true });
  allowedKeys(object, path, [
    "pendingStatus", "selectionPrompt", "paymentPrompt", "receiptPrompt", "namePrompt", "successMessage",
  ]);
  return {
    pendingStatus: text(object.pendingStatus ?? "Aguardando conferência", pointer(path, "pendingStatus"), { max: 80 }),
    selectionPrompt: text(object.selectionPrompt, pointer(path, "selectionPrompt"), { max: 500, optional: true }),
    paymentPrompt: text(object.paymentPrompt, pointer(path, "paymentPrompt"), { max: 500, optional: true }),
    receiptPrompt: text(object.receiptPrompt, pointer(path, "receiptPrompt"), { max: 500, optional: true }),
    namePrompt: text(object.namePrompt, pointer(path, "namePrompt"), { max: 500, optional: true }),
    successMessage: text(object.successMessage, pointer(path, "successMessage"), { max: 1_000, optional: true }),
  };
}

function parseHumanHandoff(value, path) {
  const object = plainObject(value, path, { optional: true });
  allowedKeys(object, path, ["message", "channel", "assigneeRef"]);
  return {
    message: text(object.message, pointer(path, "message"), { max: 1_000, optional: true }),
    channel: text(object.channel, pointer(path, "channel"), { max: 300, optional: true }),
    assigneeRef: reference(object.assigneeRef, pointer(path, "assigneeRef"), { optional: true, type: "user" }),
  };
}

function parseAi(value, path) {
  const object = plainObject(value, path, { optional: true });
  allowedKeys(object, path, [
    "enabled", "provider", "model", "personality", "prompt", "maxOutputTokens",
    "monthlyTokenLimit", "monthlyCostLimit", "keyMode", "credentialRef", "fallbackMessage", "followUpQuestion",
  ]);
  const enabled = boolean(object.enabled, pointer(path, "enabled"), false);
  const keyMode = object.keyMode == null ? "shared" : text(object.keyMode, pointer(path, "keyMode"), { max: 20 });
  if (!["shared", "own", "simulated"].includes(keyMode)) {
    fail("INVALID_AI_KEY_MODE", pointer(path, "keyMode"), "keyMode deve ser shared, own ou simulated.");
  }
  return {
    enabled,
    provider: text(object.provider, pointer(path, "provider"), { max: 80, optional: true }),
    model: text(object.model, pointer(path, "model"), { max: 120, optional: true }),
    personality: text(object.personality, pointer(path, "personality"), { max: 2_000, optional: true }),
    prompt: text(object.prompt, pointer(path, "prompt"), { max: 20_000, optional: true }),
    maxOutputTokens: integer(object.maxOutputTokens, pointer(path, "maxOutputTokens"), { min: 1, max: 16_384, fallback: 800 }),
    monthlyTokenLimit: integer(object.monthlyTokenLimit, pointer(path, "monthlyTokenLimit"), { min: 1, max: 1_000_000_000, fallback: 1_000_000 }),
    monthlyCostLimit: amount(object.monthlyCostLimit ?? 100, pointer(path, "monthlyCostLimit")),
    keyMode,
    credentialRef: reference(object.credentialRef, pointer(path, "credentialRef"), { optional: true, type: "credential" }),
    fallbackMessage: text(object.fallbackMessage, pointer(path, "fallbackMessage"), { max: 1_000, optional: true }),
    followUpQuestion: text(object.followUpQuestion, pointer(path, "followUpQuestion"), { max: 300, optional: true }),
  };
}

function simpleConditionValue(value, path) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value === "string" && value.length <= 500) return value.normalize("NFC");
  fail("INVALID_FLOW_CONDITION", path, "O valor de equals deve ser texto curto, número, booleano ou nulo.");
}

function parseFlowStep(value, path) {
  const step = plainObject(value, path);
  allowedKeys(step, path, [
    "id", "type", "message", "field", "required", "options", "nextStepId",
    "condition", "whenTrueStepId", "whenFalseStepId",
  ]);
  const type = text(step.type, pointer(path, "type"), { max: 40 });
  if (!FLOW_STEP_TYPES.has(type)) fail("UNKNOWN_FLOW_STEP_TYPE", pointer(path, "type"), "Este tipo de etapa não é permitido.");
  const options = array(step.options, pointer(path, "options"), (entry, entryPath) => {
    const option = plainObject(entry, entryPath);
    allowedKeys(option, entryPath, ["id", "label", "nextStepId"]);
    return {
      id: id(option.id, pointer(entryPath, "id")),
      label: text(option.label, pointer(entryPath, "label"), { max: 120 }),
      nextStepId: id(option.nextStepId, pointer(entryPath, "nextStepId")),
    };
  }, { optional: true, max: 30 });
  unique(options, (option) => option.id, pointer(path, "options"));
  let condition;
  if (step.condition != null) {
    const input = plainObject(step.condition, pointer(path, "condition"));
    allowedKeys(input, pointer(path, "condition"), ["field", "operator", "value"]);
    const operator = text(input.operator, pointer(pointer(path, "condition"), "operator"), { max: 20 });
    if (!["equals", "present", "absent"].includes(operator)) {
      fail("INVALID_FLOW_CONDITION", pointer(pointer(path, "condition"), "operator"), "A condição deve usar equals, present ou absent.");
    }
    if (operator !== "equals" && input.value !== undefined) {
      fail("INVALID_FLOW_CONDITION", pointer(pointer(path, "condition"), "value"), "Somente equals aceita um valor.");
    }
    condition = {
      field: id(input.field, pointer(pointer(path, "condition"), "field")),
      operator,
      value: operator === "equals" ? simpleConditionValue(input.value, pointer(pointer(path, "condition"), "value")) : undefined,
    };
  }
  return {
    id: id(step.id, pointer(path, "id")),
    type,
    message: text(step.message, pointer(path, "message"), { max: 2_000, optional: true }),
    field: step.field == null ? undefined : id(step.field, pointer(path, "field")),
    required: boolean(step.required, pointer(path, "required"), false),
    options,
    nextStepId: step.nextStepId == null ? undefined : id(step.nextStepId, pointer(path, "nextStepId")),
    condition,
    whenTrueStepId: step.whenTrueStepId == null ? undefined : id(step.whenTrueStepId, pointer(path, "whenTrueStepId")),
    whenFalseStepId: step.whenFalseStepId == null ? undefined : id(step.whenFalseStepId, pointer(path, "whenFalseStepId")),
  };
}

function parseFlows(value, path) {
  const object = plainObject(value, path, { optional: true });
  allowedKeys(object, path, ["definitions"]);
  const definitions = array(object.definitions, pointer(path, "definitions"), (entry, entryPath) => {
    const flow = plainObject(entry, entryPath);
    allowedKeys(flow, entryPath, ["key", "name", "version", "startStepId", "steps"]);
    const steps = array(flow.steps, pointer(entryPath, "steps"), parseFlowStep, { min: 2, max: 200 });
    unique(steps, (step) => step.id, pointer(entryPath, "steps"));
    const stepIds = new Set(steps.map((step) => step.id));
    const startStepId = id(flow.startStepId, pointer(entryPath, "startStepId"));
    if (!stepIds.has(startStepId)) fail("FLOW_START_MISSING", pointer(entryPath, "startStepId"), "A etapa inicial não existe neste fluxo.");
    if (!steps.some((step) => step.type === "completion")) {
      fail("FLOW_COMPLETION_MISSING", pointer(entryPath, "steps"), "O fluxo deve possuir uma etapa de conclusão.");
    }
    for (const [index, step] of steps.entries()) {
      const refs = [step.nextStepId, step.whenTrueStepId, step.whenFalseStepId, ...step.options.map((option) => option.nextStepId)].filter(Boolean);
      for (const target of refs) {
        if (!stepIds.has(target)) fail("FLOW_TARGET_MISSING", pointer(pointer(entryPath, "steps"), index), "Uma etapa de destino não existe neste fluxo.");
      }
      if (step.type === "condition" && (!step.condition || !step.whenTrueStepId || !step.whenFalseStepId)) {
        fail("INVALID_FLOW_CONDITION", pointer(pointer(entryPath, "steps"), index), "Uma condição exige condição e dois destinos.");
      }
      if (step.type === "single_choice" && step.options.length === 0) {
        fail("FLOW_OPTIONS_MISSING", pointer(pointer(pointer(entryPath, "steps"), index), "options"), "Uma escolha única exige opções.");
      }
    }
    const definition = {
      key: id(flow.key, pointer(entryPath, "key")),
      name: text(flow.name, pointer(entryPath, "name"), { max: 160 }),
      version: integer(flow.version, pointer(entryPath, "version"), { min: 1, max: 1_000_000, fallback: 1 }),
      startStepId,
      steps,
    };
    try {
      return parseFlowDefinition(JSON.parse(JSON.stringify(definition)));
    } catch (error) {
      if (!(error instanceof FlowDefinitionValidationError)) throw error;
      const first = error.issues[0];
      const nestedPath = first?.path && first.path !== "/" ? first.path : "";
      fail(first?.code || "FLOW_DEFINITION_INVALID", `${entryPath}${nestedPath}`, first?.message || "A definição do fluxo é inválida.");
    }
  }, { optional: true, max: 100 });
  unique(definitions, (flow) => flow.key, pointer(path, "definitions"));
  return { definitions };
}

function parseIntegrations(value, path) {
  const integrations = array(value, path, (entry, entryPath) => {
    const integration = plainObject(entry, entryPath);
    allowedKeys(integration, entryPath, ["id", "type", "name", "enabled", "required", "credentialRefs"]);
    const credentialRefs = array(integration.credentialRefs, pointer(entryPath, "credentialRefs"), (item, itemPath) => reference(item, itemPath, { type: "credential" }), { optional: true, max: 20 });
    unique(credentialRefs, (item) => item, pointer(entryPath, "credentialRefs"));
    return {
      id: id(integration.id, pointer(entryPath, "id")),
      type: id(integration.type, pointer(entryPath, "type")),
      name: text(integration.name, pointer(entryPath, "name"), { max: 160 }),
      enabled: boolean(integration.enabled, pointer(entryPath, "enabled"), true),
      required: boolean(integration.required, pointer(entryPath, "required"), false),
      credentialRefs,
    };
  }, { optional: true, max: 100 });
  unique(integrations, (integration) => integration.id, path);
  return integrations;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .map(([key, child]) => [key, stripUndefined(child)]));
}

export function parseTenantRuntimeConfigV2(input) {
  try {
    stableJson(input);
  } catch {
    fail("INVALID_JSON", "/", "A configuração deve conter somente JSON seguro e sem ciclos.");
  }
  rejectForbiddenFields(input);
  const object = plainObject(input, "");
  allowedKeys(object, "", [
    "schemaVersion", "identity", "retention", "modules",
    "menu", "routing", "publicReplies", "catalog", "events", "appointments", "payments",
    "orders", "humanHandoff", "ai", "flows", "integrations",
  ]);
  if (object.schemaVersion !== TENANT_RUNTIME_CONFIG_V2_SCHEMA_VERSION) {
    fail("UNSUPPORTED_SCHEMA_VERSION", "/schemaVersion", `schemaVersion deve ser ${TENANT_RUNTIME_CONFIG_V2_SCHEMA_VERSION}.`);
  }
  const modules = parseModules(object.modules, "/modules");
  const enabled = new Set(modules);
  const parsed = {
    schemaVersion: TENANT_RUNTIME_CONFIG_V2_SCHEMA_VERSION,
    identity: parseIdentity(object.identity, "/identity"),
    retention: parseRetention(object.retention, "/retention"),
    modules,
    menu: parseMenu(object.menu, "/menu", enabled),
    routing: parseRouting(object.routing, "/routing", enabled),
    publicReplies: parsePublicReplies(object.publicReplies, "/publicReplies", enabled),
    catalog: parseCatalog(object.catalog, "/catalog"),
    events: parseEvents(object.events, "/events"),
    appointments: parseAppointments(object.appointments, "/appointments"),
    payments: parsePayments(object.payments, "/payments"),
    orders: parseOrders(object.orders, "/orders"),
    humanHandoff: parseHumanHandoff(object.humanHandoff, "/humanHandoff"),
    ai: parseAi(object.ai, "/ai"),
    flows: parseFlows(object.flows, "/flows"),
    integrations: parseIntegrations(object.integrations, "/integrations"),
  };

  if (enabled.has("payments") && !parsed.payments.credentialRef && !parsed.payments.integrationRef) {
    fail("PAYMENT_REFERENCE_REQUIRED", "/payments", "Pagamentos exigem uma referência de credencial ou integração.");
  }
  if (enabled.has("appointments") && !parsed.appointments.services.some((service) => service.active)) {
    fail("APPOINTMENT_SERVICE_REQUIRED", "/appointments/services", "Agendamentos exigem ao menos um serviço ativo.");
  }
  if (enabled.has("ai_freeform")) {
    if (!parsed.ai.enabled) fail("AI_CONFIGURATION_REQUIRED", "/ai/enabled", "A configuração de IA deve estar habilitada.");
    if (!parsed.ai.provider || !parsed.ai.model || !parsed.ai.prompt) {
      fail("AI_CONFIGURATION_REQUIRED", "/ai", "IA exige provedor, modelo e prompt público.");
    }
    if (!new Set(["shared", "own", "simulated"]).has(parsed.ai.keyMode)) fail("INVALID_AI_KEY_MODE", "/ai/keyMode", "keyMode deve ser shared, own ou simulated.");
    if (parsed.ai.keyMode === "own" && !parsed.ai.credentialRef) fail("AI_CREDENTIAL_REFERENCE_REQUIRED", "/ai/credentialRef", "IA com chave própria exige uma referência de credencial.");
    if (parsed.ai.keyMode !== "own" && parsed.ai.credentialRef) fail("AI_CREDENTIAL_REFERENCE_FORBIDDEN", "/ai/credentialRef", "Somente keyMode own aceita referência de credencial.");
  }
  if (enabled.has("flows") && parsed.flows.definitions.length === 0) {
    fail("FLOW_DEFINITION_REQUIRED", "/flows/definitions", "A capacidade flows exige ao menos uma definição válida.");
  }
  if (!enabled.has("flows") && parsed.flows.definitions.length > 0) {
    fail("FLOW_CAPABILITY_DISABLED", "/flows/definitions", "Habilite flows antes de configurar definições.");
  }
  for (const [flowIndex, flow] of parsed.flows.definitions.entries()) {
    for (const [stepIndex, step] of flow.steps.entries()) {
      const interactiveLimit = step.required === true ? 10 : 9;
      if (step.type === "service_selection") {
        const activeServices = parsed.appointments.services.filter((service) => service.active !== false);
        if (activeServices.length > interactiveLimit) {
          fail(
            "FLOW_OPTIONS_LIMIT",
            `/flows/definitions/${flowIndex}/steps/${stepIndex}`,
            `A seleção de serviço excede ${interactiveLimit} opções interativas seguras.`,
          );
        }
      }
      if (step.type === "schedule_selection") {
        const oversizedService = parsed.appointments.services.find((service) => (
          service.active !== false
          && service.slots.filter((slot) => slot.available !== false).length > interactiveLimit
        ));
        if (oversizedService) {
          fail(
            "FLOW_OPTIONS_LIMIT",
            `/appointments/services/${parsed.appointments.services.indexOf(oversizedService)}/slots`,
            `A seleção de horário excede ${interactiveLimit} opções interativas seguras.`,
          );
        }
      }
    }
  }
  const knownFlowRefs = new Set(parsed.flows.definitions.map((flow) => `flow:${flow.key}`));
  const flowBindings = [
    ...parsed.menu.options.filter((option) => option.action === "flows.start"),
    ...parsed.routing.aliases.filter((alias) => alias.action === "flows.start"),
  ];
  if (flowBindings.some((binding) => !knownFlowRefs.has(binding.params.flowRef))) {
    fail("FLOW_REFERENCE_UNKNOWN", "/flows/definitions", "Uma ação referencia um fluxo que não existe na configuração.");
  }
  return deepFreeze(stripUndefined(parsed));
}

export function validateTenantRuntimeConfigV2(input) {
  try {
    return Object.freeze({ valid: true, value: parseTenantRuntimeConfigV2(input), issues: Object.freeze([]) });
  } catch (error) {
    if (!(error instanceof ConfigurationValidationError)) throw error;
    return Object.freeze({ valid: false, value: null, issues: error.issues });
  }
}

export const FLOW_STEP_TYPES_V2 = Object.freeze([...FLOW_STEP_TYPES]);
