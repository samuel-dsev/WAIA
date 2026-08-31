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

test("configuração operacional consulta somente datas existentes na tabela", async () => {
  const { calls, pool } = fakePool();
  const repository = new PostgresAdminRepository(pool);

  await repository.list({ resource: "runtime-config", empresaId: TENANT_ID, limit: 1, page: 1, sort: "updatedAt", direction: "desc", filters: {} });

  const select = calls.find(({ sql }) => /AS "id".*FROM configuracoes_empresa r/u.test(sql))?.sql;
  assert.ok(select);
  assert.match(select, /r\.updated_at AS "updatedAt"/u);
  assert.doesNotMatch(select, /r\.created_at/u);
});

test("configuração de IA informa o estado da credencial própria", async () => {
  const { calls, pool } = fakePool();
  const repository = new PostgresAdminRepository(pool);

  await repository.list({ resource: "ai-config", empresaId: TENANT_ID, limit: 1, page: 1, sort: "updatedAt", direction: "desc", filters: {} });

  const select = calls.find(({ sql }) => /AS "credentialStatus".*FROM configuracoes_ia r/u.test(sql))?.sql;
  assert.ok(select);
  assert.match(select, /SELECT c\.status FROM credenciais_empresa c/u);
  assert.match(select, /c\.id = r\.credencial_propria_id/u);
});

test("ativação do número exige token Meta e troca o principal atomicamente", async () => {
  const calls = [];
  let hasCredential = false;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT status, principal FROM numeros_whatsapp/u.test(sql)) return { rows: [{ status: "pendente", principal: false }], rowCount: 1 };
      if (/FROM credenciais_empresa/u.test(sql)) return { rows: hasCredential ? [{ "?column?": 1 }] : [], rowCount: hasCredential ? 1 : 0 };
      if (/UPDATE numeros_whatsapp SET status/u.test(sql)) return { rows: [{ id: "number-1" }], rowCount: 1 };
      if (/AS "id".*FROM numeros_whatsapp r/u.test(sql)) return { rows: [{ id: "number-1", empresaId: TENANT_ID, status: "ativo", principal: true }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = new PostgresAdminRepository({ async connect() { return client; } });

  await assert.rejects(
    repository.update({ resource: "numbers", empresaId: TENANT_ID, id: "number-1", changes: { status: "ativo", principal: true } }),
    /token Meta/u,
  );

  hasCredential = true;
  const result = await repository.update({ resource: "numbers", empresaId: TENANT_ID, id: "number-1", changes: { status: "ativo", principal: true } });
  assert.equal(result.principal, true);
  assert.equal(calls.some(({ sql }) => /id <> \$2 AND principal = true/u.test(sql)), true);
  assert.equal(calls.some(({ params }) => params.includes("whatsapp:number-1")), true);
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
