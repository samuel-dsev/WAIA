import {
  FLOW_ACTIONS,
  FLOW_ACTION_KEYS,
  FLOW_EXECUTION_SCHEMA_VERSION,
  FLOW_EXECUTION_STATUSES,
  FlowExecutionError,
} from "./contracts.js";
import { parseFlowDefinition } from "./graph-validator.js";
import { SafeJsonError, cloneSafeJson, deepFreeze } from "./safe-json.js";

const VERSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/u;
const DOCUMENT_REF_PATTERN = /^document:[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,191}$/u;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u;
const ANSWER_STEP_TYPES = new Set([
  "single_choice", "text", "name", "email", "phone", "date", "consent",
  "document", "service_selection", "schedule_selection",
]);
const STATE_KEYS = new Set([
  "schemaVersion", "flowKey", "flowVersion", "flowVersionId", "status",
  "currentStepId", "answers", "transitionCount",
]);

function executionError(code, message, details) {
  throw new FlowExecutionError(message, { code, details });
}

function safeState(input) {
  let state;
  try {
    state = cloneSafeJson(input);
  } catch (error) {
    if (error instanceof SafeJsonError) executionError("FLOW_STATE_INVALID", "O estado do fluxo não contém JSON seguro.");
    throw error;
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) executionError("FLOW_STATE_INVALID", "O estado do fluxo é obrigatório.");
  for (const key of Object.keys(state)) if (!STATE_KEYS.has(key)) executionError("FLOW_STATE_INVALID", "O estado contém um campo desconhecido.", { field: key });
  if (state.schemaVersion !== FLOW_EXECUTION_SCHEMA_VERSION) executionError("FLOW_STATE_VERSION_UNSUPPORTED", "A versão do estado do fluxo não é suportada.");
  if (typeof state.flowKey !== "string" || !ID_PATTERN.test(state.flowKey)) executionError("FLOW_STATE_INVALID", "O estado não identifica um fluxo válido.");
  if (!Number.isSafeInteger(state.flowVersion) || state.flowVersion < 1) executionError("FLOW_STATE_INVALID", "O estado não identifica uma versão válida.");
  if (typeof state.flowVersionId !== "string" || !VERSION_ID_PATTERN.test(state.flowVersionId)) executionError("FLOW_STATE_INVALID", "O estado não fixa uma revisão válida do fluxo.");
  if (!FLOW_EXECUTION_STATUSES.includes(state.status)) executionError("FLOW_STATE_INVALID", "O estado do fluxo possui status inválido.");
  if (typeof state.currentStepId !== "string" || !ID_PATTERN.test(state.currentStepId)) executionError("FLOW_STATE_INVALID", "O estado não identifica a etapa atual.");
  if (!state.answers || typeof state.answers !== "object" || Array.isArray(state.answers)) executionError("FLOW_STATE_INVALID", "As respostas do fluxo devem formar um objeto.");
  if (Object.keys(state.answers).length > 200) executionError("FLOW_STATE_INVALID", "O estado excede o limite de respostas.");
  for (const value of Object.values(state.answers)) {
    if (!(["string", "boolean"].includes(typeof value)) || (typeof value === "string" && value.length > 5_000)) {
      executionError("FLOW_STATE_INVALID", "O estado contém uma resposta fora do contrato serializável.");
    }
  }
  if (!Number.isSafeInteger(state.transitionCount) || state.transitionCount < 0 || state.transitionCount > 10_000) {
    executionError("FLOW_STATE_INVALID", "O contador de transições do fluxo é inválido.");
  }
  return state;
}

function flowIndex(definition) {
  return new Map(definition.steps.map((step) => [step.id, step]));
}

function assertPinnedDefinition(definition, state) {
  if (definition.key !== state.flowKey || definition.version !== state.flowVersion) {
    executionError("FLOW_VERSION_MISMATCH", "O estado está fixado em outra versão do fluxo.");
  }
  const knownFields = new Set(definition.steps.map((step) => step.field).filter(Boolean));
  const stepsByField = new Map(definition.steps.filter((step) => step.field).map((step) => [step.field, step]));
  for (const field of Object.keys(state.answers)) {
    if (!knownFields.has(field)) executionError("FLOW_STATE_ANSWER_UNKNOWN", "O estado contém uma resposta que não pertence à versão fixada.", { field });
    const step = stepsByField.get(field);
    const inputTypes = {
      single_choice: "selection",
      text: "text",
      name: "text",
      email: "text",
      phone: "text",
      date: "date",
      consent: "consent",
      document: "document",
      service_selection: "selection",
      schedule_selection: "selection",
    };
    try {
      const consumed = consumeInput(step, { type: inputTypes[step.type], value: state.answers[field] });
      if (!Object.is(consumed.answer, state.answers[field])) executionError("FLOW_STATE_ANSWER_INVALID", "O estado contém uma resposta não normalizada.", { field });
    } catch (error) {
      if (error instanceof FlowExecutionError && error.code !== "FLOW_STATE_ANSWER_INVALID") {
        executionError("FLOW_STATE_ANSWER_INVALID", "O estado contém uma resposta inválida para a versão fixada.", { field });
      }
      throw error;
    }
  }
}

