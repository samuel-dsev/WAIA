import test from "node:test";
import assert from "node:assert/strict";
import {
  FLOW_ACTIONS,
  FLOW_ACTION_KEYS,
  FLOW_CONDITION_OPERATORS,
  FLOW_STEP_TYPES,
  FlowDefinitionValidationError,
  FlowExecutionError,
  cancelFlow,
  continueFlow,
  executeFlowAction,
  parseFlowDefinition,
  startFlow,
  validateFlowDefinition,
} from "../src/modules/flows/index.js";

function syntheticFlow(overrides = {}) {
  return {
    key: "synthetic_onboarding",
    name: "Triagem sintética completa",
    version: 3,
    startStepId: "welcome",
    steps: [
      { id: "welcome", type: "message", message: "Vamos iniciar.", required: false, options: [], nextStepId: "name" },
      { id: "name", type: "name", message: "Qual é seu nome?", field: "name", required: true, options: [], nextStepId: "email" },
      { id: "email", type: "email", message: "Qual é seu e-mail?", field: "email", required: true, options: [], nextStepId: "phone" },
      { id: "phone", type: "phone", message: "Qual é seu telefone?", field: "phone", required: true, options: [], nextStepId: "date" },
      { id: "date", type: "date", message: "Escolha a data.", field: "date", required: true, options: [], nextStepId: "consent" },
      { id: "consent", type: "consent", message: "Você concorda?", field: "consent", required: true, options: [], nextStepId: "document" },
      { id: "document", type: "document", message: "Envie o documento.", field: "document", required: true, options: [], nextStepId: "service" },
      { id: "service", type: "service_selection", message: "Escolha o serviço.", field: "service", required: true, options: [], nextStepId: "schedule" },
      { id: "schedule", type: "schedule_selection", message: "Escolha o horário.", field: "schedule", required: true, options: [], nextStepId: "route" },
      {
        id: "route", type: "single_choice", message: "Como deseja concluir?", field: "route", required: true,
        options: [
          { id: "finish", label: "Concluir", nextStepId: "notes" },
          { id: "human", label: "Atendimento humano", nextStepId: "notes" },
        ],
      },
      { id: "notes", type: "text", message: "Observações finais?", field: "notes", required: false, options: [], nextStepId: "route_condition" },
      {
        id: "route_condition", type: "condition", required: false, options: [],
        condition: { field: "route", operator: "equals", value: "human" },
        whenTrueStepId: "handoff", whenFalseStepId: "done",
      },
      { id: "handoff", type: "handoff", message: "Vou chamar uma pessoa.", required: false, options: [] },
      { id: "done", type: "completion", message: "Triagem concluída.", required: false, options: [] },
    ],
    ...overrides,
  };
}

test("contratos públicos mantêm apenas ações, tipos e operadores allowlisted", () => {
  assert.deepEqual(FLOW_ACTION_KEYS, ["flows.start", "flows.continue", "flows.cancel"]);
  assert.equal(FLOW_ACTIONS.START, "flows.start");
  assert.deepEqual(FLOW_CONDITION_OPERATORS, ["equals", "present", "absent"]);
  assert.deepEqual(FLOW_STEP_TYPES, [
    "message", "single_choice", "text", "name", "email", "phone", "date", "consent",
    "document", "service_selection", "schedule_selection", "handoff", "completion", "condition",
  ]);
  assert.ok(Object.isFrozen(FLOW_STEP_TYPES));
});

test("validador aceita diretamente o contrato V2 completo e devolve definição imutável", () => {
  const result = validateFlowDefinition(syntheticFlow());
  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0);
  assert.equal(result.definition.steps.length, 14);
  assert.ok(Object.isFrozen(result.definition));
  assert.ok(Object.isFrozen(result.definition.steps[0]));
  assert.deepEqual(JSON.parse(JSON.stringify(result.definition)), result.definition);
});

test("grafo falha fechado para código, templates, condições livres, destinos e ciclos automáticos", () => {
  assert.throws(
    () => parseFlowDefinition({ ...syntheticFlow(), script: "return true" }),
    (error) => error instanceof FlowDefinitionValidationError && error.issues[0].code === "FLOW_UNKNOWN_FIELD",
  );
  assert.throws(
    () => parseFlowDefinition(syntheticFlow({ name: "Executar {{codigo}}" })),
    (error) => error.issues[0].code === "FLOW_TEMPLATE_FORBIDDEN",
  );
  const arbitraryCondition = syntheticFlow();
  arbitraryCondition.steps[11].condition.operator = "javascript";
  assert.throws(
    () => parseFlowDefinition(arbitraryCondition),
    (error) => error.issues[0].code === "FLOW_CONDITION_OPERATOR_INVALID",
  );
  const missingTarget = syntheticFlow();
  missingTarget.steps[0].nextStepId = "missing";
  assert.equal(validateFlowDefinition(missingTarget).issues[0].code, "FLOW_TARGET_MISSING");

  const automaticCycle = {
    key: "cycle",
    name: "Ciclo",
    version: 1,
    startStepId: "a",
    steps: [
      { id: "a", type: "message", message: "A", nextStepId: "b" },
      { id: "b", type: "message", message: "B", nextStepId: "a" },
      { id: "done", type: "completion", message: "Fim" },
    ],
  };
  assert.equal(validateFlowDefinition(automaticCycle).issues[0].code, "FLOW_STEP_UNREACHABLE");

  const reachableAutomaticCycle = {
    key: "reachable_cycle",
    name: "Ciclo alcançável",
    version: 1,
    startStepId: "answer",
    steps: [
      { id: "answer", type: "text", field: "answer", required: true, nextStepId: "condition" },
      {
        id: "condition", type: "condition",
        condition: { field: "answer", operator: "equals", value: "loop" },
        whenTrueStepId: "message", whenFalseStepId: "done",
      },
      { id: "message", type: "message", message: "Reavaliar", nextStepId: "condition" },
      { id: "done", type: "completion", message: "Fim" },
    ],
  };
  assert.equal(validateFlowDefinition(reachableAutomaticCycle).issues[0].code, "FLOW_AUTOMATIC_CYCLE");
});

