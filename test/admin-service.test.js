import test from "node:test";
import assert from "node:assert/strict";
import { AdminForbiddenError, AdminService, AdminValidationError, MemoryAdminRepository, adminErrorMiddleware, publicAdminError } from "../src/modules/admin/index.js";
import { ConversationService, MemoryConversationRepository } from "../src/modules/conversations/index.js";
import { DraftVersionConflictError } from "../src/modules/configuration/index.js";
import { TenantNotReadyError } from "../src/modules/onboarding/onboarding-errors.js";

const platform = { user: { id: "platform" }, platformRole: "platform_admin", memberships: [] };
const tenantAdmin = { user: { id: "admin-a" }, memberships: [{ empresaId: "tenant-a", role: "tenant_admin", permissions: [] }] };
const operator = { user: { id: "operator-a" }, memberships: [{ empresaId: "tenant-a", role: "tenant_operator", permissions: [] }] };

function fixture() {
  const repository = new MemoryAdminRepository({ environment: "test", tenants: [{ id: "tenant-a", name: "A", status: "active" }, { id: "tenant-b", name: "B", status: "active" }], records: { contacts: [{ id: "contact-a", empresaId: "tenant-a", name: "Contato A" }, { id: "contact-b", empresaId: "tenant-b", name: "Contato B" }] } });
  return { repository, service: new AdminService({ repository }) };
}

test("administrador da empresa não acessa tenant por ID adulterado", async () => {
  const { service, repository } = fixture();
  await assert.rejects(service.list({ auth: tenantAdmin, empresaId: "tenant-b", resource: "contacts" }), (error) => error.status === 403);
  assert.equal(repository.audit.at(-1).result, "denied");
});

test("operador lê operação, mas não altera configuração", async () => {
  const { service } = fixture();
  assert.equal((await service.list({ auth: operator, empresaId: "tenant-a", resource: "contacts" })).items.length, 1);
  await assert.rejects(service.create({ auth: operator, empresaId: "tenant-a", resource: "modules", body: { moduleKey: "catalog", enabled: true, configuration: {} } }), (error) => error.status === 403);
});

test("operador não lê recursos administrativos mesmo com permissão curinga injetada", async () => {
  const { service } = fixture();
  const forged = { ...operator, memberships: [{ ...operator.memberships[0], permissions: ["*"] }] };
  for (const resource of ["credentials", "users", "logs", "ai-config", "integrations"]) {
    await assert.rejects(service.list({ auth: forged, empresaId: "tenant-a", resource }), (error) => error.status === 403);
  }
  await assert.rejects(service.diagnostics({ auth: forged, empresaId: "tenant-a" }), (error) => error.status === 403);
});

test("configurações variáveis rejeitam segredos aninhados", async () => {
  const { service } = fixture();
  await assert.rejects(
    service.create({ auth: tenantAdmin, empresaId: "tenant-a", resource: "integrations", body: { type: "outro", name: "X", enabled: true, requiredForConfirmation: false, status: "healthy", configuration: { nested: { apiKey: "nao-persistir" } } } }),
    (error) => error instanceof AdminValidationError,
  );
});

test("cofre aceita JSON de conta de serviço com múltiplas linhas", async () => {
  const repository = new MemoryAdminRepository({ environment: "test", tenants: [{ id: "tenant-a", name: "A", status: "active" }] });
  const received = [];
  const credentialVault = {
    async createCredential(input) { received.push(input.secret); return { id: input.credentialId, maskedSecret: "••••json", status: "active" }; },
    async rotateCredential(input) { received.push(input.newSecret); return { id: input.credentialId, maskedSecret: "••••json", status: "active" }; },
  };
  const service = new AdminService({ repository, credentialVault, idGenerator: () => "credential-google" });
  const secret = "{\n\t\"type\": \"service_account\",\n\t\"private_key\": \"linha-1\\nlinha-2\"\n}";

  await service.createCredential({ auth: tenantAdmin, empresaId: "tenant-a", body: { provider: "google", purpose: "google_sheets:integration-a", secret } });
  await service.rotateCredential({ auth: tenantAdmin, empresaId: "tenant-a", credentialId: "credential-google", body: { secret } });

  assert.deepEqual(received, [secret, secret]);
  await assert.rejects(
    service.createCredential({ auth: tenantAdmin, empresaId: "tenant-a", body: { provider: "google", purpose: "google_sheets:integration-a", secret: "valor\u0000invalido" } }),
    /secret inválido/u,
  );
});

