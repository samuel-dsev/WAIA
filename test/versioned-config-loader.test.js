import test from "node:test";
import assert from "node:assert/strict";
import { compileTenantRuntimeConfigV2 } from "../src/modules/configuration/index.js";
import {
  PostgresTenantDefinitionRepository,
  TenantRuntimeConfigurationError,
} from "../src/tenants/postgres-config-loader.js";

const EMPRESA_ID = "00000000-0000-4000-8000-000000000201";
function minimalConfig() {
  return {
    schemaVersion: 2,
    identity: { name: "Empresa Versionada" },
    modules: ["catalog"],
    menu: {
      text: "Escolha uma opção:",
      options: [{ id: "produtos", label: "Produtos", action: "catalog.list", params: {} }],
    },
  };
}

function fakePool(resolveQuery) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("set_config('app.empresa_id'")) return { rows: [{}] };
      return resolveQuery(sql, params);
    },
    release() {},
  };
  return {
    queries,
    async connect() { return client; },
  };
}

test("loader usa exclusivamente a revisão ativa verificada para tenant versionado", async () => {
  const compiled = compileTenantRuntimeConfigV2(minimalConfig(), {
    empresaId: EMPRESA_ID,
    configVersion: 7,
    draftVersion: 3,
  });
  const pool = fakePool(async (sql) => {
    if (sql.includes("FROM empresas")) return { rows: [{
      id: EMPRESA_ID,
      configuracao_runtime_modo: "versionado",
      configuracao_ativa_versao: 7,
      versao_configuracao: 7,
    }] };
    if (sql.includes("FROM configuracoes_revisoes")) return { rows: [{
      config_version: 7,
      checksum: compiled.checksum,
      configuracao_compilada: structuredClone(compiled),
    }] };
    assert.fail(`consulta legada inesperada: ${sql}`);
  });

  const definition = await new PostgresTenantDefinitionRepository(pool).load(EMPRESA_ID);

  assert.equal(definition.runtime.empresaId, EMPRESA_ID);
  assert.equal(definition.runtime.version, 7);
  assert.equal(definition.runtime.identity.name, "Empresa Versionada");
  assert.equal(definition.runtime.menu.options[0].action, "catalog.list");
  assert.equal(pool.queries.some(({ sql }) => sql.includes("configuracoes_empresa")), false);
});

test("loader versionado resolve exatamente a credencial de pagamento da revisão ativa", async () => {
  const credentialRef = "credential:00000000-0000-4000-8000-000000000299";
  const compiled = compileTenantRuntimeConfigV2({
    ...minimalConfig(),
    identity: { name: "Empresa Versionada", displayName: "Recebedor Versionado" },
    modules: ["catalog", "payments"],
    payments: { credentialRef },
  }, { empresaId: EMPRESA_ID, configVersion: 8, draftVersion: 4 });
  const pool = fakePool(async (sql) => {
    if (sql.includes("FROM empresas")) return { rows: [{
      id: EMPRESA_ID,
      configuracao_runtime_modo: "versionado",
      configuracao_ativa_versao: 8,
      versao_configuracao: 8,
    }] };
    if (sql.includes("FROM configuracoes_revisoes")) return { rows: [{
      config_version: 8,
      checksum: compiled.checksum,
      configuracao_compilada: structuredClone(compiled),
    }] };
    assert.fail(`consulta inesperada: ${sql}`);
  });
  const calls = [];
  const paymentResolver = {
    async resolve(input) {
      calls.push(input);
      return { value: "pix-versionado", recipient: input.recipient, instructions: "Aguarde conferência." };
    },
  };

  const definition = await new PostgresTenantDefinitionRepository(pool, { paymentResolver }).load(EMPRESA_ID);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].credentialRef, credentialRef);
  assert.equal(calls[0].recipient, "Recebedor Versionado");
  assert.equal(definition.runtime.payments.pix.key, "pix-versionado");
  assert.equal(definition.runtime.payments.pix.recipient, "Recebedor Versionado");
});

test("loader versionado falha fechado quando a credencial de pagamento não resolve", async () => {
  const compiled = compileTenantRuntimeConfigV2({
    ...minimalConfig(),
    modules: ["catalog", "payments"],
    payments: { credentialRef: "credential:00000000-0000-4000-8000-000000000299" },
  }, { empresaId: EMPRESA_ID, configVersion: 8, draftVersion: 4 });
  const pool = fakePool(async (sql) => {
    if (sql.includes("FROM empresas")) return { rows: [{
      id: EMPRESA_ID,
      configuracao_runtime_modo: "versionado",
      configuracao_ativa_versao: 8,
      versao_configuracao: 8,
    }] };
    if (sql.includes("FROM configuracoes_revisoes")) return { rows: [{
      config_version: 8,
      checksum: compiled.checksum,
      configuracao_compilada: structuredClone(compiled),
    }] };
    assert.fail(`consulta inesperada: ${sql}`);
  });

  await assert.rejects(
    new PostgresTenantDefinitionRepository(pool, { paymentResolver: { async resolve() { return null; } } }).load(EMPRESA_ID),
    (error) => error.code === "PAYMENT_CREDENTIAL_UNAVAILABLE",
  );
});

