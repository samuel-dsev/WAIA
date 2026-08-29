import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CredentialVaultService } from "../src/modules/secrets/credential-vault-service.js";
import { PostgresCredentialRepository } from "../src/modules/secrets/postgres-credential-repository.js";
import { VersionedKeyring } from "../src/security/versioned-keyring.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";

function fakePool() {
  const rows = new Map();
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^INSERT INTO credenciais_empresa/u.test(sql.trim())) {
        const row = {
          id: params[0],
          empresa_id: params[1],
          provedor: params[2],
          finalidade: params[3],
          secret_ciphertext: params[4],
          secret_kdf_salt: params[5],
          secret_nonce: params[6],
          secret_tag: params[7],
          key_version: params[8],
          valor_mascarado: params[9],
          secret_version: params[10],
          revision: params[11],
          status: params[12],
          rotated_at: params[13],
          revoked_at: params[14],
          created_at: new Date("2026-08-28T03:00:00.000Z"),
          updated_at: new Date("2026-08-28T03:00:00.000Z"),
        };
        rows.set(`${row.empresa_id}:${row.id}`, row);
        return { rows: [row], rowCount: 1 };
      }
      if (/^SELECT \* FROM credenciais_empresa/u.test(sql.trim())) {
        return { rows: [rows.get(`${params[0]}:${params[1]}`)].filter(Boolean), rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { calls, pool: { async connect() { return client; } } };
}

test("repositorio PostgreSQL preserva envelope completo para uso pelo vault", async () => {
  const { calls, pool } = fakePool();
  const repository = new PostgresCredentialRepository(pool);
  const service = new CredentialVaultService({
    repository,
    keyring: new VersionedKeyring({ activeVersion: "v1", keys: { v1: randomBytes(32) } }),
    auditWriter: async () => {},
    idGenerator: () => CREDENTIAL_ID,
  });

  const secret = "synthetic-postgres-token-7788";
  const metadata = await service.createCredential({
    empresaId: TENANT_ID,
    provider: "meta",
    purpose: "whatsapp-access-token",
    secret,
  });

  assert.equal(metadata.maskedSecret.endsWith("7788"), true);
  assert.equal(await service.getCredentialForUse({ empresaId: TENANT_ID, credentialId: CREDENTIAL_ID }), secret);
  const insert = calls.find(({ sql }) => /^INSERT INTO credenciais_empresa/u.test(sql.trim()));
  assert.match(insert.sql, /secret_kdf_salt/u);
  assert.equal(Buffer.isBuffer(insert.params[4]), true);
  assert.equal(Buffer.isBuffer(insert.params[5]), true);
  assert.equal(Buffer.isBuffer(insert.params[6]), true);
  assert.equal(Buffer.isBuffer(insert.params[7]), true);
  assert.doesNotMatch(JSON.stringify(insert.params), new RegExp(secret, "u"));
});
