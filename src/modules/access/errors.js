export class AccessError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'AccessError';
    this.code = code;
    this.status = status;
  }
}

export const accessDenied = () => new AccessError('ACCESS_ADMIN_REQUIRED', 403, 'A operação exige administração geral WAIA.');
export const accessMissing = () => new AccessError('ACCESS_NOT_FOUND', 404, 'Acesso ou empresa não encontrado.');
export const accessConflict = (code = 'ACCESS_VERSION_CONFLICT', message = 'O acesso mudou. Atualize a página antes de continuar.') =>
  new AccessError(code, 409, message);

export function safeAccessError(error) {
  if (error instanceof AccessError || ['SESSION_REQUIRED', 'MFA_INVALID', 'REAUTH_REQUIRED', 'RATE_LIMITED'].includes(error?.code)) return error;
  if (error?.code === '23514' && String(error.message).includes('LAST_PLATFORM_ADMIN_PROTECTED')) {
    return accessConflict('LAST_ADMIN_PROTECTED', 'Mantenha outro administrador geral operacional antes desta alteração.');
  }
  if (['23503', '23505', '23514', '40001', '40P01'].includes(error?.code)) return accessConflict('ACCESS_CONFLICT', 'A operação conflitou com o estado atual. Atualize a página.');
  return new AccessError('ACCESS_UNAVAILABLE', 503, 'Gestão de acessos temporariamente indisponível. Tente novamente.');
}
