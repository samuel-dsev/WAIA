import test from "node:test";
import assert from "node:assert/strict";
import { AuthService, MemoryAuthRateLimiter, MemoryAuthRepository, createSessionTokenCodec, hashPassword, hasPermission } from "../src/modules/auth/index.js";

test("login cria sessão opaca, CSRF e isolamento de permissões", async () => {
  const passwordHash = await hashPassword("senha-sintetica-forte-123");
  const repository = new MemoryAuthRepository({ environment: "test", users: [{ id: "u1", email: "admin@example.invalid", name: "Admin", passwordHash, status: "active", platformRole: null }], memberships: [{ userId: "u1", empresaId: "tenant-a", role: "tenant_admin", status: "active", permissions: [] }] });
  const audit = [];
  const service = new AuthService({ repository, tokenCodec: createSessionTokenCodec({ pepper: "p".repeat(40) }), rateLimiter: new MemoryAuthRateLimiter({ environment: "test" }), audit: (event) => audit.push(event) });
  const result = await service.login({ email: "admin@example.invalid", password: "senha-sintetica-forte-123" });
  assert.equal(result.credentials.sessionToken.includes("senha"), false);
  assert.equal(service.verifyCsrf({ sessionToken: result.credentials.sessionToken, csrfToken: result.credentials.csrfToken }), true);
  const principal = await service.authenticate(result.credentials.sessionToken);
  assert.equal(hasPermission(principal, "catalog.manage", "tenant-a"), true);
  assert.equal(hasPermission(principal, "catalog.manage", "tenant-b"), false);
  await service.logout({ sessionId: principal.sessionId, userId: principal.user.id });
  await assert.rejects(service.authenticate(result.credentials.sessionToken), /Autenticação necessária/u);
  assert.doesNotMatch(JSON.stringify(audit), /senha-sintetica/u);
});

test("troca de senha exige a atual, aplica política e revoga as outras sessões", async () => {
  const oldPassword = "senha-sintetica-antiga-123";
  const newPassword = "senha-sintetica-nova-456";
  const repository = new MemoryAuthRepository({
    environment: "test",
    users: [{ id: "u1", email: "admin@example.invalid", name: "Admin", passwordHash: await hashPassword(oldPassword), status: "active", platformRole: "platform_admin" }],
  });
  const audit = [];
  const service = new AuthService({
    repository,
    tokenCodec: createSessionTokenCodec({ pepper: "p".repeat(40) }),
    rateLimiter: new MemoryAuthRateLimiter({ environment: "test" }),
    audit: (event) => audit.push(event),
  });
  const kept = await service.login({ email: "admin@example.invalid", password: oldPassword });
  const revoked = await service.login({ email: "admin@example.invalid", password: oldPassword });
  await assert.rejects(service.changePassword({
    sessionId: kept.principal.sessionId,
    userId: "u1",
    currentPassword: "incorreta",
    newPassword,
  }), /E-mail ou senha/u);
  await service.changePassword({
    sessionId: kept.principal.sessionId,
    userId: "u1",
    currentPassword: oldPassword,
    newPassword,
  });
  await service.authenticate(kept.credentials.sessionToken);
  await assert.rejects(service.authenticate(revoked.credentials.sessionToken), /Autenticação necessária/u);
  await assert.rejects(service.login({ email: "admin@example.invalid", password: oldPassword }), /E-mail ou senha/u);
  assert.equal((await service.login({ email: "admin@example.invalid", password: newPassword })).principal.user.id, "u1");
  assert.equal(audit.some(({ action }) => action === "auth.password_changed"), true);
  assert.doesNotMatch(JSON.stringify(audit), /senha-sintetica/u);
});