function copyState(state, overrides = {}) {
  return {
    schemaVersion: state.schemaVersion,
    flowKey: state.flowKey,
    flowVersion: state.flowVersion,
    flowVersionId: state.flowVersionId,
    status: state.status,
    currentStepId: state.currentStepId,
    answers: { ...state.answers },
    transitionCount: state.transitionCount,
    ...overrides,
  };
}

function addTransition(state) {
  const transitionCount = state.transitionCount + 1;
  if (transitionCount > 10_000) executionError("FLOW_TRANSITION_LIMIT", "O fluxo excedeu o limite total de transições.");
  return copyState(state, { transitionCount });
}

function conditionMatches(condition, answers) {
  const present = Object.hasOwn(answers, condition.field) && answers[condition.field] !== null && answers[condition.field] !== "";
  if (condition.operator === "present") return present;
  if (condition.operator === "absent") return !present;
  return Object.hasOwn(answers, condition.field) && Object.is(answers[condition.field], condition.value);
}

function promptEffect(step) {
  const inputTypes = {
    single_choice: "selection",
    text: "text",
    name: "text",
    email: "text",
    phone: "text",
    date: "date",
    consent: "consent",
    document: "document",
    service_selection: "selection",
    schedule_selection: "selection",
  };
  const descriptor = {
    type: inputTypes[step.type],
    field: step.field,
    required: step.type === "single_choice" || step.required,
  };
  if (step.type === "single_choice") {
    descriptor.options = step.options.map(({ id, label }) => ({ id, label }));
  }
  const effect = { type: "prompt", stepId: step.id, input: descriptor };
  if (step.message) effect.text = step.message;
  return effect;
}

function advance(definition, state, startStepId) {
  const byId = flowIndex(definition);
  const effects = [];
  let current = startStepId;
  let nextState = state;
  let hops = 0;
  while (true) {
    hops += 1;
    if (hops > definition.steps.length + 1) executionError("FLOW_AUTOMATIC_TRANSITION_LIMIT", "O fluxo não alcançou uma etapa de espera com segurança.");
    const step = byId.get(current);
    if (!step) executionError("FLOW_STEP_NOT_FOUND", "A etapa atual não existe na versão fixada do fluxo.", { stepId: current });
    nextState = addTransition(copyState(nextState, { currentStepId: step.id }));
    if (step.type === "message") {
      effects.push({ type: "message", stepId: step.id, text: step.message });
      current = step.nextStepId;
      continue;
    }
    if (step.type === "condition") {
      current = conditionMatches(step.condition, nextState.answers) ? step.whenTrueStepId : step.whenFalseStepId;
      continue;
    }
    if (step.type === "completion") {
      if (step.message) effects.push({ type: "message", stepId: step.id, text: step.message });
      effects.push({ type: "completed", stepId: step.id });
      return { state: copyState(nextState, { status: "completed" }), effects };
    }
    if (step.type === "handoff") {
      if (step.message) effects.push({ type: "message", stepId: step.id, text: step.message });
      effects.push({ type: "handoff", stepId: step.id });
      return { state: copyState(nextState, { status: "handoff" }), effects };
    }
    if (!ANSWER_STEP_TYPES.has(step.type)) executionError("FLOW_STEP_UNSUPPORTED", "A etapa não pode ser executada.", { stepId: step.id });
    effects.push(promptEffect(step));
    return { state: copyState(nextState, { status: "waiting_input" }), effects };
  }
}

