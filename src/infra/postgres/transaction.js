const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalUuid(value, fieldName) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${fieldName} deve ser um UUID válido.`);
  }
  return value.toLowerCase();
}

function requiredUuid(value, fieldName) {
  const parsed = optionalUuid(value, fieldName);
  if (!parsed) throw new TypeError(`${fieldName} é obrigatório.`);
  return parsed;
}

async function runTransaction(pool, context, callback) {
  if (!pool?.connect) throw new TypeError('Pool PostgreSQL inválido.');
  if (typeof callback !== 'function') throw new TypeError('Callback transacional é obrigatório.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT
         set_config('app.empresa_id', $1, true),
         set_config('app.usuario_id', $2, true),
         set_config('app.is_platform_admin', $3, true),
         set_config('app.audience', $4, true)`,
      [context.tenantId, context.userId, context.isPlatformAdmin ? 'true' : 'false', context.audience || ''],
    );

    const tx = Object.freeze({
      client,
      tenantId: context.tenantId || null,
      userId: context.userId || null,
      isPlatformAdmin: context.isPlatformAdmin,
    });
    const result = await callback(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserva o erro original e deixa o pool descartar uma conexão quebrada.
    }
    throw error;
  } finally {
    client.release();
  }
}

export function withTenantTransaction(pool, { empresaId, usuarioId, audience = '' } = {}, callback) {
  return runTransaction(pool, {
    tenantId: requiredUuid(empresaId, 'empresaId'),
    userId: optionalUuid(usuarioId, 'usuarioId'),
    isPlatformAdmin: false,
    audience,
  }, callback);
}

export function withPlatformTransaction(pool, { usuarioId } = {}, callback) {
  return runTransaction(pool, {
    tenantId: '',
    userId: optionalUuid(usuarioId, 'usuarioId'),
    isPlatformAdmin: true,
  }, callback);
}

export function withIdentityTransaction(pool, { usuarioId }, callback) {
  return runTransaction(pool, {
    tenantId: '', userId: requiredUuid(usuarioId, 'usuarioId'), isPlatformAdmin: false, audience: 'customer',
  }, callback);
}

// Only authenticated server context reaches this helper. Roles/tenant IDs from
// a request body never define authorization. Locks serialize revocation with use.
export function withCustomerTransaction(pool, { usuarioId, sessionId, empresaId, permission,
  now = new Date(), idleMs = 3600_000 } = {}, callback) {
  const userId = requiredUuid(usuarioId, 'usuarioId');
  const session = requiredUuid(sessionId, 'sessionId');
  const tenantId = optionalUuid(empresaId, 'empresaId');
  if (tenantId && (typeof permission !== 'string' || !permission)) throw new AccountError('ACCESS_DENIED', 403, 'Você não tem permissão para esta operação.');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !Number.isSafeInteger(idleMs) || idleMs < 1) throw invalidSession();
  // Narrow, fixed authorization queries need locks before customer RLS denies
  // UPDATE authority. No caller callback runs with this bootstrap privilege.
  return runTransaction(pool, { tenantId, userId, isPlatformAdmin: true, audience: '' }, async (tx) => {
    const identity = await tx.client.query("SELECT id FROM usuarios WHERE id=$1 AND status='ativo' AND deleted_at IS NULL AND NOT activation_required FOR UPDATE", [userId]);
    if (!identity.rowCount) throw invalidSession();
    const found = await tx.client.query(`SELECT s.id FROM auth_sessions s JOIN usuarios u ON u.id=s.usuario_id
      WHERE s.id=$1 AND s.usuario_id=$2 AND s.audience='customer' AND s.revoked_at IS NULL
      AND s.expires_at>$3 AND s.last_seen_at>$4 AND s.security_version=u.security_version
      AND u.status='ativo' AND u.deleted_at IS NULL
      AND (NOT u.mfa_habilitado OR s.mfa_verified_at IS NOT NULL)
      AND (u.papel_plataforma<>'administrador' OR s.mfa_verified_at IS NOT NULL)
      FOR SHARE OF s`, [session, userId, now, new Date(now.getTime() - idleMs)]);
    if (!found.rowCount) throw invalidSession();
    if (tenantId) {
      const membership = (await tx.client.query(`SELECT m.status,m.permissoes permissions,e.status AS "companyStatus"
        FROM usuarios_empresas m JOIN empresas e ON e.id=m.empresa_id
        WHERE m.usuario_id=$1 AND m.empresa_id=$2 AND m.status='ativo' AND e.deleted_at IS NULL
        FOR SHARE OF m,e`, [userId, tenantId])).rows[0];
      if (!membership) throw new AccountError('COMPANY_NOT_FOUND', 404, 'Empresa não encontrada.');
      if (permission && !effectiveCustomerCapabilities(membership).includes(permission)) {
        throw new AccountError('ACCESS_DENIED', 403, 'Você não tem permissão para esta operação.');
      }
    } else if (permission) throw new AccountError('ACCESS_DENIED', 403, 'Você não tem permissão para esta operação.');
    await tx.client.query("SELECT set_config('app.is_platform_admin','false',true),set_config('app.audience','customer',true)");
    return callback(Object.freeze({ ...tx, isPlatformAdmin: false }));
  });
}

export function assertTenantTransaction(tx) {
  if (!tx?.client?.query || !tx.tenantId || tx.isPlatformAdmin) {
    throw new TypeError('A operação exige uma transação vinculada a uma empresa.');
  }
  return tx;
}

export function assertPlatformTransaction(tx) {
  if (!tx?.client?.query || !tx.isPlatformAdmin) {
    throw new TypeError('A operação exige uma transação administrativa da plataforma.');
  }
  return tx;
}
import { effectiveCustomerCapabilities } from '../../modules/auth/permissions.js';
import { AccountError, invalidSession } from '../../modules/accounts/errors.js';
