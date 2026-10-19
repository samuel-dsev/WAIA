import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createAdminRouter } from "../src/modules/admin/router.js";
import { publicAdminError } from "../src/modules/admin/errors.js";
import { qualificationFormat, parseQualification, QUALIFICATION_CRITERIA, QUALIFICATION_CLOSING } from "../src/modules/group-notifier/qualification.js";
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
