import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSqlDirectory } from './sql-runner.js';

const defaultDirectory = fileURLToPath(new URL('../../../db/seeds', import.meta.url));

export function runSeeds(pool, { directory = defaultDirectory } = {}) {
  return runSqlDirectory({
    pool,
    directory: path.resolve(directory),
    controlTable: 'schema_seeds',
    advisoryLockKey: 8_104_202_602,
  });
}
