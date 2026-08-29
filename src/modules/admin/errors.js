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

export function publicAdminError(error) {
  if (error instanceof AdminError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message } } };
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