test("validador não executa getters e bloqueia coleta de credenciais", () => {
  const getter = syntheticFlow();
  Object.defineProperty(getter.steps[0], "script", {
    enumerable: true,
    get() { throw new Error("não deve executar"); },
  });
  assert.throws(
    () => parseFlowDefinition(getter),
    (error) => error.issues[0].code === "FLOW_JSON_ACCESSOR_FORBIDDEN",
  );
  const secretField = syntheticFlow();
  secretField.steps[1].field = "access_token";
  assert.throws(
    () => parseFlowDefinition(secretField),
    (error) => error.issues[0].code === "FLOW_SENSITIVE_FIELD_FORBIDDEN",
  );
});

test("executor percorre fluxo sintético completo, fixa versão e produz somente JSON serializável", () => {
  const definition = syntheticFlow();
  let result = executeFlowAction({ action: "flows.start", definition, flowVersionId: "flow-version:synthetic-v3" });
  assert.equal(result.state.flowVersionId, "flow-version:synthetic-v3");
  assert.equal(result.state.currentStepId, "name");
  assert.deepEqual(result.effects.map(({ type }) => type), ["message", "prompt"]);

  const answers = [
    { type: "text", value: "Pessoa Sintética" },
    { type: "text", value: "pessoa@example.invalid" },
    { type: "text", value: "+55 (11) 99999-9999" },
    { type: "date", value: "2026-09-15" },
    { type: "consent", value: true },
    { type: "document", value: "document:synthetic-1" },
    { type: "selection", value: "service-1" },
    { type: "selection", value: "slot-1" },
    { type: "selection", value: "finish" },
    { type: "skip" },
  ];
  for (const input of answers) result = continueFlow({ definition, state: result.state, input });
  assert.equal(result.state.status, "completed");
  assert.equal(result.state.currentStepId, "done");
  assert.deepEqual(result.effects.map(({ type }) => type), ["message", "completed"]);
  assert.deepEqual(result.state.answers, {
    consent: true,
    date: "2026-09-15",
    document: "document:synthetic-1",
    email: "pessoa@example.invalid",
    name: "Pessoa Sintética",
    phone: "5511999999999",
    route: "finish",
    schedule: "slot-1",
    service: "service-1",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.ok(Object.isFrozen(result.state.answers));
});

test("handoff, cancelamento e erros de entrada permanecem determinísticos", () => {
  const definition = syntheticFlow();
  let result = startFlow({ definition, flowVersionId: "flow-version:handoff-v3" });
  assert.throws(
    () => continueFlow({ definition, state: result.state, input: { type: "date", value: "2026-09-01" } }),
    (error) => error instanceof FlowExecutionError && error.code === "FLOW_INPUT_TYPE_MISMATCH",
  );
  result = cancelFlow({ state: result.state });
  assert.equal(result.state.status, "cancelled");
  assert.deepEqual(result.effects, [{ type: "cancelled", stepId: "name" }]);
  assert.throws(
    () => cancelFlow({ state: result.state }),
    (error) => error.code === "FLOW_NOT_CANCELLABLE",
  );
});

test("condições present e absent usam apenas respostas serializadas do fluxo", () => {
  const definition = {
    key: "presence",
    name: "Presença",
    version: 1,
    startStepId: "optional",
    steps: [
      { id: "optional", type: "text", field: "note", required: false, nextStepId: "present" },
      {
        id: "present", type: "condition",
        condition: { field: "note", operator: "present" },
        whenTrueStepId: "with_note", whenFalseStepId: "absent",
      },
      { id: "with_note", type: "completion", message: "Com observação" },
      {
        id: "absent", type: "condition",
        condition: { field: "note", operator: "absent" },
        whenTrueStepId: "without_note", whenFalseStepId: "with_note",
      },
      { id: "without_note", type: "completion", message: "Sem observação" },
    ],
  };
  const started = startFlow({ definition, flowVersionId: "flow-version:presence-v1" });
  const absent = continueFlow({ definition, state: started.state, input: { type: "skip" } });
  assert.equal(absent.state.currentStepId, "without_note");
  const present = continueFlow({ definition, state: started.state, input: { type: "text", value: "registrada" } });
  assert.equal(present.state.currentStepId, "with_note");
});

test("continue rejeita troca da versão fixada e ações desconhecidas", () => {
  const definition = syntheticFlow();
  const started = startFlow({ definition, flowVersionId: "flow-version:pinned-v3" });
  assert.throws(
    () => continueFlow({ definition: { ...definition, version: 4 }, state: started.state, input: { type: "text", value: "Nome" } }),
    (error) => error.code === "FLOW_VERSION_MISMATCH",
  );
  assert.throws(
    () => executeFlowAction({ action: "flows.eval", definition }),
    (error) => error.code === "FLOW_ACTION_UNKNOWN",
  );
  assert.throws(
    () => continueFlow({
      definition,
      state: { ...started.state, answers: { injected: true } },
      input: { type: "text", value: "Nome" },
    }),
    (error) => error.code === "FLOW_STATE_ANSWER_UNKNOWN",
  );
});
