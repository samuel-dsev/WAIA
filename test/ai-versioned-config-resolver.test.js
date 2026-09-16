import test from "node:test";
import assert from "node:assert/strict";
import { compileTenantRuntimeConfigV2 } from "../src/modules/configuration/index.js";
import {
  AiSecretResolver,
  AiRuntimeConfigurationError,
  PostgresAiConfigResolver,
} from "../src/modules/ai/postgres-adapters.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000201";
const CREDENTIAL_ID = "00000000-0000-4000-8000-000000000298";

function poolFor(resolveQuery) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("set_config('app.empresa_id'")) return { rows: [{}] };
      return resolveQuery(sql, params);
    },
    release() {},
  };
  return { queries, async connect() { return client; } };
}

function compiledAi() {
  return compileTenantRuntimeConfigV2({
    schemaVersion: 2,
    identity: { name: "Empresa IA Versionada" },
    modules: ["catalog", "ai_freeform"],
    menu: { text: "Menu", options: [{ id: "catalogo", label: "Catálogo", action: "catalog.list", params: {} }] },
    ai: {
      enabled: true,
      provider: "openai",
      model: "modelo-versionado",
      prompt: "Responda apenas sobre a empresa.",
      personality: "Objetiva",
      keyMode: "own",
      credentialRef: `credential:${CREDENTIAL_ID}`,
      maxOutputTokens: 456,
      monthlyTokenLimit: 12345,
      monthlyCostLimit: 67,
      fallbackMessage: "Contingência versionada.",
    },
  }, { empresaId: TENANT_ID, configVersion: 9, draftVersion: 4 });
}

test("resolver de IA usa exclusivamente a revisão V2 ativa para tenant versionado", async () => {
  const compiled = compiledAi();
  const pool = poolFor(async (sql) => {
    if (sql.includes("FROM empresas")) return { rows: [{ configuracao_runtime_modo: "versionado", configuracao_ativa_versao: 9, versao_configuracao: 9 }] };
    if (sql.includes("FROM configuracoes_revisoes")) return { rows: [{ config_version: 9, checksum: compiled.checksum, configuracao_compilada: structuredClone(compiled) }] };
    assert.fail(`consulta legada inesperada: ${sql}`);
  });

  const config = await new PostgresAiConfigResolver(pool).getAiConfig({ empresaId: TENANT_ID });

  assert.equal(config.model, "modelo-versionado");
  assert.equal(config.prompt, "Responda apenas sobre a empresa.");
  assert.equal(config.personality, "Objetiva");
  assert.equal(config.keyType, "own");
  assert.equal(config.credentialId, CREDENTIAL_ID);
  assert.equal(config.maxOutputTokens, 456);
  assert.equal(config.monthlyTokenLimit, 12345);
  assert.equal(config.monthlyCostLimit, 67);
  assert.equal(config.version, 9);
  assert.equal(pool.queries.some(({ sql }) => sql.includes("configuracoes_ia")), false);
});

test("resolver de IA preserva a tabela atual somente para tenant legado", async () => {
  const pool = poolFor(async (sql) => {
    if (sql.includes("FROM empresas")) return { rows: [{ configuracao_runtime_modo: "legado", configuracao_ativa_versao: null, versao_configuracao: 3 }] };
    if (sql.includes("FROM configuracoes_ia")) return { rows: [{
      habilitada: true,
      provedor: "openai",
      modelo: "modelo-legado",
      prompt: "Prompt legado",
      personalidade: "Legada",
      tipo_chave: "compartilhada",
      credencial_propria_id: null,
      limite_tokens_mensal: 1000,
      limite_custo_mensal: 10,
      alerta_percentual: 80,
      max_historico_mensagens: 8,
      max_output_tokens: 300,
      mensagem_contingencia: "Contingência",
      version: 3,
    }] };
    assert.fail(`consulta inesperada: ${sql}`);
  });

  const config = await new PostgresAiConfigResolver(pool).getAiConfig({ empresaId: TENANT_ID });
  assert.equal(config.model, "modelo-legado");
  assert.equal(config.version, 3);
  assert.equal(pool.queries.some(({ sql }) => sql.includes("configuracoes_revisoes")), false);
});

test("resolver de IA versionado falha fechado para revisão corrompida", async () => {
  const compiled = { ...compiledAi(), checksum: "0".repeat(64) };
  const pool = poolFor(async (sql) => {
    if (sql.includes("FROM empresas")) return { rows: [{ configuracao_runtime_modo: "versionado", configuracao_ativa_versao: 9, versao_configuracao: 9 }] };
    if (sql.includes("FROM configuracoes_revisoes")) return { rows: [{ config_version: 9, checksum: compiled.checksum, configuracao_compilada: compiled }] };
    assert.fail(`consulta inesperada: ${sql}`);
  });

  await assert.rejects(
    new PostgresAiConfigResolver(pool).getAiConfig({ empresaId: TENANT_ID }),
    (error) => error instanceof AiRuntimeConfigurationError && error.code === "AI_ACTIVE_CONFIGURATION_CORRUPTED",
  );
});

test("resolver de segredo de IA recusa credencial de outro provedor antes de decifrar", async () => {
  let secretReads = 0;
  const resolver = new AiSecretResolver({
    sharedApiKey: null,
    credentialVault: {
      async getCredentialMetadata() {
        return { empresaId: TENANT_ID, provider: "payment", status: "active", configured: true };
      },
      async getCredentialForUse() {
        secretReads += 1;
        return "nao-deve-ser-lido";
      },
    },
  });
  await assert.rejects(
    resolver.resolve({ empresaId: TENANT_ID, provider: "openai", keyType: "own", credentialId: CREDENTIAL_ID }),
    (error) => error instanceof AiRuntimeConfigurationError && error.code === "AI_CREDENTIAL_UNAVAILABLE",
  );
  assert.equal(secretReads, 0);
});
