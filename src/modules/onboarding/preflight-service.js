import { OnboardingError } from "./onboarding-errors.js";
import { randomUUID } from "node:crypto";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u;

const CHECK_DEFINITIONS = Object.freeze({
  meta: Object.freeze({
    prefix: "META_EXTERNAL_CONNECTION",
    step: 8,
    passedMessage: "A conexão externa com a Meta foi confirmada.",
    failedMessage: "Não foi possível confirmar a conexão externa com a Meta.",
    correctiveAction: "Revise o aplicativo, o número e as credenciais Meta e execute o preflight novamente.",
  }),
  ai: Object.freeze({
    prefix: "AI_PROVIDER_CONNECTION",
    step: 7,
    passedMessage: "A conexão externa com o provedor de IA foi confirmada.",
    failedMessage: "Não foi possível confirmar a conexão externa com o provedor de IA.",
    correctiveAction: "Revise o provedor, o modelo e a credencial de IA e execute o preflight novamente.",
  }),
  payments: Object.freeze({
    prefix: "PAYMENT_PROVIDER_CONNECTION",
    step: 5,
    passedMessage: "A conexão externa de pagamentos foi confirmada.",
    failedMessage: "Não foi possível confirmar a conexão externa de pagamentos.",
    correctiveAction: "Revise a integração ou credencial de pagamento e execute o preflight novamente.",
  }),
  appointments: Object.freeze({
    prefix: "APPOINTMENT_INTEGRATION_CONNECTION",
    step: 5,
    passedMessage: "A integração externa de agendamento foi confirmada.",
    failedMessage: "Não foi possível confirmar a integração externa de agendamento.",
    correctiveAction: "Revise a agenda externa e suas credenciais e execute o preflight novamente.",
  }),
  integrations: Object.freeze({
    prefix: "REQUIRED_INTEGRATION_CONNECTION",
    step: 5,
    passedMessage: "A integração externa obrigatória foi confirmada.",
    failedMessage: "Não foi possível confirmar uma integração externa obrigatória.",
    correctiveAction: "Revise a integração obrigatória e suas credenciais e execute o preflight novamente.",
  }),
});

export const PREFLIGHT_CHECK_DEFINITIONS = CHECK_DEFINITIONS;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function requiredIdentifier(value, field) {
  const normalized = String(value || "").trim();
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new PreflightServiceError("PREFLIGHT_INPUT_INVALID", `${field} inválido.`, { status: 400 });
  }
  return normalized;
}

function optionalIdentifier(value, field) {
  if (value == null || value === "") return null;
  return requiredIdentifier(value, field);
}

function safeIdentifier(value) {
  const normalized = String(value || "").trim();
  return IDENTIFIER_PATTERN.test(normalized) ? normalized : null;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeClock(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new PreflightServiceError(
      "PREFLIGHT_CLOCK_INVALID",
      "Não foi possível registrar a execução do preflight.",
      { status: 500 },
    );
  }
  return value;
}

function normalizeTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 10 || value > 60_000) {
    throw new TypeError("timeoutMs deve ser um inteiro entre 10 e 60000.");
  }
  return value;
}

function normalizeAbortGrace(value) {
  if (!Number.isSafeInteger(value) || value < 10 || value > 5_000) {
    throw new TypeError("abortGraceMs deve ser um inteiro entre 10 e 5000.");
  }
  return value;
}

function normalizeConcurrency(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 8) {
    throw new TypeError("maxConcurrency deve ser um inteiro entre 1 e 8.");
  }
  return value;
}

function modulesOf(configuration) {
  return new Set(Array.isArray(configuration?.modules)
    ? configuration.modules.map((item) => String(item || "").trim()).filter(Boolean)
    : []);
}

function publicTarget(kind, reference) {
  return deepFreeze({ kind, ...(reference ? { reference } : {}) });
}

function taskFor(kind, { probeTarget = {}, reference = null, presetFailure = null } = {}) {
  return deepFreeze({
    kind,
    probeTarget: clone(probeTarget),
    target: publicTarget(kind, reference),
    presetFailure,
  });
}

function metaTask(empresaId, target) {
  const input = plainObject(target);
  if (input.empresaId != null && String(input.empresaId) !== empresaId) {
    return taskFor("meta", { presetFailure: "TENANT_MISMATCH" });
  }
  const applicationId = safeIdentifier(input.applicationId ?? input.appId);
  const numberId = safeIdentifier(input.numberId);
  if (!applicationId || !numberId) return taskFor("meta", { presetFailure: "TARGET_MISSING" });
  return taskFor("meta", {
    reference: applicationId,
    probeTarget: { applicationId, numberId },
  });
}

function aiTask(configuration) {
  const ai = plainObject(configuration.ai);
  return taskFor("ai", {
    reference: safeIdentifier(ai.provider),
    probeTarget: {
      provider: safeIdentifier(ai.provider),
      model: safeIdentifier(ai.model),
      keyMode: safeIdentifier(ai.keyMode),
      credentialRef: safeIdentifier(ai.credentialRef),
    },
  });
}

