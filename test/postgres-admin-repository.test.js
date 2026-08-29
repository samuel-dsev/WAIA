import test from "node:test";
import assert from "node:assert/strict";
import { PostgresAdminRepository } from "../src/modules/admin/postgres-admin-repository.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";

function fakePool() {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/count\(\*\)/u.test(sql)) return { rows: [{ total: 1 }], rowCount: 1 };
      if (/AS "id"/u.test(sql)) return { rows: [{ id: "contact-1", empresaId: TENANT_ID, name: "Contato" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { calls, pool: { async connect() { return client; } } };
}

test("repositório PostgreSQL usa descritor fixo e filtro redundante de empresa", async () => {
  const { calls, pool } = fakePool();
  const repository = new PostgresAdminRepository(pool);
  const result = await repository.list({ resource: "contacts", empresaId: TENANT_ID, limit: 20, page: 1, sort: "name", direction: "asc", filters: {} });
  assert.equal(result.pagination.total, 1);
  const statements = calls.map(({ sql }) => sql).join("\n");
  assert.match(statements, /FROM contatos r/u);
  assert.match(statements, /r\.empresa_id = \$1/u);
  assert.equal(calls.some(({ params }) => params.includes(TENANT_ID)), true);
  await assert.rejects(repository.list({ resource: "contatos; DROP TABLE empresas", empresaId: TENANT_ID }), /suportado/u);
});

test("unidade administrativa usa uma transação e faz rollback se a auditoria falhar", async () => {
  const { calls, pool } = fakePool();
  const repository = new PostgresAdminRepository(pool);

  await assert.rejects(
    repository.withAuditedMutation({ empresaId: TENANT_ID, actorId: ACTOR_ID }, async (transaction) => {
      await transaction.client.query("UPDATE contatos SET nome = $2 WHERE empresa_id = $1", [TENANT_ID, "Novo nome"]);
      throw new Error("falha de auditoria");
    }),
    /falha de auditoria/u,
  );

  const statements = calls.map(({ sql }) => sql);
  assert.equal(statements.filter((sql) => sql === "BEGIN").length, 1);
  assert.equal(statements.filter((sql) => sql === "ROLLBACK").length, 1);
  assert.equal(statements.includes("COMMIT"), false);
  assert.equal(calls.some(({ sql, params }) => /UPDATE contatos/u.test(sql) && params.includes(TENANT_ID)), true);
});
