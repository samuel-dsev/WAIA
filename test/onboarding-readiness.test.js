import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_CATALOG_V2,
  actionOwnerV2,
  compileTenantRuntimeConfigV2,
  validateActionParamsV2,
} from "../src/modules/configuration/index.js";
import { ReadinessService } from "../src/modules/onboarding/readiness-service.js";

const TENANT_ID = "00000000-0000-4000-8000-0000000000a1";

function validConfiguration() {
  return {
    schemaVersion: 2,
    identity: {
      name: "Empresa Sintética",
      displayName: "Empresa Sintética",
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
    },
    retention: { messagesDays: 365, logsDays: 90 },
    modules: ["catalog"],
    menu: {
      text: "Escolha:",
      options: [{ id: "catalogo", label: "Catálogo", action: "catalog.list", params: {} }],
    },
    integrations: [],
  };
}

function validSnapshot(overrides = {}) {
  return {
    tenant: {
      empresaId: TENANT_ID,
      status: "rascunho",
      runtimeMode: "versionado",
      configurationVersion: 1,
    },
    draftVersion: 1,
    administratorCount: 1,
    whatsapp: {
      primaryNumber: {
        primary: true,
        status: "ativo",
        phoneNumberId: "phone-sintetico",
        wabaId: "waba-sintetico",
        numeroE164: "+5511999999999",
      },
      accessTokenConfigured: true,
      applicationValid: true,
    },
    credentialReferences: [],
    integrations: [],
    environment: "production",
    ...overrides,
  };
}

function readiness(compiler = compileTenantRuntimeConfigV2) {
  return new ReadinessService({
    compiler,
    capabilityCatalog: CAPABILITY_CATALOG_V2,
    actionOwner: actionOwnerV2,
    validateActionParams: validateActionParamsV2,
  });
}

function byCode(result, code) {
  return result.checks.find((check) => check.code === code);
}

test("backend produz matriz estável completa e pronta sem depender do painel", () => {
  const result = readiness().evaluate({
    empresaId: TENANT_ID,
    configuration: validConfiguration(),
    snapshot: validSnapshot(),
  });
  assert.equal(result.mode, "enforcement");
  assert.equal(result.ready, true);
  assert.equal(result.blockingCount, 0);
  assert.equal(result.automaticSuspension, false);
  assert.equal(result.checks.length, 17);
  assert.deepEqual(Object.keys(result.checks[0]), [
    "code", "state", "severity", "step", "message", "correctiveAction",
  ]);
  assert.ok(result.checks.every((check) => check.state === "passed" && check.severity === "info"));
  assert.equal(Object.isFrozen(result.checks), true);
  assert.equal(Object.isFrozen(result.checks[0]), true);
});

test("identidade, retenção, módulos, menu, administrador, WhatsApp e compilação geram bloqueadores corrigíveis", () => {
  const result = readiness(() => { throw new Error("erro interno que não pode vazar"); }).evaluate({
    empresaId: TENANT_ID,
    configuration: { schemaVersion: 2, identity: {}, retention: {}, modules: [], menu: { options: [] } },
    snapshot: { tenant: { status: "rascunho", runtimeMode: "versionado", configurationVersion: 1 } },
  });
  for (const [code, step] of [
    ["CONFIGURATION_DRAFT_AVAILABLE", 10],
    ["IDENTITY_COMPLETE", 1],
    ["RETENTION_VALID", 1],
    ["MODULES_SELECTED", 2],
    ["MODULE_DEPENDENCIES_VALID", 2],
    ["MENU_ACTIONS_VALID", 4],
    ["WHATSAPP_PRIMARY_NUMBER_READY", 8],
    ["WHATSAPP_TOKEN_AVAILABLE", 8],
    ["META_APPLICATION_VALID", 8],
    ["TENANT_ADMIN_AVAILABLE", 9],
    ["RUNTIME_CONFIGURATION_COMPILES", 10],
  ]) {
    assert.deepEqual(
      { state: byCode(result, code).state, severity: byCode(result, code).severity, step: byCode(result, code).step },
      { state: "failed", severity: "blocker", step },
    );
    assert.ok(byCode(result, code).correctiveAction.length > 0);
  }
  assert.equal(result.ready, false);
  assert.doesNotMatch(JSON.stringify(result), /erro interno/u);
});

test("dependências e ações ligadas a módulo desabilitado são recusadas", () => {
  const configuration = validConfiguration();
  configuration.modules = ["orders"];
  configuration.menu.options = [{ id: "pagamento", label: "Pagamento", action: "payments.instructions", params: {} }];
  const result = readiness().evaluate({ empresaId: TENANT_ID, configuration, snapshot: validSnapshot() });
  assert.equal(byCode(result, "MODULE_DEPENDENCIES_VALID").state, "failed");
  assert.equal(byCode(result, "MENU_ACTIONS_VALID").state, "failed");
  assert.equal(byCode(result, "RUNTIME_CONFIGURATION_COMPILES").state, "failed");
});

