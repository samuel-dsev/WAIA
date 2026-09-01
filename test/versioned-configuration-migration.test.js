import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../db/migrations/017_versioned_tenant_configuration.sql", import.meta.url);

async function migrationSql() {
  return readFile(migrationUrl, "utf8");
}

test("migração 017 cria progresso, rascunho otimista e revisões imutáveis por tenant", async () => {
  const sql = await migrationSql();

  for (const table of ["onboarding_progressos", "configuracoes_rascunho", "configuracoes_revisoes"]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`, "u"));
    assert.match(sql, new RegExp(`'${table}'`, "u"));
  }

  assert.match(sql, /draft_version bigint NOT NULL DEFAULT 1 CHECK \(draft_version > 0\)/u);
  assert.match(sql, /PRIMARY KEY \(empresa_id, config_version\)/u);
  assert.match(sql, /UNIQUE \(empresa_id, checksum\)/u);
  assert.match(sql, /checksum ~ '\^\[a-f0-9\]\{64\}\$'/u);
  assert.match(sql, /configuracao_compilada ->> 'empresaId' = empresa_id::text/u);
  assert.match(sql, /configuracao_compilada ->> 'configVersion' = config_version::text/u);
  assert.match(sql, /configuracao_compilada ->> 'draftVersion' = source_draft_version::text/u);
  assert.match(sql, /octet_length\(configuracao_compilada::text\) <= 1048576/u);
});

test("migração 017 preserva existentes em legado, cria novos em versionado e liga revisão ativa por FK composta", async () => {
  const sql = await migrationSql();

  assert.match(sql, /set_config\('app\.is_platform_admin', 'true', true\)/u);
  assert.match(sql, /ADD COLUMN configuracao_runtime_modo text,/u);
  assert.match(sql, /UPDATE empresas[^]*SET configuracao_runtime_modo = 'legado'[^]*WHERE configuracao_runtime_modo IS NULL/u);
  assert.match(sql, /ALTER COLUMN configuracao_runtime_modo SET DEFAULT 'versionado'/u);
  assert.match(sql, /ALTER COLUMN configuracao_runtime_modo SET NOT NULL/u);
  assert.match(sql, /configuracao_runtime_modo IN \('legado', 'versionado'\)/u);
  assert.match(sql, /configuracao_runtime_modo = 'legado' AND configuracao_ativa_versao IS NULL/u);
  assert.match(sql, /OR\s+configuracao_runtime_modo = 'versionado'/u);
  assert.match(sql, /FOREIGN KEY \(id, configuracao_ativa_versao\)[^]*REFERENCES configuracoes_revisoes \(empresa_id, config_version\)[^]*DEFERRABLE INITIALLY DEFERRED/u);
  assert.doesNotMatch(sql, /ALTER TABLE configuracoes_revisoes\s+.*set_updated_at/iu);
});

test("migração 017 documenta atores globais sem enfraquecer referências tenant-scoped", async () => {
  const sql = await migrationSql();

  assert.match(sql, /empresa_id uuid PRIMARY KEY REFERENCES empresas\(id\) ON DELETE CASCADE/u);
  assert.match(sql, /empresa_id uuid NOT NULL REFERENCES empresas\(id\) ON DELETE CASCADE/u);
  assert.match(sql, /created_by uuid REFERENCES usuarios\(id\) ON DELETE RESTRICT/u);
  assert.match(sql, /updated_by uuid REFERENCES usuarios\(id\) ON DELETE RESTRICT/u);
  assert.match(sql, /publicada_por uuid NOT NULL REFERENCES usuarios\(id\) ON DELETE RESTRICT/u);
  assert.match(sql, /COMMENT ON COLUMN onboarding_progressos\.updated_by/u);
  assert.match(sql, /Ator global: referencia usuarios porque administradores de plataforma podem nao possuir membership no tenant\./u);
});

test("migração 017 força RLS e protege revisões sem impedir cascade do tenant", async () => {
  const sql = await migrationSql();

  assert.match(sql, /ALTER TABLE %I ENABLE ROW LEVEL SECURITY/u);
  assert.match(sql, /ALTER TABLE %I FORCE ROW LEVEL SECURITY/u);
  assert.match(sql, /USING \(empresa_id = app_current_empresa_id\(\) OR app_is_platform_admin\(\)\)/u);
  assert.match(sql, /WITH CHECK \(empresa_id = app_current_empresa_id\(\) OR app_is_platform_admin\(\)\)/u);
  assert.match(sql, /REFERENCES empresas\(id\) ON DELETE CASCADE/u);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON configuracoes_revisoes/u);
  assert.match(sql, /TG_OP = 'DELETE' AND NOT EXISTS \([^]*SELECT 1 FROM empresas WHERE id = OLD\.empresa_id/u);
  assert.match(sql, /ERRCODE = '55000'/u);
  assert.match(sql, /ON onboarding_progressos \(empresa_id,/u);
  assert.match(sql, /ON configuracoes_rascunho \(empresa_id,/u);
  assert.match(sql, /ON configuracoes_revisoes \(empresa_id,/u);
});
