import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSqlDirectory } from './sql-runner.js';

const defaultDirectory = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

export function runMigrations(pool, { directory = defaultDirectory } = {}) {
  return runSqlDirectory({
    pool,
    directory: path.resolve(directory),
    controlTable: 'schema_migrations',
    advisoryLockKey: 8_104_202_601,
  });
}
