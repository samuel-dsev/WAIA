import pg from 'pg';

const { Pool } = pg;

function integerOption(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Configuração numérica do PostgreSQL fora do intervalo ${min}-${max}.`);
  }
  return parsed;
}

function sslFromEnvironment() {
  const mode = String(process.env.PGSSLMODE || '').toLowerCase();
  if (!mode || mode === 'disable') return false;
  if (mode === 'require' || mode === 'prefer') return { rejectUnauthorized: false };
  return true;
}

export function createPostgresPool(options = {}) {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString && !options.host) {
    throw new Error('PostgreSQL não configurado. Informe DATABASE_URL ou opções explícitas de conexão.');
  }

  return new Pool({
    ...options,
    connectionString,
    max: integerOption(options.max ?? process.env.PG_POOL_MAX, 10, { max: 100 }),
    idleTimeoutMillis: integerOption(
      options.idleTimeoutMillis ?? process.env.PG_IDLE_TIMEOUT_MS,
      30_000,
      { min: 1_000 },
    ),
    connectionTimeoutMillis: integerOption(
      options.connectionTimeoutMillis ?? process.env.PG_CONNECTION_TIMEOUT_MS,
      5_000,
      { min: 100 },
    ),
    application_name: options.application_name || process.env.PG_APPLICATION_NAME || 'waia',
    ssl: options.ssl ?? sslFromEnvironment(),
    allowExitOnIdle: options.allowExitOnIdle ?? true,
  });
}

export async function closePostgresPool(pool) {
  if (pool?.end) await pool.end();
}
