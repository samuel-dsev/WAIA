import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/019_meta_multi_application.sql", import.meta.url);

test("migração 019 cria aplicativos Meta tenant-scoped sem armazenar segredos", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /CREATE TABLE aplicativos_meta\b/u);
  assert.match(sql, /PRIMARY KEY \(empresa_id, id\)/u);
  assert.match(sql, /UNIQUE \(webhook_public_id\)/u);
  assert.match(sql, /modo IN \('compartilhado', 'proprio'\)/u);
  assert.match(sql, /app_secret_credencial_id uuid/u);
  assert.match(sql, /verify_token_credencial_id uuid/u);
  assert.match(sql, /REFERENCES credenciais_empresa\(empresa_id, id\)/u);
  assert.doesNotMatch(sql, /CREATE TABLE aplicativos_meta[^]*\b(bytea|jsonb)\b[^]*\);/u);
  assert.doesNotMatch(sql, /DROP TABLE\s+credenciais_meta/iu);
});

test("migração 019 preserva shared e exige refs do cofre para own ativo", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /modo = 'compartilhado'[^]*app_secret_credencial_id IS NULL[^]*verify_token_credencial_id IS NULL/u);
  assert.match(sql, /estado <> 'ativo'[^]*modo = 'compartilhado'[^]*app_secret_credencial_id IS NOT NULL AND verify_token_credencial_id IS NOT NULL/u);
  assert.match(sql, /app_secret_rotacionado_at timestamptz/u);
  assert.match(sql, /app_secret_anterior_credencial_id IS NOT NULL[^]*app_secret_rotacionado_at IS NOT NULL[^]*app_secret_anterior_valido_ate IS NOT NULL/u);
  assert.match(sql, /app_secret_anterior_valido_ate > app_secret_rotacionado_at/u);
});

test("migração 019 vincula número a app e access token do mesmo tenant", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /ADD COLUMN aplicativo_meta_id uuid/u);
  assert.match(sql, /ADD COLUMN access_token_credencial_id uuid/u);
  assert.match(sql, /ADD COLUMN meta_binding_revision bigint NOT NULL DEFAULT 1/u);
  assert.match(sql, /FOREIGN KEY \(empresa_id, aplicativo_meta_id\)[^]*REFERENCES aplicativos_meta\(empresa_id, id\)/u);
  assert.match(sql, /FOREIGN KEY \(empresa_id, access_token_credencial_id\)[^]*REFERENCES credenciais_empresa\(empresa_id, id\)/u);
  assert.match(sql, /\(aplicativo_meta_id IS NULL AND access_token_credencial_id IS NULL\)[^]*\(aplicativo_meta_id IS NOT NULL AND access_token_credencial_id IS NOT NULL\)/u);
});

test("migração 019 aplica RLS, índices tenant-first e retenção do erro", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /ALTER TABLE aplicativos_meta ENABLE ROW LEVEL SECURITY/u);
  assert.match(sql, /ALTER TABLE aplicativos_meta FORCE ROW LEVEL SECURITY/u);
  assert.match(sql, /USING \(empresa_id = app_current_empresa_id\(\) OR app_is_platform_admin\(\)\)/u);
  assert.match(sql, /ON aplicativos_meta \(empresa_id, estado, updated_at DESC, id\)/u);
  assert.match(sql, /ON numeros_whatsapp \(empresa_id, aplicativo_meta_id, status, id\)/u);
  assert.match(sql, /ultimo_erro_expires_at timestamptz/u);
  assert.match(sql, /aplicativos_meta_empresa_erro_retencao_idx/u);
  assert.match(sql, /CREATE TRIGGER aplicativos_meta_set_updated_at/u);
});
