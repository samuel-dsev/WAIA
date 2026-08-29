import "dotenv/config";
import { createPostgresPool, closePostgresPool } from "../src/infra/postgres/pool.js";
import { runMigrations } from "../src/infra/postgres/migrations.js";

const connectionString = process.env.DATABASE_MIGRATOR_URL;
if (!connectionString) {
  throw new Error("DATABASE_MIGRATOR_URL obrigatorio para executar migracoes.");
}

const pool = createPostgresPool({
  connectionString,
  application_name: "waia-migrator",
});
try {
  const result = await runMigrations(pool);
  console.log(`Migrações concluídas: ${result.applied.length} nova(s), ${result.discovered} descoberta(s).`);
} finally {
  await closePostgresPool(pool);
}
