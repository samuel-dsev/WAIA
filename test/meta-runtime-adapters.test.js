import assert from "node:assert/strict";
import test from "node:test";
import {
  MetaWebhookConnectionResolver,
  MetaWebhookCredentialResolver,
} from "../src/modules/meta/runtime-adapters.js";

test("adaptador usa credenciais globais somente para aplicativo compartilhado", async () => {
  const resolver = new MetaWebhookConnectionResolver({
    repository: {
      async resolveByWebhookPublicId() {
        return { id: "app-a", mode: "shared", appSecretCredentialId: null, verifyTokenCredentialId: null };
      },
    },
  });
  const connection = await resolver.resolveByWebhookPublicId("public-a");
  assert.match(connection.appSecretCredentialId, /^internal:/u);
  assert.match(connection.verifyTokenCredentialId, /^internal:/u);

  const credentials = new MetaWebhookCredentialResolver({
    sharedAppSecret: "synthetic-shared-secret",
    sharedVerifyToken: "synthetic-shared-verify",
  });
  assert.equal(await credentials.getCredentialForUse({ credentialId: connection.appSecretCredentialId }), "synthetic-shared-secret");
  assert.equal(await credentials.getCredentialForUse({ credentialId: connection.verifyTokenCredentialId }), "synthetic-shared-verify");
});

test("adaptador próprio mantém referências tenant-scoped e delega ao cofre", async () => {
  const connection = {
    id: "app-own", mode: "own", appSecretCredentialId: "credential-a", verifyTokenCredentialId: "credential-b",
  };
  const resolver = new MetaWebhookConnectionResolver({
    repository: { async resolveByWebhookPublicId() { return connection; } },
  });
  assert.equal(await resolver.resolveByWebhookPublicId("public-a"), connection);

  const calls = [];
  const credentials = new MetaWebhookCredentialResolver({
    credentialVault: {
      async getCredentialForUse(input) { calls.push(input); return "synthetic-own-secret"; },
    },
  });
  assert.equal(await credentials.getCredentialForUse({ empresaId: "tenant-a", credentialId: "credential-a" }), "synthetic-own-secret");
  assert.deepEqual(calls, [{ empresaId: "tenant-a", credentialId: "credential-a" }]);
});

test("adaptador compartilhado falha fechado quando infraestrutura não possui segredo", async () => {
  const credentials = new MetaWebhookCredentialResolver();
  await assert.rejects(
    credentials.getCredentialForUse({ credentialId: "internal:shared-meta-app-secret" }),
    /indisponível/u,
  );
});
