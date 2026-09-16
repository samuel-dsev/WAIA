import assert from "node:assert/strict";
import test from "node:test";
import { AdminService, MemoryAdminRepository } from "../src/modules/admin/index.js";

const NOW = new Date("2026-09-02T18:00:00.000Z");
const admin = { user: { id: "admin-a" }, memberships: [{ empresaId: "tenant-a", role: "tenant_admin", permissions: [] }] };
const operator = { user: { id: "operator-a" }, memberships: [{ empresaId: "tenant-a", role: "tenant_operator", permissions: [] }] };

function setup() {
  const calls = [];
  const repository = new MemoryAdminRepository({
    environment: "test",
    tenants: [{ id: "tenant-a", name: "Tenant A", status: "draft" }],
  });
  const app = {
    id: "app-a", empresaId: "tenant-a", name: "App A", appId: "external-a", mode: "own",
    state: "pending", appSecretCredentialId: "credential-old", rawAppSecret: "must-not-leak", revision: 3,
  };
  const metaAppRepository = {
    async listApps(input) { calls.push(["list", input]); return [app]; },
    async createApp(input) { calls.push(["create", input]); return { ...app, ...input }; },
    async findAppById(input) { calls.push(["find", input]); return app; },
    async updateApp(input) { calls.push(["update", input]); return { ...app, ...input, revision: 4 }; },
    async bindNumber(input) { calls.push(["bind", input]); return { id: input.numberId, empresaId: input.empresaId, bindingRevision: 2 }; },
  };
  const metaHealthService = {
    async run(input) { calls.push(["preflight", input]); return { success: true, state: "healthy" }; },
  };
  const service = new AdminService({
    repository,
    metaAppRepository,
    metaHealthService,
    clock: () => new Date(NOW),
  });
  return { calls, repository, metaAppRepository, service };
}

test("admin gerencia aplicativo e vínculo Meta sem receber segredos", async () => {
  const { calls, service } = setup();
  const listed = await service.listMetaApplications({ auth: admin, empresaId: "tenant-a" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].appSecretCredentialId, "credential-old");
  assert.equal(Object.hasOwn(listed[0], "rawAppSecret"), false);
  await service.createMetaApplication({
    auth: admin,
    empresaId: "tenant-a",
    body: {
      name: "App A", metaAppId: "external-a", mode: "own",
      appSecretCredentialId: "credential-secret", verifyTokenCredentialId: "credential-verify",
    },
    correlationId: "correlation-a",
  });
  await service.bindMetaNumber({
    auth: admin,
    empresaId: "tenant-a",
    numberId: "number-a",
    body: { metaAppId: "app-a", accessTokenCredentialId: "credential-access", expectedRevision: 1 },
    correlationId: "correlation-a",
  });
  const create = calls.find(([type]) => type === "create")[1];
  assert.equal(create.state, undefined);
  assert.equal(create.actorId, "admin-a");
  assert.doesNotMatch(JSON.stringify({ create, calls }), /appSecretValue|verifyTokenValue|accessTokenValue/u);
});

test("ativação direta é recusada e preflight recebe ator e correlação", async () => {
  const { calls, service } = setup();
  await assert.rejects(service.updateMetaApplication({
    auth: admin, empresaId: "tenant-a", appId: "app-a",
    body: { expectedRevision: 3, state: "active" },
  }), (error) => error.status === 400);
  await assert.rejects(service.updateMetaApplication({
    auth: admin, empresaId: "tenant-a", appId: "app-a",
    body: { expectedRevision: 3 },
  }), (error) => error.status === 400);
  const result = await service.preflightMetaApplication({
    auth: admin,
    empresaId: "tenant-a",
    appId: "app-a",
    body: { numberId: "number-a" },
    correlationId: "correlation-a",
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls.find(([type]) => type === "preflight")[1], {
    empresaId: "tenant-a", appId: "app-a", numberId: "number-a",
    actorId: "admin-a", correlationId: "correlation-a",
  });
});

test("rotação mantém segredo anterior somente pela janela configurada", async () => {
  const { calls, service } = setup();
  await service.rotateMetaApplicationSecret({
    auth: admin,
    empresaId: "tenant-a",
    appId: "app-a",
    body: { expectedRevision: 3, newAppSecretCredentialId: "credential-new", rotationWindowSeconds: 900 },
    correlationId: "correlation-a",
  });
  const update = calls.find(([type]) => type === "update")[1];
  assert.equal(update.appSecretCredentialId, "credential-new");
  assert.equal(update.previousAppSecretCredentialId, "credential-old");
  assert.equal(update.appSecretRotatedAt.toISOString(), NOW.toISOString());
  assert.equal(update.previousAppSecretValidUntil.toISOString(), "2026-09-02T18:15:00.000Z");
  assert.equal(update.state, "pending");
});

test("operador não acessa gestão Meta e conflito do repositório vira HTTP 409", async () => {
  const { calls, metaAppRepository, service } = setup();
  await assert.rejects(
    service.listMetaApplications({ auth: operator, empresaId: "tenant-a" }),
    (error) => error.status === 403,
  );
  assert.equal(calls.length, 0);
  metaAppRepository.updateApp = async () => { throw Object.assign(new Error("revisão interna 7"), { code: "META_APP_CONFLICT" }); };
  await assert.rejects(service.updateMetaApplication({
    auth: admin,
    empresaId: "tenant-a",
    appId: "app-a",
    body: { expectedRevision: 2, name: "Novo nome" },
  }), (error) => error.status === 409 && error.code === "CONFLICT" && !error.message.includes("7"));
});
