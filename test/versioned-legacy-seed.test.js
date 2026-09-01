import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("seed do Capitão Mor permanece explicitamente no loader legado após a migração 017", async () => {
  const sql = await readFile(new URL("../db/seeds/001_capitao_mor.sql", import.meta.url), "utf8");
  assert.match(sql, /INSERT INTO empresas \([^]*configuracao_runtime_modo[^]*\)[^]*VALUES \([^]*'legado'[^]*\)/u);
  assert.doesNotMatch(sql, /configuracao_ativa_versao/u);
});
