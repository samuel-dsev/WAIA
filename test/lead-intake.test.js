import test from "node:test";
import assert from "node:assert/strict";
import { compileTenantRuntimeConfigV2, verifyCompiledTenantRuntimeConfigV2 } from "../src/modules/configuration/index.js";
import { materializeLegacyTenantDefinition } from "../src/modules/configuration/legacy-adapter.js";
import { MemoryAiConfigResolver, MemoryAiLedger, MemoryAiSecretResolver, MemoryPricingCatalog, MemoryResponsesClientFactory, MultiTenantAiService } from "../src/modules/ai/index.js";
import { normalizeAiConfig } from "../src/modules/ai/contracts.js";
import { parseLeadIntake } from "../src/modules/group-notifier/lead-intake.js";
import { replyFromRow } from "../src/modules/jobs/reply-batch.js";

const WAIT = "Em breve, um de nossos vendedores dará continuidade à sua solicitação por aqui.";
const CLOSE = "Recebemos seu interesse. Um de nossos vendedores dará continuidade ao seu atendimento em breve. Obrigado!";
const LEAD = { status: "qualified", name: "Ana Silva", city: "Taubaté", model: "Harley X15" };
const CONFIG = { schemaVersion: 2, identity: { name: "Loja sintética" }, modules: ["ai_freeform", "human_handoff"],
  menu: { text: "Como ajudar?", options: [{ id: "human", label: "Atendente", action: "human_handoff.request", params: {} }] },
  humanHandoff: { message: WAIT }, ai: { enabled: true, provider: "openai", model: "test-model", prompt: "Faça triagem de novos compradores.",
    leadQualificationEnabled: true, leadQualificationCriteria: "Novo comprador com nome, cidade e modelo de interesse.", leadIntakeOnlyEnabled: true } };

function fixture(outputs, overrides = {}) {
  const config = { empresaId: "tenant-a", enabled: true, provider: "openai", model: "test-model", keyType: "shared", version: 2,
    prompt: "Triagem simples de novos compradores.", leadQualificationEnabled: true, leadQualificationCriteria: CONFIG.ai.leadQualificationCriteria,
    leadIntakeOnlyEnabled: true, nonLeadHandoffMessage: WAIT, leadQualificationClosing: CLOSE,
    maxHistoryMessages: 30, maxOutputTokens: 800, allowedContextKeys: ["adContext", "catalog", "events", "services", "knowledgeBase"], ...overrides };
  let calls = 0;
  const clientFactory = new MemoryResponsesClientFactory(async () => ({
    output_text: JSON.stringify(outputs[Math.min(calls++, outputs.length - 1)]), usage: { input_tokens: 100, output_tokens: 40 },
  }));
  const ledger = new MemoryAiLedger(), logs = [];
  const service = new MultiTenantAiService({ configResolver: new MemoryAiConfigResolver([config]),
    conversationService: { getHistory: async () => [] }, clientFactory,
    secretResolver: new MemoryAiSecretResolver({ sharedSecret: "synthetic" }), ledger,
    pricingCatalog: new MemoryPricingCatalog({ "test-model": { inputPerMillion: 1, outputPerMillion: 1, version: "test" } }),
    logger: { warn(event, data) { logs.push({ event, ...data }); }, info() {} },
  });
  const request = { empresaId: "tenant-a", conversationId: "conversation-a", messageId: "input", correlationId: "correlation-a",
    message: "Sou Ana Silva, de Taubaté. Quero comprar a Harley X15." };
  return { service, request, ledger, clientFactory, logs, config };
}

test("triagem simples é opt-in, preserva revisões e exige qualificação e fila humana", () => {
  const old = structuredClone(CONFIG); delete old.ai.leadIntakeOnlyEnabled;
  const prior = compileTenantRuntimeConfigV2(old, { empresaId: "tenant-a", configVersion: 1 });
  assert.equal(Object.hasOwn(prior.configuration.ai, "leadIntakeOnlyEnabled"), false);
  assert.equal(verifyCompiledTenantRuntimeConfigV2(prior), true);
  const next = compileTenantRuntimeConfigV2(CONFIG, { empresaId: "tenant-a", configVersion: 2 });
  assert.equal(materializeLegacyTenantDefinition(next).ai.leadIntakeOnlyEnabled, true);
  for (const patch of [{ leadQualificationEnabled: false }, { leadIntakeOnlyEnabled: "true" }]) {
    assert.throws(() => compileTenantRuntimeConfigV2({ ...CONFIG, ai: { ...CONFIG.ai, ...patch } }, { empresaId: "tenant-a", configVersion: 2 }));
  }
  assert.throws(() => compileTenantRuntimeConfigV2({ ...CONFIG, modules: ["ai_freeform"], menu: { text: "Olá", options: [] } }, { empresaId: "tenant-a", configVersion: 2 }));
  const f = fixture([]);
  assert.throws(() => normalizeAiConfig({ ...f.config, leadQualificationEnabled: false }, "tenant-a"));
  assert.throws(() => normalizeAiConfig({ ...f.config, nonLeadHandoffMessage: "" }, "tenant-a"));
});

