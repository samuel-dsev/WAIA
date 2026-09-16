import test from "node:test";
import assert from "node:assert/strict";
import {
  compileTenantRuntimeConfigV2,
  materializeLegacyTenantDefinition,
} from "../src/modules/configuration/index.js";
import { PreviewService } from "../src/modules/onboarding/preview-service.js";
import { createConfiguredTenantRuntime } from "../src/tenants/configured-runtime.js";

const ACTOR_A = "admin-a";
const ACTOR_B = "admin-b";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

function baseConfiguration(name = "Empresa Sintética") {
  return {
    schemaVersion: 2,
    identity: {
      name,
      displayName: name,
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
      welcomeMessage: `Olá, você está no menu da ${name}.`,
      fallbackMessage: "Fallback público.",
    },
    retention: { messagesDays: 30, logsDays: 30 },
    modules: ["catalog", "ai_freeform"],
    menu: {
      text: `Menu da ${name}`,
      options: [{ id: "catalogo", label: "Catálogo", action: "catalog.list", params: {} }],
    },
    routing: {
      greetings: ["oi"],
      aliases: [{ terms: ["produtos"], action: "catalog.list", params: {} }],
      fallbackAction: "ai_freeform.reply",
    },
    catalog: { items: [{ id: "item-1", name: `Item da ${name}`, price: 12.5, active: true }] },
    ai: {
      enabled: true,
      provider: "simulated",
      model: "preview-v1",
      prompt: "Use somente o contexto público.",
      keyMode: "own",
      credentialRef: "credential:ai-preview-secret-reference",
      fallbackMessage: "IA indisponível.",
    },
  };
}

function flowAndAppointmentConfiguration() {
  return {
    schemaVersion: 2,
    identity: { name: "Clínica Sintética", fallbackMessage: "Escolha uma opção." },
    modules: ["appointments", "flows", "human_handoff"],
    menu: {
      text: "Menu da clínica",
      options: [
        { id: "agendar", label: "Agendar", action: "appointments.start", params: {} },
        { id: "triagem", label: "Triagem", action: "flows.start", params: { flowRef: "flow:triagem" } },
        { id: "humano", label: "Atendimento humano", action: "human_handoff.request", params: {} },
      ],
    },
    routing: {
      greetings: ["oi"],
      aliases: [{ terms: ["iniciar triagem"], action: "flows.start", params: { flowRef: "flow:triagem" } }],
    },
    appointments: {
      services: [{
        id: "consulta",
        name: "Consulta inicial",
        active: true,
        slots: [{ id: "seg-09", label: "Segunda às 09h", startsAt: "2026-09-07T09:00:00-03:00", available: true }],
      }],
    },
    humanHandoff: { message: "A equipe continuará o atendimento." },
    flows: {
      definitions: [{
        key: "triagem",
        name: "Triagem documental",
        version: 1,
        startStepId: "choice",
        steps: [
          {
            id: "choice",
            type: "single_choice",
            message: "Deseja anexar o documento?",
            field: "route",
            required: true,
            options: [{ id: "attach", label: "Anexar", nextStepId: "document" }],
          },
          {
            id: "document",
            type: "document",
            message: "Envie um PDF.",
            field: "document",
            required: true,
            nextStepId: "done",
          },
          { id: "done", type: "completion", message: "Triagem concluída." },
        ],
      }],
    },
  };
}

function memoryStateRepository() {
  const values = new Map();
  return {
    async load({ empresaId, conversationId }) {
      return structuredClone(values.get(`${empresaId}:${conversationId}`) || null);
    },
    async save({ empresaId, conversationId }, state) {
      const key = `${empresaId}:${conversationId}`;
      if (state == null) values.delete(key);
      else values.set(key, structuredClone(state));
    },
  };
}

function request(overrides = {}) {
  return {
    actorId: ACTOR_A,
    empresaId: TENANT_A,
    configuration: baseConfiguration(),
    draftVersion: 7,
    sessionId: "session-1",
    expectedSessionRevision: 0,
    message: { type: "text", text: "oi" },
    ...overrides,
  };
}

