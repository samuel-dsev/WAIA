import test from "node:test";
import assert from "node:assert/strict";
import { AdminForbiddenError, AdminService, AdminValidationError, MemoryAdminRepository, adminErrorMiddleware } from "../src/modules/admin/index.js";
import { ConversationService, MemoryConversationRepository } from "../src/modules/conversations/index.js";

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

test("middleware administrativo devolve apenas o corpo público", () => {
  const captured = {};
  const response = { status(value) { captured.status = value; return this; }, json(value) { captured.body = value; } };
  adminErrorMiddleware(new AdminValidationError("Inválido."), {}, response, () => assert.fail("não deveria delegar"));
  assert.equal(captured.status, 400);
  assert.deepEqual(captured.body, { error: { code: "VALIDATION_ERROR", message: "Inválido." } });
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

test("administrador global cria e suspende empresa com auditoria", async () => {
  const { service, repository } = fixture();
  const created = await service.createTenant({ auth: platform, body: { slug: "tenant-c", name: "C", displayName: "Empresa C", timezone: "America/Sao_Paulo", locale: "pt-BR", status: "draft", messageRetentionDays: 180, logRetentionDays: 30 } });
  const suspended = await service.suspendTenant({ auth: platform, empresaId: created.id });
  assert.equal(suspended.status, "suspended");
  assert.equal(repository.audit.some((item) => item.action === "tenant.suspend"), true);
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