function paymentTask(configuration) {
  const payments = plainObject(configuration.payments);
  const integrationId = String(payments.integrationRef || "").startsWith("integration:")
    ? String(payments.integrationRef).slice("integration:".length)
    : null;
  const integration = Array.isArray(configuration.integrations)
    ? configuration.integrations.find((entry) => entry?.id === integrationId)
    : null;
  return taskFor("payments", {
    reference: safeIdentifier(payments.integrationRef ?? payments.credentialRef),
    probeTarget: {
      credentialRef: safeIdentifier(payments.credentialRef),
      integrationRef: safeIdentifier(payments.integrationRef),
      type: safeIdentifier(integration?.type),
    },
  });
}

function integrationKind(type) {
  return new Set(["agenda", "appointment", "appointments", "calendar", "scheduling"])
    .has(String(type || "").trim().toLowerCase())
    ? "appointments"
    : "integrations";
}

function integrationTasks(configuration) {
  if (!Array.isArray(configuration.integrations)) return [];
  return configuration.integrations
    .filter((integration) => integration?.enabled === true && integration?.required === true)
    .map((integration) => {
      const kind = integrationKind(integration.type);
      const id = safeIdentifier(integration.id);
      return taskFor(kind, {
        reference: id,
        presetFailure: id ? null : "TARGET_MISSING",
        probeTarget: {
          id,
          type: safeIdentifier(integration.type),
          credentialRefs: Array.isArray(integration.credentialRefs)
            ? integration.credentialRefs.map(safeIdentifier).filter(Boolean)
            : [],
        },
      });
    });
}

function deriveTasks({ empresaId, configuration, targets }) {
  const modules = modulesOf(configuration);
  const ai = plainObject(configuration.ai);
  const payments = plainObject(configuration.payments);
  return [
    metaTask(empresaId, plainObject(targets).meta),
    ...(modules.has("ai_freeform") && ai.keyMode !== "simulated" ? [aiTask(configuration)] : []),
    ...(modules.has("payments") && payments.integrationRef ? [paymentTask(configuration)] : []),
    ...integrationTasks(configuration),
  ];
}

function resultCode(task, outcome) {
  const prefix = CHECK_DEFINITIONS[task.kind].prefix;
  if (task.presetFailure) return `${prefix}_${task.presetFailure}`;
  if (outcome === "passed") return `${prefix}_OK`;
  if (outcome === "timeout") return `${prefix}_TIMEOUT`;
  if (outcome === "timeout_uncooperative") return `${prefix}_TIMEOUT_UNCOOPERATIVE`;
  if (outcome === "missing_probe") return `${prefix}_CHECK_UNAVAILABLE`;
  return `${prefix}_UNAVAILABLE`;
}

function publicCheck(task, outcome, durationMs) {
  const definition = CHECK_DEFINITIONS[task.kind];
  const passed = outcome === "passed";
  return deepFreeze({
    code: resultCode(task, outcome),
    state: passed ? "passed" : "failed",
    severity: passed ? "info" : "blocker",
    step: definition.step,
    message: passed ? definition.passedMessage : definition.failedMessage,
    correctiveAction: passed ? "Nenhuma ação adicional." : definition.correctiveAction,
    target: task.target,
    durationMs,
  });
}

function safeDuration(startedAt, endedAt) {
  const duration = Number(endedAt) - Number(startedAt);
  return Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0;
}

function auditView(checks) {
  return checks.map(({ code, state, severity, step, target, durationMs }) => ({
    code,
    state,
    severity,
    step,
    target,
    durationMs,
  }));
}

export class PreflightServiceError extends OnboardingError {
  constructor(code, message, { status = 422 } = {}) {
    super(code, message, { status });
  }
}

/**
 * Orquestra provas externas tenant-scoped sem decidir o gate de publicação.
 *
 * Cada probe recebe somente referências/configuração pública:
 *   probe({ empresaId, target, signal, actorId, correlationId, preflightId }) -> { success: true|false }
 *
 * `auditWriter` recebe um resumo allowlisted; retornos e erros dos provedores
 * nunca são propagados, persistidos ou expostos por este serviço.
 */
