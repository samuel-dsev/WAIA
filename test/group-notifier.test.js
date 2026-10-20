import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createAdminRouter } from "../src/modules/admin/router.js";
import { publicAdminError } from "../src/modules/admin/errors.js";
import { qualificationFormat, parseQualification, announcesQualificationClosing, QUALIFICATION_CRITERIA, QUALIFICATION_CLOSING } from "../src/modules/group-notifier/qualification.js";
import { createGroupNotifierWorker } from "../src/modules/group-notifier/worker.js";
import { GroupNotifierAdminService } from "../src/modules/group-notifier/admin-service.js";
import { compileTenantRuntimeConfigV2, verifyCompiledTenantRuntimeConfigV2 } from "../src/modules/configuration/index.js";
import { MemoryAiConfigResolver, MemoryAiLedger, MemoryAiSecretResolver, MemoryPricingCatalog, MemoryResponsesClientFactory, MultiTenantAiService } from "../src/modules/ai/index.js";

const LEAD = { status: "qualified", name: "Ana Silva", summary: "Relata atraso na entrega do imóvel e pede orientação do escritório.", qualification: "Direito Imobiliário; análise humana necessária." };
const CONFIG = { schemaVersion: 2, identity: { name: "Escritório sintético" }, modules: ["ai_freeform", "human_handoff"],
  menu: { text: "Como ajudar?", options: [{ id: "human", label: "Falar com a equipe", action: "human_handoff.request", params: {} }] }, ai: { enabled: true, provider: "openai", model: "test-model", prompt: "Faça triagem para análise humana.", leadQualificationEnabled: true, leadQualificationCriteria: QUALIFICATION_CRITERIA } };

test("configuração antiga mantém checksum e triagem depende de critérios publicados", () => {
  const legacy = structuredClone(CONFIG); delete legacy.ai.leadQualificationEnabled; delete legacy.ai.leadQualificationCriteria;
  const old = compileTenantRuntimeConfigV2(legacy, { empresaId: "tenant-a", configVersion: 1 });
  assert.equal(Object.hasOwn(old.configuration.ai, "leadQualificationEnabled"), false);
  assert.equal(verifyCompiledTenantRuntimeConfigV2(old), true);
  const configured = compileTenantRuntimeConfigV2(CONFIG, { empresaId: "tenant-a", configVersion: 2 });
  assert.equal(configured.configuration.ai.leadQualificationEnabled, true);
  assert.throws(() => compileTenantRuntimeConfigV2({ ...CONFIG, ai: { ...CONFIG.ai, leadQualificationCriteria: "" } }, { empresaId: "tenant-a", configVersion: 2 }));
});

test("triagem preserva formato comercial e recusa identidade inventada/dados incompletos", () => {
  const base = { type: "json_schema", name: "base", strict: true, schema: { type: "object", properties: { text: { type: "string" }, productIds: { type: "array" } }, required: ["text", "productIds"], additionalProperties: false } };
  const combined = qualificationFormat(base);
  assert.deepEqual(base.schema.required, ["text", "productIds"]);
  assert.deepEqual(combined.schema.required, ["text", "productIds", "leadQualification"]);
  assert.throws(() => parseQualification(LEAD, { configVersion: 2, evidence: ["Sou outra pessoa"] }));
  assert.throws(() => parseQualification({ ...LEAD, summary: null }, { configVersion: 2, evidence: ["Ana Silva"] }));
  assert.equal(parseQualification({ status: "collecting", name: null, summary: null, qualification: null }, { configVersion: 2 }), null);
});

