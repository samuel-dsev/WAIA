function frozenIssue(code, path, message) {
  return Object.freeze({ code, path, severity: "error", message });
}

export class VersionedConfigurationError extends Error {
  constructor(code, message, { status = 422, path = "/", details, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "VersionedConfigurationError";
    this.code = code;
    this.status = status;
    this.issues = Object.freeze([frozenIssue(code, path, message)]);
    if (details) this.details = Object.freeze({ ...details });
  }
}

export class DraftVersionConflictError extends VersionedConfigurationError {
  constructor({ expectedDraftVersion, currentDraftVersion }) {
    super("DRAFT_VERSION_CONFLICT", "O rascunho foi alterado por outra sessão. Recarregue antes de salvar novamente.", {
      status: 409,
      path: "/draftVersion",
      details: { expectedDraftVersion, currentDraftVersion },
    });
    this.name = "DraftVersionConflictError";
  }
}

export class VersionedConfigurationNotFoundError extends VersionedConfigurationError {
  constructor(code, message) {
    super(code, message, { status: 404 });
    this.name = "VersionedConfigurationNotFoundError";
  }
}

export class VersionedConfigurationPersistenceError extends VersionedConfigurationError {
  constructor(code, message, cause) {
    super(code, message, { status: 500, cause });
    this.name = "VersionedConfigurationPersistenceError";
  }
}

