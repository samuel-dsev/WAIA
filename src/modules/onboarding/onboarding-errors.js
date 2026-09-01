const CHECK_STATES = new Set(["passed", "failed", "warning"]);
const CHECK_SEVERITIES = new Set(["info", "warning", "blocker"]);

function safeText(value, fallback, max = 1_000) {
  const text = typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim()
    : "";
  return (text || fallback).slice(0, max);
}

function safeCode(value, fallback = "READINESS_CHECK_FAILED") {
  const code = String(value || "").trim();
  return /^[A-Z][A-Z0-9_]{1,99}$/u.test(code) ? code : fallback;
}

export function sanitizeReadinessChecks(checks) {
  if (!Array.isArray(checks)) return Object.freeze([]);
  return Object.freeze(checks.slice(0, 200).map((check) => {
    const source = check && typeof check === "object" && !Array.isArray(check) ? check : {};
    const step = Number.isInteger(source.step) && source.step >= 1 && source.step <= 10
      ? source.step
      : null;
    return Object.freeze({
      code: safeCode(source.code),
      state: CHECK_STATES.has(source.state) ? source.state : "failed",
      severity: CHECK_SEVERITIES.has(source.severity) ? source.severity : "blocker",
      step,
      message: safeText(source.message, "A configuração possui uma pendência."),
      correctiveAction: safeText(
        source.correctiveAction,
        "Revise a configuração antes de continuar.",
      ),
    });
  }));
}

function issue(code, path, message) {
  return Object.freeze({ code, path, severity: "error", message });
}

export class OnboardingError extends Error {
  constructor(code, message, { status = 422, path = "/", details, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.issues = Object.freeze([issue(code, path, message)]);
    if (details) this.details = Object.freeze({ ...details });
  }
}

export class OnboardingNotFoundError extends OnboardingError {
  constructor(code, message) {
    super(code, message, { status: 404 });
  }
}

export class OnboardingRevisionConflictError extends OnboardingError {
  constructor(code, message, details, path) {
    super(code, message, { status: 409, path, details });
  }
}

export class OnboardingPersistenceError extends OnboardingError {
  constructor(code, message, cause) {
    super(code, message, { status: 500, cause });
  }
}

export class TenantNotReadyError extends OnboardingError {
  constructor(checks) {
    super(
      "TENANT_NOT_READY",
      "A empresa possui pendências bloqueadoras e não pode continuar.",
      { status: 409, path: "/readiness" },
    );
    this.checks = sanitizeReadinessChecks(checks);
  }
}