test("novo comprador com três dados gera ficha factual e encerramento sem catálogo", async () => {
  const f = fixture([{ text: "Texto livre que não deve ser usado ao encerrar", leadQualification: LEAD }]);
  f.request.context = { catalog: { salesMode: true, items: [{ id: "p1", name: "Produto antigo", price: 1 }] },
    events: { items: ["evento antigo"] }, services: ["serviço antigo"], knowledgeBase: ["preço antigo"] };
  const result = await f.service.reply(f.request);
  assert.equal(result.text, CLOSE);
  assert.deepEqual(result.leadQualification, { name: "Ana Silva", summary: "Cidade: Taubaté\nModelo de interesse: Harley X15",
    qualification: "Novo cliente com interesse em compra.", configVersion: 2 });
  assert.equal(result.messages, undefined); assert.equal(result.nonLeadHandoff, undefined);
  const provider = f.clientFactory.requests[0].request;
  assert.equal(provider.text.format.name, "simple_lead_intake");
  assert.doesNotMatch(provider.input[0].content, /Produto antigo|evento antigo|serviço antigo|preço antigo/u);
  assert.equal(f.ledger.events.length, 1); assert.equal(f.ledger.events[0].totalTokens, 140);
});

test("anúncio do Facebook/Instagram identifica o modelo sem planilha e sem pedir que o cliente repita", async () => {
  for (const adReferral of [{ headline: "Harley X15", body: "Moto elétrica" }, { headline: "Loja sintética", body: "Conheça a Harley X15, motor 1000 W" }]) {
    const f = fixture([{ text: "", leadQualification: LEAD }]);
    f.request.message = "Meu nome é Ana Silva, sou de Taubaté.";
    f.request.context = { adContext: { referral: adReferral, current: false } };
    const result = await f.service.reply(f.request);
    assert.equal(result.text, CLOSE); assert.match(result.leadQualification.summary, /Harley X15/u);
    assert.equal(f.clientFactory.requests.length, 1);
  }
});

test("histórico reaproveita nome/cidade, mas dados da loja/anúncio não viram identidade do cliente", async () => {
  const f = fixture([{ text: "", leadQualification: LEAD }]);
  f.service.conversationService.getHistory = async () => [{ id: "prior", direction: "inbound", type: "text", body: "Ana Silva, Taubaté" }];
  f.request.message = "Quero saber o valor da Harley X15.";
  assert.equal((await f.service.reply(f.request)).text, CLOSE);
  for (const message of ["Sou de Taubaté, quero a Harley X15", "Sou Ana Silva, quero a Harley X15"]) {
    const missing = fixture([{ text: "", leadQualification: LEAD }]); missing.request.message = message;
    missing.request.context = { adContext: { referral: { headline: "Ana Silva em Taubaté", body: "Harley X15" } } };
    const result = await missing.service.reply(missing.request);
    assert.equal(result.leadQualification, undefined); assert.equal(result.nonLeadHandoff, undefined);
    assert.equal(result.text, message.includes("Ana Silva") ? "De qual cidade você está falando?" : "Qual é o seu nome?");
  }
});

test("não inventa modelo pela descrição do anúncio, texto do bot ou campos não permitidos", () => {
  for (const adReferral of [{ body: "1000 W, autonomia 40/60km, bateria removível" }, { source_id: "Harley X15", thumbnail_url: "Harley X15" }]) {
    assert.throws(() => parseLeadIntake(LEAD, { configVersion: 2, evidence: ["Ana Silva, Taubaté"], adReferral }), { validationReason: "MODEL_EVIDENCE" });
  }
  assert.throws(() => parseLeadIntake({ ...LEAD, city: "SP" }, { configVersion: 2, evidence: ["Ana Silva é especialista, Harley X15"] }), { validationReason: "CITY_EVIDENCE" });
});

