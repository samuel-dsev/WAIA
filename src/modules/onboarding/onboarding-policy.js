export const READINESS_STATES = Object.freeze(["passed", "failed", "warning"]);
export const READINESS_SEVERITIES = Object.freeze(["info", "blocker", "warning"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function isActiveLegacyTenant(snapshot) {
  const status = String(snapshot?.tenant?.status || "").toLocaleLowerCase("pt-BR");
  const runtimeMode = String(snapshot?.tenant?.runtimeMode || "").toLocaleLowerCase("pt-BR");
  return ["active", "ativa"].includes(status) && ["legacy", "legado"].includes(runtimeMode);
}

export function readinessCheck({ code, passed, step, message, correctiveAction }) {
  if (!/^[A-Z][A-Z0-9_]+$/u.test(String(code || ""))) throw new TypeError("Código de readiness inválido.");
  if (!Number.isSafeInteger(step) || step < 1 || step > 10) throw new TypeError("Etapa de readiness inválida.");
  return deepFreeze({
    code,
    state: passed ? "passed" : "failed",
    severity: passed ? "info" : "blocker",
    step,
    message: String(passed ? message : correctiveAction),
    correctiveAction: String(correctiveAction),
  });
}

export function applyOnboardingPolicy(checks, snapshot, { mode } = {}) {
  if (!Array.isArray(checks)) throw new TypeError("checks deve ser um array.");
  if (mode != null && mode !== "enforcement") throw new TypeError("mode deve ser enforcement quando informado.");
  const diagnostic = mode !== "enforcement" && isActiveLegacyTenant(snapshot);
  const effectiveChecks = checks.map((check) => {
    if (!diagnostic || check.state !== "failed" || check.severity !== "blocker") return check;
    return deepFreeze({ ...check, state: "warning", severity: "warning" });
  });
  const blockingCount = effectiveChecks.filter((check) => check.state === "failed" && check.severity === "blocker").length;
  const warningCount = effectiveChecks.filter((check) => check.state === "warning").length;
  return deepFreeze({
    mode: diagnostic ? "diagnostic" : "enforcement",
    ready: blockingCount === 0,
    blockingCount,
    warningCount,
    automaticSuspension: false,
    checks: effectiveChecks,
  });
}
