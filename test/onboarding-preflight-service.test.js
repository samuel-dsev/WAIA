import test from "node:test";
import assert from "node:assert/strict";
import {
  PreflightService,
  PreflightServiceError,
} from "../src/modules/onboarding/preflight-service.js";

const TENANT_ID = "00000000-0000-4000-8000-0000000000a1";
const PREFLIGHT_ID = "00000000-0000-4000-8000-0000000000f7";

function configuration() {
  return {
    modules: ["catalog", "ai_freeform", "payments", "appointments", "external_integrations"],
    ai: {
      enabled: true,
      provider: "openai",
      model: "modelo-sintetico",
      keyMode: "own",
      credentialRef: "credential:ai-sintetica",
    },
    payments: { integrationRef: "integration:payment-sintetica" },
    integrations: [
      {
        id: "agenda-sintetica",
        type: "agenda",
        enabled: true,
        required: true,
        credentialRefs: ["credential:agenda-sintetica"],
      },
      {
        id: "erp-sintetico",
        type: "erp",
        enabled: true,
        required: true,
        credentialRefs: ["credential:erp-sintetica"],
      },
      { id: "opcional", type: "crm", enabled: true, required: false },
    ],
  };
}

function subject(overrides = {}) {
  const audits = [];
  let tick = 0;
  const probes = Object.fromEntries(
    ["meta", "ai", "payments", "appointments", "integrations"]
      .map((kind) => [kind, async () => ({ success: true })]),
  );
  const service = new PreflightService({
    probes,
    auditWriter: async (event) => audits.push(event),
    clock: () => new Date(tick++ === 0 ? "2026-09-02T12:00:00.000Z" : "2026-09-02T12:00:01.000Z"),
    now: () => tick,
    timeoutMs: 100,
    abortGraceMs: 50,
    idGenerator: () => PREFLIGHT_ID,
    ...overrides,
  });
  return { service, audits };
}

const targets = {
  meta: {
    empresaId: TENANT_ID,
    applicationId: "meta-app-sintetico",
    numberId: "numero-sintetico",
  },
};

test("orquestra somente dependências aplicáveis e preserva o readiness como gate autoritativo", async () => {
  const calls = [];
  const probes = Object.fromEntries(
    ["meta", "ai", "payments", "appointments", "integrations"].map((kind) => [
      kind,
      async (input) => {
        calls.push({ kind, input });
        return { success: true, accessToken: "segredo-que-nao-pode-sair" };
      },
    ]),
  );
  const { service, audits } = subject({ probes });
  const result = await service.run({
    empresaId: TENANT_ID,
    configuration: configuration(),
    targets,
    actorId: "00000000-0000-4000-8000-0000000000b1",
    correlationId: "correlation-fase-7",
  });

  assert.equal(result.authoritativeGate, "readiness");
  assert.equal(result.preflightId, PREFLIGHT_ID);
  assert.equal("ready" in result, false);
  assert.deepEqual(result.summary, { total: 5, passedCount: 5, failedCount: 0 });
  assert.deepEqual(calls.map(({ kind }) => kind), ["meta", "ai", "payments", "appointments", "integrations"]);
  assert.ok(calls.every(({ input }) => input.empresaId === TENANT_ID && input.signal instanceof AbortSignal));
  assert.ok(calls.every(({ input }) => input.actorId === "00000000-0000-4000-8000-0000000000b1"));
  assert.ok(calls.every(({ input }) => input.correlationId === "correlation-fase-7"));
  assert.ok(calls.every(({ input }) => input.preflightId === PREFLIGHT_ID));
  assert.equal(calls.find(({ kind }) => kind === "meta").input.target.numberId, "numero-sintetico");
  assert.equal(calls.find(({ kind }) => kind === "ai").input.target.credentialRef, "credential:ai-sintetica");
  assert.equal(calls.find(({ kind }) => kind === "appointments").input.target.id, "agenda-sintetica");
  assert.equal(calls.some(({ input }) => input.target.id === "opcional"), false);
  assert.ok(result.checks.every((check) => check.state === "passed" && check.severity === "info"));
  assert.ok(result.checks.every((check) => check.correctiveAction === "Nenhuma ação adicional."));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.checks[0]), true);
  assert.equal(audits.length, 2);
  assert.equal(audits[0].action, "onboarding.preflight.started");
  assert.equal(audits[0].empresaId, TENANT_ID);
  assert.equal(audits[0].resourceId, PREFLIGHT_ID);
  assert.equal(audits[0].result, "success");
  assert.equal(audits[1].action, "onboarding.preflight.completed");
  assert.equal(audits[1].resourceId, PREFLIGHT_ID);
  assert.equal(audits[1].details.preflightId, PREFLIGHT_ID);
  assert.equal(audits[1].result, "success");
  assert.doesNotMatch(JSON.stringify({ result, audits }), /segredo-que-nao-pode-sair/u);
});

