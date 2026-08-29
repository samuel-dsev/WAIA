import test from "node:test";
import assert from "node:assert/strict";
import {
  createGoogleSheetsIntegration,
  createMetaGateway,
  createOpenAiGateway,
  createSimulatedGoogleSheetsIntegration,
  createSimulatedMetaGateway,
  createSimulatedOpenAiGateway,
} from "../src/integrations/index.js";

function response(status, payload = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function scopedCache() {
  const values = new Map();
  const key = ({ empresaId, integrationId }) => `${empresaId}:${integrationId}`;
  return {
    async load(scope) { return structuredClone(values.get(key(scope)) || null); },
    async save(scope, value) { values.set(key(scope), structuredClone(value)); },
  };
}

function onceRepository() {
  const values = new Map();
  return {
    async runOnce(scope, operation) {
      const key = `${scope.empresaId}:${scope.integrationId}:${scope.operation}:${scope.idempotencyKey}`;
      if (values.has(key)) return { executed: false, value: structuredClone(values.get(key)) };
      const value = await operation();
      values.set(key, structuredClone(value));
      return { executed: true, value };
    },
  };
}

test("Meta resolve número e token corretos por tenant para texto, botões e read", async () => {
  const credentials = {
    "tenant-a:number-a": { accessToken: "token-a-super-secreto", phoneNumberId: "phone-a", apiVersion: "v99.0" },
    "tenant-b:number-b": { accessToken: "token-b-super-secreto", phoneNumberId: "phone-b", apiVersion: "v99.0" },
  };
  const calls = [];
  const gateway = createMetaGateway({
    credentialResolver: {
      async resolveMeta({ empresaId, numeroWhatsappId }) {
        return credentials[`${empresaId}:${numeroWhatsappId}`] || null;
      },
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { messages: [{ id: `message-${calls.length}` }] });
    },
  });

  await gateway.sendReply(
    { empresaId: "tenant-a", numeroWhatsappId: "number-a" },
    { to: "551100000001", text: "Mensagem A" },
  );
  await gateway.sendReply(
    { empresaId: "tenant-b", numeroWhatsappId: "number-b" },
    { to: "551100000002", text: "Escolha", buttons: [{ id: "agenda", label: "Agenda" }] },
  );
  await gateway.markRead(
    { empresaId: "tenant-a", numeroWhatsappId: "number-a" },
    { messageId: "wamid-a" },
  );

  assert.match(calls[0].url, /v99\.0\/phone-a\/messages$/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer token-a-super-secreto");
  assert.equal(JSON.parse(calls[0].options.body).type, "text");
  assert.match(calls[1].url, /v99\.0\/phone-b\/messages$/);
  assert.equal(calls[1].options.headers.Authorization, "Bearer token-b-super-secreto");
  assert.deepEqual(JSON.parse(calls[1].options.body).interactive.action.buttons, [{
    type: "reply",
    reply: { id: "agenda", title: "Agenda" },
  }]);
  assert.match(calls[2].url, /phone-a\/messages$/);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    messaging_product: "whatsapp",
    status: "read",
    message_id: "wamid-a",
  });
});

test("Meta aplica timeout e nunca registra token nem corpo de erro do provedor", async () => {
  const logs = [];
  const token = "token-que-nao-pode-aparecer";
  const logger = { warn(event, data) { logs.push({ event, data }); } };
  const unavailable = createMetaGateway({
    credentialResolver: { async resolveMeta() { return { accessToken: token, phoneNumberId: "phone-a" }; } },
    fetchImpl: async () => response(500, { error: { message: `falha contendo ${token}` } }),
    logger,
  });
  await assert.rejects(
    () => unavailable.sendReply(
      { empresaId: "tenant-a", numeroWhatsappId: "number-a" },
      { to: "551100000001", text: "Teste" },
    ),
    (error) => error.code === "META_REQUEST_FAILED" && !error.message.includes(token),
  );
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(token));

  const timedOut = createMetaGateway({
    credentialResolver: { async resolveMeta() { return { accessToken: token, phoneNumberId: "phone-a" }; } },
    timeoutMs: 5,
    logger,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })), { once: true });
    }),
  });
  await assert.rejects(
    () => timedOut.sendReply(
      { empresaId: "tenant-a", numeroWhatsappId: "number-a" },
      { to: "551100000001", text: "Teste" },
    ),
    (error) => error.code === "META_TIMEOUT",
  );
});

