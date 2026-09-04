import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/018_configurable_flows.sql", import.meta.url);

async function migrationSql() {
  return readFile(migrationUrl, "utf8");
}

test("migração 018 cria versões imutáveis, vínculo com configuração e submissões pinadas", async () => {
  const sql = await migrationSql();

  for (const table of [
    "fluxos",
    "fluxo_versoes",
    "configuracoes_fluxos_publicados",
    "fluxo_submissoes",
    "fluxo_documentos",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`, "u"));
    assert.match(sql, new RegExp(`'${table}'`, "u"));
  }

  assert.match(sql, /PRIMARY KEY \(empresa_id, id\)/u);
  assert.match(sql, /UNIQUE \(empresa_id, fluxo_id, versao\)/u);
  assert.match(sql, /FOREIGN KEY \(empresa_id, config_version\)[^]*REFERENCES configuracoes_revisoes\(empresa_id, config_version\)/u);
  assert.match(sql, /FOREIGN KEY \(empresa_id, fluxo_versao_id, fluxo_id, versao_fluxo\)[^]*REFERENCES fluxo_versoes\(empresa_id, id, fluxo_id, versao\)/u);
  assert.match(sql, /FOREIGN KEY \(empresa_id, config_version, fluxo_id, fluxo_versao_id\)[^]*REFERENCES configuracoes_fluxos_publicados/u);
  assert.match(sql, /fluxo_submissoes_conversa_aberta_uq/u);
  assert.match(sql, /status IN \('em_andamento', 'aguardando'\)/u);
});

test("migração 018 aplica tenant-first, FORCE RLS, retenção e auditoria imutável", async () => {
  const sql = await migrationSql();

  assert.match(sql, /ALTER TABLE %I ENABLE ROW LEVEL SECURITY/u);
  assert.match(sql, /ALTER TABLE %I FORCE ROW LEVEL SECURITY/u);
  assert.match(sql, /USING \(empresa_id = app_current_empresa_id\(\) OR app_is_platform_admin\(\)\)/u);
  assert.match(sql, /WITH CHECK \(empresa_id = app_current_empresa_id\(\) OR app_is_platform_admin\(\)\)/u);
  assert.match(sql, /ON fluxo_submissoes \(empresa_id, expires_at, id\)/u);
  assert.match(sql, /ON fluxo_documentos \(empresa_id, expires_at, id\)/u);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON fluxo_versoes/u);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON configuracoes_fluxos_publicados/u);
  assert.match(sql, /BEFORE DELETE ON fluxo_submissoes/u);
  assert.match(sql, /ERRCODE = '55000'/u);
});

test("migração 018 recusa segredos em definições e remove mídia na anonimização", async () => {
  const sql = await migrationSql();

  assert.match(sql, /CREATE OR REPLACE FUNCTION flow_json_has_forbidden_key\(document jsonb\)/u);
  assert.match(sql, /password\|secret\|token\|apikey\|privatekey\|credential/u);
  assert.match(sql, /NOT flow_json_has_forbidden_key\(definicao\)/u);
  assert.match(sql, /octet_length\(definicao::text\) <= 1048576/u);
  assert.match(sql, /status = 'anonimizado'[^]*storage_key IS NULL[^]*mensagem_id IS NULL/u);
  assert.match(sql, /dados_coletados = '\{\}'::jsonb AND passo_atual_key IS NULL/u);
  assert.match(sql, /CREATE TRIGGER fluxo_submissoes_protect_state/u);
  assert.match(sql, /A pinagem da submissao de fluxo e imutavel/u);
  assert.match(sql, /Submissoes terminais de fluxo nao podem ser reabertas/u);
  assert.match(sql, /CREATE TRIGGER fluxo_documentos_protect_state/u);
});

test("migração 020 mantém a guarda recursiva utilizável durante restore", async () => {
  const sql = await readFile(new URL("../db/migrations/020_restore_safe_flow_guard.sql", import.meta.url), "utf8");

  assert.match(sql, /SET search_path = pg_catalog/u);
  assert.match(sql, /public\.flow_json_has_forbidden_key\(item\.value\)/u);
  assert.match(sql, /public\.flow_json_has_forbidden_key\(child\)/u);
});