test("falha fechado para erro, retorno ambíguo, probe ausente e timeout sem vazar detalhes", async () => {
  const secret = "synthetic-provider-secret-123";
  const probes = {
    meta: async () => { throw new Error(`Bearer ${secret}`); },
    ai: async () => ({ success: false, error: secret }),
    payments: async () => undefined,
    appointments: async ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ success: true }), { once: true });
    }),
    // integrations propositalmente ausente
  };
  const { service, audits } = subject({ probes, timeoutMs: 10 });
  const result = await service.run({ empresaId: TENANT_ID, configuration: configuration(), targets });

  assert.deepEqual(result.summary, { total: 5, passedCount: 0, failedCount: 5 });
  assert.ok(result.checks.every((check) => check.state === "failed" && check.severity === "blocker"));
  assert.ok(result.checks.some(({ code }) => code === "META_EXTERNAL_CONNECTION_UNAVAILABLE"));
  assert.ok(result.checks.some(({ code }) => code === "AI_PROVIDER_CONNECTION_UNAVAILABLE"));
  assert.ok(result.checks.some(({ code }) => code === "PAYMENT_PROVIDER_CONNECTION_UNAVAILABLE"));
  assert.ok(result.checks.some(({ code }) => code === "APPOINTMENT_INTEGRATION_CONNECTION_TIMEOUT"));
  assert.ok(result.checks.some(({ code }) => code === "REQUIRED_INTEGRATION_CONNECTION_CHECK_UNAVAILABLE"));
  assert.equal(audits[1].result, "failure");
  assert.doesNotMatch(JSON.stringify({ result, audits }), new RegExp(secret, "u"));
});

test("limita concorrência sem alterar a ordem determinística dos checks", async () => {
  let active = 0;
  let peak = 0;
  const release = [];
  const probe = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => release.push(resolve));
    active -= 1;
    return { success: true };
  };
  const { service } = subject({
    probes: { meta: probe, ai: probe, payments: probe, appointments: probe, integrations: probe },
    maxConcurrency: 2,
  });
  const running = service.run({ empresaId: TENANT_ID, configuration: configuration(), targets });

  while (release.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  release.shift()();
  while (release.length < 2) await new Promise((resolve) => setImmediate(resolve));
  release.shift()();
  while (release.length < 2) await new Promise((resolve) => setImmediate(resolve));
  while (release.length > 0) release.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  while (release.length > 0) release.shift()();

  const result = await running;
  assert.equal(peak, 2);
  assert.deepEqual(result.checks.map(({ target }) => target.kind), [
    "meta", "ai", "payments", "appointments", "integrations",
  ]);
});

test("recusa alvo Meta de outro tenant sem chamar o probe", async () => {
  let calls = 0;
  const { service, audits } = subject({ probes: { meta: async () => { calls += 1; return { success: true }; } } });
  const result = await service.run({
    empresaId: TENANT_ID,
    configuration: { modules: ["catalog"], integrations: [] },
    targets: { meta: { empresaId: "tenant-b", applicationId: "app-b", numberId: "number-b" } },
  });

  assert.equal(calls, 0);
  assert.equal(result.checks[0].code, "META_EXTERNAL_CONNECTION_TENANT_MISMATCH");
  assert.equal(result.checks[0].state, "failed");
  assert.equal(audits[1].empresaId, TENANT_ID);
});

