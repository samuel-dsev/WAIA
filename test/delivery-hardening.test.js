import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { AdminService, MemoryAdminRepository, createAdminRouter } from "../src/modules/admin/index.js";
import { createRetentionRunner } from "../src/operations/retention.js";
import { createWorkerHandlers } from "../src/modules/jobs/handlers.js";

const platform = { user: { id: "platform" }, platformRole: "platform_admin", memberships: [] };

async function request(app, path, options = {}) {
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    return await fetch(`http://127.0.0.1:${port}${path}`, options);
  } finally {
    server.close();
  }
}

test("onboarding mínimo cria tenant em rascunho com padrões operacionais", async () => {
  const repository = new MemoryAdminRepository({ environment: "test" });
  const service = new AdminService({ repository });
  const tenant = await service.createTenant({ auth: platform, body: { name: "Clínica Exemplo", identity: "Atendimento da clínica" } });
  assert.equal(tenant.slug, "clinica-exemplo");
  assert.equal(tenant.displayName, "Clínica Exemplo");
  assert.equal(tenant.status, "draft");
  assert.equal(tenant.messageRetentionDays, 365);
  assert.equal(repository.audit.at(-1).action, "tenant.create");
});

test("rota PUT de módulos usa contrato em lote do painel", async () => {
  let captured;
  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminRouter({
    adminService: {
      async replaceModules(input) { captured = input; return { items: [] }; },
    },
    authenticate(request, _response, next) { request.auth = platform; next(); },
    csrf(_request, _response, next) { next(); },
  }));
  const response = await request(app, "/api/admin/tenants/tenant-a/modules", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabledModules: ["catalog", "appointments"] }),
  });
  assert.equal(response.status, 200);
  assert.equal(captured.empresaId, "tenant-a");
  assert.deepEqual(captured.body.enabledModules, ["catalog", "appointments"]);
});

test("rota de resposta humana exige CSRF e devolve aceitação assíncrona", async () => {
  let captured;
  let csrfChecked = false;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.context = { correlationId: "00000000-0000-4000-8000-000000000044" }; next(); });
  app.use("/api/admin", createAdminRouter({
    adminService: {
      async sendHumanMessage(input) { captured = input; return { id: "message-human", status: "queued" }; },
    },
    authenticate(request, _response, next) { request.auth = { user: { id: "operator-a" } }; next(); },
    csrf(request, _response, next) { csrfChecked = request.get("x-csrf-token") === "csrf-test"; next(); },
  }));
  const response = await request(app, "/api/admin/tenants/tenant-a/conversations/conversation-a/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": "csrf-test" },
    body: JSON.stringify({ text: "Resposta humana", idempotencyKey: "00000000-0000-4000-8000-000000000055" }),
  });
  assert.equal(response.status, 202);
  assert.equal(csrfChecked, true);
  assert.equal(captured.empresaId, "tenant-a");
  assert.equal(captured.conversationId, "conversation-a");
  assert.equal(captured.correlationId, "00000000-0000-4000-8000-000000000044");
});

test("rotas operacionais de jobs falhos exigem CSRF e distinguem retry de resolução", async () => {
  const calls = [];
  let csrfChecks = 0;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.context = { correlationId: "00000000-0000-4000-8000-000000000081" }; next(); });
  app.use("/api/admin", createAdminRouter({
    adminService: {
      async retryFailedJob(input) { calls.push(["retry", input]); return { retryJobId: "job-new" }; },
      async resolveFailedJob(input) { calls.push(["resolve", input]); return { resolutionKind: "resolvido" }; },
    },
    authenticate(request, _response, next) { request.auth = { user: { id: "admin-a" } }; next(); },
    csrf(request, _response, next) { csrfChecks += Number(request.get("x-csrf-token") === "csrf-test"); next(); },
  }));
  const options = {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": "csrf-test" },
    body: JSON.stringify({ reason: "Incidente analisado." }),
  };
  const retried = await request(app, "/api/admin/tenants/tenant-a/failed-jobs/failed-1/retry", options);
  const resolved = await request(app, "/api/admin/tenants/tenant-a/failed-jobs/failed-2/resolve", options);
  assert.equal(retried.status, 202);
  assert.equal(resolved.status, 200);
  assert.equal(csrfChecks, 2);
  assert.deepEqual(calls.map(([action, input]) => [action, input.failedJobId, input.empresaId]), [
    ["retry", "failed-1", "tenant-a"],
    ["resolve", "failed-2", "tenant-a"],
  ]);
});

