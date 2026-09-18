export class AccountError extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status; }
}
export const invalidSession = () => new AccountError('SESSION_REQUIRED', 401, 'Entre novamente para continuar.');
export const invalidToken = () => new AccountError('TOKEN_INVALID', 422, 'Link inválido ou expirado. Solicite um novo link.');