test("middleware administrativo devolve apenas o corpo público", () => {
  const captured = {};
  const response = { status(value) { captured.status = value; return this; }, json(value) { captured.body = value; } };
  adminErrorMiddleware(new AdminValidationError("Inválido.", {
    field: "displayName",
    internalQuery: "não pode vazar",
  }), {}, response, () => assert.fail("não deveria delegar"));
  assert.equal(captured.status, 400);
  assert.deepEqual(captured.body, {
    error: {
      code: "VALIDATION_ERROR",
      message: "Inválido.",
      details: { field: "displayName" },
    },
  });
  assert.doesNotMatch(JSON.stringify(captured.body), /não pode vazar/u);
});

test("cofre administrativo aceita somente chave escalar em credencial PIX", async () => {
  const repository = new MemoryAdminRepository({ environment: "test", tenants: [{ id: "tenant-a", name: "A", status: "active" }] });
  const received = [];
  const credentialVault = {
    async createCredential(input) { received.push(input.secret); return { id: input.credentialId, maskedSecret: "••••8901", status: "active" }; },
    async getCredentialMetadata() { return { provider: "payment", purpose: "pix" }; },
    async rotateCredential(input) { received.push(input.newSecret); return { id: input.credentialId, maskedSecret: "••••8901", status: "active" }; },
  };
  const service = new AdminService({ repository, credentialVault, idGenerator: () => "credential-pix" });

  await service.createCredential({ auth: tenantAdmin, empresaId: "tenant-a", body: { provider: "payment", purpose: "pix", secret: "123.456.789-01" } });
  await service.rotateCredential({ auth: tenantAdmin, empresaId: "tenant-a", credentialId: "credential-pix", body: { secret: "12345678901" } });
  assert.deepEqual(received, ["12345678901", "12345678901"]);

  await assert.rejects(
    service.createCredential({ auth: tenantAdmin, empresaId: "tenant-a", body: { provider: "payment", purpose: "pix", secret: "{ key: '12345678901' }" } }),
    (error) => error instanceof AdminValidationError && error.details?.field === "secret",
  );
});

test("middleware administrativo converte restrições PostgreSQL sem expor SQL", () => {
  const captured = {};
  const response = {
    status(value) { captured.status = value; return this; },
    json(value) { captured.body = value; },
  };
  adminErrorMiddleware(
    Object.assign(new Error("violates check constraint internal_name"), { code: "23514" }),
    {},
    response,
    () => assert.fail("não deveria delegar"),
  );
  assert.equal(captured.status, 400);
  assert.deepEqual(captured.body, {
    error: { code: "VALIDATION_ERROR", message: "Os dados informados violam uma regra do recurso." },
  });
});

test("erros de onboarding e concorrência expõem somente diagnóstico seguro", () => {
  const conflict = publicAdminError(new DraftVersionConflictError({
    expectedDraftVersion: 3,
    currentDraftVersion: 4,
  }));
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body.error.details, { expectedDraftVersion: 3, currentDraftVersion: 4 });

  const blocked = publicAdminError(new TenantNotReadyError([{
    code: "TOKEN_REQUIRED",
    state: "failed",
    severity: "blocker",
    step: 8,
    message: "Token ausente",
    correctiveAction: "Cadastre a credencial pelo cofre.",
    accessToken: "nao-pode-vazar",
  }]));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "TENANT_NOT_READY");
  assert.equal(blocked.body.error.checks[0].code, "TOKEN_REQUIRED");
  assert.doesNotMatch(JSON.stringify(blocked), /nao-pode-vazar/u);
});