test("comprovante privado exige autenticação, tenant e retorna headers seguros", async () => {
  const repository = new MemoryAdminRepository({ tenants: [{ id: "tenant-a", name: "Tenant A", status: "active" }], environment: "test" });
  repository.getPrivateMedia = async ({ empresaId, messageId }) => empresaId === "tenant-a" && messageId === "message-1"
    ? { storageKey: "tenant-a/message-1", mimeType: "image/jpeg", sizeBytes: 4, sha256: "a".repeat(64) }
    : null;
  const service = new AdminService({
    repository,
    mediaStore: {
      async read(input) {
        assert.deepEqual(input, { empresaId: "tenant-a", storageKey: "tenant-a/message-1", expectedSha256: "a".repeat(64) });
        return Buffer.from("test");
      },
    },
  });
  const app = express();
  app.use("/api/admin", createAdminRouter({
    adminService: service,
    authenticate(request, _response, next) { request.auth = platform; next(); },
    csrf(_request, _response, next) { next(); },
  }));
  const response = await request(app, "/api/admin/tenants/tenant-a/messages/message-1/media");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "test");
  assert.equal(repository.audit.at(-1).action, "messages.media.read");
});

test("infra publica painel e separa migrador do papel restrito da aplicação", async () => {
  const [nginx, compose, roleScript, migration, migrateScript] = await Promise.all([
    readFile(new URL("../infra/panel/nginx.conf", import.meta.url), "utf8"),
    readFile(new URL("../docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../infra/postgres/init-app-role.sh", import.meta.url), "utf8"),
    readFile(new URL("../db/migrations/008_credential_links_and_runtime_safety.sql", import.meta.url), "utf8"),
    readFile(new URL("../scripts/migrate.js", import.meta.url), "utf8"),
  ]);
  assert.match(nginx, /location \/api\/[^]*proxy_pass http:\/\/api:3001/u);
  assert.match(compose, /DATABASE_APP_USER/u);
  assert.match(compose, /x-waia-image: &waia-image[^]*image: \$\{WAIA_IMAGE:-waia:local\}/u);
  assert.equal((compose.match(/<<: \*waia-image/gu) || []).length, 4);
  assert.match(compose, /METRICS_BEARER_TOKEN/u);
  assert.match(compose, /DATABASE_MIGRATOR_URL: postgres:\/\/\$\{POSTGRES_USER/u);
  assert.match(compose, /media-init:[^]*chown -R 1000:1000 \/media/u);
  assert.match(compose, /service_completed_successfully/u);
  assert.match(roleScript, /NOSUPERUSER[^\n]*NOBYPASSRLS/u);
  assert.match(roleScript, /REASSIGN OWNED BY %I TO %I', :'app_user', :'owner_user'/u);
  assert.match(roleScript, /REVOKE CREATE ON SCHEMA public FROM %I/u);
  assert.doesNotMatch(roleScript, /GRANT[^\n]*CREATE[^\n]*TO %I[^\n]*app_user/u);
  assert.doesNotMatch(roleScript, /GRANT EXECUTE ON ALL FUNCTIONS/u);
  assert.match(migrateScript, /process\.env\.DATABASE_MIGRATOR_URL/u);
  assert.doesNotMatch(migrateScript, /createPostgresPool\(\)/u);
  assert.match(migration, /REFERENCES credenciais_empresa \(empresa_id, id\)/u);
});

test("runtime SaaS não aceita fallback global de credenciais Meta", async () => {
  const [runtimeSource, configSource, legacySource, envExample] = await Promise.all([
    readFile(new URL("../src/bootstrap/app-runtime.js", import.meta.url), "utf8"),
    readFile(new URL("../src/config.js", import.meta.url), "utf8"),
    readFile(new URL("../src/whatsapp.js", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(runtimeSource, /WHATSAPP_ACCESS_TOKEN|WHATSAPP_PHONE_NUMBER_ID/u);
  assert.doesNotMatch(configSource, /process\.env\.WHATSAPP_(?:ACCESS_TOKEN|PHONE_NUMBER_ID)/u);
  assert.match(legacySource, /legacyCapitaoMorWhatsapp/u);
  assert.match(envExample, /CAPITAO_MOR_WHATSAPP_ACCESS_TOKEN/u);
  assert.match(envExample, /METRICS_BEARER_TOKEN=/u);
  assert.match(configSource, /METRICS_BEARER_TOKEN>=32/u);
  assert.doesNotMatch(envExample, /^WHATSAPP_(?:ACCESS_TOKEN|PHONE_NUMBER_ID)=/mu);
});

test("imagem de produção contém somente os artefatos necessários ao runtime", async () => {
  const [dockerfile, workflow] = await Promise.all([
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(dockerfile, /COPY \. \./u);
  for (const directory of ["src", "scripts", "db", "panel", "public"]) {
    assert.match(dockerfile, new RegExp(`COPY ${directory} \\.\\/${directory}`, "u"));
  }
  assert.match(workflow, /docker save waia:\$\{GITHUB_SHA\} \| gzip -1 > waia-image\.tar\.gz/u);
  assert.match(workflow, /sha256sum waia-image\.tar\.gz > waia-image\.tar\.gz\.sha256/u);
  assert.match(workflow, /path: \|[^]*waia-image\.tar\.gz[^]*waia-image\.tar\.gz\.sha256/u);
});

test("retenção percorre tenants isoladamente e continua após falha", async () => {
  const anonymized = [];
  const deleted = [];
  const deletedMedia = [];
  const errors = [];
  const runner = createRetentionRunner({
    conversationService: {
      async anonymizeExpired(input) {
        anonymized.push(input);
        if (input.empresaId === "tenant-b") throw new Error("falha isolada");
        return { anonymized: 2, mediaStorageKeys: [`${input.empresaId}/message-1`] };
      },
    },
    policies: async () => [
      { empresa_id: "tenant-a", retencao_mensagens_dias: 30 },
      { empresa_id: "tenant-b", retencao_mensagens_dias: 60 },
      { empresa_id: "tenant-c", retencao_mensagens_dias: 90 },
    ],
    cleanupLogs: async (policy) => { deleted.push(policy.empresa_id); return 1; },
    mediaStore: { async delete(input) { deletedMedia.push(input); } },
    logger: { error(code, fields) { errors.push({ code, fields }); } },
  });
  const result = await runner.runOnce();
  assert.deepEqual(anonymized.map((item) => item.empresaId), ["tenant-a", "tenant-b", "tenant-c"]);
  assert.deepEqual(deleted, ["tenant-a", "tenant-c"]);
  assert.deepEqual(deletedMedia, [
    { empresaId: "tenant-a", storageKey: "tenant-a/message-1" },
    { empresaId: "tenant-c", storageKey: "tenant-c/message-1" },
  ]);
  assert.equal(errors.length, 1);
  assert.deepEqual(result.map((item) => item.empresaId), ["tenant-a", "tenant-c"]);
});

test("worker retoma resposta preparada sem reexecutar runtime ou IA", async () => {
  const sent = [];
  const marked = [];
  const handlers = createWorkerHandlers({
    repository: {
      async inboundMessage() { return { id: "in-1", conversationId: "conv-1", numeroWhatsappId: "num-1", senderPhone: "5511999999999" }; },
      async statusEvent() { return null; },
      async preparedReply() { return { id: "out-1", text: "Resposta preparada", buttons: [], status: "processando" }; },
      async markReplySent(input) { marked.push(input); },
    },
    conversationService: {
      async getConversation() { return { mode: "bot" }; },
      async recordMessage() { assert.fail("não deve criar uma segunda mensagem"); },
      async applyMetaStatus() {},
    },
    tenantDefinitionRepository: { async load() { assert.fail("não deve recarregar nem executar o domínio"); } },
    metaGateway: { async sendReply(_context, payload) { sent.push(payload); return { messages: [{ id: "wamid.out" }] }; } },
  });
  const result = await handlers.process_inbound_message({ empresaId: "tenant-a", messageId: "in-1" });
  assert.deepEqual(result, { replied: true });
  assert.equal(sent[0].text, "Resposta preparada");
  assert.equal(marked[0].replyId, "out-1");
});
