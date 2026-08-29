export class AuthError extends Error {
  constructor(message, { code = "AUTH_ERROR", status = 401, retryAfterMs } = {}) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class InvalidCredentialsError extends AuthError {
  constructor() {
    super("E-mail ou senha inválidos.", { code: "INVALID_CREDENTIALS", status: 401 });
  }
}

export class AuthenticationRequiredError extends AuthError {
  constructor() {
    super("Autenticação necessária.", { code: "AUTHENTICATION_REQUIRED", status: 401 });
  }
}

export class AuthorizationDeniedError extends AuthError {
  constructor() {
    super("Acesso não autorizado.", { code: "AUTHORIZATION_DENIED", status: 403 });
  }
}