function aiFixture(output, overrides = {}) {
  const config = { empresaId: "tenant-a", enabled: true, provider: "openai", model: "test-model", keyType: "shared", version: 2, prompt: "Triagem imobiliária, sem avaliação jurídica.",
    leadQualificationEnabled: true, leadQualificationCriteria: QUALIFICATION_CRITERIA, maxHistoryMessages: 30, maxOutputTokens: 800, allowedContextKeys: [], ...overrides };
  const clientFactory = new MemoryResponsesClientFactory(async () => ({ output_text: output, usage: { input_tokens: 100, output_tokens: 40 } }));
  const ledger = new MemoryAiLedger(), logs = [];
  const service = new MultiTenantAiService({ configResolver: new MemoryAiConfigResolver([config]),
    conversationService: { getHistory: async () => [{ id: "prior", direction: "inbound", type: "text", body: "Meu nome é Ana Silva." }] },
    clientFactory, secretResolver: new MemoryAiSecretResolver({ sharedSecret: "synthetic" }), ledger,
    pricingCatalog: new MemoryPricingCatalog({ "test-model": { inputPerMillion: 1, outputPerMillion: 1, version: "test" } }), logger: { warn(event, data) { logs.push({ event, ...data }); }, info() {} },
  });
  const request = { empresaId: "tenant-a", conversationId: "conversation-a", messageId: "message-a", correlationId: "correlation-a", message: "O imóvel atrasou e quero falar com o advogado." };
  return { service, clientFactory, request, ledger, logs };
}

test("resposta da IA produz ficha sem telefone/destino e fechamento controlado pelo sistema", async () => {
  const f = aiFixture(JSON.stringify({ text: "Já mandei seu caso ao grupo secreto.", leadQualification: LEAD }));
  const reply = await f.service.reply(f.request);
  assert.equal(reply.source, "ai"); assert.equal(reply.text, QUALIFICATION_CLOSING);
  assert.deepEqual(reply.leadQualification, { name: LEAD.name, summary: LEAD.summary, qualification: LEAD.qualification, configVersion: 2 });
  assert.equal(reply.leadQualification.phone, undefined); assert.equal(reply.leadQualification.groupId, undefined);
  assert.ok(f.clientFactory.requests[0].request.text.format.schema.properties.leadQualification);
  assert.match(f.clientFactory.requests[0].request.instructions, /Não invente nome/u);
});

test("envelope ilegível/incompleto mantém contingência sem registrar qualificação", async () => {
  for (const output of ["{invalid", JSON.stringify({ text: "Tudo certo" }), JSON.stringify({ text: "", leadQualification: { status: "collecting", name: null, summary: null, qualification: null } })]) {
    const f = aiFixture(output), result = await f.service.reply(f.request);
    assert.equal(result.source, "fallback"); assert.equal(result.leadQualification, undefined);
  }
  const f = aiFixture(JSON.stringify({ text: "Pode resumir o problema do imóvel?", leadQualification: { status: "collecting", name: null, summary: null, qualification: null } }));
  const result = await f.service.reply(f.request);
  assert.equal(result.text, "Pode resumir o problema do imóvel?"); assert.equal(result.leadQualification, undefined);
});

test("ficha válida não exige texto redundante da IA quando o encerramento vem da configuração", async () => {
  const f = aiFixture(JSON.stringify({ text: "", leadQualification: LEAD }));
  const result = await f.service.reply(f.request);
  assert.equal(result.source, "ai"); assert.equal(result.text, QUALIFICATION_CLOSING);
  assert.equal(result.leadQualification.name, LEAD.name); assert.equal(f.clientFactory.requests.length, 1);
});

test("resposta truncada continua bloqueada mesmo se o fragmento parecer uma ficha válida", async () => {
  const f = aiFixture("");
  f.clientFactory.responder = async () => ({ status: "incomplete", output_text: JSON.stringify({ text: "", leadQualification: LEAD }), usage: { input_tokens: 100, output_tokens: 40 } });
  const result = await f.service.reply(f.request);
  assert.equal(result.source, "fallback"); assert.equal(result.leadQualification, undefined);
  assert.equal(f.ledger.events[0].errorCode, "AI_INCOMPLETE_RESPONSE");
});

test("coleta parcial não exige ficha completa nem substitui a pergunta por contingência", async () => {
  for (const status of ["collecting", "not_qualified"]) {
    const f = aiFixture(JSON.stringify({ text: "Qual é o seu nome?", leadQualification: { status, name: "", summary: "Imóvel", qualification: "" } }));
    const result = await f.service.reply(f.request);
    assert.equal(result.source, "ai"); assert.equal(result.text, "Qual é o seu nome?");
    assert.equal(result.leadQualification, undefined); assert.equal(f.clientFactory.requests.length, 1);
  }
});