test("manutenção, compra antiga e outros assuntos usam só mensagem humana, sem ficha ou grupo", async () => {
  for (const message of ["Quero manutenção da Harley X15 que comprei de vocês", "Onde está meu pedido antigo?", "Quero falar com o Francisco", "Sou Ana Silva, Taubaté. Ainda não tenho modelo em mente."]) {
    const f = fixture([{ text: "Vou mandar seu caso ao grupo e pedir seu CPF", leadQualification: { status: "not_qualified", name: null, city: null, model: null } }]);
    f.request.message = message; f.request.context = { adContext: { referral: { body: "Harley X15" } } };
    const result = await f.service.reply(f.request);
    assert.equal(result.text, WAIT); assert.deepEqual(result.nonLeadHandoff, { configVersion: 2 });
    assert.equal(result.leadQualification, undefined); assert.equal(result.messages, undefined);
    assert.equal(f.clientFactory.requests.length, 1);
  }
});

test("coleta faz pergunta sem encerramento; ficha sem cidade ou modelo pede o dado faltante", async () => {
  const collecting = fixture([{ text: "De qual cidade você está falando?", leadQualification: { status: "collecting", name: "Ana Silva", city: null, model: "Harley X15" } }]);
  const result = await collecting.service.reply(collecting.request);
  assert.equal(result.text, "De qual cidade você está falando?"); assert.equal(result.nonLeadHandoff, undefined); assert.equal(result.leadQualification, undefined);
  for (const [patch, text] of [[{ city: null }, "De qual cidade você está falando?"], [{ model: null }, "Qual modelo despertou seu interesse?"], [{ model: "Modelo inventado" }, "Qual modelo despertou seu interesse?"]]) {
    const f = fixture([{ text: CLOSE, leadQualification: { ...LEAD, ...patch } }]);
    const result = await f.service.reply(f.request);
    assert.equal(result.text, text); assert.equal(result.leadQualification, undefined); assert.equal(result.nonLeadHandoff, undefined);
    assert.equal(f.clientFactory.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(f.logs), /Ana Silva|Taubaté|Harley|Modelo inventado/u);
  }
});

test("conclusão sem ficha é reavaliada no schema simples com consumo agregado e limite de duas chamadas", async () => {
  const partial = { text: CLOSE, leadQualification: { status: "collecting", name: null, city: null, model: null } };
  for (const second of [{ text: "", leadQualification: LEAD }, { text: "", leadQualification: { status: "not_qualified", name: null, city: null, model: null } }, partial]) {
    const f = fixture([partial, second]), result = await f.service.reply(f.request);
    assert.equal(f.clientFactory.requests.length, 2); assert.equal(f.ledger.events.length, 1); assert.equal(f.ledger.events[0].totalTokens, 280);
    assert.match(f.clientFactory.requests[1].request.instructions, /REAVALIAÇÃO DA TRIAGEM SIMPLES/u);
    assert.doesNotMatch(f.clientFactory.requests[1].request.instructions, /summary e qualification completos/u);
    if (second === partial) { assert.equal(result.leadQualification, undefined); assert.equal(result.nonLeadHandoff, undefined); assert.ok(result.text.endsWith("?")); }
    else assert.equal(result.text, second.leadQualification.status === "qualified" ? CLOSE : WAIT);
  }
});

test("resposta inválida ou truncada não pausa nem notifica; checkpoint preserva encaminhamento sem lead", async () => {
  for (const output of [{ text: "", leadQualification: { ...LEAD, extra: true } }, { text: "" }]) {
    const f = fixture([output]), result = await f.service.reply(f.request);
    assert.equal(result.source, "fallback"); assert.equal(result.nonLeadHandoff, undefined); assert.equal(result.leadQualification, undefined);
  }
  const f = fixture([]);
  f.clientFactory.responder = async () => ({ status: "incomplete", output_text: JSON.stringify({ text: "", leadQualification: LEAD }) });
  assert.equal((await f.service.reply(f.request)).source, "fallback");
  assert.deepEqual(replyFromRow({ id: "reply", corpo: WAIT, outbound_payload: { nonLeadHandoff: { configVersion: 2 } } }).nonLeadHandoff, { configVersion: 2 });
});