test("administrador global cria e suspende empresa com auditoria", async () => {
  const { service, repository } = fixture();
  await assert.rejects(
    service.createTenant({ auth: platform, body: { name: "C", status: "active" } }),
    (error) => error.code === "VALIDATION_ERROR" && error.details?.field === "status",
  );
  const created = await service.createTenant({ auth: platform, body: { slug: "tenant-c", name: "C", displayName: "Empresa C", timezone: "America/Sao_Paulo", locale: "pt-BR", messageRetentionDays: 180, logRetentionDays: 30 } });
  assert.equal(created.status, "draft");
  await assert.rejects(
    service.updateTenant({ auth: platform, empresaId: created.id, body: { status: "active" } }),
    (error) => error.code === "VALIDATION_ERROR" && error.details?.field === "status",
  );
  const suspended = await service.suspendTenant({ auth: platform, empresaId: created.id });
  assert.equal(suspended.status, "suspended");
  assert.equal(repository.audit.some((item) => item.action === "tenant.suspend"), true);
});

test("CRUD legado de módulos reconhece flows sem exigir mecanismo paralelo", async () => {
  const { service } = fixture();
  const result = await service.replaceModules({
    auth: tenantAdmin,
    empresaId: "tenant-a",
    body: { enabledModules: ["catalog", "flows"] },
  });
  const modules = Object.fromEntries(result.items.map((item) => [item.moduleKey, item.enabled]));
  assert.equal(modules.catalog, true);
  assert.equal(modules.flows, true);
});

test("somente administrador global consulta usuário existente por e-mail exato sem enumerar vínculos", async () => {
  const repository = new MemoryAdminRepository({
    environment: "test",
    tenants: [{ id: "tenant-a", name: "A", status: "draft" }],
    records: {
      users: [{
        id: "user-global-a",
        empresaId: "tenant-b",
        name: "Pessoa Existente",
        email: "existente@example.test",
        status: "active",
        initialPassword: "não-pode-vazar",
      }],
    },
  });
  const service = new AdminService({ repository });
  const result = await service.lookupGlobalUser({ auth: platform, email: "EXISTENTE@example.test" });
  assert.deepEqual(result, {
    id: "user-global-a",
    name: "Pessoa Existente",
    email: "existente@example.test",
    status: "active",
  });
  assert.doesNotMatch(JSON.stringify(result), /não-pode-vazar|tenant-b/u);
  await assert.rejects(
    service.lookupGlobalUser({ auth: tenantAdmin, email: "existente@example.test" }),
    (error) => error.code === "FORBIDDEN",
  );
  await assert.rejects(
    service.lookupGlobalUser({ auth: platform, email: "existente" }),
    (error) => error.code === "VALIDATION_ERROR" && error.details?.field === "email",
  );
});

test("repositório em memória lista e edita vínculo de usuário global como o PostgreSQL", async () => {
  const repository = new MemoryAdminRepository({
    environment: "test",
    tenants: [{ id: "tenant-a", name: "A", status: "draft" }, { id: "tenant-b", name: "B", status: "active" }],
    records: {
      users: [{ id: "user-global", empresaId: "tenant-b", name: "Pessoa Global", email: "global@example.test", role: "tenant_operator", status: "active" }],
    },
  });
  const service = new AdminService({ repository });

  await service.create({
    auth: platform,
    empresaId: "tenant-a",
    resource: "memberships",
    body: { userId: "user-global", role: "tenant_operator", status: "active", permissions: ["contacts.read"] },
  });
  let users = await service.list({ auth: platform, empresaId: "tenant-a", resource: "users", query: {} });
  assert.equal(users.items[0].id, "user-global");
  assert.equal(users.items[0].membershipStatus, "active");
  assert.deepEqual(users.items[0].permissions, ["contacts.read"]);

  await service.update({
    auth: platform,
    empresaId: "tenant-a",
    resource: "memberships",
    id: "user-global",
    body: { status: "suspended", permissions: [] },
  });
  users = await service.list({ auth: platform, empresaId: "tenant-a", resource: "users", query: {} });
  assert.equal(users.items[0].membershipStatus, "suspended");
  assert.deepEqual(users.items[0].permissions, []);

  await service.remove({ auth: platform, empresaId: "tenant-a", resource: "users", id: "user-global" });
  users = await service.list({ auth: platform, empresaId: "tenant-a", resource: "users", query: {} });
  assert.equal(users.items.length, 0);
  assert.equal((await service.lookupGlobalUser({ auth: platform, email: "global@example.test" })).id, "user-global");
});