function normalizedInput(input) {
  let value;
  try {
    value = cloneSafeJson(input);
  } catch (error) {
    if (error instanceof SafeJsonError) executionError("FLOW_INPUT_INVALID", "A entrada não contém JSON seguro.");
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) executionError("FLOW_INPUT_REQUIRED", "A entrada do fluxo é obrigatória.");
  const allowed = new Set(["type", "value"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) executionError("FLOW_INPUT_INVALID", "A entrada contém um campo desconhecido.", { field: key });
  if (typeof value.type !== "string") executionError("FLOW_INPUT_INVALID", "A entrada deve informar seu tipo.");
  return value;
}

function requiredText(value, { code, message, max = 5_000 }) {
  if (typeof value !== "string") executionError(code, message);
  const normalized = value.trim().normalize("NFC");
  if (!normalized || normalized.length > max) executionError(code, message);
  return normalized;
}

function consumeInput(step, rawInput) {
  const input = normalizedInput(rawInput);
  if (input.type === "skip") {
    if (step.required || step.type === "single_choice") executionError("FLOW_INPUT_REQUIRED", "Esta etapa exige uma resposta.", { stepId: step.id });
    if (Object.hasOwn(input, "value")) executionError("FLOW_INPUT_INVALID", "skip não aceita valor.");
    return { skipped: true, nextStepId: step.nextStepId };
  }
  if (step.type === "single_choice") {
    if (input.type !== "selection") executionError("FLOW_INPUT_TYPE_MISMATCH", "Esta etapa exige uma seleção.");
    const selected = step.options.find((option) => option.id === input.value);
    if (!selected) executionError("FLOW_SELECTION_INVALID", "A opção selecionada não pertence à versão atual do fluxo.");
    return { answer: selected.id, nextStepId: selected.nextStepId };
  }
  if (step.type === "service_selection" || step.type === "schedule_selection") {
    if (input.type !== "selection" || typeof input.value !== "string" || !ID_PATTERN.test(input.value)) {
      executionError("FLOW_SELECTION_INVALID", "Esta etapa exige um identificador de seleção válido.");
    }
    return { answer: input.value, nextStepId: step.nextStepId };
  }
  if (["text", "name", "email", "phone"].includes(step.type)) {
    if (input.type !== "text") executionError("FLOW_INPUT_TYPE_MISMATCH", "Esta etapa exige texto.");
    const limits = { text: 5_000, name: 200, email: 320, phone: 32 };
    let answer = requiredText(input.value, { code: "FLOW_TEXT_INVALID", message: "O texto informado é inválido.", max: limits[step.type] });
    if (step.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(answer)) executionError("FLOW_EMAIL_INVALID", "Informe um e-mail válido.");
    if (step.type === "phone") {
      answer = answer.replace(/\D/gu, "");
      if (!/^[1-9][0-9]{7,14}$/u.test(answer)) executionError("FLOW_PHONE_INVALID", "Informe um telefone internacional válido.");
    }
    return { answer, nextStepId: step.nextStepId };
  }
  if (step.type === "date") {
    if (input.type !== "date" || typeof input.value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(input.value)) {
      executionError("FLOW_DATE_INVALID", "Informe uma data no formato YYYY-MM-DD.");
    }
    const date = new Date(`${input.value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input.value) executionError("FLOW_DATE_INVALID", "Informe uma data válida.");
    return { answer: input.value, nextStepId: step.nextStepId };
  }
  if (step.type === "consent") {
    if (input.type !== "consent" || typeof input.value !== "boolean") executionError("FLOW_CONSENT_INVALID", "O consentimento deve ser verdadeiro ou falso.");
    return { answer: input.value, nextStepId: step.nextStepId };
  }
  if (step.type === "document") {
    if (input.type !== "document" || typeof input.value !== "string" || !DOCUMENT_REF_PATTERN.test(input.value)) {
      executionError("FLOW_DOCUMENT_INVALID", "A etapa exige uma referência opaca de documento.");
    }
    return { answer: input.value, nextStepId: step.nextStepId };
  }
  executionError("FLOW_STEP_UNSUPPORTED", "A etapa atual não aceita entrada.", { stepId: step.id });
}

function finish(result) {
  return deepFreeze(cloneSafeJson(result));
}

export function startFlow({ definition: rawDefinition, flowVersionId } = {}) {
  const definition = parseFlowDefinition(rawDefinition);
  if (typeof flowVersionId !== "string" || !VERSION_ID_PATTERN.test(flowVersionId)) {
    executionError("FLOW_VERSION_ID_REQUIRED", "flowVersionId é obrigatório para fixar a execução em uma revisão imutável.");
  }
  const initial = {
    schemaVersion: FLOW_EXECUTION_SCHEMA_VERSION,
    flowKey: definition.key,
    flowVersion: definition.version,
    flowVersionId,
    status: "waiting_input",
    currentStepId: definition.startStepId,
    answers: {},
    transitionCount: 0,
  };
  return finish(advance(definition, initial, definition.startStepId));
}

export function continueFlow({ definition: rawDefinition, state: rawState, input } = {}) {
  const definition = parseFlowDefinition(rawDefinition);
  const state = safeState(rawState);
  assertPinnedDefinition(definition, state);
  if (state.status !== "waiting_input") executionError("FLOW_NOT_WAITING_INPUT", "O fluxo não está aguardando uma resposta.");
  const step = flowIndex(definition).get(state.currentStepId);
  if (!step || !ANSWER_STEP_TYPES.has(step.type)) executionError("FLOW_STATE_STEP_MISMATCH", "A etapa fixada no estado não aceita entrada.");
  const consumed = consumeInput(step, input);
  const answers = { ...state.answers };
  if (!consumed.skipped) answers[step.field] = consumed.answer;
  const nextState = copyState(state, { answers });
  return finish(advance(definition, nextState, consumed.nextStepId));
}

export function cancelFlow({ state: rawState } = {}) {
  const state = safeState(rawState);
  if (state.status !== "waiting_input") executionError("FLOW_NOT_CANCELLABLE", "Somente um fluxo em andamento pode ser cancelado.");
  return finish({
    state: copyState(state, { status: "cancelled" }),
    effects: [{ type: "cancelled", stepId: state.currentStepId }],
  });
}

export function executeFlowAction({ action, ...input } = {}) {
  if (!FLOW_ACTION_KEYS.includes(action)) executionError("FLOW_ACTION_UNKNOWN", "A ação de fluxo não existe.");
  if (action === FLOW_ACTIONS.START) return startFlow(input);
  if (action === FLOW_ACTIONS.CONTINUE) return continueFlow(input);
  return cancelFlow(input);
}
