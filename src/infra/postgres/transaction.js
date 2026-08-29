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
         set_config('app.is_platform_admin', $3, true)`,
      [context.tenantId, context.userId, context.isPlatformAdmin ? 'true' : 'false'],
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

export function withTenantTransaction(pool, { empresaId, usuarioId } = {}, callback) {
  return runTransaction(pool, {
    tenantId: requiredUuid(empresaId, 'empresaId'),
    userId: optionalUuid(usuarioId, 'usuarioId'),
    isPlatformAdmin: false,
  }, callback);
}

export function withPlatformTransaction(pool, { usuarioId } = {}, callback) {
  return runTransaction(pool, {
    tenantId: '',
    userId: optionalUuid(usuarioId, 'usuarioId'),
    isPlatformAdmin: true,
  }, callback);
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
