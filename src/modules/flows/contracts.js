export const FLOW_ACTIONS = Object.freeze({
  START: "flows.start",
  CONTINUE: "flows.continue",
  CANCEL: "flows.cancel",
});

export const FLOW_ACTION_KEYS = Object.freeze(Object.values(FLOW_ACTIONS));

export const FLOW_STEP_TYPES = Object.freeze([
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

export const FLOW_CONDITION_OPERATORS = Object.freeze(["equals", "present", "absent"]);
export const FLOW_INPUT_TYPES = Object.freeze(["text", "selection", "date", "consent", "document", "skip"]);
export const FLOW_EXECUTION_STATUSES = Object.freeze(["waiting_input", "completed", "handoff", "cancelled"]);
export const FLOW_EXECUTION_SCHEMA_VERSION = 1;

export class FlowDefinitionValidationError extends TypeError {
  constructor(issues) {
    const normalized = Object.freeze([...(Array.isArray(issues) ? issues : [issues])].map((entry) => Object.freeze({ ...entry })));
    super(normalized[0]?.message || "Definição de fluxo inválida.");
    this.name = "FlowDefinitionValidationError";
    this.code = "FLOW_DEFINITION_INVALID";
    this.status = 422;
    this.issues = normalized;
  }
}

export class FlowExecutionError extends Error {
  constructor(message, { code = "FLOW_EXECUTION_ERROR", status = 422, details } = {}) {
    super(message);
    this.name = "FlowExecutionError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = Object.freeze({ ...details });
  }
}
