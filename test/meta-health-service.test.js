import assert from "node:assert/strict";
import test from "node:test";
import { MetaHealthCheckError, MetaHealthService } from "../src/modules/meta/meta-health-service.js";

const FIXED_DATE = new Date("2026-09-02T15:00:00.000Z");
const APP = Object.freeze({
  id: "app-record-a",
  empresaId: "tenant-a",
  name: "Aplicativo sintético",
  appId: "meta-app-a",
  webhookPublicId: "webhook-public-a",
  mode: "own",
  state: "draft",
  appSecretCredentialId: "credential-app-secret-a",
  verifyTokenCredentialId: "credential-verify-token-a",
  revision: 7,
});
const NUMBER = Object.freeze({
  id: "number-a",
  empresaId: "tenant-a",
  phoneNumberId: "phone-a",
  wabaId: "waba-a",
  metaAppId: "app-record-a",
  accessTokenCredentialId: "credential-access-token-a",
  status: "pendente",
  primary: true,
});

function dependencies(overrides = {}) {
  const records = [];
  const repository = {
    async findAppById() { return APP; },
    async findNumberBinding() { return NUMBER; },
    async recordHealthCheck(input) { records.push(structuredClone(input)); },
    ...overrides.repository,
  };
  const credentialVault = {
    async getCredentialMetadata() { return { status: "active", configured: true }; },
    async getCredentialForUse() { return "synthetic-access-token-a"; },
    ...overrides.credentialVault,
  };
  const client = {
    async checkConnection() {
      return { appId: "meta-app-a", wabaId: "waba-a", phoneNumberId: "phone-a", tokenValid: true };
    },
    ...overrides.client,
  };
  return {
    records,
    repository,
    credentialVault,
    client,
    service: new MetaHealthService({ repository, credentialVault, client, clock: () => FIXED_DATE }),
  };
}

test("preflight Meta valida configuração, credenciais e identidade externa sem expor segredo", async () => {
  const calls = [];
  const context = dependencies({
    client: {
      async checkConnection(input) {
        calls.push(input);
        return {
          appId: input.appId,
          wabaId: input.wabaId,
          phoneNumberId: input.phoneNumberId,
          tokenValid: true,
          providerResponse: { accessToken: input.accessToken },
        };
      },
    },
  });

  const result = await context.service.run({ empresaId: "tenant-a", appId: "app-record-a", numberId: "number-a" });

  assert.deepEqual(result, {
    state: "healthy",
    success: true,
    code: "META_PREFLIGHT_OK",
    message: "Conexão Meta validada com sucesso.",
    testedAt: FIXED_DATE.toISOString(),
    applicationId: "app-record-a",
    numberId: "number-a",
  });
  assert.equal(calls[0].accessToken, "synthetic-access-token-a");
  assert.deepEqual(context.records, [{
    empresaId: "tenant-a",
    appId: "app-record-a",
    expectedRevision: 7,
    testedAt: FIXED_DATE.toISOString(),
    success: true,
    state: "active",
    errorSanitized: null,
    actorId: null,
    correlationId: null,
  }]);
  assert.doesNotMatch(JSON.stringify({ result, records: context.records }), /synthetic-access-token-a/u);
});

test("preflight Meta bloqueia aplicativo incompleto antes de consultar cofre ou rede", async () => {
  let vaultCalls = 0;
  let externalCalls = 0;
  const context = dependencies({
    repository: { async findAppById() { return { ...APP, verifyTokenCredentialId: null }; } },
    credentialVault: {
      async getCredentialMetadata() { vaultCalls += 1; },
      async getCredentialForUse() { vaultCalls += 1; },
    },
    client: { async checkConnection() { externalCalls += 1; } },
  });

  const result = await context.service.run({ empresaId: "tenant-a", appId: "app-record-a", numberId: "number-a" });

  assert.equal(result.state, "not_configured");
  assert.equal(result.code, "META_APP_INCOMPLETE");
  assert.equal(vaultCalls, 0);
  assert.equal(externalCalls, 0);
  assert.equal(context.records[0].errorSanitized.code, "META_APP_INCOMPLETE");
});

test("preflight Meta aceita aplicativo compartilhado sem referências de segredo próprias", async () => {
  const metadataCalls = [];
  const context = dependencies({
    repository: {
      async findAppById() {
        return {
          ...APP,
          mode: "shared",
          appSecretCredentialId: null,
          verifyTokenCredentialId: null,
        };
      },
    },
    credentialVault: {
      async getCredentialMetadata(input) { metadataCalls.push(input); return null; },
    },
  });

  const result = await context.service.run({ empresaId: "tenant-a", appId: "app-record-a", numberId: "number-a" });

  assert.equal(result.success, true);
  assert.deepEqual(metadataCalls, []);
});

