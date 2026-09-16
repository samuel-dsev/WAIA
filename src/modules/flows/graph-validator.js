import {
  FLOW_CONDITION_OPERATORS,
  FLOW_STEP_TYPES,
  FlowDefinitionValidationError,
} from "./contracts.js";
import { SafeJsonError, cloneSafeJson, deepFreeze, pointer } from "./safe-json.js";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u;
const TEMPLATE_PATTERNS = [/\{\{[^}]+\}\}/u, /\$\{[^}]+\}/u, /<%[^%]+%>/u];
const FORBIDDEN_FIELD_FRAGMENTS = ["secret", "password", "passwd", "token", "apikey", "privatekey", "credential", "pixkey"];
const INPUT_STEP_TYPES = new Set([
  "single_choice", "text", "name", "email", "phone", "date", "consent",
  "document", "service_selection", "schedule_selection",
]);
const AUTOMATIC_STEP_TYPES = new Set(["message", "condition"]);
const TERMINAL_STEP_TYPES = new Set(["completion", "handoff"]);
const FLOW_KEYS = ["key", "name", "version", "startStepId", "steps"];
const STEP_KEYS = [
  "id", "type", "message", "field", "required", "options", "nextStepId",
  "condition", "whenTrueStepId", "whenFalseStepId",
];
const OPTION_KEYS = ["id", "label", "nextStepId"];
const CONDITION_KEYS = ["field", "operator", "value"];

function issue(code, path, message) {
  return Object.freeze({ code, path: path || "/", severity: "error", message });
}

function fail(code, path, message) {
  throw new FlowDefinitionValidationError(issue(code, path, message));
}

function plainObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("FLOW_OBJECT_REQUIRED", path, "Este campo deve ser um objeto.");
  }
  return value;
}

function allowedKeys(value, path, allowed) {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) fail("FLOW_UNKNOWN_FIELD", pointer(path, key), "Este campo não pertence ao contrato de fluxos.");
  }
}

function requiredString(value, path, { max, pattern, templateSafe = false } = {}) {
  if (typeof value !== "string") fail("FLOW_STRING_REQUIRED", path, "Este campo deve ser um texto.");
  const normalized = value.trim().normalize("NFC");
  if (!normalized) fail("FLOW_REQUIRED", path, "Este campo é obrigatório.");
  if (max && normalized.length > max) fail("FLOW_MAX_LENGTH", path, `Este campo excede ${max} caracteres.`);
  if (pattern && !pattern.test(normalized)) fail("FLOW_INVALID_ID", path, "Este identificador possui formato inválido.");
  if (templateSafe && TEMPLATE_PATTERNS.some((candidate) => candidate.test(normalized))) {
    fail("FLOW_TEMPLATE_FORBIDDEN", path, "Templates livres não são permitidos em fluxos.");
  }
  return normalized;
}

function optionalString(value, path, options) {
  if (value == null || value === "") return undefined;
  return requiredString(value, path, options);
}

function id(value, path) {
  return requiredString(value, path, { max: 128, pattern: ID_PATTERN });
}

function fieldId(value, path) {
  const normalized = id(value, path);
  const compact = normalized.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/gu, "");
  if (FORBIDDEN_FIELD_FRAGMENTS.some((fragment) => compact.includes(fragment))) {
    fail("FLOW_SENSITIVE_FIELD_FORBIDDEN", path, "O fluxo não pode coletar credenciais ou segredos.");
  }
  return normalized;
}

function optionalBoolean(value, path) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") fail("FLOW_BOOLEAN_REQUIRED", path, "Este campo deve ser verdadeiro ou falso.");
  return value;
}

function simpleValue(value, path) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value === "string" && value.length <= 500) return value.normalize("NFC");
  fail("FLOW_CONDITION_VALUE_INVALID", path, "equals aceita apenas texto curto, número, booleano ou nulo.");
}

