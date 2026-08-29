export class AppError extends Error {
  constructor(message, { code = "INTERNAL_ERROR", status = 500, retryable = false, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message = "Dados inválidos.", details) {
    super(message, { code: "VALIDATION_ERROR", status: 400, details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Autenticação necessária.") {
    super(message, { code: "UNAUTHORIZED", status: 401 });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Acesso não autorizado.") {
    super(message, { code: "FORBIDDEN", status: 403 });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Recurso não encontrado.") {
    super(message, { code: "NOT_FOUND", status: 404 });
  }
}

export function isRetryableError(error) {
  if (error?.retryable) return true;
  const status = Number(error?.status);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
