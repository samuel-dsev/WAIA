import { createPostgresPool, closePostgresPool } from "../src/infra/postgres/pool.js";
import { runMigrations } from "../src/infra/postgres/migrations.js";

const pool = createPostgresPool();
try {
  const result = await runMigrations(pool);
  console.log(`Migrações concluídas: ${result.applied.length} nova(s), ${result.discovered} descoberta(s).`);
} finally {
  await closePostgresPool(pool);
}