test("ficha concluída inválida continua com uma pergunta, sem encaminhamento falso ou retry", async () => {
  for (const [patch, reason] of [[{ name: "Pessoa inventada" }, "NAME_EVIDENCE"], [{ name: null }, "NAME"], [{ summary: "" }, "SUMMARY"], [{ qualification: null }, "QUALIFICATION"]]) {
    const f = aiFixture(JSON.stringify({ text: "Entendi que aguarda o imóvel previsto para 09/08.\n\nQual é o seu nome?", leadQualification: { ...LEAD, ...patch } }));
    const result = await f.service.reply(f.request);
    assert.equal(result.source, "ai"); assert.equal(result.reason, "qualification_needs_information");
    assert.equal(result.text, "Qual é o seu nome?"); assert.equal(result.leadQualification, undefined);
    assert.equal(f.clientFactory.requests.length, 1); assert.equal(f.ledger.events.length, 1);
    assert.equal(f.ledger.events[0].outputTokens, 40); assert.equal(f.ledger.events[0].success, true);
    assert.deepEqual(f.logs.map(log => [log.code, log.validationReason]), [["AI_QUALIFICATION_DEFERRED", reason]]);
    assert.doesNotMatch(JSON.stringify(f.logs), /Pessoa inventada|09\/08|Ana Silva|imóvel/u);
  }
});

test("ficha inválida não usa texto de encerramento ou promessa de envio, mesmo com pergunta", async () => {
  for (const text of ["Já enviei ao grupo. O advogado retornará.", "Seu caso já foi encaminhado ao grupo, qual é o seu nome?"]) {
    const f = aiFixture(JSON.stringify({ text, leadQualification: { ...LEAD, name: null } }));
    const result = await f.service.reply(f.request);
    assert.equal(result.text, "Qual nome você prefere usar neste atendimento?");
    assert.equal(result.leadQualification, undefined);
  }
});

test("triagem em empresa com catálogo não envia produtos durante recuperação ou encerramento", async () => {
  const catalog = { source: { type: "google_sheets", status: "healthy" }, items: [{ id: "p1", name: "Produto sintético", active: true }] };
  for (const qualification of [LEAD, { ...LEAD, name: null }]) {
    const f = aiFixture(JSON.stringify({ text: "", productIds: ["p1"], leadQualification: qualification }), { allowedContextKeys: ["catalog"] });
    const result = await f.service.reply({ ...f.request, context: { catalog } });
    assert.equal(result.source, "ai"); assert.equal(result.messages, undefined); assert.equal(result.salesInterest, undefined);
    assert.equal(Boolean(result.leadQualification), qualification.name !== null);
    assert.doesNotMatch(result.text, /Produto sintético|productIds|leadQualification/u);
  }
});

const SALES_CATALOG = { source: { type: "google_sheets", status: "healthy" }, salesMode: true,
  items: [{ id: "p1", name: "Modelo A", active: true, category: "Moto" }, { id: "p2", name: "Modelo B", active: true }, { id: "p3", name: "Modelo C", active: true }],
  interestHandoff: { enabled: true, message: "Encerramento antigo sem ficha." } };
const COLLECTING = { status: "collecting", name: null, summary: null, qualification: null };
const salesOutput = (patch = {}) => JSON.stringify({ text: "De qual cidade você fala?", catalogAction: "none", productIds: ["p1"],
  filters: { category: null, minPrice: null, maxPrice: null }, leadQualification: COLLECTING, ...patch });

