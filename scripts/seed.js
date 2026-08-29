import { createPostgresPool, closePostgresPool } from "../src/infra/postgres/pool.js";
import { runSeeds } from "../src/infra/postgres/seeds.js";

const pool = createPostgresPool();
try {
  const result = await runSeeds(pool);
  console.log(`Seeds concluídos: ${result.applied.length} novo(s), ${result.discovered} descoberto(s).`);
} finally {
  await closePostgresPool(pool);
}