function parseOption(value, path) {
  const option = plainObject(value, path);
  allowedKeys(option, path, OPTION_KEYS);
  return {
    id: id(option.id, pointer(path, "id")),
    label: requiredString(option.label, pointer(path, "label"), { max: 120, templateSafe: true }),
    nextStepId: id(option.nextStepId, pointer(path, "nextStepId")),
  };
}

function parseCondition(value, path) {
  const condition = plainObject(value, path);
  allowedKeys(condition, path, CONDITION_KEYS);
  const operator = requiredString(condition.operator, pointer(path, "operator"), { max: 20 });
  if (!FLOW_CONDITION_OPERATORS.includes(operator)) {
    fail("FLOW_CONDITION_OPERATOR_INVALID", pointer(path, "operator"), "A condição deve usar equals, present ou absent.");
  }
  if (operator === "equals" && !Object.hasOwn(condition, "value")) {
    fail("FLOW_CONDITION_VALUE_REQUIRED", pointer(path, "value"), "equals exige um valor explícito.");
  }
  if (operator !== "equals" && Object.hasOwn(condition, "value")) {
    fail("FLOW_CONDITION_VALUE_FORBIDDEN", pointer(path, "value"), "Somente equals aceita um valor.");
  }
  const parsed = {
    field: fieldId(condition.field, pointer(path, "field")),
    operator,
  };
  if (operator === "equals") parsed.value = simpleValue(condition.value, pointer(path, "value"));
  return parsed;
}

function parseStep(value, path) {
  const step = plainObject(value, path);
  allowedKeys(step, path, STEP_KEYS);
  const type = requiredString(step.type, pointer(path, "type"), { max: 40 });
  if (!FLOW_STEP_TYPES.includes(type)) fail("FLOW_STEP_TYPE_INVALID", pointer(path, "type"), "Este tipo de etapa não é permitido.");
  if (step.options !== undefined && !Array.isArray(step.options)) {
    fail("FLOW_OPTIONS_INVALID", pointer(path, "options"), "As opções devem formar uma lista.");
  }
  const options = (step.options || []).map((option, index) => parseOption(option, pointer(pointer(path, "options"), index)));
  const optionLimit = step.required === true ? 10 : 9;
  if (options.length > optionLimit) {
    fail("FLOW_OPTIONS_LIMIT", pointer(path, "options"), `A etapa excede ${optionLimit} opções interativas seguras.`);
  }
  const optionIds = new Set();
  for (const option of options) {
    if (optionIds.has(option.id)) fail("FLOW_OPTION_DUPLICATE", pointer(path, "options"), "A etapa contém uma opção duplicada.");
    optionIds.add(option.id);
  }
  const parsed = {
    id: id(step.id, pointer(path, "id")),
    type,
    required: optionalBoolean(step.required, pointer(path, "required")),
    options,
  };
  const message = optionalString(step.message, pointer(path, "message"), { max: 2_000, templateSafe: true });
  const field = step.field === undefined ? undefined : fieldId(step.field, pointer(path, "field"));
  const nextStepId = step.nextStepId === undefined ? undefined : id(step.nextStepId, pointer(path, "nextStepId"));
  const whenTrueStepId = step.whenTrueStepId === undefined ? undefined : id(step.whenTrueStepId, pointer(path, "whenTrueStepId"));
  const whenFalseStepId = step.whenFalseStepId === undefined ? undefined : id(step.whenFalseStepId, pointer(path, "whenFalseStepId"));
  const condition = step.condition === undefined ? undefined : parseCondition(step.condition, pointer(path, "condition"));
  if (message !== undefined) parsed.message = message;
  if (field !== undefined) parsed.field = field;
  if (nextStepId !== undefined) parsed.nextStepId = nextStepId;
  if (condition !== undefined) parsed.condition = condition;
  if (whenTrueStepId !== undefined) parsed.whenTrueStepId = whenTrueStepId;
  if (whenFalseStepId !== undefined) parsed.whenFalseStepId = whenFalseStepId;

  if (type === "message") {
    if (!message) fail("FLOW_MESSAGE_REQUIRED", pointer(path, "message"), "Uma etapa de mensagem exige texto.");
    if (!nextStepId) fail("FLOW_NEXT_STEP_REQUIRED", pointer(path, "nextStepId"), "Uma etapa de mensagem exige destino.");
  } else if (type === "condition") {
    if (!condition || !whenTrueStepId || !whenFalseStepId) {
      fail("FLOW_CONDITION_INVALID", path, "Uma condição exige condição e os dois destinos.");
    }
  } else if (type === "single_choice") {
    if (!field) fail("FLOW_FIELD_REQUIRED", pointer(path, "field"), "Uma escolha exige o campo de resposta.");
    if (options.length === 0) fail("FLOW_OPTIONS_REQUIRED", pointer(path, "options"), "Uma escolha exige ao menos uma opção.");
    if (nextStepId) fail("FLOW_CHOICE_TARGET_AMBIGUOUS", pointer(path, "nextStepId"), "Use o destino de cada opção na escolha única.");
  } else if (INPUT_STEP_TYPES.has(type)) {
    if (!field) fail("FLOW_FIELD_REQUIRED", pointer(path, "field"), "Uma etapa de coleta exige o campo de resposta.");
    if (!nextStepId) fail("FLOW_NEXT_STEP_REQUIRED", pointer(path, "nextStepId"), "Uma etapa de coleta exige destino.");
  }

  if (type !== "single_choice" && options.length > 0) {
    fail("FLOW_OPTIONS_FORBIDDEN", pointer(path, "options"), "Somente escolha única aceita opções declaradas.");
  }
  if (!INPUT_STEP_TYPES.has(type) && parsed.required) {
    fail("FLOW_REQUIRED_FORBIDDEN", pointer(path, "required"), "required só pode ser usado em etapas de coleta.");
  }
  if (TERMINAL_STEP_TYPES.has(type) && (nextStepId || whenTrueStepId || whenFalseStepId)) {
    fail("FLOW_TERMINAL_TARGET_FORBIDDEN", path, "Etapas terminais não aceitam transições.");
  }
  return parsed;
}

