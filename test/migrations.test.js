import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSqlDirectory } from "../src/infra/postgres/sql-runner.js";

test("checksum SQL é estável entre LF e CRLF e aceita o hash legado", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "waia-sql-checksum-"));
  const filename = path.join(directory, "001_sample.sql");
  const lf = "CREATE TABLE sample (id integer);\nSELECT 1;\n";
  const crlf = lf.replace(/\n/gu, "\r\n");
  try {
    await writeFile(filename, lf, "utf8");
    const [fromLf] = await readSqlDirectory(directory);
    await writeFile(filename, crlf, "utf8");
    const [fromCrlf] = await readSqlDirectory(directory);
    const legacyCrlfChecksum = createHash("sha256").update(crlf).digest("hex");

    assert.equal(fromLf.checksum, fromCrlf.checksum);
    assert.ok(fromLf.acceptedChecksums.has(legacyCrlfChecksum));
    assert.ok(fromCrlf.acceptedChecksums.has(legacyCrlfChecksum));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("regras do estabelecimento possuem coluna própria e carga inicial do Capitão Mor", async () => {
  const migration = await readFile(new URL("../db/migrations/015_establishment_rules.sql", import.meta.url), "utf8");
  const existingTenantBackfill = await readFile(new URL("../db/migrations/016_capitao_mor_establishment_rules.sql", import.meta.url), "utf8");
  const seed = await readFile(new URL("../db/seeds/002_capitao_mor_demo.sql", import.meta.url), "utf8");
  assert.match(migration, /ADD COLUMN regras_estabelecimento text NOT NULL DEFAULT ''/u);
  assert.match(migration, /não é permitida a entrada usando boné/u);
  assert.match(existingTenantBackfill, /company\.slug = 'capitao-mor'/u);
  assert.match(existingTenantBackfill, /config\.regras_estabelecimento = ''/u);
  assert.match(seed, /regras_estabelecimento/u);
  assert.match(seed, /aniversariante do mês tem entrada VIP/u);
});
