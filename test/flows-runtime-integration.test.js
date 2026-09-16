import test from "node:test";
import assert from "node:assert/strict";
import {
  compileTenantRuntimeConfigV2,
  materializeLegacyTenantDefinition,
} from "../src/modules/configuration/index.js";
import { createConfiguredTenantRuntime } from "../src/tenants/configured-runtime.js";

const TENANT_ID = "00000000-0000-4000-8000-0000000000f4";

function flowDefinition(version, completionText) {
  return {
    key: "synthetic_triage",
    name: "Triagem sintética",
    version,
    startStepId: "welcome",
    steps: [
      {
        id: "welcome",
        type: "message",
        message: `Início v${version}.`,
        nextStepId: "choice",
      },
      {
        id: "choice",
        type: "single_choice",
        message: "Escolha como continuar.",
        field: "route",
        required: true,
        options: [{ id: "finish", label: "Concluir", nextStepId: "done" }],
      },
      { id: "done", type: "completion", message: completionText },
    ],
  };
}

function runtimeDefinition({ configVersion, flowVersion, completionText }) {
  const compiled = compileTenantRuntimeConfigV2({
    schemaVersion: 2,
    identity: {
      name: "Empresa Fluxos",
      displayName: "Empresa Fluxos",
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
    },
    retention: { messagesDays: 30, logsDays: 30 },
    modules: ["flows"],
    menu: {
      text: "Menu principal",
      options: [{
        id: "triage",
        label: "Iniciar triagem",
        action: "flows.start",
        params: { flowRef: "flow:synthetic_triage" },
      }],
    },
    routing: {
      aliases: [{
        terms: ["triagem"],
        action: "flows.start",
        params: { flowRef: "flow:synthetic_triage" },
      }],
    },
    flows: { definitions: [flowDefinition(flowVersion, completionText)] },
  }, {
    empresaId: TENANT_ID,
    configVersion,
    draftVersion: configVersion,
  });
  return materializeLegacyTenantDefinition(compiled);
}

function memoryStateRepository() {
  const states = new Map();
  const key = ({ empresaId, conversationId }) => `${empresaId}:${conversationId}`;
  return {
    async load(context) {
      return structuredClone(states.get(key(context)) || null);
    },
    async save(context, state) {
      if (state == null) states.delete(key(context));
      else states.set(key(context), structuredClone(state));
    },
  };
}

function pinnedFlowRepository(versions) {
  let active = null;
  const calls = [];

  function versionFor(configurationVersion) {
    const definition = versions.get(configurationVersion);
    return definition && {
      flowId: `flow-id:${definition.key}`,
      flowKey: definition.key,
      flowVersionId: `flow-version:${definition.key}:v${definition.version}`,
      flowVersion: definition.version,
      configurationVersion,
      definition: structuredClone(definition),
    };
  }

  async function saveSubmission(input) {
    calls.push({ method: "saveSubmission", input: structuredClone(input) });
    assert.equal(input.flowVersionId, active.submission.flowVersionId);
    assert.equal(input.expectedRevision, active.submission.revision);
    active = {
      version: active.version,
      submission: {
        ...active.submission,
        status: input.status,
        currentStepId: input.currentStepId,
        data: structuredClone(input.data),
        revision: active.submission.revision + 1,
      },
    };
    return structuredClone(active.submission);
  }

  return {
    calls,
    async findPublishedDefinition({ empresaId, flowKey, configurationVersion }) {
      calls.push({ method: "findPublishedDefinition", empresaId, flowKey, configurationVersion });
      const version = versionFor(configurationVersion);
      return version?.flowKey === flowKey ? version : null;
    },
    async findVersionById({ flowVersionId }) {
      calls.push({ method: "findVersionById", flowVersionId });
      return active?.version.flowVersionId === flowVersionId
        ? structuredClone(active.version)
        : null;
    },
    async startSubmission(input) {
      calls.push({ method: "startSubmission", input: structuredClone(input) });
      if (active && ["active", "waiting"].includes(active.submission.status)) {
        const error = new Error("A conversa já possui um fluxo em andamento.");
        error.code = "FLOW_SUBMISSION_ALREADY_ACTIVE";
        throw error;
      }
      const version = versionFor(input.configurationVersion);
      assert.ok(version, "a revisão publicada precisa existir");
      assert.equal(input.expectedFlowVersionId, version.flowVersionId);
      assert.equal(input.initialState.flowVersionId, version.flowVersionId);
      const status = input.initialState.status === "waiting_input"
        ? "waiting"
        : input.initialState.status;
      active = {
        version,
        submission: {
          id: "submission:synthetic",
          empresaId: input.empresaId,
          flowId: version.flowId,
          flowVersionId: version.flowVersionId,
          flowVersion: version.flowVersion,
          configurationVersion: version.configurationVersion,
          conversationId: input.conversationId,
          contactId: input.contactId,
          status,
          currentStepId: input.initialState.currentStepId,
          data: structuredClone(input.initialState),
          revision: 1,
        },
      };
      return structuredClone(active);
    },
    async findActiveSubmission({ empresaId, conversationId }) {
      calls.push({ method: "findActiveSubmission", empresaId, conversationId });
      if (!active || !["active", "waiting"].includes(active.submission.status)) return null;
      return structuredClone(active);
    },
    saveSubmission,
    async completeSubmission(input) {
      return saveSubmission({ ...input, status: "completed" });
    },
    async cancelSubmission(input) {
      return saveSubmission({ ...input, status: "cancelled" });
    },
  };
}

function createRuntime(definition, stateRepository, flowRepository) {
  return createConfiguredTenantRuntime({
    definition,
    stateRepository,
    flowRepository,
  });
}