export class PreflightService {
  constructor({
    probes = {},
    auditWriter,
    clock = () => new Date(),
    now = () => Date.now(),
    timeoutMs = 5_000,
    abortGraceMs = 500,
    maxConcurrency = 2,
    idGenerator = randomUUID,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    if (!probes || typeof probes !== "object" || Array.isArray(probes)) throw new TypeError("probes deve ser um objeto.");
    if (typeof auditWriter !== "function") throw new TypeError("auditWriter é obrigatório.");
    if (typeof clock !== "function" || typeof now !== "function") throw new TypeError("clock e now são obrigatórios.");
    if (typeof idGenerator !== "function") throw new TypeError("idGenerator é obrigatório.");
    if (typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
      throw new TypeError("Funções de timeout são obrigatórias.");
    }
    this.probes = Object.freeze({ ...probes });
    this.auditWriter = auditWriter;
    this.clock = clock;
    this.now = now;
    this.timeoutMs = normalizeTimeout(timeoutMs);
    this.abortGraceMs = normalizeAbortGrace(abortGraceMs);
    this.maxConcurrency = normalizeConcurrency(maxConcurrency);
    this.idGenerator = idGenerator;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
  }

  async #execute(task, empresaId, actorId, correlationId, preflightId) {
    const startedAt = this.now();
    if (task.presetFailure) return publicCheck(task, "failed", safeDuration(startedAt, this.now()));
    const probe = this.probes[task.kind];
    if (typeof probe !== "function") return publicCheck(task, "missing_probe", safeDuration(startedAt, this.now()));

    const controller = new AbortController();
    let timeoutHandle;
    const probeResult = Promise.resolve()
      .then(() => probe({
        empresaId,
        target: clone(task.probeTarget),
        signal: controller.signal,
        actorId,
        correlationId,
        preflightId,
      }))
      .then(
        (value) => ({ kind: "result", value }),
        () => ({ kind: "error" }),
      );
    const timeout = new Promise((resolve) => {
      timeoutHandle = this.setTimeoutFn(() => {
        controller.abort();
        resolve({ kind: "timeout" });
      }, this.timeoutMs);
    });

    const settled = await Promise.race([probeResult, timeout]);
    this.clearTimeoutFn(timeoutHandle);
    let cooperativeShutdown = true;
    if (settled.kind === "timeout") {
      let abortGraceHandle;
      const abortGrace = new Promise((resolve) => {
        abortGraceHandle = this.setTimeoutFn(() => resolve({ kind: "abort_grace_expired" }), this.abortGraceMs);
      });
      const drained = await Promise.race([probeResult, abortGrace]);
      this.clearTimeoutFn(abortGraceHandle);
      cooperativeShutdown = drained.kind !== "abort_grace_expired";
    }
    const outcome = settled.kind === "timeout"
      ? cooperativeShutdown ? "timeout" : "timeout_uncooperative"
      : settled.kind === "result" && settled.value?.success === true
        ? "passed"
        : "failed";
    return publicCheck(task, outcome, safeDuration(startedAt, this.now()));
  }

  async #executeAll(tasks, empresaId, actorId, correlationId, preflightId) {
    const results = new Array(tasks.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < tasks.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await this.#execute(tasks[index], empresaId, actorId, correlationId, preflightId);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(this.maxConcurrency, tasks.length) },
      () => worker(),
    ));
    return results;
  }

  async run({ empresaId, configuration, targets = {}, actorId = null, correlationId = null } = {}) {
    const tenantId = requiredIdentifier(empresaId, "empresaId");
    const userId = optionalIdentifier(actorId, "actorId");
    const requestCorrelationId = optionalIdentifier(correlationId, "correlationId");
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
      throw new PreflightServiceError("PREFLIGHT_INPUT_INVALID", "configuration inválida.", { status: 400 });
    }
    if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
      throw new PreflightServiceError("PREFLIGHT_INPUT_INVALID", "targets inválido.", { status: 400 });
    }

    const startedAt = safeClock(this.clock);
    const tasks = deriveTasks({ empresaId: tenantId, configuration, targets });
    const preflightId = requiredIdentifier(this.idGenerator(), "preflightId");
    try {
      await this.auditWriter(deepFreeze({
        empresaId: tenantId,
        actorId: userId,
        action: "onboarding.preflight.started",
        resource: "onboarding_preflight",
        resourceId: preflightId,
        result: "success",
        correlationId: requestCorrelationId,
        occurredAt: startedAt,
        details: {
          preflightId,
          authoritativeGate: "readiness",
          plannedChecks: tasks.map(({ kind }) => kind),
        },
      }));
    } catch {
      throw new PreflightServiceError(
        "PREFLIGHT_AUDIT_FAILED",
        "Não foi possível registrar o início do preflight.",
        { status: 500 },
      );
    }

    const checks = await this.#executeAll(
      tasks,
      tenantId,
      userId,
      requestCorrelationId,
      preflightId,
    );
    const completedAt = safeClock(this.clock);
    const passedCount = checks.filter((check) => check.state === "passed").length;
    const failedCount = checks.length - passedCount;
    const summary = deepFreeze({ total: checks.length, passedCount, failedCount });
    const result = deepFreeze({
      preflightId,
      empresaId: tenantId,
      testedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      authoritativeGate: "readiness",
      summary,
      checks,
    });

    try {
      await this.auditWriter(deepFreeze({
        empresaId: tenantId,
        actorId: userId,
        action: "onboarding.preflight.completed",
        resource: "onboarding_preflight",
        resourceId: preflightId,
        result: failedCount === 0 ? "success" : "failure",
        correlationId: requestCorrelationId,
        occurredAt: completedAt,
        details: {
          preflightId,
          authoritativeGate: "readiness",
          summary,
          checks: auditView(checks),
        },
      }));
    } catch {
      throw new PreflightServiceError(
        "PREFLIGHT_AUDIT_FAILED",
        "Não foi possível registrar o preflight.",
        { status: 500 },
      );
    }

    return result;
  }
}
