import test from "node:test";
import assert from "node:assert/strict";
import { PostgresPaymentResolver } from "../src/modules/business/payment-resolver.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000201";
const CREDENTIAL_ID = "00000000-0000-4000-8000-000000000299";

test("pagamento versionado resolve somente a referência tenant-scoped selecionada", async () => {
  const calls = [];
  const credentialVault = {
    async getCredentialMetadata(input) {
      calls.push(["metadata", input]);
      return { id: CREDENTIAL_ID, empresaId: TENANT_ID, provider: "payment", status: "active", configured: true };
    },
    async getCredentialForUse(input) {
      calls.push(["secret", input]);
      return "pix-protegido";
    },
  };
  const resolver = new PostgresPaymentResolver(null, { credentialVault });

  const payment = await resolver.resolve({
    empresaId: TENANT_ID,
    type: "pix",
    credentialRef: `credential:${CREDENTIAL_ID}`,
    recipient: "Empresa Sintética",
  });

  assert.deepEqual(calls, [
    ["metadata", { empresaId: TENANT_ID, credentialId: CREDENTIAL_ID }],
    ["secret", { empresaId: TENANT_ID, credentialId: CREDENTIAL_ID }],
  ]);
  assert.equal(payment.value, "pix-protegido");
  assert.equal(payment.recipient, "Empresa Sintética");
  assert.doesNotMatch(JSON.stringify(calls), /pix-protegido/u);
});

test("pagamento versionado falha fechado para referência ou provedor incompatível", async () => {
  let secretCalls = 0;
  const resolver = new PostgresPaymentResolver(null, {
    credentialVault: {
      async getCredentialMetadata() {
        return { empresaId: TENANT_ID, provider: "openai", status: "active", configured: true };
      },
      async getCredentialForUse() { secretCalls += 1; return "não-usar"; },
    },
  });

  assert.equal(await resolver.resolve({ empresaId: TENANT_ID, type: "pix", credentialRef: "credential:slug" }), null);
  assert.equal(await resolver.resolve({ empresaId: TENANT_ID, type: "pix", credentialRef: `credential:${CREDENTIAL_ID}` }), null);
  assert.equal(secretCalls, 0);
});