test("falha da auditoria inicial impede qualquer chamada externa e não expõe a causa", async () => {
  let probeCalls = 0;
  const { service } = subject({
    probes: { meta: async () => { probeCalls += 1; return { success: true }; } },
    auditWriter: async () => { throw new Error("segredo interno da auditoria"); },
  });
  await assert.rejects(
    service.run({ empresaId: TENANT_ID, configuration: { modules: ["catalog"] }, targets }),
    (error) => {
      assert.ok(error instanceof PreflightServiceError);
      assert.equal(error.code, "PREFLIGHT_AUDIT_FAILED");
      assert.equal(error.status, 500);
      assert.doesNotMatch(JSON.stringify(error), /segredo interno/u);
      assert.equal("cause" in error, false);
      return true;
    },
  );
  assert.equal(probeCalls, 0);
});

test("timeout aguarda encerramento cooperativo após abort antes de concluir", async () => {
  const lifecycle = [];
  const { service, audits } = subject({
    timeoutMs: 10,
    abortGraceMs: 100,
    probes: {
      meta: async ({ signal }) => new Promise((resolve) => {
        lifecycle.push("probe_started");
        signal.addEventListener("abort", () => {
          setImmediate(() => {
            lifecycle.push("probe_stopped");
            resolve({ success: false });
          });
        }, { once: true });
      }),
    },
  });
  const result = await service.run({
    empresaId: TENANT_ID,
    configuration: { modules: ["catalog"], integrations: [] },
    targets,
  });

  lifecycle.push("run_completed");
  assert.deepEqual(lifecycle, ["probe_started", "probe_stopped", "run_completed"]);
  assert.equal(result.checks[0].code, "META_EXTERNAL_CONNECTION_TIMEOUT");
  assert.equal(audits[1].resourceId, result.preflightId);
});

test("timeout de probe não cooperativo encerra após limite seguro e permanece bloqueador", async () => {
  const { service } = subject({
    timeoutMs: 10,
    abortGraceMs: 10,
    probes: { meta: async () => new Promise(() => {}) },
  });
  const result = await service.run({
    empresaId: TENANT_ID,
    configuration: { modules: ["catalog"], integrations: [] },
    targets,
  });

  assert.equal(result.checks[0].code, "META_EXTERNAL_CONNECTION_TIMEOUT_UNCOOPERATIVE");
  assert.equal(result.checks[0].state, "failed");
  assert.equal(result.checks[0].severity, "blocker");
});

test("valida limites e não aceita identificadores capazes de carregar query ou segredo", async () => {
  assert.throws(() => subject({ timeoutMs: 1 }), /timeoutMs/u);
  assert.throws(() => subject({ abortGraceMs: 1 }), /abortGraceMs/u);
  assert.throws(() => subject({ maxConcurrency: 9 }), /maxConcurrency/u);
  const { service } = subject();
  await assert.rejects(
    service.run({ empresaId: "tenant?access_token=segredo", configuration: {}, targets: {} }),
    (error) => error.code === "PREFLIGHT_INPUT_INVALID" && error.status === 400,
  );
});

test("não inventa conexão externa para IA simulada ou PIX baseado apenas em credencial", async () => {
  const calls = [];
  const { service } = subject({
    probes: {
      meta: async () => ({ success: true }),
      ai: async () => { calls.push("ai"); return { success: true }; },
      payments: async () => { calls.push("payments"); return { success: true }; },
    },
  });
  const result = await service.run({
    empresaId: TENANT_ID,
    configuration: {
      modules: ["ai_freeform", "payments"],
      ai: { enabled: true, provider: "simulated", keyMode: "simulated" },
      payments: { credentialRef: "credential:pix-local" },
    },
    targets,
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(result.summary, { total: 1, passedCount: 1, failedCount: 0 });
});