test("Google Sheets mantém configuração, cache válido e falhas isolados por empresa", async () => {
  const cacheRepository = scopedCache();
  const fail = new Set();
  const clients = new Map();
  const configurationResolver = {
    async resolveGoogleSheets({ empresaId }) {
      if (empresaId === "tenant-sem-config") return null;
      return {
        enabled: true,
        integrationId: `sheets-${empresaId}`,
        spreadsheetId: `spreadsheet-${empresaId}`,
        imports: { catalog: "Catalogo!A2:C" },
        exports: { orders: "Pedidos!A:G" },
      };
    },
  };
  const integration = createGoogleSheetsIntegration({
    configurationResolver,
    credentialResolver: { async resolveGoogleSheets({ empresaId }) { return { privateKey: `private-${empresaId}` }; } },
    cacheRepository,
    idempotencyRepository: onceRepository(),
    logger: { warn() {} },
    clientFactory: async ({ empresaId, spreadsheetId }) => {
      const client = {
        spreadsheetId,
        appended: [],
        async getValues() {
          if (fail.has(empresaId)) throw new Error("indisponível");
          return [[`produto-${empresaId}`, "10"]];
        },
        async appendValues(range, row) { this.appended.push({ range, row }); return { updatedRows: 1 }; },
      };
      clients.set(empresaId, client);
      return client;
    },
  });

  const firstA = await integration.syncTenant({ empresaId: "tenant-a" });
  const firstB = await integration.syncTenant({ empresaId: "tenant-b" });
  assert.deepEqual(firstA.snapshot.catalog, [["produto-tenant-a", "10"]]);
  assert.deepEqual(firstB.snapshot.catalog, [["produto-tenant-b", "10"]]);

  fail.add("tenant-b");
  const staleB = await integration.syncTenant({ empresaId: "tenant-b" });
  assert.equal(staleB.health, "unavailable");
  assert.equal(staleB.stale, true);
  assert.deepEqual(staleB.snapshot.catalog, [["produto-tenant-b", "10"]]);
  assert.deepEqual((await integration.getCachedSnapshot({ empresaId: "tenant-a" })).catalog, [["produto-tenant-a", "10"]]);
  assert.equal((await integration.syncTenant({ empresaId: "tenant-sem-config" })).health, "not_configured");
});

test("exportação de pedido no Sheets é idempotente e escopada por tenant", async () => {
  const appendCalls = [];
  const integration = createGoogleSheetsIntegration({
    configurationResolver: {
      async resolveGoogleSheets({ empresaId }) {
        return {
          enabled: true,
          integrationId: `integration-${empresaId}`,
          spreadsheetId: `sheet-${empresaId}`,
          imports: { health: "Config!A1" },
          exports: { orders: "Pedidos!A:G" },
        };
      },
    },
    credentialResolver: { async resolveGoogleSheets({ empresaId }) { return { credential: `credential-${empresaId}` }; } },
    cacheRepository: scopedCache(),
    idempotencyRepository: onceRepository(),
    clientFactory: async ({ empresaId }) => ({
      async getValues() { return []; },
      async appendValues(range, row) { appendCalls.push({ empresaId, range, row }); return { updatedRows: 1 }; },
    }),
  });
  const order = { id: "order-1", customerName: "Pessoa Teste", eventId: "event-1", amount: 25, status: "Aguardando conferência" };

  const first = await integration.exportOrder({ empresaId: "tenant-a" }, order, { idempotencyKey: "order-1" });
  const duplicate = await integration.exportOrder({ empresaId: "tenant-a" }, order, { idempotencyKey: "order-1" });
  await integration.exportOrder({ empresaId: "tenant-b" }, order, { idempotencyKey: "order-1" });

  assert.equal(first.executed, true);
  assert.equal(duplicate.executed, false);
  assert.deepEqual(appendCalls.map(({ empresaId }) => empresaId), ["tenant-a", "tenant-b"]);
  assert.equal(appendCalls[0].row[0], "order-1");
});