test("coleta comercial aceita modelo como contexto sem perder pergunta nem enviar foto ou encerrar", async () => {
  for (const filters of [{ category: null, minPrice: null, maxPrice: null }, { category: "Moto", minPrice: 1000, maxPrice: 8000 }]) {
    const f = aiFixture(salesOutput({ filters }), { allowedContextKeys: ["catalog"] });
    const result = await f.service.reply({ ...f.request, message: "Ana Silva", context: { catalog: SALES_CATALOG } });
    assert.equal(result.source, "ai"); assert.equal(result.text, "De qual cidade você fala?");
    assert.equal(result.messages, undefined); assert.equal(result.salesInterest, undefined); assert.equal(result.leadQualification, undefined);
    assert.equal(f.clientFactory.requests.length, 1); assert.equal(f.ledger.events[0].success, true);
    assert.equal(f.ledger.events[0].outputTokens, 40);
    assert.ok(!f.clientFactory.requests[0].request.text.format.schema.properties.catalogAction.enum.includes("interest"));
  }
});

test("triagem comercial ainda recusa ID inexistente, duplicado, filtro inválido e encerramento antigo", async () => {
  for (const patch of [{ productIds: ["foreign"] }, { productIds: ["p1", "p1"] },
    { filters: { category: "Inventada", minPrice: null, maxPrice: null } },
    { filters: { category: null, minPrice: -1, maxPrice: null } },
    { catalogAction: "interest" }, { text: "" }]) {
    const f = aiFixture(salesOutput(patch), { allowedContextKeys: ["catalog"] });
    const result = await f.service.reply({ ...f.request, context: { catalog: SALES_CATALOG } });
    assert.equal(result.source, "fallback"); assert.equal(result.leadQualification, undefined); assert.equal(result.salesInterest, undefined);
    assert.equal(f.clientFactory.requests.length, 1); assert.equal(f.ledger.events[0].errorCode, "AI_INVALID_CATALOG_SELECTION");
  }
});

test("empresa sem triagem preserva validação antiga de resposta normal com seleção", async () => {
  const output = JSON.parse(salesOutput()); delete output.leadQualification;
  const f = aiFixture(JSON.stringify(output), { allowedContextKeys: ["catalog"], leadQualificationEnabled: false });
  const result = await f.service.reply({ ...f.request, context: { catalog: SALES_CATALOG } });
  assert.equal(result.source, "fallback"); assert.equal(f.ledger.events[0].errorCode, "AI_INVALID_CATALOG_SELECTION");
});

test("catálogo com triagem mantém três produtos e detalhe técnico, e ficha completa conclui sem fotos", async () => {
  const context = { catalog: SALES_CATALOG };
  const browse = aiFixture(salesOutput({ catalogAction: "browse", productIds: [] }), { allowedContextKeys: ["catalog"] });
  const cards = await browse.service.reply({ ...browse.request, context });
  assert.equal(cards.source, "ai"); assert.equal(cards.messages.filter(p => p.catalogProductId).length, 3);
  assert.equal(cards.leadQualification, undefined); assert.equal(cards.salesInterest, undefined);
  const detail = aiFixture(salesOutput({ catalogAction: "details", text: "A potência informada é de 1000 W." }), { allowedContextKeys: ["catalog"] });
  const answer = await detail.service.reply({ ...detail.request, context });
  assert.equal(answer.source, "ai"); assert.equal(answer.messages, undefined); assert.equal(answer.text, "A potência informada é de 1000 W.");
  const lead = { ...LEAD, summary: "Ana Silva fala de Taubaté, escolheu Modelo A e esclareceu as dúvidas.", qualification: "Interesse comercial para continuidade com vendedor." };
  const done = aiFixture(salesOutput({ text: "", leadQualification: lead }), { allowedContextKeys: ["catalog"], leadQualificationClosing: "Interesse anotado; o vendedor continuará." });
  const reply = await done.service.reply({ ...done.request, context });
  assert.equal(reply.source, "ai"); assert.equal(reply.text, "Interesse anotado; o vendedor continuará.");
  assert.equal(reply.leadQualification.name, LEAD.name); assert.equal(reply.messages, undefined); assert.equal(reply.salesInterest, undefined);
});