test("runtime inicia por alias, gera payloads próprios e continua na versão pinada", async () => {
  const v1 = flowDefinition(1, "Concluída pela versão 1.");
  const v2 = flowDefinition(2, "Concluída pela versão 2.");
  const flowRepository = pinnedFlowRepository(new Map([[1, v1], [2, v2]]));
  const stateRepository = memoryStateRepository();
  const conversation = { conversationId: "conversation-flow-1", contactId: "contact-flow-1" };

  const firstRuntime = createRuntime(
    runtimeDefinition({ configVersion: 1, flowVersion: 1, completionText: "Concluída pela versão 1." }),
    stateRepository,
    flowRepository,
  );
  const started = await firstRuntime.handle({ ...conversation, text: "Quero fazer a triagem" });
  assert.equal(started.module, "flows");
  assert.match(started.text, /Início v1\./u);
  assert.match(started.text, /Escolha como continuar\./u);
  assert.deepEqual(started.buttons, [{ id: "flow-option:finish", label: "Concluir" }]);

  // O worker recarrega a revisão ativa a cada mensagem. Mesmo com a v2 ativa,
  // a continuação deve obter definition e flowVersionId da submissão iniciada.
  const secondRuntime = createRuntime(
    runtimeDefinition({ configVersion: 2, flowVersion: 2, completionText: "Concluída pela versão 2." }),
    stateRepository,
    flowRepository,
  );
  const completed = await secondRuntime.handle({ ...conversation, selectionId: "flow-option:finish" });
  assert.equal(completed.module, "flows");
  assert.match(completed.text, /Concluída pela versão 1\./u);
  assert.doesNotMatch(completed.text, /versão 2/u);
  assert.deepEqual(completed.buttons, []);

  const writes = flowRepository.calls.filter(({ method }) => method === "saveSubmission");
  assert.equal(writes.at(-1).input.flowVersionId, "flow-version:synthetic_triage:v1");
  assert.equal(writes.at(-1).input.status, "completed");
  assert.ok(flowRepository.calls.some(({ method }) => method === "findActiveSubmission"));
});

test("reset para o menu cancela a submissão antes de limpar o estado conversacional", async () => {
  const definition = flowDefinition(1, "Concluída.");
  const flowRepository = pinnedFlowRepository(new Map([[1, definition]]));
  const stateRepository = memoryStateRepository();
  const runtime = createRuntime(
    runtimeDefinition({ configVersion: 1, flowVersion: 1, completionText: "Concluída." }),
    stateRepository,
    flowRepository,
  );
  const conversation = { conversationId: "conversation-flow-reset", contactId: "contact-flow-reset" };

  await runtime.handle({ ...conversation, action: "flows.start", payload: { flowRef: "flow:synthetic_triage" } });
  const menu = await runtime.handle({ ...conversation, resetToMenu: true });

  assert.equal(menu.module, null);
  assert.equal(menu.text, "Menu principal");
  const cancellation = flowRepository.calls.findLast(({ method, input }) => (
    method === "saveSubmission" && input.status === "cancelled"
  ));
  assert.ok(cancellation, "resetToMenu precisa finalizar a submissão ativa");
  assert.equal(cancellation.input.flowVersionId, "flow-version:synthetic_triage:v1");
  assert.equal(await stateRepository.load({ empresaId: TENANT_ID, conversationId: conversation.conversationId }), null);
});

test("flows.cancel encerra a submissão e devolve confirmação pública não vazia", async () => {
  const definition = flowDefinition(1, "Concluída.");
  const flowRepository = pinnedFlowRepository(new Map([[1, definition]]));
  const stateRepository = memoryStateRepository();
  const runtime = createRuntime(
    runtimeDefinition({ configVersion: 1, flowVersion: 1, completionText: "Concluída." }),
    stateRepository,
    flowRepository,
  );
  const conversation = { conversationId: "conversation-flow-cancel", contactId: "contact-flow-cancel" };

  await runtime.handle({ ...conversation, action: "flows.start", payload: { flowRef: "flow:synthetic_triage" } });
  const cancelled = await runtime.handle({ ...conversation, action: "flows.cancel" });

  assert.equal(cancelled.module, "flows");
  assert.match(cancelled.text, /cancelad[oa]/iu);
  assert.deepEqual(cancelled.buttons, []);
  const cancellation = flowRepository.calls.findLast(({ method, input }) => (
    method === "saveSubmission" && input.status === "cancelled"
  ));
  assert.ok(cancellation);
  assert.equal(await stateRepository.load({ empresaId: TENANT_ID, conversationId: conversation.conversationId }), null);
});

test("novo flows.start explícito cancela a submissão anterior antes de reiniciar", async () => {
  const definition = flowDefinition(1, "Concluída.");
  const flowRepository = pinnedFlowRepository(new Map([[1, definition]]));
  const stateRepository = memoryStateRepository();
  const runtime = createRuntime(
    runtimeDefinition({ configVersion: 1, flowVersion: 1, completionText: "Concluída." }),
    stateRepository,
    flowRepository,
  );
  const conversation = { conversationId: "conversation-flow-restart", contactId: "contact-flow-restart" };

  await runtime.handle({ ...conversation, action: "flows.start", payload: { flowRef: "flow:synthetic_triage" } });
  const restarted = await runtime.handle({
    ...conversation,
    action: "flows.start",
    payload: { flowRef: "flow:synthetic_triage" },
  });

  assert.equal(restarted.module, "flows");
  assert.match(restarted.text, /Início v1\./u);
  const relevantCalls = flowRepository.calls
    .filter(({ method }) => ["startSubmission", "saveSubmission"].includes(method));
  assert.deepEqual(relevantCalls.map(({ method, input }) => (
    method === "saveSubmission" ? `${method}:${input.status}` : method
  )), ["startSubmission", "saveSubmission:cancelled", "startSubmission"]);
});
