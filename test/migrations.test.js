import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readSqlDirectory } from "../src/infra/postgres/sql-runner.js";

test("migrações cobrem o domínio mínimo, isolamento e status Meta", async () => {
  const files = await readSqlDirectory(fileURLToPath(new URL("../db/migrations", import.meta.url)));
  const sql = files.map((file) => file.sql).join("\n");
  const requiredTables = [
    "empresas", "usuarios", "usuarios_empresas", "numeros_whatsapp", "credenciais_meta",
    "configuracoes_ia", "contatos", "conversas", "mensagens", "estados_conversa",
    "modulos_empresa", "menus", "produtos_servicos", "eventos", "pedidos", "itens_pedido",
    "agendamentos", "integracoes", "uso_ia", "jobs_falhos", "logs_operacionais", "logs_auditoria",
    "outbox_jobs", "whatsapp_status_events", "credenciais_empresa", "integracao_operacoes",
  ];
  for (const table of requiredTables) assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`, "u"));
  assert.match(sql, /FORCE ROW LEVEL SECURITY/u);
  assert.match(sql, /FOREIGN KEY \(empresa_id,/u);
  assert.match(sql, /UNIQUE \(empresa_id, external_message_id\)|mensagens_external_id_uq/u);
});

test("seed do primeiro tenant não contém segredos nem senhas", async () => {
  const seed = await readFile(new URL("../db/seeds/001_capitao_mor.sql", import.meta.url), "utf8");
  assert.doesNotMatch(seed, /access[_ -]?token|private[_ -]?key|password|senha|chave_pix|favorecid[ao]/iu);
  assert.match(seed, /'rascunho'/u);
});

test("agendamentos reservam capacidade de forma transacional", async () => {
  const migration = await readFile(new URL("../db/migrations/010_appointment_capacity_reservations.sql", import.meta.url), "utf8");
  assert.match(migration, /disponibilidade_id uuid/u);
  assert.match(migration, /reservados = reservados \+ 1/u);
  assert.match(migration, /reservados < capacidade/u);
  assert.match(migration, /BEFORE INSERT OR UPDATE[^]*OR DELETE/u);
});

test("mídia privada possui metadados de integridade, limite e retenção", async () => {
  const migration = await readFile(new URL("../db/migrations/011_private_media_storage.sql", import.meta.url), "utf8");
  assert.match(migration, /media_mime_type text/u);
  assert.match(migration, /media_size_bytes BETWEEN 1 AND 10485760/u);
  assert.match(migration, /media_sha256 ~ '\^\[a-f0-9\]\{64\}\$'/u);
  assert.match(migration, /mensagens_media_retention_idx/u);
});

test("resposta humana possui idempotência persistente por tenant", async () => {
  const migration = await readFile(new URL("../db/migrations/012_human_outbound_messages.sql", import.meta.url), "utf8");
  assert.match(migration, /client_idempotency_key/u);
  assert.match(migration, /mensagens_operator_idempotency_uq/u);
  assert.match(migration, /origem_resposta = 'operador'/u);
  assert.match(migration, /operador_usuario_id IS NOT NULL/u);
});

test("jobs falhos preservam origem, decisão e novo job de retentativa", async () => {
  const migration = await readFile(new URL("../db/migrations/013_failed_jobs_operations.sql", import.meta.url), "utf8");
  assert.match(migration, /outbox_job_id uuid/u);
  assert.match(migration, /resolved_by_usuario_id uuid/u);
  assert.match(migration, /resolution_kind = 'reenfileirado'/u);
  assert.match(migration, /retry_job_id IS NOT NULL/u);
  assert.match(migration, /jobs_falhos_retry_job_fkey/u);
});