const FALSE_CLOSING = "Ótimo, Ana Silva, anotei seu interesse no Modelo A. Um de nossos vendedores entrará em contato em breve.";
function repairFixture(outputs) {
  const f = aiFixture(salesOutput({ text: FALSE_CLOSING }), { allowedContextKeys: ["catalog"],
    leadQualificationClosing: "Interesse anotado; o vendedor continuará." });
  let calls = 0;
  f.clientFactory.responder = async () => {
    const output = outputs[calls++];
    if (output instanceof Error) throw output;
    return { output_text: typeof output === "string" ? output : salesOutput(output), usage: { input_tokens: 100, output_tokens: 40 } };
  };
  return { ...f, request: { ...f.request, message: "Ana Silva", context: { catalog: SALES_CATALOG } } };
}

test("encerramento sem ficha é reavaliado uma vez e só conclui com lead validado", async () => {
  const f = repairFixture([{ text: FALSE_CLOSING }, { text: "", leadQualification: LEAD }]);
  const result = await f.service.reply(f.request);
  assert.equal(result.source, "ai"); assert.equal(result.text, "Interesse anotado; o vendedor continuará.");
  assert.equal(result.leadQualification.name, LEAD.name); assert.equal(result.messages, undefined); assert.equal(result.salesInterest, undefined);
  assert.equal(f.clientFactory.requests.length, 2); assert.equal(f.ledger.events.length, 1);
  assert.equal(f.ledger.events[0].inputTokens, 200); assert.equal(f.ledger.events[0].outputTokens, 80);
  const [first, second] = f.clientFactory.requests.map(r => r.request);
  assert.deepEqual(second.input, first.input); assert.equal(second.store, false);
  assert.match(second.instructions, /REAVALIAÇÃO/u); assert.doesNotMatch(JSON.stringify(second.input), /anotei seu interesse/u);
  assert.doesNotMatch(JSON.stringify(f.logs), /Ana Silva|Modelo A|anotei/u);
});

test("reavaliação respeita dados faltantes e mantém pergunta sem encaminhar", async () => {
  const f = repairFixture([{ text: FALSE_CLOSING }, { text: "De qual cidade você fala?" }]);
  const result = await f.service.reply(f.request);
  assert.equal(result.text, "De qual cidade você fala?"); assert.equal(result.leadQualification, undefined);
  assert.equal(result.messages, undefined); assert.equal(result.salesInterest, undefined); assert.equal(f.clientFactory.requests.length, 2);
});

test("segunda promessa sem ficha é bloqueada sem terceiro pedido ou encerramento falso", async () => {
  const f = repairFixture([{ text: FALSE_CLOSING }, { text: FALSE_CLOSING }]);
  const result = await f.service.reply(f.request);
  assert.equal(result.source, "ai"); assert.equal(result.reason, "qualification_needs_information");
  assert.equal(result.text.endsWith("?"), true); assert.doesNotMatch(result.text, /anotei|vendedor|contato|encaminhad/u);
  assert.equal(result.leadQualification, undefined); assert.equal(result.messages, undefined); assert.equal(f.clientFactory.requests.length, 2);
  assert.equal(f.ledger.events[0].totalTokens, 280);
  assert.ok(f.logs.some(l => l.validationReason === "UNCONFIRMED_CLOSING"));
});

test("falha na reavaliação contabiliza a primeira resposta sem criar ficha", async () => {
  const error = Object.assign(new Error("synthetic private failure"), { code: "AI_TIMEOUT" });
  const f = repairFixture([{ text: FALSE_CLOSING }, error]);
  const result = await f.service.reply(f.request);
  assert.equal(result.source, "fallback"); assert.equal(result.leadQualification, undefined);
  assert.equal(f.clientFactory.requests.length, 2); assert.equal(f.ledger.events.length, 1);
  assert.equal(f.ledger.events[0].inputTokens, 100); assert.equal(f.ledger.events[0].outputTokens, 40);
  assert.equal(f.ledger.events[0].errorCode, "AI_TIMEOUT");
});

