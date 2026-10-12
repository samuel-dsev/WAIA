import test from "node:test";
import assert from "node:assert/strict";
import { AdminService, MemoryAdminRepository } from "../src/modules/admin/index.js";

const admin = { user: { id: "admin-a" }, memberships: [{ empresaId: "tenant-a", role: "tenant_admin", permissions: [] }] };
const operator = { user: { id: "operator-a" }, memberships: [{ empresaId: "tenant-a", role: "tenant_operator", permissions: [] }] };

function fixture() {
  const repository = new MemoryAdminRepository({ environment: "test", tenants: [{ id: "tenant-a" }, { id: "tenant-b" }], records: {
    contacts: [{ id: "contact-a", empresaId: "tenant-a", name: null, phone: "5511000000001" }, { id: "contact-b", empresaId: "tenant-b", name: "Outra empresa", phone: "5511000000001" }],
    conversations: [{ id: "conversation-a", empresaId: "tenant-a", contactId: "contact-a" }, { id: "conversation-a2", empresaId: "tenant-a", contactId: "contact-a" }, { id: "conversation-b", empresaId: "tenant-b", contactId: "contact-b" }],
    messages: [{ id: "message-a", empresaId: "tenant-a", conversationId: "conversation-a", contactId: "contact-a", body: "Histórico antigo" }, { id: "message-b", empresaId: "tenant-b", conversationId: "conversation-b", contactId: "contact-b", body: "Histórico B" }],
    "conversation-states": [{ id: "state-a", empresaId: "tenant-a", conversationId: "conversation-a", data: { name: "Nome aprendido", handoffResumeAt: "2099-01-01" } }],
    "outbox-jobs": [{ id: "job-a", empresaId: "tenant-a", conversationId: "conversation-a", jobType: "process_inbound_message", status: "publicado" }, { id: "export-a", empresaId: "tenant-a", conversationId: "conversation-a", jobType: "export_google_sheets_order", status: "publicado" }],
  } });
  return { repository, service: new AdminService({ repository }) };
}

test("conversas exibem telefone real e none, e refletem a edição do contato", async () => {
  const { service } = fixture();
  const list = () => service.list({ auth: admin, empresaId: "tenant-a", resource: "conversations" });
  assert.equal((await list()).items[0].contactName, "none");
  assert.equal((await list()).items[0].contactPhone, "5511000000001");
  await service.update({ auth: admin, empresaId: "tenant-a", resource: "contacts", id: "contact-a", body: { name: "Cliente de teste" } });
  assert.ok((await list()).items.every((item) => item.contactName === "Cliente de teste"));
  await service.update({ auth: admin, empresaId: "tenant-a", resource: "contacts", id: "contact-a", body: { name: null } });
  assert.equal((await list()).items[0].contactName, "none");
});

test("exclusão limpa estado e mensagens, cancela fila e oculta todas as conversas do contato", async () => {
  const { service, repository } = fixture();
  assert.deepEqual(await service.remove({ auth: admin, empresaId: "tenant-a", resource: "contacts", id: "contact-a" }), { deleted: true });
  for (const resource of ["contacts", "conversations", "messages"]) {
    assert.equal((await service.list({ auth: admin, empresaId: "tenant-a", resource })).items.length, 0);
  }
  assert.equal(repository.records.get("messages").get("message-a").body, null);
  assert.deepEqual(repository.records.get("conversation-states").get("state-a").data, {});
  assert.equal(repository.records.get("outbox-jobs").get("job-a").status, "concluido");
  assert.equal(repository.records.get("outbox-jobs").get("export-a").status, "publicado");
  assert.equal(repository.records.get("messages").get("message-b").body, "Histórico B");
  assert.equal(repository.records.get("contacts").get("contact-b").name, "Outra empresa");
  assert.ok(repository.audit.some((entry) => entry.action === "contacts.delete"));
  assert.doesNotMatch(JSON.stringify(repository.audit), /5511000000001|Histórico antigo|Nome aprendido/u);
  await assert.rejects(service.get({ auth: admin, empresaId: "tenant-a", resource: "conversations", id: "conversation-a" }), (error) => error.status === 404);
  await assert.rejects(service.remove({ auth: admin, empresaId: "tenant-a", resource: "contacts", id: "contact-a" }), (error) => error.status === 404);
});

test("novo contato do mesmo telefone não herda nome ou conversas antigas", async () => {
  const { service, repository } = fixture();
  await service.remove({ auth: admin, empresaId: "tenant-a", resource: "contacts", id: "contact-a" });
  await repository.create({ resource: "contacts", empresaId: "tenant-a", id: "new-contact", data: { phone: "5511000000001", name: null } });
  await repository.create({ resource: "conversations", empresaId: "tenant-a", id: "new-conversation", data: { contactId: "new-contact" } });
  const { items } = await service.list({ auth: admin, empresaId: "tenant-a", resource: "conversations" });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "new-conversation");
  assert.equal(items[0].contactName, "none");
});

test("operador e IDs de outra empresa não podem editar nem excluir contatos", async () => {
  const { service, repository } = fixture();
  for (const auth of [operator, admin]) {
    const id = auth === operator ? "contact-a" : "contact-b";
    const status = auth === operator ? 403 : 404;
    await assert.rejects(service.update({ auth, empresaId: "tenant-a", resource: "contacts", id, body: { name: "Adulterado" } }), (error) => error.status === status);
    await assert.rejects(service.remove({ auth, empresaId: "tenant-a", resource: "contacts", id }), (error) => error.status === status);
  }
  assert.equal(repository.records.get("contacts").get("contact-b").name, "Outra empresa");
});

test("exclusão ocupada retorna conflito sem apagar qualquer dado", async () => {
  const { service, repository } = fixture();
  repository.records.get("outbox-jobs").get("job-a").status = "em_publicacao";
  await assert.rejects(service.remove({ auth: admin, empresaId: "tenant-a", resource: "contacts", id: "contact-a" }), (error) => error.status === 409);
  assert.equal(repository.records.get("messages").get("message-a").body, "Histórico antigo");
  assert.equal((await service.list({ auth: admin, empresaId: "tenant-a", resource: "conversations" })).items.length, 2);
});

test("falha de auditoria reverte toda a exclusão", async () => {
  const { service, repository } = fixture();
  repository.writeAudit = async () => { throw new Error("Auditoria indisponível"); };
  await assert.rejects(service.remove({ auth: admin, empresaId: "tenant-a", resource: "contacts", id: "contact-a" }), /Auditoria indisponível/u);
  assert.equal(repository.records.get("contacts").get("contact-a").deletedAt, undefined);
  assert.equal(repository.records.get("messages").get("message-a").body, "Histórico antigo");
  assert.equal(repository.records.get("outbox-jobs").get("job-a").status, "publicado");
  assert.equal(repository.records.get("conversation-states").get("state-a").data.name, "Nome aprendido");
});
