import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresMetaAppRepository } from "../src/modules/meta/postgres-meta-app-repository.js";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "true";

async function createCredential(client, { empresaId, purpose }) {
  return (await client.query(
    `INSERT INTO credenciais_empresa
       (empresa_id, provedor, finalidade, secret_ciphertext, secret_kdf_salt,
        secret_nonce, secret_tag, key_version, valor_mascarado)
     VALUES ($1,'meta',$2,decode(repeat('11',32),'hex'),decode(repeat('22',16),'hex'),
             decode(repeat('33',12),'hex'),decode(repeat('44',16),'hex'),'v1','••••meta')
     RETURNING id`,
    [empresaId, purpose],
  )).rows[0].id;
}

test("PostgreSQL isola dois apps, números e credenciais Meta por tenant", { skip: !enabled }, async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL é obrigatória");
  assert.ok(process.env.DATABASE_MIGRATOR_URL, "DATABASE_MIGRATOR_URL é obrigatória");
  const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  const owner = await ownerPool.connect();
  const suffix = randomUUID();
  const tenantIds = [];

  try {
    for (const label of ["a", "b"]) {
      tenantIds.push((await owner.query(
        `INSERT INTO empresas (slug,nome,nome_exibicao,status)
         VALUES ($1,$2,$2,'rascunho') RETURNING id`,
        [`meta-${label}-${suffix}`, `Meta Tenant ${label.toUpperCase()}`],
      )).rows[0].id);
    }
    const repository = new PostgresMetaAppRepository(appPool);
    const records = [];
    for (const [index, empresaId] of tenantIds.entries()) {
      const numberId = (await owner.query(
        `INSERT INTO numeros_whatsapp
           (empresa_id,phone_number_id,waba_id,status,principal)
         VALUES ($1,$2,$3,'ativo',true) RETURNING id`,
        [empresaId, `phone-${index}-${suffix}`, `waba-${index}-${suffix}`],
      )).rows[0].id;
      const appSecretCredentialId = await createCredential(owner, {
        empresaId,
        purpose: "meta-app-secret",
      });
      const verifyTokenCredentialId = await createCredential(owner, {
        empresaId,
        purpose: "meta-verify-token",
      });
      const accessTokenCredentialId = await createCredential(owner, {
        empresaId,
        purpose: `whatsapp:${numberId}`,
      });
      const app = await repository.createApp({
        empresaId,
        name: `App ${index}`,
        metaAppId: `external-app-${index}-${suffix}`,
        mode: "own",
        state: "active",
        appSecretCredentialId,
        verifyTokenCredentialId,
      });
      const binding = await repository.bindNumber({
        empresaId,
        numberId,
        metaAppId: app.id,
        accessTokenCredentialId,
        expectedRevision: 1,
      });
      records.push({ app, binding, numberId });
    }

    const resolvedA = await repository.resolveByWebhookPublicId({
      webhookPublicId: records[0].app.webhookPublicId,
    });
    const resolvedB = await repository.resolveByWebhookPublicId({
      webhookPublicId: records[1].app.webhookPublicId,
    });
    assert.equal(resolvedA.app.empresaId, tenantIds[0]);
    assert.deepEqual(resolvedA.numbers.map((number) => number.id), [records[0].numberId]);
    assert.equal(resolvedB.app.empresaId, tenantIds[1]);
    assert.deepEqual(resolvedB.numbers.map((number) => number.id), [records[1].numberId]);
    assert.notEqual(resolvedA.app.webhookPublicId, resolvedB.app.webhookPublicId);

    assert.equal(await repository.findNumberBinding({
      empresaId: tenantIds[1],
      numberId: records[0].numberId,
    }), null);
    await assert.rejects(
      repository.bindNumber({
        empresaId: tenantIds[0],
        numberId: records[0].numberId,
        metaAppId: records[1].app.id,
        accessTokenCredentialId: records[0].binding.accessTokenCredentialId,
        expectedRevision: records[0].binding.bindingRevision,
      }),
      (error) => error.code === "META_APP_NOT_FOUND",
    );

    const failed = await repository.recordHealthCheck({
      empresaId: tenantIds[0],
      appId: records[0].app.id,
      expectedRevision: records[0].app.revision,
      success: false,
      state: "failed",
      testedAt: new Date("2026-09-02T12:00:00.000Z"),
      errorSanitized: { code: "META_TIMEOUT", message: "Timeout sintético", status: 504 },
    });
    assert.deepEqual(failed.lastErrorSanitized, {
      code: "META_TIMEOUT",
      message: "Timeout sintético",
      status: 504,
    });
    assert.deepEqual(await repository.clearExpiredErrors({
      empresaId: tenantIds[0],
      before: new Date("2036-09-02T12:00:00.000Z"),
    }), [records[0].app.id]);
  } finally {
    for (const empresaId of tenantIds) {
      await owner.query("DELETE FROM logs_auditoria WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM numeros_whatsapp WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM aplicativos_meta WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM credenciais_empresa WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM empresas WHERE id = $1", [empresaId]).catch(() => {});
    }
    owner.release();
    await appPool.end();
    await ownerPool.end();
  }
});
