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