test("OpenAI resolve prompt, modelo e chave compartilhada ou própria sem estado cruzado", async () => {
  const factories = [];
  const requests = [];
  const configs = {
    "tenant-a": { enabled: true, model: "model-a", instructions: "Prompt A", keyMode: "shared" },
    "tenant-b": { enabled: true, model: "model-b", instructions: "Prompt B", keyMode: "tenant" },
  };
  const gateway = createOpenAiGateway({
    configurationResolver: { async resolveOpenAi({ empresaId }) { return configs[empresaId] || null; } },
    credentialResolver: {
      async resolveOpenAi({ empresaId, keyMode }) {
        return { apiKey: keyMode === "shared" ? "shared-secret-key" : `own-secret-${empresaId}` };
      },
    },
    clientFactory: async (scope) => {
      factories.push(scope);
      return {
        responses: {
          async create(input) {
            requests.push({ empresaId: scope.empresaId, input });
            return { output_text: `resposta-${scope.empresaId}`, usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
          },
        },
        async checkHealth() {},
      };
    },
  });

  const resultA = await gateway.reply({ empresaId: "tenant-a" }, { message: "Pergunta A", validatedContext: "Catálogo A" });
  const resultB = await gateway.reply({ empresaId: "tenant-b" }, { message: "Pergunta B", validatedContext: "Catálogo B" });
  assert.equal(resultA.keyMode, "shared");
  assert.equal(resultB.keyMode, "tenant");
  assert.deepEqual(resultB.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  assert.match(requests[0].input.instructions, /Prompt A/);
  assert.doesNotMatch(requests[0].input.instructions, /Prompt B/);
  assert.match(requests[0].input.input[0].content, /Catálogo A/);
  assert.match(requests[1].input.instructions, /Prompt B/);
  assert.doesNotMatch(requests[1].input.instructions, /Prompt A/);
  assert.equal(factories[0].apiKey, "shared-secret-key");
  assert.equal(factories[1].apiKey, "own-secret-tenant-b");
});

test("health diferencia not_configured, healthy e unavailable", async () => {
  const gateway = createMetaGateway({
    credentialResolver: {
      async resolveMeta({ empresaId }) {
        if (empresaId === "missing") return null;
        return { accessToken: "synthetic-token", phoneNumberId: "synthetic-phone" };
      },
    },
    fetchImpl: async (url) => url.includes("unavailable") ? response(503) : response(200, { id: "ok" }),
    graphBaseUrl: "https://example.invalid",
    logger: { warn() {} },
  });
  assert.equal((await gateway.health({ empresaId: "missing", numeroWhatsappId: "missing" })).state, "not_configured");
  assert.equal((await gateway.health({ empresaId: "healthy", numeroWhatsappId: "healthy" })).state, "healthy");

  const unavailable = createMetaGateway({
    credentialResolver: { async resolveMeta() { return { accessToken: "synthetic-token", phoneNumberId: "synthetic-phone" }; } },
    fetchImpl: async () => response(503),
    logger: { warn() {} },
  });
  assert.equal((await unavailable.health({ empresaId: "unavailable", numeroWhatsappId: "unavailable" })).state, "unavailable");

  const sheets = createGoogleSheetsIntegration({
    configurationResolver: {
      async resolveGoogleSheets({ empresaId }) {
        if (empresaId === "missing") return null;
        return {
          enabled: true,
          integrationId: empresaId,
          spreadsheetId: empresaId,
          imports: { health: "Config!A1" },
        };
      },
    },
    credentialResolver: { async resolveGoogleSheets() { return { credential: "synthetic" }; } },
    cacheRepository: scopedCache(),
    idempotencyRepository: onceRepository(),
    clientFactory: async ({ empresaId }) => ({
      async getValues() { if (empresaId === "unavailable") throw new Error("offline"); return []; },
      async appendValues() {},
    }),
  });
  assert.equal((await sheets.health({ empresaId: "missing" })).state, "not_configured");
  assert.equal((await sheets.health({ empresaId: "healthy" })).state, "healthy");
  assert.equal((await sheets.health({ empresaId: "unavailable" })).state, "unavailable");

  const openai = createOpenAiGateway({
    configurationResolver: {
      async resolveOpenAi({ empresaId }) {
        return empresaId === "missing" ? null : { enabled: true, model: "synthetic", instructions: "Synthetic" };
      },
    },
    credentialResolver: { async resolveOpenAi() { return { apiKey: "synthetic" }; } },
    clientFactory: async ({ empresaId }) => ({
      responses: { async create() { return { output_text: "ok" }; } },
      async checkHealth() { if (empresaId === "unavailable") throw new Error("offline"); },
    }),
  });
  assert.equal((await openai.health({ empresaId: "missing" })).state, "not_configured");
  assert.equal((await openai.health({ empresaId: "healthy" })).state, "healthy");
  assert.equal((await openai.health({ empresaId: "unavailable" })).state, "unavailable");
});

test("erros de Sheets e OpenAI não expõem credenciais em logs ou respostas", async () => {
  const secret = "segredo-externo-123";
  const logs = [];
  const logger = { warn(event, data) { logs.push({ event, data }); } };
  const sheets = createGoogleSheetsIntegration({
    configurationResolver: {
      async resolveGoogleSheets() {
        return {
          enabled: true,
          integrationId: "sheet",
          spreadsheetId: "sheet",
          imports: { health: "A1" },
          exports: { orders: "Pedidos!A:G" },
        };
      },
    },
    credentialResolver: { async resolveGoogleSheets() { return { privateKey: secret }; } },
    cacheRepository: scopedCache(),
    idempotencyRepository: onceRepository(),
    clientFactory: async () => ({
      async getValues() { return []; },
      async appendValues() { throw Object.assign(new Error(`falha ${secret}`), { code: secret }); },
    }),
    logger,
  });
  await assert.rejects(
    () => sheets.exportOrder({ empresaId: "a" }, { id: "1" }, { idempotencyKey: "1" }),
    (error) => error.code === "GOOGLE_ORDER_EXPORT_FAILED" && !error.message.includes(secret),
  );

  const openai = createOpenAiGateway({
    configurationResolver: { async resolveOpenAi() { return { enabled: true, model: "m", instructions: "p" }; } },
    credentialResolver: { async resolveOpenAi() { return { apiKey: secret }; } },
    clientFactory: async () => ({
      responses: { async create() { throw Object.assign(new Error(`falha ${secret}`), { code: secret }); } },
      async checkHealth() {},
    }),
    logger,
  });
  await assert.rejects(
    () => openai.reply({ empresaId: "a" }, { message: "teste" }),
    (error) => error.code === "OPENAI_UNAVAILABLE" && !error.message.includes(secret),
  );
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(secret));
});

test("simuladores não usam rede e falham fechados fora de development/test", async () => {
  assert.throws(() => createSimulatedMetaGateway({ environment: "production" }), /somente em development e test/i);
  assert.throws(() => createSimulatedGoogleSheetsIntegration({ environment: "production" }), /somente em development e test/i);
  assert.throws(() => createSimulatedOpenAiGateway({ environment: "production" }), /somente em development e test/i);

  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls += 1; throw new Error("rede proibida"); };
  try {
    const meta = createSimulatedMetaGateway({ environment: "test", tenants: { a: { configured: true } } });
    const sheets = createSimulatedGoogleSheetsIntegration({ environment: "test", tenants: { a: { configured: true, snapshot: { catalog: [] } } } });
    const openai = createSimulatedOpenAiGateway({ environment: "test", tenants: { a: { configured: true, response: "ok" } } });
    await meta.sendReply({ empresaId: "a", numeroWhatsappId: "numero-a" }, { to: "5511", text: "teste" });
    await sheets.syncTenant({ empresaId: "a" });
    await sheets.exportOrder({ empresaId: "a" }, { id: "order" }, { idempotencyKey: "order" });
    await openai.reply({ empresaId: "a" }, { message: "teste" });
    assert.equal(networkCalls, 0);
    assert.equal((await meta.health({ empresaId: "desconhecido", numeroWhatsappId: "numero" })).state, "not_configured");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