test("preflight Meta recusa vínculo entre aplicativo e número antes de resolver token", async () => {
  let tokenCalls = 0;
  let externalCalls = 0;
  const context = dependencies({
    repository: { async findNumberBinding() { return { ...NUMBER, metaAppId: "outro-app" }; } },
    credentialVault: { async getCredentialForUse() { tokenCalls += 1; } },
    client: { async checkConnection() { externalCalls += 1; } },
  });

  const result = await context.service.run({ empresaId: "tenant-a", appId: "app-record-a", numberId: "number-a" });

  assert.equal(result.code, "META_APP_NUMBER_MISMATCH");
  assert.equal(tokenCalls, 0);
  assert.equal(externalCalls, 0);
  assert.equal(context.records[0].success, false);
  assert.equal(context.records[0].state, "failed");
});

test("preflight Meta falha fechado se o repositório devolver registro de outro tenant", async () => {
  let vaultCalls = 0;
  const context = dependencies({
    repository: { async findNumberBinding() { return { ...NUMBER, empresaId: "tenant-b" }; } },
    credentialVault: {
      async getCredentialMetadata() { vaultCalls += 1; },
      async getCredentialForUse() { vaultCalls += 1; },
    },
  });

  const result = await context.service.run({ empresaId: "tenant-a", appId: "app-record-a", numberId: "number-a" });

  assert.equal(result.code, "META_APP_NUMBER_MISMATCH");
  assert.equal(vaultCalls, 0);
});

test("preflight Meta não executa chamada externa com credencial revogada", async () => {
  let externalCalls = 0;
  const context = dependencies({
    credentialVault: {
      async getCredentialMetadata({ credentialId }) {
        return { status: credentialId.includes("app-secret") ? "revoked" : "active", configured: true };
      },
    },
    client: { async checkConnection() { externalCalls += 1; } },
  });

  const result = await context.service.run({ empresaId: "tenant-a", appId: "app-record-a", numberId: "number-a" });

  assert.equal(result.code, "META_CREDENTIAL_UNAVAILABLE");
  assert.equal(externalCalls, 0);
  assert.doesNotMatch(JSON.stringify({ result, records: context.records }), /credential-app-secret-a/u);
});

test("preflight Meta sanitiza erro externo e não persiste token nem corpo do provedor", async () => {
  const secret = "synthetic-access-token-a";
  const context = dependencies({
    client: {
      async checkConnection() {
        throw Object.assign(new Error(`Graph recusou ${secret}: corpo privado`), {
          code: "GRAPH_UNAVAILABLE",
          status: 503,
          response: { body: `resposta com ${secret}` },
        });
      },
    },
  });

  const result = await context.service.run({ empresaId: "tenant-a", appId: "app-record-a", numberId: "number-a" });
  const serialized = JSON.stringify({ result, records: context.records });

  assert.equal(result.code, "META_EXTERNAL_UNAVAILABLE");
  assert.equal(result.providerCode, "GRAPH_UNAVAILABLE");
  assert.deepEqual(context.records[0].errorSanitized, {
    code: "META_EXTERNAL_UNAVAILABLE",
    message: "Não foi possível validar a conexão com a Meta.",
    providerCode: "GRAPH_UNAVAILABLE",
    status: 503,
  });
  assert.doesNotMatch(serialized, new RegExp(secret, "u"));
  assert.doesNotMatch(serialized, /corpo privado/u);
  assert.doesNotMatch(serialized, /resposta com/u);
});

test("preflight Meta registra mismatch quando Graph identifica outro WABA ou número", async () => {
  const context = dependencies({
    client: {
      async checkConnection() {
        return { appId: "meta-app-a", wabaId: "waba-b", phoneNumberId: "phone-b", tokenValid: true };
      },
    },
  });

  const result = await context.service.run({ empresaId: "tenant-a", appId: "app-record-a", numberId: "number-a" });

  assert.equal(result.code, "META_EXTERNAL_MISMATCH");
  assert.equal(result.state, "unavailable");
  assert.equal(context.records[0].errorSanitized.message, "A Meta retornou identificadores diferentes dos configurados.");
});

test("preflight Meta mantém tenant em todas as consultas ao repositório e ao cofre", async () => {
  const scopes = [];
  const context = dependencies({
    repository: {
      async findAppById(input) { scopes.push(["app", input]); return APP; },
      async findNumberBinding(input) { scopes.push(["number", input]); return NUMBER; },
      async recordHealthCheck(input) { scopes.push(["record", input]); },
    },
    credentialVault: {
      async getCredentialMetadata(input) { scopes.push(["metadata", input]); return { status: "active", configured: true }; },
      async getCredentialForUse(input) { scopes.push(["use", input]); return "synthetic-access-token-a"; },
    },
  });

  await context.service.run({ empresaId: "tenant-a", appId: "app-record-a", numberId: "number-a" });

  assert.ok(scopes.length >= 6);
  assert.ok(scopes.every(([, input]) => input.empresaId === "tenant-a"));
});

test("serviço Meta exige dependências injetáveis e entradas válidas", async () => {
  assert.throws(() => new MetaHealthService(), (error) => (
    error instanceof MetaHealthCheckError && error.code === "META_HEALTH_DEPENDENCY_ERROR"
  ));
  const context = dependencies();
  await assert.rejects(
    () => context.service.run({ empresaId: "", appId: "app-record-a", numberId: "number-a" }),
    (error) => error.code === "META_HEALTH_INPUT_ERROR",
  );
});
