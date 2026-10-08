import test from "node:test";
import assert from "node:assert/strict";
import { scriptSaveRequest } from "../panel/attendance-script.js";
import { compileTenantRuntimeConfigV2, materializeLegacyTenantDefinition } from "../src/modules/configuration/index.js";
import { createConfiguredTenantRuntime } from "../src/tenants/configured-runtime.js";
import { AdminService, MemoryAdminRepository } from "../src/modules/admin/index.js";

const configuration = () => ({
  schemaVersion: 2,
  identity: { name: "Empresa Sintética", welcomeMessage: "Olá!", fallbackMessage: "Indisponível" },
  modules: ["catalog", "human_handoff", "ai_freeform"],
  menu: { text: "Olá! Como podemos ajudar?", options: [{ id: "endereco", label: "Endereço", action: "catalog.address" }] },
  routing: { greetings: ["oi", "olá"], aliases: [
    { terms: ["endereço", "onde fica"], action: "catalog.address" },
    { terms: ["áreas de atuação"], action: "catalog.menu" },
    { terms: ["quero falar com um advogado", "falar com advogado"], action: "human_handoff.request" },
  ], fallbackAction: null },
  publicReplies: [{ action: "catalog.address", text: "Rua Sintética, 10." }, { action: "catalog.menu", text: "Áreas configuradas." }],
  humanHandoff: { message: "Encaminhado à equipe." },
  ai: { enabled: true, provider: "simulated", model: "test", prompt: "Seja acolhedor.\nPeça o nome e relate os próximos passos.", keyMode: "simulated", followUpQuestion: "Pergunta antiga?" },
});

function runtime(definition) {
  const states = new Map();
  const calls = [];
  const result = createConfiguredTenantRuntime({ definition, stateRepository: {
    async load({ conversationId }) { return states.get(conversationId) || null; },
    async save({ conversationId }, state) { states.set(conversationId, state); },
  }, handoffRepository: { async request() {} },
  aiHandler: async (context) => { calls.push(context.input.text); return { reply: { text: "Resposta conforme roteiro." } }; } });
  return { ...result, calls };
}

test("saudações, menu e aliases são predefinidos; demais mensagens usam IA mesmo com fallback antigo", async () => {
  const compiled = compileTenantRuntimeConfigV2(configuration(), { empresaId: "synthetic", configVersion: 2 });
  const bot = runtime(materializeLegacyTenantDefinition(compiled));
  for (const [index, text] of ["oi", "olá", "Endereço", "onde fica o escritório?", "Quais as áreas de atuação?"].entries()) {
    const reply = await bot.handle({ conversationId: `preset-${index}`, text });
    assert.ok(reply.text);
    assert.notEqual(reply.module, "ai_freeform");
  }
  assert.equal(bot.calls.length, 0);
  for (const text of ["Preciso de orientação sobre uma situação", "Quais informações devo fornecer?"]) {
    const reply = await bot.handle({ conversationId: "livre", text });
    assert.equal(reply.module, "ai_freeform");
    assert.equal(reply.text, "Resposta conforme roteiro."); // Não injeta a pergunta complementar antiga.
  }
  assert.equal(bot.calls.length, 2);
  const handoff = await bot.handle({ conversationId: "humano", text: "Eu quero falar com um advogado, por favor" });
  assert.equal(handoff.module, "human_handoff");
  await bot.handle({ conversationId: "humano", text: "Outra pergunta fora da predefinição" });
  assert.equal(bot.calls.length, 2); // Pausa humana continua valendo.
});

test("roteiro vazio ou IA desabilitada mantém o roteamento anterior", async () => {
  for (const change of [{ prompt: "" }, { enabled: false }]) {
    // Contrato legado também aceita IA sem prompt e preserva seu fallback.
    const definition = materializeLegacyTenantDefinition(compileTenantRuntimeConfigV2(configuration(), { empresaId: "synthetic", configVersion: 2 }));
    definition.routing.fallbackAction = "catalog.list";
    Object.assign(definition.ai, change);
    const bot = runtime(definition);
    assert.equal((await bot.handle({ conversationId: "sem-roteiro", text: "Texto livre" })).module, "catalog");
    assert.equal(bot.calls.length, 0);
  }
});

test("salvar roteiro versionado preserva predefinições e usa revisão otimista; legado atualiza só prompt", () => {
  const draft = { draftVersion: 7, configuration: configuration() };
  const before = structuredClone(draft);
  const operation = scriptSaveRequest({ base: "/tenants/synthetic", draft, value: "Novo\nroteiro" });
  assert.equal(operation.path, "/tenants/synthetic/configuration/draft");
  assert.equal(operation.method, "PUT");
  assert.equal(operation.body.draftVersion, 7);
  assert.equal(operation.body.configuration.ai.prompt, "Novo\nroteiro");
  assert.deepEqual(operation.body.configuration.routing, draft.configuration.routing);
  assert.deepEqual(operation.body.configuration.publicReplies, draft.configuration.publicReplies);
  assert.deepEqual(draft, before);
  assert.deepEqual(scriptSaveRequest({ base: "/tenants/synthetic", value: "Novo\nroteiro" }), {
    path: "/tenants/synthetic/ai-config/synthetic", method: "PATCH", body: { prompt: "Novo\nroteiro" },
  });
});

test("API legada aceita roteiro multilinha até 20000 caracteres, preservando isolamento e rejeitando controles", async () => {
  const repository = new MemoryAdminRepository({ environment: "test", tenants: [{ id: "tenant-a", status: "active" }, { id: "tenant-b", status: "active" }],
    records: { "ai-config": [{ id: "tenant-a", empresaId: "tenant-a", model: "test" }] } });
  const service = new AdminService({ repository });
  const auth = { user: { id: "admin-a" }, memberships: [{ empresaId: "tenant-a", role: "tenant_admin" }] };
  const update = (prompt, empresaId = "tenant-a") => service.update({ auth, empresaId, resource: "ai-config", id: empresaId, body: { prompt } });
  const script = `Início\r\n\t${"x".repeat(19_980)}\nFim`;
  await update(script);
  assert.equal((await repository.get({ resource: "ai-config", empresaId: "tenant-a", id: "tenant-a" })).prompt, script.replaceAll("\r\n", "\n"));
  for (const invalid of ["x".repeat(20_001), "a\u0000b", 123]) await assert.rejects(update(invalid), (error) => error.status === 400);
  await assert.rejects(update("Roteiro", "tenant-b"), (error) => error.status === 403);
});