test("ficha inventada na reavaliação não encaminha e uso das duas respostas é contabilizado", async () => {
  const f = repairFixture([{ text: FALSE_CLOSING }, { text: FALSE_CLOSING, leadQualification: { ...LEAD, name: "Nome inventado" } }]);
  const result = await f.service.reply(f.request);
  assert.equal(result.source, "ai"); assert.equal(result.leadQualification, undefined);
  assert.equal(result.text, "Qual nome você prefere usar neste atendimento?");
  assert.equal(f.clientFactory.requests.length, 2); assert.equal(f.ledger.events[0].totalTokens, 280);
});

test("coleta normal e ficha completa não pedem reavaliação nem duplicam consumo", async () => {
  for (const output of [{ text: "Qual é o seu nome?" }, { text: "", leadQualification: LEAD }]) {
    const f = repairFixture([output]); const result = await f.service.reply(f.request);
    assert.equal(result.source, "ai"); assert.equal(f.clientFactory.requests.length, 1); assert.equal(f.ledger.events[0].totalTokens, 140);
  }
});

test("detector distingue anúncio de conclusão de perguntas e informações normais", () => {
  for (const text of [FALSE_CLOSING, "Seu interesse foi registrado.", "A equipe retornará por aqui.", "Já enviei ao grupo.",
    "O responsável irá analisar seu caso e retornar por aqui. Por favor, aguarde o retorno."]) {
    assert.equal(announcesQualificationClosing(text, QUALIFICATION_CLOSING), true);
  }
  for (const text of ["Qual é o seu nome?", "De qual cidade você fala?", "O vendedor pode confirmar o estoque desse modelo.",
    "A moto tem autonomia informada de 50 km. Gostaria de saber mais algum detalhe?", "Qual modelo despertou seu interesse?"]) {
    assert.equal(announcesQualificationClosing(text, QUALIFICATION_CLOSING), false);
  }
});

test("resposta inválida ou truncada na reavaliação bloqueia conclusão e preserva consumo agregado", async () => {
  for (const incomplete of [false, true]) {
    const f = repairFixture([]); let calls = 0;
    f.clientFactory.responder = async () => {
      calls += 1;
      return { ...(calls === 2 && incomplete ? { status: "incomplete" } : {}),
        output_text: calls === 1 ? salesOutput({ text: FALSE_CLOSING }) : incomplete ? salesOutput({ leadQualification: LEAD }) : "{invalid",
        usage: { input_tokens: 100, output_tokens: 40 } };
    };
    const result = await f.service.reply(f.request);
    assert.equal(result.source, "fallback"); assert.equal(result.leadQualification, undefined);
    assert.equal(calls, 2); assert.equal(f.ledger.events[0].totalTokens, 280); assert.equal(f.ledger.events[0].success, false);
    if (incomplete) assert.equal(f.ledger.events[0].errorCode, "AI_INCOMPLETE_RESPONSE");
  }
});

test("reavaliação respeita prazo único e aborta sem consumo informado da segunda chamada", async () => {
  const f = repairFixture([]); f.service.timeoutMs = 300;
  let calls = 0;
  f.clientFactory.responder = async (_request, options) => {
    calls += 1;
    if (calls === 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { output_text: salesOutput({ text: FALSE_CLOSING }), usage: { input_tokens: 100, output_tokens: 40 } };
    }
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  };
  const result = await f.service.reply(f.request);
  assert.equal(result.source, "fallback"); assert.equal(result.reason, "timeout");
  assert.equal(calls, 2); assert.equal(f.clientFactory.requests[1].transportOptions.signal.aborted, true);
  assert.equal(f.ledger.events[0].totalTokens, 140); assert.equal(result.leadQualification, undefined);
});

test("limite mensal reserva espaço para reavaliação antes de chamar o provedor", async () => {
  const f = repairFixture([{ text: FALSE_CLOSING }, { text: "", leadQualification: LEAD }]);
  let budget;
  const reserve = f.ledger.reserve.bind(f.ledger);
  f.ledger.reserve = input => { budget = input; return reserve({ ...input, tokenLimit: 1 }); };
  const result = await f.service.reply(f.request);
  assert.equal(result.reason, "monthly_limit"); assert.equal(f.clientFactory.requests.length, 0);
  assert.ok(budget.estimatedTokens > 1600); assert.ok(budget.estimatedCost > 0);
});