test("empresa mantém ao menos um administrador ativo ao editar ou remover a equipe", async () => {
  const repository = new MemoryAdminRepository({
    environment: "test",
    tenants: [{ id: "tenant-a", name: "A", status: "draft" }],
    records: {
      users: [{
        id: "admin-a",
        empresaId: "tenant-a",
        name: "Administrador",
        email: "admin@example.test",
        role: "tenant_admin",
        status: "active",
      }],
    },
  });
  const service = new AdminService({ repository });
  await assert.rejects(
    service.update({ auth: tenantAdmin, empresaId: "tenant-a", resource: "users", id: "admin-a", body: { role: "tenant_operator" } }),
    (error) => error.code === "VALIDATION_ERROR" && error.details?.field === "role",
  );
  await assert.rejects(
    service.remove({ auth: tenantAdmin, empresaId: "tenant-a", resource: "users", id: "admin-a" }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  const secondAdmin = await service.create({
    auth: tenantAdmin,
    empresaId: "tenant-a",
    resource: "users",
    body: {
      name: "Segundo Administrador",
      email: "segundo@example.test",
      role: "tenant_admin",
      status: "active",
      initialPassword: "senha-sintetica-forte",
      permissions: ["contacts.read", "contacts.update"],
    },
  });
  assert.deepEqual(secondAdmin.permissions, ["contacts.read", "contacts.update"]);
  const updatedPermissions = await service.update({
    auth: tenantAdmin,
    empresaId: "tenant-a",
    resource: "users",
    id: secondAdmin.id,
    body: { permissions: ["orders.read", "orders.update"] },
  });
  assert.deepEqual(updatedPermissions.permissions, ["orders.read", "orders.update"]);
  assert.deepEqual(
    await service.remove({ auth: tenantAdmin, empresaId: "tenant-a", resource: "users", id: "admin-a" }),
    { deleted: true },
  );
});

test("onboarding exige administrador do tenant e ativação exige plataforma", async () => {
  const repository = new MemoryAdminRepository({
    environment: "test",
    tenants: [{ id: "tenant-a", name: "A", status: "draft" }],
  });
  const calls = [];
  const onboardingService = new Proxy({}, {
    get(_target, method) {
      return async (input) => {
        calls.push([method, input]);
        return { ok: true };
      };
    },
  });
  const service = new AdminService({ repository, onboardingService });
  await service.saveOnboardingStep({
    auth: tenantAdmin,
    empresaId: "tenant-a",
    step: "3",
    body: { revision: 1, completedSteps: [{ step: 2, completedAt: "2026-09-01T12:00:00.000Z" }] },
    correlationId: "00000000-0000-4000-8000-000000000302",
  });
  await service.activateTenant({
    auth: platform,
    empresaId: "tenant-a",
    body: { draftVersion: 4 },
  });
  assert.deepEqual(calls[0], ["saveProgressStep", {
    empresaId: "tenant-a",
    expectedRevision: 1,
    currentStep: 3,
    completedSteps: [{ step: 2, completedAt: "2026-09-01T12:00:00.000Z" }],
    actorId: "admin-a",
    correlationId: "00000000-0000-4000-8000-000000000302",
  }]);
  assert.deepEqual(calls[1], ["activate", {
    empresaId: "tenant-a",
    expectedDraftVersion: 4,
    actorId: "platform",
    correlationId: null,
  }]);
  await assert.rejects(
    service.activateTenant({ auth: tenantAdmin, empresaId: "tenant-a", body: { draftVersion: 4 } }),
    (error) => error.code === "FORBIDDEN",
  );
  await assert.rejects(
    service.configurationReadiness({ auth: operator, empresaId: "tenant-a" }),
    (error) => error.code === "FORBIDDEN",
  );
});

test("simulador e preflight usam draft versionado, escopo administrativo e auditoria segura", async () => {
  const repository = new MemoryAdminRepository({
    environment: "test",
    tenants: [{ id: "tenant-a", name: "A", status: "draft" }],
  });
  const calls = [];
  const onboardingService = {
    async simulateMessage(input) {
      calls.push(["simulateMessage", input]);
      return { sessionId: "preview-a", sessionRevision: 1, synthetic: true };
    },
    async preflight(input) {
      calls.push(["preflight", input]);
      return { state: "passed", authoritativeGate: "readiness", checks: [] };
    },
  };
  const service = new AdminService({ repository, onboardingService });
  await service.simulateConfigurationMessage({
    auth: tenantAdmin,
    empresaId: "tenant-a",
    body: { draftVersion: 2, message: { type: "text", text: "oi" } },
    correlationId: "00000000-0000-4000-8000-000000000310",
  });
  await service.preflightConfiguration({
    auth: tenantAdmin,
    empresaId: "tenant-a",
    body: { draftVersion: 2 },
    correlationId: "00000000-0000-4000-8000-000000000311",
  });
  assert.equal(calls[0][1].actorId, "admin-a");
  assert.equal(calls[0][1].expectedSessionRevision, 0);
  assert.equal(calls[1][1].expectedDraftVersion, 2);
  assert.deepEqual(repository.audit.at(-1).changedFields, ["draft_version", "session_revision", "message_type"]);
  assert.doesNotMatch(JSON.stringify(repository.audit), /"text":"oi"/u);
  await assert.rejects(
    service.preflightConfiguration({ auth: operator, empresaId: "tenant-a", body: { draftVersion: 2 } }),
    (error) => error.code === "FORBIDDEN",
  );
  await assert.rejects(
    service.simulateConfigurationMessage({
      auth: tenantAdmin,
      empresaId: "tenant-a",
      body: { draftVersion: 2, configVersion: 99, message: { type: "text", text: "oi" } },
    }),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("falha de auditoria reverte a mutação administrativa", async () => {
  const { service, repository } = fixture();
  repository.writeAudit = async () => { throw new Error("auditoria indisponível"); };

  await assert.rejects(
    service.updateTenant({ auth: platform, empresaId: "tenant-a", body: { name: "Nome inconsistente" } }),
    /auditoria indisponível/u,
  );

  assert.equal((await repository.getTenant({ empresaId: "tenant-a" })).name, "A");
  assert.equal(repository.audit.length, 0);
});

test("falha de auditoria não deixa novo recurso persistido", async () => {
  const { service, repository } = fixture();
  repository.writeAudit = async () => { throw new Error("auditoria indisponível"); };

  await assert.rejects(
    service.create({
      auth: tenantAdmin,
      empresaId: "tenant-a",
      resource: "integrations",
      body: { type: "outro", name: "Integração", enabled: true, requiredForConfirmation: false, status: "healthy", configuration: {} },
    }),
    /auditoria indisponível/u,
  );

  assert.equal((await repository.list({ resource: "integrations", empresaId: "tenant-a" })).items.length, 0);
});

test("falha de auditoria reverte mudança do modo de atendimento", async () => {
  const repository = new MemoryAdminRepository({ environment: "test", tenants: [{ id: "tenant-a", name: "A", status: "active" }] });
  const conversationRepository = new MemoryConversationRepository({ environment: "test", idFactory: (() => { let id = 0; return () => `id-${++id}`; })() });
  const conversationService = new ConversationService({ repository: conversationRepository });
  const opened = await conversationService.openOrResume({
    empresaId: "tenant-a",
    phone: "5511999999999",
    numeroWhatsappId: "number-a",
    correlationId: "correlation-a",
  });
  const service = new AdminService({ repository, conversationService });
  repository.writeAudit = async () => { throw new Error("auditoria indisponível"); };

  await assert.rejects(
    service.setConversationMode({
      auth: operator,
      empresaId: "tenant-a",
      conversationId: opened.conversation.id,
      mode: "human",
      operatorId: "operator-a",
    }),
    /auditoria indisponível/u,
  );

  const conversation = await conversationService.getConversation({ empresaId: "tenant-a", conversationId: opened.conversation.id });
  assert.equal(conversation.mode, "bot");
  assert.equal(conversation.operatorId, null);
});

test("operador registra resposta humana e outbox na mesma unidade auditada", async () => {
  const { repository } = fixture();
  let queued;
  repository.queueHumanMessage = async (input) => {
    queued = input;
    return repository.create({
      resource: "messages",
      empresaId: input.empresaId,
      id: "message-human-1",
      data: { conversationId: input.conversationId, body: input.text, status: "queued" },
    });
  };
  const service = new AdminService({ repository, idGenerator: () => "00000000-0000-4000-8000-000000000099" });
  const result = await service.sendHumanMessage({
    auth: operator,
    empresaId: "tenant-a",
    conversationId: "conversation-a",
    body: { text: "Olá!\nComo posso ajudar?", idempotencyKey: "00000000-0000-4000-8000-000000000011" },
    correlationId: "00000000-0000-4000-8000-000000000022",
  });

  assert.equal(result.id, "message-human-1");
  assert.equal(queued.operatorId, "operator-a");
  assert.equal(queued.correlationId, "00000000-0000-4000-8000-000000000022");
  assert.equal(queued.transaction.kind, "memory-admin-transaction");
  assert.equal(repository.audit.at(-1).action, "conversation.message.send");
  assert.equal(repository.audit.at(-1).resourceId, "message-human-1");
  assert.deepEqual(repository.audit.at(-1).changedFields, ["text"]);
});

test("falha de auditoria reverte a resposta humana", async () => {
  const { repository } = fixture();
  repository.queueHumanMessage = (input) => repository.create({
    resource: "messages",
    empresaId: input.empresaId,
    id: "message-rollback",
    data: { conversationId: input.conversationId, body: input.text, status: "queued" },
  });
  repository.writeAudit = async () => { throw new Error("auditoria indisponível"); };
  const service = new AdminService({ repository });

  await assert.rejects(service.sendHumanMessage({
    auth: operator,
    empresaId: "tenant-a",
    conversationId: "conversation-a",
    body: { text: "Não deve persistir", idempotencyKey: "00000000-0000-4000-8000-000000000033" },
  }), /auditoria indisponível/u);
  assert.equal((await repository.list({ resource: "messages", empresaId: "tenant-a" })).items.length, 0);
});

test("tentativa de responder conversa atribuída a outro operador é auditada", async () => {
  const { repository } = fixture();
  repository.queueHumanMessage = async () => { throw new AdminForbiddenError(); };
  const service = new AdminService({ repository });

  await assert.rejects(service.sendHumanMessage({
    auth: operator,
    empresaId: "tenant-a",
    conversationId: "conversation-a",
    body: { text: "Tentativa negada", idempotencyKey: "00000000-0000-4000-8000-000000000066" },
  }), (error) => error.status === 403);
  assert.equal(repository.audit.at(-1).action, "conversation.message.send");
  assert.equal(repository.audit.at(-1).result, "denied");
});

test("somente administrador consulta detalhes sanitizados de jobs falhos", async () => {
  const repository = new MemoryAdminRepository({
    environment: "test",
    tenants: [{ id: "tenant-a", name: "A", status: "active" }],
    records: {
      "failed-jobs": [{
        id: "failed-1",
        empresaId: "tenant-a",
        jobType: "send_human_message",
        errorCode: "META_REQUEST_FAILED",
        error: "Falha sanitizada.",
        accessToken: "nao-pode-vazar",
        status: "open",
        resolvedAt: null,
      }],
    },
  });
  const service = new AdminService({ repository });

  await assert.rejects(
    service.listFailedJobs({ auth: operator, empresaId: "tenant-a" }),
    (error) => error.status === 403,
  );
  const listed = await service.listFailedJobs({ auth: tenantAdmin, empresaId: "tenant-a" });
  const detail = await service.getFailedJob({ auth: tenantAdmin, empresaId: "tenant-a", failedJobId: "failed-1" });
  assert.equal(listed.items.length, 1);
  assert.doesNotMatch(JSON.stringify({ listed, detail }), /nao-pode-vazar/u);
});

test("administrador reenfileira job falho com novo ID e auditoria transacional", async () => {
  const repository = new MemoryAdminRepository({
    environment: "test",
    tenants: [{ id: "tenant-a", name: "A", status: "active" }],
    records: {
      "failed-jobs": [{
        id: "failed-1", empresaId: "tenant-a", jobType: "send_human_message",
        conversationId: "conversation-1", messageId: "message-1", status: "open", resolvedAt: null,
      }],
    },
  });
  const generated = ["00000000-0000-4000-8000-000000000071", "00000000-0000-4000-8000-000000000072"];
  const service = new AdminService({ repository, idGenerator: () => generated.shift() });
  const result = await service.retryFailedJob({
    auth: tenantAdmin,
    empresaId: "tenant-a",
    failedJobId: "failed-1",
    body: { reason: "Credencial corrigida e validada." },
    correlationId: "00000000-0000-4000-8000-000000000073",
  });

  assert.equal(result.resolutionKind, "reenfileirado");
  assert.equal(result.retryJobId, "00000000-0000-4000-8000-000000000071");
  assert.equal((await repository.get({ resource: "outbox-jobs", empresaId: "tenant-a", id: result.retryJobId })).status, "pendente");
  assert.equal(repository.audit.at(-1).action, "failed_jobs.retry");
  assert.equal(repository.audit.at(-1).resourceId, "failed-1");
});

test("falha de auditoria reverte retentativa de job falho", async () => {
  const repository = new MemoryAdminRepository({
    environment: "test",
    tenants: [{ id: "tenant-a", name: "A", status: "active" }],
    records: { "failed-jobs": [{ id: "failed-rollback", empresaId: "tenant-a", jobType: "x", status: "open", resolvedAt: null }] },
  });
  repository.writeAudit = async () => { throw new Error("auditoria indisponível"); };
  const service = new AdminService({ repository, idGenerator: () => "00000000-0000-4000-8000-000000000074" });

  await assert.rejects(service.retryFailedJob({
    auth: tenantAdmin,
    empresaId: "tenant-a",
    failedJobId: "failed-rollback",
    body: { reason: "Retentar após correção." },
  }), /auditoria indisponível/u);
  assert.equal((await repository.getFailedJob({ empresaId: "tenant-a", id: "failed-rollback" })).resolvedAt, null);
  assert.equal((await repository.list({ resource: "outbox-jobs", empresaId: "tenant-a" })).items.length, 0);
});

test("resolução administrativa encerra alerta sem criar novo job", async () => {
  const repository = new MemoryAdminRepository({
    environment: "test",
    tenants: [{ id: "tenant-a", name: "A", status: "active" }],
    records: { "failed-jobs": [{ id: "failed-resolve", empresaId: "tenant-a", jobType: "x", status: "open", resolvedAt: null }] },
  });
  const service = new AdminService({ repository });
  const resolved = await service.resolveFailedJob({
    auth: tenantAdmin,
    empresaId: "tenant-a",
    failedJobId: "failed-resolve",
    body: { reason: "Incidente analisado; nenhuma ação externa necessária." },
  });

  assert.equal(resolved.resolutionKind, "resolvido");
  assert.equal(resolved.retryJobId, undefined);
  assert.equal((await repository.list({ resource: "outbox-jobs", empresaId: "tenant-a" })).items.length, 0);
  assert.equal(repository.audit.at(-1).action, "failed_jobs.resolve");
  await assert.rejects(service.resolveFailedJob({
    auth: tenantAdmin,
    empresaId: "tenant-a",
    failedJobId: "failed-resolve",
    body: { reason: "Duplicada." },
  }), (error) => error instanceof AdminValidationError);
});