function targets(step) {
  if (step.type === "condition") return [step.whenTrueStepId, step.whenFalseStepId];
  if (step.type === "single_choice") return step.options.map((option) => option.nextStepId);
  return step.nextStepId ? [step.nextStepId] : [];
}

function validateGraph(definition) {
  const byId = new Map(definition.steps.map((step) => [step.id, step]));
  if (!byId.has(definition.startStepId)) fail("FLOW_START_MISSING", "/startStepId", "A etapa inicial não existe.");
  if (!definition.steps.some((step) => step.type === "completion")) {
    fail("FLOW_COMPLETION_MISSING", "/steps", "O fluxo exige ao menos uma conclusão.");
  }
  for (const [index, step] of definition.steps.entries()) {
    for (const target of targets(step)) {
      if (!byId.has(target)) fail("FLOW_TARGET_MISSING", `/steps/${index}`, "Uma transição aponta para uma etapa inexistente.");
    }
  }

  const reachable = new Set();
  const queue = [definition.startStepId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (reachable.has(current)) continue;
    reachable.add(current);
    queue.push(...targets(byId.get(current)));
  }
  const unreachable = definition.steps.find((step) => !reachable.has(step.id));
  if (unreachable) fail("FLOW_STEP_UNREACHABLE", `/steps/${definition.steps.indexOf(unreachable)}`, "A etapa não é alcançável a partir do início.");

  const reverse = new Map(definition.steps.map((step) => [step.id, []]));
  for (const step of definition.steps) for (const target of targets(step)) reverse.get(target).push(step.id);
  const reachesTerminal = new Set();
  const terminalQueue = definition.steps.filter((step) => TERMINAL_STEP_TYPES.has(step.type)).map((step) => step.id);
  while (terminalQueue.length > 0) {
    const current = terminalQueue.shift();
    if (reachesTerminal.has(current)) continue;
    reachesTerminal.add(current);
    terminalQueue.push(...reverse.get(current));
  }
  const trapped = definition.steps.find((step) => !reachesTerminal.has(step.id));
  if (trapped) fail("FLOW_TERMINAL_UNREACHABLE", `/steps/${definition.steps.indexOf(trapped)}`, "A etapa não possui caminho até uma saída terminal.");

  const visited = new Set();
  const active = new Set();
  function visitAutomatic(stepId) {
    if (active.has(stepId)) fail("FLOW_AUTOMATIC_CYCLE", `/steps/${definition.steps.findIndex((step) => step.id === stepId)}`, "O fluxo contém um ciclo sem entrada do usuário.");
    if (visited.has(stepId)) return;
    const step = byId.get(stepId);
    if (!AUTOMATIC_STEP_TYPES.has(step.type)) return;
    active.add(stepId);
    for (const target of targets(step)) {
      if (AUTOMATIC_STEP_TYPES.has(byId.get(target).type)) visitAutomatic(target);
    }
    active.delete(stepId);
    visited.add(stepId);
  }
  for (const step of definition.steps) if (AUTOMATIC_STEP_TYPES.has(step.type)) visitAutomatic(step.id);
}

