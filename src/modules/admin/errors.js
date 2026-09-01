import { VersionedConfigurationError } from "../configuration/versioned-configuration-errors.js";
import { OnboardingError, sanitizeReadinessChecks } from "../onboarding/onboarding-errors.js";

export class AdminError extends Error {
  constructor(message, { code = "ADMIN_ERROR", status = 500, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class AdminUnauthorizedError extends AdminError {
  constructor() {
    super("Autenticação necessária.", { code: "UNAUTHORIZED", status: 401 });
  }
}

export class AdminForbiddenError extends AdminError {
  constructor() {
    super("Acesso não autorizado.", { code: "FORBIDDEN", status: 403 });
  }
}

export class AdminValidationError extends AdminError {
  constructor(message, details) {
    super(message, { code: "VALIDATION_ERROR", status: 400, details });
  }
}

export class AdminNotFoundError extends AdminError {
  constructor() {
    super("Recurso não encontrado.", { code: "NOT_FOUND", status: 404 });
  }
}

function publicIssue(value) {
  if (!value || typeof value !== "object") return null;
  const code = /^[A-Z][A-Z0-9_]{1,99}$/u.test(String(value.code || ""))
    ? String(value.code)
    : "VALIDATION_ERROR";
  const path = typeof value.path === "string" && value.path.startsWith("/")
    ? value.path.slice(0, 500)
    : "/";
  const message = typeof value.message === "string"
    ? value.message.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 1_000)
    : "Os dados informados são inválidos.";
  return { code, path, severity: "error", message };
}

function publicConflictDetails(details) {
  if (!details || typeof details !== "object") return undefined;
  const allowed = ["expectedDraftVersion", "currentDraftVersion", "expectedRevision", "currentRevision"];
  const output = Object.fromEntries(allowed
    .filter((key) => Number.isSafeInteger(details[key]) && details[key] >= 0)
    .map((key) => [key, details[key]]));
  return Object.keys(output).length > 0 ? output : undefined;
}

function publicWorkflowError(error) {
  const issues = Array.isArray(error.issues) ? error.issues.map(publicIssue).filter(Boolean).slice(0, 200) : [];
  const details = publicConflictDetails(error.details);
  const checks = error instanceof OnboardingError && Array.isArray(error.checks)
    ? sanitizeReadinessChecks(error.checks)
    : undefined;
  return {
    status: Number.isInteger(error.status) ? error.status : 500,
    body: {
      error: {
        code: error.code,
        message: error.message,
        ...(issues.length > 0 ? { issues } : {}),
        ...(details ? { details } : {}),
        ...(checks ? { checks } : {}),
      },
    },
  };
}

export function publicAdminError(error) {
  if (error instanceof AdminError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  }
  if (error instanceof VersionedConfigurationError || error instanceof OnboardingError) {
    return publicWorkflowError(error);
  }
  if (/^23/u.test(String(error?.code || ""))) {
    const conflict = error.code === "23505";
    return {
      status: conflict ? 409 : 400,
      body: {
        error: {
          code: conflict ? "CONFLICT" : "VALIDATION_ERROR",
          message: conflict
            ? "Já existe um registro com estes dados."
            : "Os dados informados violam uma regra do recurso.",
        },
      },
    };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: "Falha interna no serviço administrativo." } },
  };
}
