const definitions = [
  {
    key: "catalog",
    label: "Catálogo",
    description: "Produtos, serviços e respostas públicas do estabelecimento.",
    dependencies: [],
    actions: ["catalog.list", "catalog.address", "catalog.menu"],
  },
  {
    key: "orders",
    label: "Pedidos",
    description: "Compra determinística com conferência humana do pagamento.",
    dependencies: ["events", "payments"],
    actions: ["orders.start", "orders.select_event", "orders.continue"],
  },
  {
    key: "events",
    label: "Eventos",
    description: "Agenda pública, programação e regras de eventos.",
    dependencies: [],
    actions: ["events.list", "events.birthday_rule"],
  },
  {
    key: "appointments",
    label: "Agendamentos",
    description: "Seleção de serviço, horário e solicitação de agendamento.",
    dependencies: [],
    actions: [
      "appointments.start",
      "appointments.select_service",
      "appointments.select_slot",
      "appointments.continue",
    ],
  },
  {
    key: "payments",
    label: "Pagamentos",
    description: "Instruções de pagamento resolvidas por credencial do cofre.",
    dependencies: [],
    actions: ["payments.instructions"],
  },
  {
    key: "human_handoff",
    label: "Atendimento humano",
    description: "Pausa da automação e encaminhamento para a equipe.",
    dependencies: [],
    actions: ["human_handoff.request"],
  },
  {
    key: "ai_freeform",
    label: "IA para texto livre",
    description: "Respostas públicas limitadas pelas guardrails da plataforma.",
    dependencies: [],
    actions: ["ai_freeform.reply"],
  },
  {
    key: "external_integrations",
    label: "Integrações externas",
    description: "Conectores administrados e referenciados sem segredos na configuração.",
    dependencies: [],
    actions: ["external_integrations.run"],
  },
  {
    key: "flows",
    label: "Fluxos",
    description: "Triagens e coletas declarativas, sem código arbitrário.",
    dependencies: [],
    actions: ["flows.start", "flows.continue", "flows.cancel"],
  },
];

const ACTION_PARAMETER_SCHEMAS = Object.freeze({
  "catalog.list": {},
  "catalog.address": {},
  "catalog.menu": {},
  "orders.start": { page: { type: "integer", required: false, minimum: 1 } },
  "orders.select_event": { eventId: { type: "id", required: true } },
  "orders.continue": {},
  "events.list": { page: { type: "integer", required: false, minimum: 1 } },
  "events.birthday_rule": {},
  "appointments.start": { page: { type: "integer", required: false, minimum: 1 } },
  "appointments.select_service": { serviceId: { type: "id", required: true }, page: { type: "integer", required: false, minimum: 1 } },
  "appointments.select_slot": { slotId: { type: "id", required: true } },
  "appointments.continue": {},
  "payments.instructions": {},
  "human_handoff.request": {},
  "ai_freeform.reply": {},
  "external_integrations.run": { integrationId: { type: "id", required: true } },
  "flows.start": { flowRef: { type: "reference", referenceType: "flow", required: true } },
  "flows.continue": {},
  "flows.cancel": {},
});

const ACTION_CONTEXTS = Object.freeze({
  "orders.select_event": ["runtime"],
  "orders.continue": ["runtime"],
  "appointments.select_service": ["runtime"],
  "appointments.select_slot": ["runtime"],
  "appointments.continue": ["runtime"],
  "flows.continue": ["runtime"],
  "flows.cancel": ["runtime", "menu", "alias"],
  "external_integrations.run": ["runtime"],
  "ai_freeform.reply": ["alias", "runtime", "fallback"],
});

