import test from "node:test";
import assert from "node:assert/strict";
import { capitaoMorDemoDefinition } from "../src/tenants/capitao-mor.js";
import { createConfiguredTenantRuntime } from "../src/tenants/configured-runtime.js";
import {
  ACTION_KEYS_V2,
  CAPABILITY_CATALOG_V2,
  CAPABILITY_KEYS_V2,
  ConfigurationValidationError,
  actionDefinitionV2,
  adaptLegacyTenantDefinitionToV2,
  compileTenantRuntimeConfigV2,
  configurationChecksum,
  materializeLegacyTenantDefinition,
  parseTenantRuntimeConfigV2,
  stableJson,
  validateTenantRuntimeConfigV2,
  verifyCompiledTenantRuntimeConfigV2,
} from "../src/modules/configuration/index.js";

function minimalConfig(overrides = {}) {
  return {
    schemaVersion: 2,
    identity: { name: "Empresa Sintética" },
    modules: ["catalog"],
    menu: {
      text: "Escolha uma opção:",
      options: [{ id: "produtos", label: "Produtos", action: "catalog.list", params: {} }],
    },
    ...overrides,
  };
}

function memoryStateRepository() {
  const values = new Map();
  return {
    async load({ empresaId, conversationId }) {
      return values.get(`${empresaId}:${conversationId}`) || null;
    },
    async save({ empresaId, conversationId }, state) {
      const key = `${empresaId}:${conversationId}`;
      if (state == null) values.delete(key);
      else values.set(key, structuredClone(state));
    },
  };
}

test("catálogo V2 congela capacidades, ações, contextos e parâmetros sem alterar o V1", () => {
  assert.deepEqual(CAPABILITY_KEYS_V2, [
    "catalog", "orders", "events", "appointments", "payments",
    "human_handoff", "ai_freeform", "external_integrations", "flows",
  ]);
  assert.notEqual(CAPABILITY_CATALOG_V2.find(({ key }) => key === "flows").reserved, true);
  assert.ok(ACTION_KEYS_V2.includes("flows.start"));
  assert.ok(ACTION_KEYS_V2.includes("flows.continue"));
  assert.ok(ACTION_KEYS_V2.includes("flows.cancel"));
  assert.deepEqual(CAPABILITY_CATALOG_V2.find(({ key }) => key === "orders").dependencies, ["events", "payments"]);
  assert.deepEqual(actionDefinitionV2("orders.select_event").parameters, {
    eventId: { type: "id", required: true },
  });
  assert.deepEqual(actionDefinitionV2("flows.start").parameters, {
    flowRef: { type: "reference", referenceType: "flow", required: true },
  });
  assert.deepEqual(actionDefinitionV2("external_integrations.run").contexts, ["runtime"]);
});

test("validador entrega falhas estruturadas com código estável e JSON Pointer", () => {
  const result = validateTenantRuntimeConfigV2(minimalConfig({
    modules: ["orders", "events"],
  }));
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues, [{
    code: "CAPABILITY_DEPENDENCY_MISSING",
    path: "/modules",
    severity: "error",
    message: "A capacidade orders requer payments.",
  }]);
  assert.ok(Object.isFrozen(result.issues));
  assert.throws(
    () => parseTenantRuntimeConfigV2(minimalConfig({ menu: { options: [{ id: "x", label: "X", action: "external_integrations.run", params: { integrationId: "x" } }] } })),
    (error) => error instanceof ConfigurationValidationError
      && error.status === 422
      && error.issues[0].code === "ACTION_CAPABILITY_DISABLED"
      && error.issues[0].path === "/menu/options/0/action",
  );
});

