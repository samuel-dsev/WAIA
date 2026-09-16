import assert from "node:assert/strict";
import test from "node:test";
import { PostgresMetaCredentialResolver } from "../src/bootstrap/app-runtime.js";

function setup({ number, legacyCredential } = {}) {
  const queries = [];
  const vaultCalls = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("FROM numeros_whatsapp nw")) return { rows: number ? [number] : [] };
      if (sql.includes("FROM credenciais_empresa")) return { rows: legacyCredential ? [legacyCredential] : [] };
      return { rows: [] };
    },
  };
  const resolver = new PostgresMetaCredentialResolver({
    pool: {},
    apiVersion: "v99.0",
    credentialVault: {
      async getCredentialForUse(input) { vaultCalls.push(input); return `secret:${input.credentialId}`; },
    },
    transactionRunner: async (_pool, context, callback) => callback({ client, tenantId: context.empresaId }),
  });
  return { resolver, queries, vaultCalls };
}

test("envio usa exclusivamente o access token ligado ao app ativo do número", async () => {
  const context = setup({ number: {
    phone_number_id: "phone-a",
    aplicativo_meta_id: "app-a",
    access_token_credencial_id: "credential-explicit-a",
    aplicativo_estado: "ativo",
  } });
  assert.deepEqual(await context.resolver.resolveMeta({ empresaId: "tenant-a", numeroWhatsappId: "number-a" }), {
    accessToken: "secret:credential-explicit-a",
    phoneNumberId: "phone-a",
    apiVersion: "v99.0",
  });
  assert.deepEqual(context.vaultCalls, [{ empresaId: "tenant-a", credentialId: "credential-explicit-a" }]);
  assert.equal(context.queries.some(({ sql }) => sql.includes("FROM credenciais_empresa")), false);
});

test("envio falha fechado se o app explicitamente ligado não estiver ativo", async () => {
  const context = setup({
    number: {
      phone_number_id: "phone-a",
      aplicativo_meta_id: "app-a",
      access_token_credencial_id: "credential-explicit-a",
      aplicativo_estado: "falha",
    },
    legacyCredential: { id: "credential-legacy" },
  });
  assert.equal(await context.resolver.resolveMeta({ empresaId: "tenant-a", numeroWhatsappId: "number-a" }), null);
  assert.deepEqual(context.vaultCalls, []);
  assert.equal(context.queries.some(({ sql }) => sql.includes("FROM credenciais_empresa")), false);
});

test("número ainda não migrado conserva fallback legado por tenant", async () => {
  const context = setup({
    number: {
      phone_number_id: "phone-legacy",
      aplicativo_meta_id: null,
      access_token_credencial_id: null,
      aplicativo_estado: null,
    },
    legacyCredential: { id: "credential-legacy" },
  });
  assert.deepEqual(await context.resolver.resolveMeta({ empresaId: "tenant-a", numeroWhatsappId: "number-a" }), {
    accessToken: "secret:credential-legacy",
    phoneNumberId: "phone-legacy",
    apiVersion: "v99.0",
  });
  assert.match(context.queries[1].sql, /finalidade IN \(\$2, 'whatsapp'\)/u);
  assert.deepEqual(context.queries[1].params, ["tenant-a", "whatsapp:number-a"]);
});