test("empresa sem triagem preserva resposta única e não usa o detector de encerramento", async () => {
  const f = aiFixture(FALSE_CLOSING, { leadQualificationEnabled: false });
  const result = await f.service.reply(f.request);
  assert.equal(result.source, "ai"); assert.equal(result.text, FALSE_CLOSING);
  assert.equal(f.clientFactory.requests.length, 1); assert.equal(f.ledger.events[0].totalTokens, 140);
});

test("recuperação de ficha inválida também remove promessa seguida de pergunta", async () => {
  const f = repairFixture([{ text: `${FALSE_CLOSING} Gostaria de acrescentar algo?`, leadQualification: { ...LEAD, name: null } }]);
  const result = await f.service.reply(f.request);
  assert.equal(result.text, "Qual nome você prefere usar neste atendimento?");
  assert.equal(result.leadQualification, undefined); assert.equal(f.clientFactory.requests.length, 1);
});

function workerFixture() {
  let status = "pending", lease = true, sends = 0, complete = 0;
  const calls = [], connection = { phase: "connected", qr: null };
  const session = { connect: async () => {}, close() { calls.push("close"); }, disconnect: async () => {}, snapshot: () => connection,
    listGroups: async () => [{ id: "123@g.us", name: "Grupo A" }], groupMetadata: async () => ({ id: "123@g.us" }),
    async sendText(group, text) { sends += 1; calls.push([group, text]); return { messageId: "synthetic-group-id" }; } };
  const repository = {
    lease: async () => lease ? { desired: true, epoch: 2, phone: "+5511000000001" } : null,
    authStore: () => ({}), recover: async () => {}, publish: async () => {}, cacheGroups: async () => {}, release: async () => {},
    candidate: async () => status === "pending" ? { id: "delivery-a", group_id: "123@g.us" } : null,
    beginSend: async () => { status = "sending"; return { group_id: "123@g.us", company_name: "Empresa A", ...LEAD, phone: "5511000000002" }; },
    complete: async (_owner, _id, result) => { complete += 1; status = result.messageId ? "accepted" : "unconfirmed"; },
    deferCandidate: async () => { calls.push("deferred"); },
  };
  const worker = createGroupNotifierWorker({ repository, sessionFactory: () => session });
  return { worker, session, repository, calls, get sends() { return sends; }, get status() { return status; }, get complete() { return complete; }, loseLease() { lease = false; } };
}

test("worker serializa, usa destino do servidor e não reenvia aceitação conhecida", async () => {
  const f = workerFixture();
  await Promise.all([f.worker.tick(), f.worker.tick()]); await f.worker.tick();
  assert.equal(f.sends, 1); assert.equal(f.status, "accepted");
  assert.equal(f.calls.find(Array.isArray)[0], "123@g.us");
  assert.match(f.calls.find(Array.isArray)[1], /WhatsApp: \+5511000000002/u);
  await f.worker.close();
});

test("timeout após início de envio vira incerto, sem retry; falha antes do envio adia sem enviar", async () => {
  const f = workerFixture(); f.session.sendText = async () => { throw new Error("synthetic-private-provider-error"); };
  await f.worker.tick(); await f.worker.tick();
  assert.equal(f.status, "unconfirmed"); assert.equal(f.complete, 1);
  const preflight = workerFixture(); preflight.session.groupMetadata = async () => { throw new Error("not member"); };
  await preflight.worker.tick(); assert.equal(preflight.sends, 0); assert.equal(preflight.status, "pending"); assert.ok(preflight.calls.includes("deferred"));
});

test("worker sem lease ou com política revogada não envia", async () => {
  const f = workerFixture(); f.loseLease(); await f.worker.tick(); assert.equal(f.sends, 0);
  const revoked = workerFixture(); revoked.repository.beginSend = async () => null;
  await revoked.worker.tick(); assert.equal(revoked.sends, 0);
});