test("simulador e runtime existente tomam decisões conversacionais equivalentes", async () => {
  const configuration = baseConfiguration();
  const aiSimulator = async () => ({ reply: { text: "Resposta sintética equivalente.", buttons: [] } });
  const preview = new PreviewService({ aiSimulator });
  const compiled = compileTenantRuntimeConfigV2(configuration, {
    empresaId: TENANT_A,
    configVersion: 7,
    draftVersion: 7,
  });
  const direct = createConfiguredTenantRuntime({
    definition: materializeLegacyTenantDefinition(compiled),
    stateRepository: memoryStateRepository(),
    aiHandler: aiSimulator,
  });
  const inputs = [
    { message: { type: "text", text: "oi" }, runtime: { type: "text", text: "oi" } },
    { message: { type: "text", text: "quero produtos" }, runtime: { type: "text", text: "quero produtos" } },
    { message: { type: "list", selectionId: "catalogo" }, runtime: { type: "interactive", text: "catalogo", selectionId: "catalogo" } },
    { message: { type: "text", text: "pergunta livre" }, runtime: { type: "text", text: "pergunta livre" } },
  ];
  let revision = 0;
  for (const [index, input] of inputs.entries()) {
    const simulated = await preview.simulate(request({
      configuration,
      expectedSessionRevision: revision,
      message: input.message,
    }));
    revision = simulated.sessionRevision;
    const actual = await direct.handle({
      conversationId: "direct-conversation",
      contactId: "direct-contact",
      correlationId: `direct-${index}`,
      ...input.runtime,
    });
    assert.deepEqual(simulated.reply, {
      source: actual.source,
      module: actual.module,
      text: actual.text,
      buttons: actual.buttons,
    });
  }
  assert.equal(revision, inputs.length);
});

test("sessões são isoladas por ator e tenant e rejeitam revisão stale ou configuração trocada", async () => {
  const preview = new PreviewService();
  const firstA = await preview.simulate(request());
  const firstOtherActor = await preview.simulate(request({
    actorId: ACTOR_B,
  }));
  const firstOtherTenant = await preview.simulate(request({
    empresaId: TENANT_B,
    configuration: baseConfiguration("Empresa B"),
  }));
  assert.equal(firstA.sequence, 1);
  assert.equal(firstOtherActor.sequence, 1);
  assert.equal(firstOtherTenant.sequence, 1);
  assert.match(firstA.reply.text, /Empresa Sintética/u);
  assert.match(firstOtherActor.reply.text, /Empresa Sintética/u);
  assert.match(firstOtherTenant.reply.text, /Empresa B/u);

  await assert.rejects(
    preview.simulate(request({ expectedSessionRevision: 0, message: { type: "text", text: "produtos" } })),
    (error) => error.code === "PREVIEW_SESSION_REVISION_CONFLICT"
      && error.status === 409
      && error.details.currentSessionRevision === 1,
  );
  await assert.rejects(
    preview.simulate(request({
      expectedSessionRevision: 1,
      configuration: baseConfiguration("Configuração alterada"),
      message: { type: "text", text: "produtos" },
    })),
    (error) => error.code === "PREVIEW_CONFIGURATION_CHANGED" && error.status === 409,
  );
  assert.equal(preview.resetSession({
    actorId: ACTOR_A,
    empresaId: TENANT_A,
    sessionId: "session-1",
    expectedSessionRevision: 1,
  }), true);
  const restarted = await preview.simulate(request({ configuration: baseConfiguration("Configuração alterada") }));
  assert.equal(restarted.sessionRevision, 1);
  assert.match(restarted.reply.text, /Configuração alterada/u);
});

test("TTL elimina sessões vencidas e limite impede crescimento sem controle", async () => {
  let now = 1_000;
  const preview = new PreviewService({ clock: () => now, sessionTtlMs: 1_000, maxSessions: 1 });
  await preview.simulate(request());
  await assert.rejects(
    preview.simulate(request({ sessionId: "session-2" })),
    (error) => error.code === "PREVIEW_SESSION_LIMIT_REACHED" && error.status === 429,
  );
  now = 2_001;
  const afterExpiry = await preview.simulate(request({ sessionId: "session-2" }));
  assert.equal(afterExpiry.sessionRevision, 1);
  await assert.rejects(
    preview.simulate(request({ expectedSessionRevision: 1 })),
    (error) => error.code === "PREVIEW_SESSION_REVISION_CONFLICT"
      && error.details.currentSessionRevision === 0,
  );
});