test("módulos condicionais geram bloqueadores específicos e não genéricos", () => {
  const configuration = validConfiguration();
  configuration.modules = [
    "catalog", "orders", "events", "payments", "appointments",
    "ai_freeform", "external_integrations", "flows",
  ];
  configuration.payments = { credentialRef: "credential:pagamento" };
  configuration.appointments = { services: [] };
  configuration.ai = {
    enabled: true,
    provider: "openai",
    model: "modelo-sintetico",
    prompt: "Use somente informações públicas.",
    keyMode: "own",
    credentialRef: "credential:ia",
  };
  configuration.flows = { definitions: [] };
  configuration.integrations = [{
    id: "agenda-externa",
    type: "agenda",
    name: "Agenda externa",
    enabled: true,
    required: true,
    credentialRefs: ["credential:agenda"],
  }];
  const result = readiness().evaluate({
    empresaId: TENANT_ID,
    configuration,
    snapshot: validSnapshot({ credentialReferences: [], integrations: [{ id: "agenda-externa", status: "unavailable" }] }),
  });
  for (const code of [
    "PAYMENT_CREDENTIAL_AVAILABLE",
    "APPOINTMENT_SERVICE_AVAILABLE",
    "AI_CONFIGURATION_AVAILABLE",
    "FLOWS_VALID",
    "FLOW_RUNTIME_AVAILABLE",
    "REQUIRED_INTEGRATIONS_AVAILABLE",
  ]) {
    assert.equal(byCode(result, code).state, "failed", code);
  }
});

test("integração de pagamento não substitui a credencial exigida pelo runtime", () => {
  const configuration = validConfiguration();
  configuration.modules = ["catalog", "payments"];
  configuration.payments = { integrationRef: "integration:payment-provider" };
  configuration.menu.options = [{ id: "pagar", label: "Pagar", action: "payments.instructions", params: {} }];
  const result = readiness().evaluate({
    empresaId: TENANT_ID,
    configuration,
    snapshot: validSnapshot({ integrations: [{ reference: "integration:payment-provider", status: "healthy" }] }),
  });
  assert.equal(byCode(result, "PAYMENT_CREDENTIAL_AVAILABLE").state, "failed");
  assert.equal(byCode(result, "RUNTIME_CONFIGURATION_COMPILES").state, "failed");
});

test("credencial ativa de outro provedor não satisfaz IA própria nem pagamento", () => {
  const reference = "credential:compartilhada-errada";
  const configuration = validConfiguration();
  configuration.modules = ["catalog", "ai_freeform", "payments"];
  configuration.ai = {
    enabled: true,
    provider: "openai",
    model: "modelo-sintetico",
    prompt: "Use somente dados públicos.",
    keyMode: "own",
    credentialRef: reference,
  };
  configuration.payments = { credentialRef: reference };
  const result = readiness().evaluate({
    empresaId: TENANT_ID,
    configuration,
    snapshot: validSnapshot({
      credentialReferences: [reference],
      credentials: [{ reference, provider: "google_sheets", status: "active", configured: true }],
    }),
  });
  assert.equal(byCode(result, "AI_CONFIGURATION_AVAILABLE").state, "failed");
  assert.equal(byCode(result, "PAYMENT_CREDENTIAL_AVAILABLE").state, "failed");
});

test("tenant ativo legado recebe apenas diagnóstico e nunca suspensão automática", () => {
  const snapshot = {
    tenant: { empresaId: TENANT_ID, status: "ativa", runtimeMode: "legado", configurationVersion: 1 },
    whatsapp: { accessToken: "token-que-nao-pode-sair", verifyToken: "outro-segredo" },
  };
  const result = readiness(() => { throw new Error("falha sensível"); }).evaluate({
    empresaId: TENANT_ID,
    configuration: {},
    snapshot,
  });
  assert.equal(result.mode, "diagnostic");
  assert.equal(result.ready, true);
  assert.equal(result.blockingCount, 0);
  assert.ok(result.warningCount > 0);
  assert.equal(result.automaticSuspension, false);
  assert.ok(result.checks.every((check) => check.state !== "failed" && check.severity !== "blocker"));
  assert.doesNotMatch(JSON.stringify(result), /token-que-nao-pode-sair|outro-segredo|falha sensível/u);
  assert.equal(snapshot.tenant.status, "ativa");
  assert.equal(snapshot.tenant.runtimeMode, "legado");
});

test("tenant versionado ativo continua sujeito ao gate de novas publicações", () => {
  const result = readiness(() => { throw new Error("inválida"); }).evaluate({
    empresaId: TENANT_ID,
    configuration: {},
    snapshot: { tenant: { empresaId: TENANT_ID, status: "ativa", runtimeMode: "versionado", configurationVersion: 2 } },
  });
  assert.equal(result.mode, "enforcement");
  assert.equal(result.ready, false);
  assert.ok(result.blockingCount > 0);
  assert.equal(result.automaticSuspension, false);
});

test("compilador recebe envelope confiável do snapshot", () => {
  const calls = [];
  const compiler = (configuration, envelope) => {
    calls.push({ configuration, envelope });
    return { checksum: "0".repeat(64) };
  };
  const configuration = validConfiguration();
  const result = readiness(compiler).evaluate({
    empresaId: TENANT_ID,
    configuration,
    snapshot: validSnapshot({ draftVersion: 4, nextConfigurationVersion: 9 }),
  });
  assert.equal(byCode(result, "RUNTIME_CONFIGURATION_COMPILES").state, "passed");
  assert.deepEqual(calls, [{
    configuration,
    envelope: { empresaId: TENANT_ID, configVersion: 9, draftVersion: 4 },
  }]);
});

test("publicação de legado ativo pode exigir enforcement sem permitir downgrade manual", () => {
  const input = {
    empresaId: TENANT_ID,
    configuration: {},
    snapshot: { tenant: { empresaId: TENANT_ID, status: "ativa", runtimeMode: "legado", configurationVersion: 1 } },
  };
  const subject = readiness(() => { throw new Error("inválida"); });
  const enforced = subject.evaluate({ ...input, mode: "enforcement" });
  assert.equal(enforced.mode, "enforcement");
  assert.equal(enforced.ready, false);
  assert.ok(enforced.blockingCount > 0);
  assert.throws(() => subject.evaluate({ ...input, mode: "diagnostic" }), /mode deve ser enforcement/u);
});