test("encerramento aguarda operação em curso e libera lease sem iniciar novo envio", async () => {
  const f = workerFixture();
  let unblock, entered;
  const reached = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { unblock = resolve; });
  f.session.groupMetadata = async () => { entered(); await blocked; };
  f.repository.release = async () => f.calls.push("release");
  const tick = f.worker.tick(); await reached;
  const closing = f.worker.close();
  await Promise.resolve(); assert.equal(f.calls.includes("release"), false);
  unblock(); await tick; await closing; await f.worker.tick();
  assert.equal(f.sends, 0); assert.equal(f.calls.at(-1), "release");
});

test("somente plataforma controla sessão e destinos; cliente não consulta leads de outra empresa", async () => {
  const calls = [];
  const service = new GroupNotifierAdminService({ status: async () => ({ phase: "connected", qr: "synthetic-private-qr" }),
    configure: async () => calls.push("configure"), leads: async () => [], route: async () => null }, async () => "synthetic-image");
  const platform = { user: { id: "actor" }, platformRole: "platform_admin" };
  const tenant = { user: { id: "actor" }, memberships: [{ empresaId: "tenant-a", role: "tenant_admin" }] };
  await assert.rejects(service.status(tenant));
  assert.throws(() => service.leads(tenant, "tenant-b"));
  assert.throws(() => service.saveRoute(tenant, "tenant-a", {}));
  const data = await service.status(platform); assert.equal(data.qr, undefined); assert.equal(data.qrImage, "synthetic-image");
  await assert.rejects(service.connect(platform, { phone: "+5511000000001" })); assert.equal(calls.length, 0);
});

test("API administrativa protege QR por autenticação e não aceita mutação sem CSRF", async (t) => {
  const app = express(); app.use(express.json());
  let configured = 0;
  const service = new GroupNotifierAdminService({ status: async () => ({ phase: "qr", qr: "synthetic-private-qr" }),
    configure: async () => { configured += 1; return { started: true }; }, leads: async () => [] }, async () => "data:image/png;base64,synthetic");
  app.use("/api/admin", createAdminRouter({ adminService: {}, groupNotifierService: service,
    authenticate(req, res, next) {
      if (!req.get("x-test-profile")) return res.sendStatus(401);
      req.auth = req.get("x-test-profile") === "platform" ? { user: { id: "actor" }, platformRole: "platform_admin" }
        : { user: { id: "actor" }, memberships: [{ empresaId: "tenant-a", role: "tenant_admin" }] }; next();
    },
    csrf(req, res, next) { if (req.get("x-test-csrf") !== "valid") return res.sendStatus(403); next(); },
  }));
  app.use((error, _req, res, _next) => { const safe = publicAdminError(error); res.status(safe.status).json(safe.body); });
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  assert.equal((await fetch(`${base}/group-notifier`)).status, 401);
  assert.equal((await fetch(`${base}/group-notifier`, { headers: { "x-test-profile": "tenant" } })).status, 403);
  const status = await fetch(`${base}/group-notifier`, { headers: { "x-test-profile": "platform" } });
  assert.match(status.headers.get("cache-control"), /no-store/u);
  const body = await status.json(); assert.equal(body.qr, undefined); assert.equal(body.qrImage, "data:image/png;base64,synthetic");
  const post = { method: "POST", headers: { "x-test-profile": "platform", "content-type": "application/json" }, body: JSON.stringify({ dedicated: true, phone: "+5511000000099" }) };
  assert.equal((await fetch(`${base}/group-notifier/connect`, post)).status, 403); assert.equal(configured, 0);
  assert.equal((await fetch(`${base}/group-notifier/connect`, { ...post, headers: { ...post.headers, "x-test-csrf": "valid" } })).status, 200); assert.equal(configured, 1);
  assert.equal((await fetch(`${base}/tenants/tenant-b/group-notifier/leads`, { headers: { "x-test-profile": "tenant" } })).status, 403);
});