test("limite de sessões é isolado por administrador e tenant", async () => {
  const preview = new PreviewService({ maxSessions: 1 });
  await preview.simulate(request());
  const anotherActor = await preview.simulate(request({
    actorId: "00000000-0000-4000-8000-0000000000b2",
    sessionId: "session-2",
  }));
  const anotherTenant = await preview.simulate(request({
    empresaId: "00000000-0000-4000-8000-0000000000a2",
    sessionId: "session-3",
  }));

  assert.equal(anotherActor.sessionRevision, 1);
  assert.equal(anotherTenant.sessionRevision, 1);
});

test("fluxo, botão, documento sintético, reset, agendamento e handoff usam apenas repositórios isolados", async () => {
  const configuration = flowAndAppointmentConfiguration();
  const preview = new PreviewService();
  const send = async (sessionId, expectedSessionRevision, message) => preview.simulate(request({
    configuration,
    draftVersion: 3,
    sessionId,
    expectedSessionRevision,
    message,
  }));

  let flow = await send("flow", 0, { type: "text", text: "quero iniciar triagem" });
  assert.deepEqual(flow.reply.buttons, [{ id: "flow-option:attach", label: "Anexar" }]);
  flow = await send("flow", 1, { type: "button", selectionId: "flow-option:attach" });
  assert.match(flow.reply.text, /Envie um PDF/u);
  flow = await send("flow", 2, {
    type: "document",
    document: { name: "arquivo.pdf", mimeType: "application/pdf", sizeBytes: 2_048 },
  });
  assert.match(flow.reply.text, /Triagem concluída/u);
  assert.deepEqual(flow.activity.flows, [{
    flowKey: "triagem",
    flowVersion: 1,
    status: "completed",
    currentStepId: "done",
    documentCount: 1,
  }]);

  let reset = await send("reset", 0, { type: "text", text: "iniciar triagem" });
  reset = await send("reset", 1, { type: "reset" });
  assert.equal(reset.reply.module, null);
  assert.equal(reset.reply.text, "Menu da clínica");
  assert.equal(reset.activity.flows[0].status, "cancelled");

  let appointment = await send("appointment", 0, { type: "list", selectionId: "agendar" });
  appointment = await send("appointment", 1, { type: "button", selectionId: "appointment:consulta" });
  appointment = await send("appointment", 2, { type: "button", selectionId: "slot:seg-09" });
  appointment = await send("appointment", 3, { type: "text", text: "Pessoa Sintética" });
  assert.equal(appointment.activity.appointments.length, 1);
  assert.deepEqual(appointment.activity.appointments[0], {
    status: "Pendente",
    serviceId: "consulta",
    slotId: "seg-09",
  });

  const handoff = await send("handoff", 0, { type: "button", selectionId: "humano" });
  assert.equal(handoff.reply.module, "human_handoff");
  assert.deepEqual(handoff.activity.handoffs, [{ status: "waiting_operator" }]);
});

test("IA, integrações e documentos são marcados como simulados sem rede nem referências sensíveis na resposta", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("rede proibida no simulador");
  };
  try {
    const preview = new PreviewService();
    const result = await preview.simulate(request({ message: { type: "text", text: "pergunta não mapeada" } }));
    const serialized = JSON.stringify(result);
    assert.equal(networkCalls, 0);
    assert.equal(result.synthetic, true);
    assert.deepEqual(result.externalCalls, []);
    assert.deepEqual(result.simulation, {
      runtime: "configured-runtime",
      persistence: "isolated-memory",
      ai: "simulated",
      documents: "synthetic-metadata-only",
      externalCallsAllowed: false,
    });
    assert.match(result.reply.text, /Resposta simulada da IA/u);
    assert.doesNotMatch(serialized, /ai-preview-secret-reference/u);
    assert.doesNotMatch(serialized, /Use somente o contexto público/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("configVersion é resolvida internamente e valores enviados pelo cliente são recusados", async () => {
  const resolutions = [];
  const preview = new PreviewService({
    configurationVersionResolver(input) {
      resolutions.push(structuredClone(input));
      return 42;
    },
  });
  const input = request();
  input.configVersion = 999;
  await assert.rejects(
    preview.simulate(input),
    (error) => error.code === "PREVIEW_INPUT_UNKNOWN_FIELD" && error.path === "/configVersion",
  );
  const result = await preview.simulate(request());
  assert.equal(result.configVersion, 42);
  assert.deepEqual(resolutions, [{ actorId: ACTOR_A, empresaId: TENANT_A, draftVersion: 7 }]);
});
