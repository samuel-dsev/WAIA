import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SQL_FILE_PATTERN = /^\d+[a-zA-Z0-9_-]*\.sql$/;

function checksum(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

function sqlChecksums(sql) {
  const canonicalSql = sql.replace(/\r\n?/gu, '\n');
  const canonical = checksum(canonicalSql);
  return {
    canonical,
    accepted: new Set([
      canonical,
      checksum(sql),
      checksum(canonicalSql.replace(/\n/gu, '\r\n')),
    ]),
  };
}

function safeControlTable(table) {
  if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new TypeError('Nome inválido para tabela de controle SQL.');
  return table;
}

export async function readSqlDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && SQL_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));

  return Promise.all(filenames.map(async (filename) => {
    const sql = await readFile(path.join(directory, filename), 'utf8');
    const checksums = sqlChecksums(sql);
    return { filename, sql, checksum: checksums.canonical, acceptedChecksums: checksums.accepted };
  }));
}

export async function runSqlDirectory({ pool, directory, controlTable, advisoryLockKey }) {
  const table = safeControlTable(controlTable);
  const files = await readSqlDirectory(directory);
  const client = await pool.connect();
  const appliedNow = [];

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [String(advisoryLockKey)]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        filename text PRIMARY KEY,
        checksum char(64) NOT NULL,
        executed_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const appliedResult = await client.query(`SELECT filename, checksum FROM ${table}`);
    const applied = new Map(appliedResult.rows.map((row) => [row.filename, row.checksum.trim()]));

    for (const file of files) {
      if (applied.has(file.filename)) {
        if (!file.acceptedChecksums.has(applied.get(file.filename))) {
          throw new Error(`O arquivo SQL já aplicado foi alterado: ${file.filename}.`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query(
          `INSERT INTO ${table} (filename, checksum) VALUES ($1, $2)`,
          [file.filename, file.checksum],
        );
        await client.query('COMMIT');
        appliedNow.push(file.filename);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    return { discovered: files.length, applied: appliedNow };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [String(advisoryLockKey)]);
    } finally {
      client.release();
    }
  }
}
