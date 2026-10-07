import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresMetaAppRepository } from "../src/modules/meta/postgres-meta-app-repository.js";
import { PostgresOnboardingRepository } from "../src/modules/onboarding/postgres-onboarding-repository.js";

test("PostgreSQL YCloud preserva isolamento, finalidades e readiness com os vínculos existentes", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "true",
}, async () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const tenants = [], suffix = randomUUID();
  try {
    for (const label of ["a", "b"]) tenants.push((await owner.query(
      "INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1::text,$1::text,$1::text,'rascunho') RETURNING id",
      [`ycloud-check-${label}-${suffix}`],
    )).rows[0].id);
    const repository = new PostgresMetaAppRepository(pool);
    const records = [];
    for (const [index, empresaId] of tenants.entries()) {
      const credentials = {};
      for (const purpose of ["ycloud-webhook-secret", "ycloud-api-key", "meta-app-secret"]) {
        credentials[purpose] = (await owner.query(`INSERT INTO credenciais_empresa
          (empresa_id,provedor,finalidade,secret_ciphertext,secret_kdf_salt,secret_nonce,secret_tag,key_version,valor_mascarado)
          VALUES($1,$2,$3,decode(repeat('11',32),'hex'),decode(repeat('22',16),'hex'),
            decode(repeat('33',12),'hex'),decode(repeat('44',16),'hex'),'v1','synthetic') RETURNING id`,
          [empresaId, purpose.startsWith("ycloud") ? "ycloud" : "meta", purpose])).rows[0].id;
      }
      const number = (await owner.query(`INSERT INTO numeros_whatsapp
        (empresa_id,phone_number_id,waba_id,numero_e164,status,principal)
        VALUES($1,$2,$3,$4,'ativo',true) RETURNING id`,
        [empresaId, `phone-${index}-${suffix}`, `waba-${index}-${suffix}`, `+551199999000${index + 1}`])).rows[0];
      await assert.rejects(repository.createApp({ empresaId, name: "Wrong provider", metaAppId: `bad-${suffix}`,
        mode: "ycloud", appSecretCredentialId: credentials["meta-app-secret"] }), { code: "META_CREDENTIAL_INVALID" });
      const app = await repository.createApp({ empresaId, name: "YCloud synthetic", metaAppId: `company-${index}-${suffix}`,
        mode: "ycloud", state: "active", appSecretCredentialId: credentials["ycloud-webhook-secret"] });
      await assert.rejects(repository.bindNumber({ empresaId, numberId: number.id, metaAppId: app.id,
        accessTokenCredentialId: credentials["ycloud-webhook-secret"], expectedRevision: 1 }), { code: "META_CREDENTIAL_INVALID" });
      await repository.bindNumber({ empresaId, numberId: number.id, metaAppId: app.id,
        accessTokenCredentialId: credentials["ycloud-api-key"], expectedRevision: 1 });
      const resolved = await repository.resolveByWebhookPublicId(app.webhookPublicId);
      assert.equal(resolved.mode, "ycloud"); assert.equal(resolved.empresaId, empresaId);
      assert.equal(resolved.numbers[0].numeroE164, `+551199999000${index + 1}`);
      const snapshot = await new PostgresOnboardingRepository(pool).readReadinessSnapshot({ empresaId });
      assert.equal(snapshot.whatsapp.accessTokenConfigured, true);
      assert.equal(snapshot.whatsapp.applicationValid, true);
      records.push({ app, number, credentials });
    }
    await assert.rejects(repository.bindNumber({ empresaId: tenants[0], numberId: records[0].number.id,
      metaAppId: records[1].app.id, accessTokenCredentialId: records[0].credentials["ycloud-api-key"], expectedRevision: 2 }), { code: "META_APP_NOT_FOUND" });
    await assert.rejects(repository.bindNumber({ empresaId: tenants[0], numberId: records[0].number.id,
      metaAppId: records[0].app.id, accessTokenCredentialId: records[1].credentials["ycloud-api-key"], expectedRevision: 2 }), { code: "META_CREDENTIAL_INVALID" });
    assert.equal(await repository.findAppById({ empresaId: tenants[1], appId: records[0].app.id }), null);
  } finally {
    for (const empresaId of tenants) {
      for (const table of ["logs_auditoria", "numeros_whatsapp", "aplicativos_meta", "credenciais_empresa"]) {
        await owner.query(`DELETE FROM ${table} WHERE empresa_id=$1`, [empresaId]).catch(() => {});
      }
      await owner.query("DELETE FROM empresas WHERE id=$1", [empresaId]).catch(() => {});
    }
    await pool.end(); await owner.end();
  }
});