const DEFAULT_CONTEXTS = Object.freeze(["menu", "alias", "runtime"]);
const ACTION_LABELS = Object.freeze({
  "catalog.list": "Listar catálogo",
  "catalog.address": "Mostrar endereço",
  "catalog.menu": "Mostrar cardápio",
  "orders.start": "Iniciar compra",
  "orders.select_event": "Selecionar evento para compra",
  "orders.continue": "Continuar compra",
  "events.list": "Listar eventos",
  "events.birthday_rule": "Mostrar regra de aniversariante",
  "appointments.start": "Iniciar agendamento",
  "appointments.select_service": "Selecionar serviço",
  "appointments.select_slot": "Selecionar horário",
  "appointments.continue": "Continuar agendamento",
  "payments.instructions": "Mostrar instruções de pagamento",
  "human_handoff.request": "Solicitar atendimento humano",
  "ai_freeform.reply": "Responder com IA",
  "external_integrations.run": "Executar integração administrada",
  "flows.start": "Iniciar fluxo",
  "flows.continue": "Continuar fluxo",
  "flows.cancel": "Cancelar fluxo",
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const TENANT_RUNTIME_CONFIG_V2_SCHEMA_VERSION = 2;
export const CAPABILITY_CATALOG_V2 = deepFreeze(definitions.map((definition) => ({
  ...definition,
  dependencies: [...definition.dependencies],
  actions: [...definition.actions],
  actionDefinitions: definition.actions.map((key) => ({
    key,
    label: ACTION_LABELS[key],
    contexts: [...(ACTION_CONTEXTS[key] || DEFAULT_CONTEXTS)],
    parameters: { ...ACTION_PARAMETER_SCHEMAS[key] },
  })),
  reserved: definition.reserved === true,
})));

export const CAPABILITY_KEYS_V2 = Object.freeze(CAPABILITY_CATALOG_V2.map(({ key }) => key));
export const ACTION_KEYS_V2 = Object.freeze(CAPABILITY_CATALOG_V2.flatMap(({ actions }) => actions));

const capabilitiesByKey = new Map(CAPABILITY_CATALOG_V2.map((definition) => [definition.key, definition]));
const actionOwners = new Map(CAPABILITY_CATALOG_V2.flatMap((definition) => (
  definition.actions.map((action) => [action, definition.key])
)));

export function capabilityDefinitionV2(key) {
  return capabilitiesByKey.get(String(key || "")) || null;
}

export function actionOwnerV2(action) {
  return actionOwners.get(String(action || "")) || null;
}

export function actionDefinitionV2(action) {
  const key = String(action || "");
  const owner = actionOwners.get(key);
  if (!owner) return null;
  return capabilitiesByKey.get(owner).actionDefinitions.find((definition) => definition.key === key) || null;
}

function validId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(value);
}

function validReference(value, type) {
  return typeof value === "string"
    && new RegExp(`^${type}:[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,191}$`, "u").test(value);
}

export function validateActionParamsV2(action, params, { context = "runtime" } = {}) {
  const definition = actionDefinitionV2(action);
  if (!definition) return Object.freeze({ valid: false, code: "UNKNOWN_ACTION", field: null });
  if (!definition.contexts.includes(context)) {
    return Object.freeze({ valid: false, code: "ACTION_CONTEXT_FORBIDDEN", field: null });
  }
  if (!params || typeof params !== "object" || Array.isArray(params) || Object.getPrototypeOf(params) !== Object.prototype) {
    return Object.freeze({ valid: false, code: "INVALID_ACTION_PARAMS", field: null });
  }
  const schema = definition.parameters;
  for (const key of Object.keys(params)) {
    if (!Object.hasOwn(schema, key)) return Object.freeze({ valid: false, code: "UNKNOWN_ACTION_PARAM", field: key });
  }
  for (const [key, rule] of Object.entries(schema)) {
    const value = params[key];
    if (rule.required && (value == null || value === "")) {
      return Object.freeze({ valid: false, code: "ACTION_PARAM_REQUIRED", field: key });
    }
    if (value == null) continue;
    if (rule.type === "id" && !validId(value)) {
      return Object.freeze({ valid: false, code: "INVALID_ACTION_PARAM", field: key });
    }
    if (rule.type === "integer" && (!Number.isSafeInteger(value) || value < (rule.minimum || 0))) {
      return Object.freeze({ valid: false, code: "INVALID_ACTION_PARAM", field: key });
    }
    if (rule.type === "reference" && !validReference(value, rule.referenceType)) {
      return Object.freeze({ valid: false, code: "INVALID_ACTION_PARAM", field: key });
    }
  }
  return Object.freeze({ valid: true, code: null, field: null });
}

export function requiredCapabilitiesV2(keys) {
  const requested = new Set(Array.isArray(keys) ? keys : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...requested]) {
      const definition = capabilitiesByKey.get(key);
      if (!definition) continue;
      for (const dependency of definition.dependencies) {
        if (!requested.has(dependency)) {
          requested.add(dependency);
          changed = true;
        }
      }
    }
  }
  return Object.freeze(CAPABILITY_KEYS_V2.filter((key) => requested.has(key)));
}