test("compilador é determinístico, imutável, tenant-bound e normaliza Unicode", () => {
  const composed = minimalConfig({ identity: { name: "Café Sintético" } });
  const decomposed = minimalConfig({ identity: { name: "Cafe\u0301 Sinte\u0301tico" } });
  const options = { empresaId: "tenant-a", configVersion: 7, draftVersion: 3 };
  const first = compileTenantRuntimeConfigV2(composed, options);
  const repeated = compileTenantRuntimeConfigV2(composed, options);
  const normalized = compileTenantRuntimeConfigV2(decomposed, options);
  const otherTenant = compileTenantRuntimeConfigV2(composed, { ...options, empresaId: "tenant-b" });
  const otherVersion = compileTenantRuntimeConfigV2(composed, { ...options, configVersion: 8 });

  assert.equal(first.checksum, repeated.checksum);
  assert.equal(first.checksum, normalized.checksum);
  assert.notEqual(first.checksum, otherTenant.checksum);
  assert.notEqual(first.checksum, otherVersion.checksum);
  assert.equal(verifyCompiledTenantRuntimeConfigV2(first), true);
  assert.equal(Object.isFrozen(first.configuration.menu.options[0]), true);
  assert.match(first.configuration.menu.options[0].transportId, /^cfg:[a-f0-9]{24}$/u);
  assert.equal(first.configuration.menu.options[0].transportId, repeated.configuration.menu.options[0].transportId);
  assert.equal(verifyCompiledTenantRuntimeConfigV2({ ...first, checksum: "0".repeat(64) }), false);
  assert.equal(verifyCompiledTenantRuntimeConfigV2({ ...first, draftVersion: 4 }), false);
  assert.equal(verifyCompiledTenantRuntimeConfigV2({ ...first, unexpectedSecret: "não-persistir" }), false);
  const changedTransport = structuredClone(first);
  changedTransport.configuration.menu.options[0].transportId = "cfg:000000000000000000000000";
  assert.equal(verifyCompiledTenantRuntimeConfigV2(changedTransport), false);
});

test("schema e checksum rejeitam segredos, referências erradas e JSON ambíguo", () => {
  assert.throws(
    () => parseTenantRuntimeConfigV2(minimalConfig({ payments: { accessToken: "não-persistir" } })),
    (error) => error.issues[0].code === "SECRET_FIELD_FORBIDDEN"
      && error.issues[0].path === "/payments/accessToken",
  );
  assert.throws(
    () => parseTenantRuntimeConfigV2(minimalConfig({
      modules: ["payments"],
      payments: { credentialRef: "integration:pagamento" },
      menu: { options: [{ id: "pagar", label: "Pagar", action: "payments.instructions", params: {} }] },
    })),
    (error) => error.issues[0].code === "INVALID_REFERENCE_TYPE",
  );
  assert.throws(
    () => parseTenantRuntimeConfigV2(minimalConfig({
      modules: ["payments"],
      payments: { integrationRef: "integration:pagamento" },
      menu: { options: [{ id: "pagar", label: "Pagar", action: "payments.instructions", params: {} }] },
    })),
    (error) => error.issues[0].code === "PAYMENT_CREDENTIAL_REFERENCE_REQUIRED"
      && error.issues[0].path === "/payments/credentialRef",
  );

  const dangerous = { safe: true };
  Object.defineProperty(dangerous, "__proto__", { value: "colisão", enumerable: true });
  assert.throws(() => configurationChecksum(dangerous), /chave permitida/u);

  const cyclic = { safe: true };
  cyclic.self = cyclic;
  assert.throws(() => stableJson(cyclic), /circular/u);

  const getter = {};
  Object.defineProperty(getter, "value", { enumerable: true, get() { throw new Error("não deve executar"); } });
  assert.throws(() => stableJson(getter), /accessor/u);

  const arrayWithExtra = [1];
  arrayWithExtra.extra = true;
  assert.throws(() => stableJson(arrayWithExtra), /propriedades extras/u);

  const arrayWithOwnMap = [1];
  arrayWithOwnMap.map = () => { throw new Error("não deve executar"); };
  assert.throws(() => stableJson(arrayWithOwnMap), /propriedades extras/u);
  assert.throws(() => stableJson({ value: undefined }), /não serializável/u);
  assert.throws(
    () => parseTenantRuntimeConfigV2(minimalConfig({
      identity: { name: "Empresa Sintética", publicIdentity: "Bearer synthetic-token-value-123456" },
    })),
    (error) => error.issues[0].code === "SECRET_VALUE_FORBIDDEN"
      && error.issues[0].path === "/identity/publicIdentity"
      && !JSON.stringify(error.issues).includes("synthetic-token-value-123456"),
  );

  const oversized = [];
  oversized.length = 20_001;
  assert.throws(() => stableJson(oversized), /limite de itens/u);
});