function parseDefinition(input) {
  let definition;
  try {
    definition = cloneSafeJson(input);
  } catch (error) {
    if (error instanceof SafeJsonError) fail(error.code, error.path, error.message);
    throw error;
  }
  const flow = plainObject(definition, "");
  allowedKeys(flow, "", FLOW_KEYS);
  if (!Array.isArray(flow.steps)) fail("FLOW_STEPS_REQUIRED", "/steps", "steps deve ser uma lista.");
  if (flow.steps.length < 2 || flow.steps.length > 200) {
    fail("FLOW_STEPS_LIMIT", "/steps", "O fluxo deve possuir entre 2 e 200 etapas.");
  }
  if (!Number.isSafeInteger(flow.version) || flow.version < 1 || flow.version > 1_000_000) {
    fail("FLOW_VERSION_INVALID", "/version", "A versão do fluxo deve ser um inteiro positivo.");
  }
  const steps = flow.steps.map((step, index) => parseStep(step, `/steps/${index}`));
  const stepIds = new Set();
  const fieldIds = new Set();
  for (const [index, step] of steps.entries()) {
    if (stepIds.has(step.id)) fail("FLOW_STEP_DUPLICATE", `/steps/${index}/id`, "O fluxo contém uma etapa duplicada.");
    stepIds.add(step.id);
    if (step.field) {
      if (fieldIds.has(step.field)) fail("FLOW_FIELD_DUPLICATE", `/steps/${index}/field`, "Cada campo de coleta deve ser definido uma única vez.");
      fieldIds.add(step.field);
    }
  }
  for (const [index, step] of steps.entries()) {
    if (step.type === "condition" && !fieldIds.has(step.condition.field)) {
      fail("FLOW_CONDITION_FIELD_UNKNOWN", `/steps/${index}/condition/field`, "A condição deve consultar um campo coletado pelo fluxo.");
    }
  }
  const parsed = {
    key: id(flow.key, "/key"),
    name: requiredString(flow.name, "/name", { max: 160, templateSafe: true }),
    version: flow.version,
    startStepId: id(flow.startStepId, "/startStepId"),
    steps,
  };
  validateGraph(parsed);
  return deepFreeze(parsed);
}

export function parseFlowDefinition(input) {
  return parseDefinition(input);
}

export function validateFlowDefinition(input) {
  try {
    return Object.freeze({ valid: true, definition: parseDefinition(input), issues: Object.freeze([]) });
  } catch (error) {
    if (!(error instanceof FlowDefinitionValidationError)) throw error;
    return Object.freeze({ valid: false, definition: null, issues: error.issues });
  }
}