test("loader falha fechado quando tenant versionado não possui revisão ativa", async () => {
  const pool = fakePool(async (sql) => {
    if (sql.includes("FROM empresas")) return { rows: [{
      id: EMPRESA_ID,
      configuracao_runtime_modo: "versionado",
      configuracao_ativa_versao: null,
    }] };
    assert.fail(`consulta inesperada: ${sql}`);
  });

  await assert.rejects(
    new PostgresTenantDefinitionRepository(pool).load(EMPRESA_ID),
    (error) => error instanceof TenantRuntimeConfigurationError
      && error.code === "ACTIVE_CONFIGURATION_REQUIRED",
  );
  assert.equal(pool.queries.some(({ sql }) => sql.includes("configuracoes_empresa")), false);
});

test("loader não usa fallback quando a revisão ativa está corrompida", async () => {
  const compiled = compileTenantRuntimeConfigV2(minimalConfig(), {
    empresaId: EMPRESA_ID,
    configVersion: 2,
    draftVersion: 1,
  });
  const pool = fakePool(async (sql) => {
    if (sql.includes("FROM empresas")) return { rows: [{
      id: EMPRESA_ID,
      configuracao_runtime_modo: "versionado",
      configuracao_ativa_versao: 2,
      versao_configuracao: 2,
    }] };
    if (sql.includes("FROM configuracoes_revisoes")) return { rows: [{
      config_version: 2,
      checksum: "0".repeat(64),
      configuracao_compilada: structuredClone(compiled),
    }] };
    assert.fail(`consulta legada inesperada: ${sql}`);
  });

  await assert.rejects(
    new PostgresTenantDefinitionRepository(pool).load(EMPRESA_ID),
    (error) => error instanceof TenantRuntimeConfigurationError
      && error.code === "ACTIVE_CONFIGURATION_CORRUPTED",
  );
  assert.equal(pool.queries.some(({ sql }) => sql.includes("configuracoes_empresa")), false);
});

test("loader mantém fallback legado somente para tenant explicitamente legado", async () => {
  const pool = fakePool(async (sql) => {
    if (sql.includes("FROM empresas")) return { rows: [{
      id: EMPRESA_ID,
      configuracao_runtime_modo: "legado",
      versao_configuracao: 9,
      nome_exibicao: "Empresa Legada",
      timezone: "America/Sao_Paulo",
    }] };
    if (sql.includes("FROM configuracoes_empresa")) return { rows: [{
      saudacao: "Olá do legado",
      mensagem_fallback: "Contingência legada",
      respostas_publicas: [],
      roteamento: {},
    }] };
    return { rows: [] };
  });

  const definition = await new PostgresTenantDefinitionRepository(pool).load(EMPRESA_ID);

  assert.equal(definition.runtime.version, 9);
  assert.equal(definition.runtime.identity.name, "Empresa Legada");
  assert.equal(definition.runtime.identity.welcomeMessage, "Olá do legado");
  assert.equal(pool.queries.some(({ sql }) => sql.includes("configuracoes_revisoes")), false);
});

test("loader recusa ponte ativa inconsistente antes de ler a revisão", async () => {
  const pool = fakePool(async (sql) => {
    if (sql.includes("FROM empresas")) return { rows: [{
      id: EMPRESA_ID,
      configuracao_runtime_modo: "versionado",
      configuracao_ativa_versao: 4,
      versao_configuracao: 5,
    }] };
    assert.fail(`consulta inesperada: ${sql}`);
  });

  await assert.rejects(
    new PostgresTenantDefinitionRepository(pool).load(EMPRESA_ID),
    (error) => error instanceof TenantRuntimeConfigurationError
      && error.code === "ACTIVE_CONFIGURATION_POINTER_INVALID",
  );
  assert.equal(pool.queries.some(({ sql }) => sql.includes("configuracoes_revisoes")), false);
});

test("loader recusa modo ausente ou desconhecido sem consultar o legado", async () => {
  for (const configurationMode of [undefined, "desconhecido"]) {
    const pool = fakePool(async (sql) => {
      if (sql.includes("FROM empresas")) return { rows: [{
        id: EMPRESA_ID,
        configuracao_runtime_modo: configurationMode,
      }] };
      assert.fail(`consulta inesperada: ${sql}`);
    });

    await assert.rejects(
      new PostgresTenantDefinitionRepository(pool).load(EMPRESA_ID),
      (error) => error instanceof TenantRuntimeConfigurationError
        && error.code === "CONFIGURATION_MODE_UNSUPPORTED",
    );
    assert.equal(pool.queries.some(({ sql }) => sql.includes("configuracoes_empresa")), false);
  }
});