test("flows fica disponível e só compila com definição declarativa válida", () => {
  assert.throws(
    () => parseTenantRuntimeConfigV2(minimalConfig({
      modules: ["flows"],
      menu: { options: [{ id: "triagem", label: "Triagem", action: "flows.start", params: { flowRef: "flow:triagem" } }] },
    })),
    (error) => error.issues[0].code === "FLOW_DEFINITION_REQUIRED",
  );

  const parsed = parseTenantRuntimeConfigV2(minimalConfig({
    modules: ["flows"],
    menu: { options: [{ id: "triagem", label: "Triagem", action: "flows.start", params: { flowRef: "flow:triagem" } }] },
    flows: {
      definitions: [{
        key: "triagem",
        name: "Triagem sintética",
        version: 1,
        startStepId: "inicio",
        steps: [
          { id: "inicio", type: "message", message: "Vamos começar.", nextStepId: "fim" },
          { id: "fim", type: "completion", message: "Concluído." },
        ],
      }],
    },
  }));
  assert.equal(parsed.flows.definitions[0].startStepId, "inicio");
  assert.ok(!Object.hasOwn(parsed, "empresaId"));
  assert.ok(!Object.hasOwn(parsed, "configVersion"));
  assert.throws(
    () => parseTenantRuntimeConfigV2(minimalConfig({
      modules: ["flows"],
      menu: { options: [{ id: "triagem", label: "Triagem", action: "flows.start", params: { flowRef: "flow:ausente" } }] },
      flows: parsed.flows,
    })),
    (error) => error.issues[0].code === "FLOW_REFERENCE_UNKNOWN",
  );
});

test("adaptador legado não copia PIX e a ponte efêmera preserva respostas do Capitão Mor", async () => {
  const adapted = adaptLegacyTenantDefinitionToV2(capitaoMorDemoDefinition);
  const compiled = compileTenantRuntimeConfigV2(adapted, {
    empresaId: capitaoMorDemoDefinition.runtime.empresaId,
    configVersion: capitaoMorDemoDefinition.runtime.version,
    draftVersion: 1,
  });
  const serialized = JSON.stringify(compiled);
  assert.doesNotMatch(serialized, /pix-demo@exemplo\.invalid/u);
  assert.doesNotMatch(serialized, /"(?:pix|key|recipient)"\s*:/u);
  assert.match(compiled.configuration.payments.credentialRef, /^credential:/u);

  const materialized = materializeLegacyTenantDefinition(compiled, {
    payment: capitaoMorDemoDefinition.runtime.payments.pix,
  });
  const inputs = [
    { text: "oi" },
    { selectionId: "cardapio" },
    { selectionId: "agenda" },
    { selectionId: "convites" },
    { selectionId: "event:evento-demo-sexta" },
    { text: "pergunta livre não reconhecida" },
  ];
  for (const [index, input] of inputs.entries()) {
    const dependencies = { stateRepository: memoryStateRepository() };
    const current = createConfiguredTenantRuntime({ definition: capitaoMorDemoDefinition, ...dependencies });
    const bridged = createConfiguredTenantRuntime({ definition: materialized, stateRepository: memoryStateRepository() });
    const envelope = { conversationId: `golden-${index}`, contactId: "contato-sintetico", ...input };
    assert.deepEqual(await bridged.handle(envelope), await current.handle(envelope));
  }

  const currentOrders = [];
  const bridgedOrders = [];
  const current = createConfiguredTenantRuntime({
    definition: capitaoMorDemoDefinition,
    stateRepository: memoryStateRepository(),
    orderRepository: { async createPending(order) { currentOrders.push(structuredClone(order)); } },
  });
  const bridged = createConfiguredTenantRuntime({
    definition: materialized,
    stateRepository: memoryStateRepository(),
    orderRepository: { async createPending(order) { bridgedOrders.push(structuredClone(order)); } },
  });
  const purchaseSequence = [
    { selectionId: "convites" },
    { selectionId: "event:evento-demo-sexta" },
    { type: "text", text: "paguei" },
    { type: "image", mediaId: "media-golden-v2" },
    { type: "text", text: "Pessoa Demonstração" },
  ];
  for (const input of purchaseSequence) {
    const envelope = { conversationId: "golden-purchase-v2", contactId: "contato-sintetico", ...input };
    assert.deepEqual(await bridged.handle(envelope), await current.handle(envelope));
  }
  assert.deepEqual(bridgedOrders, currentOrders);
});
