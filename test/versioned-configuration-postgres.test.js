import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresTenantDefinitionRepository } from "../src/tenants/postgres-config-loader.js";
import { PostgresVersionedConfigurationRepository } from "../src/modules/configuration/postgres-versioned-configuration-repository.js";
import { VersionedConfigurationService } from "../src/modules/configuration/versioned-configuration-service.js";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "true";

function configuration(name) {
  return {
    schemaVersion: 2,
    identity: { name },
    modules: ["catalog"],
    menu: {
      text: "Escolha uma opção:",
      options: [{ id: "produtos", label: "Produtos", action: "catalog.list", params: {} }],
    },
  };
}

test("PostgreSQL publica revisão atomicamente e mantém draft fora do runtime", { skip: !enabled }, async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL é obrigatória");
  assert.ok(process.env.DATABASE_MIGRATOR_URL, "DATABASE_MIGRATOR_URL é obrigatória");
  const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  const owner = await ownerPool.connect();
  const suffix = randomUUID();
  let actorId;
  const tenantIds = [];

  try {
    actorId = (await owner.query(
      "INSERT INTO usuarios (email, nome, password_hash) VALUES ($1, 'Autor sintético', 'hash-sintetico') RETURNING id",
      [`versioned-${suffix}@example.invalid`],
    )).rows[0].id;
    for (const label of ["atomic", "rollback"]) {
      const tenant = (await owner.query(
        `INSERT INTO empresas (slug, nome, nome_exibicao, status)
         VALUES ($1, $2, $2, 'rascunho')
         RETURNING id, configuracao_runtime_modo, configuracao_ativa_versao`,
        [`versioned-${label}-${suffix}`, `Empresa ${label}`],
      )).rows[0];
      tenantIds.push(tenant.id);
      assert.equal(tenant.configuracao_runtime_modo, "versionado");
      assert.equal(tenant.configuracao_ativa_versao, null);
    }

    const repository = new PostgresVersionedConfigurationRepository(appPool);
    const service = new VersionedConfigurationService(repository);
    const [tenantId, rollbackTenantId] = tenantIds;
    const firstDraft = await service.saveDraft({
      empresaId: tenantId,
      actorId,
      expectedDraftVersion: 0,
      configuration: configuration("Configuração publicada"),
    });
    assert.equal(firstDraft.draftVersion, 1);
    const beforePublish = (await owner.query(
      "SELECT configuracao_ativa_versao, versao_configuracao FROM empresas WHERE id = $1",
      [tenantId],
    )).rows[0];
    assert.equal(beforePublish.configuracao_ativa_versao, null);
    await assert.rejects(
      new PostgresTenantDefinitionRepository(appPool).load(tenantId),
      (error) => error.code === "ACTIVE_CONFIGURATION_REQUIRED",
    );

    const published = await service.publish({
      empresaId: tenantId,
      actorId,
      expectedDraftVersion: 1,
      correlationId: randomUUID(),
    });
    assert.equal(published.runtimeMode, "versionado");
    const active = await new PostgresTenantDefinitionRepository(appPool).load(tenantId);
    assert.equal(active.runtime.identity.name, "Configuração publicada");
    assert.equal(active.runtime.version, published.configVersion);

    await service.saveDraft({
      empresaId: tenantId,
      actorId,
      expectedDraftVersion: 1,
      configuration: configuration("Somente no rascunho"),
    });
    const stillActive = await new PostgresTenantDefinitionRepository(appPool).load(tenantId);
    assert.equal(stillActive.runtime.identity.name, "Configuração publicada");
    assert.equal(stillActive.runtime.version, published.configVersion);

    const persisted = (await owner.query(
      `SELECT e.configuracao_ativa_versao, e.versao_configuracao,
              r.source_draft_version, r.checksum,
              r.configuracao_compilada -> 'configuration' -> 'identity' ->> 'name' AS published_name,
              count(a.id)::int AS audits
         FROM empresas e
         JOIN configuracoes_revisoes r
           ON r.empresa_id = e.id AND r.config_version = e.configuracao_ativa_versao
         LEFT JOIN logs_auditoria a
           ON a.empresa_id = e.id AND a.acao = 'configuration.publish'
        WHERE e.id = $1
        GROUP BY e.id, r.empresa_id, r.config_version`,
      [tenantId],
    )).rows[0];
    assert.equal(Number(persisted.configuracao_ativa_versao), published.configVersion);
    assert.equal(Number(persisted.versao_configuracao), published.configVersion);
    assert.equal(Number(persisted.source_draft_version), 1);
    assert.equal(persisted.checksum, published.checksum);
    assert.equal(persisted.published_name, "Configuração publicada");
    assert.equal(persisted.audits, 1);

    await assert.rejects(
      owner.query(
        "UPDATE configuracoes_revisoes SET checksum = $3 WHERE empresa_id = $1 AND config_version = $2",
        [tenantId, published.configVersion, "0".repeat(64)],
      ),
      (error) => error.code === "55000",
    );
    await assert.rejects(
      owner.query(
        "DELETE FROM configuracoes_revisoes WHERE empresa_id = $1 AND config_version = $2",
        [tenantId, published.configVersion],
      ),
      (error) => error.code === "55000",
    );

    await service.saveDraft({
      empresaId: rollbackTenantId,
      actorId,
      expectedDraftVersion: 0,
      configuration: configuration("Deve reverter"),
    });
    const scopedClient = await appPool.connect();
    try {
      await scopedClient.query("BEGIN");
      await scopedClient.query("SELECT set_config('app.empresa_id', $1, true)", [tenantId]);
      const hiddenDrafts = await scopedClient.query(
        "SELECT count(*)::int AS count FROM configuracoes_rascunho WHERE empresa_id = $1",
        [rollbackTenantId],
      );
      assert.equal(hiddenDrafts.rows[0].count, 0);
      await assert.rejects(
        scopedClient.query(
          "INSERT INTO onboarding_progressos (empresa_id) VALUES ($1)",
          [rollbackTenantId],
        ),
        (error) => error.code === "42501",
      );
    } finally {
      await scopedClient.query("ROLLBACK").catch(() => {});
      scopedClient.release();
    }
    const concurrent = await Promise.allSettled([
      service.saveDraft({
        empresaId: rollbackTenantId,
        actorId,
        expectedDraftVersion: 1,
        configuration: configuration("Concorrente A"),
      }),
      service.saveDraft({
        empresaId: rollbackTenantId,
        actorId,
        expectedDraftVersion: 1,
        configuration: configuration("Concorrente B"),
      }),
    ]);
    assert.equal(concurrent.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(concurrent.filter(({ status, reason }) => status === "rejected" && reason.code === "DRAFT_VERSION_CONFLICT").length, 1);
    await assert.rejects(
      service.publish({
        empresaId: rollbackTenantId,
        actorId,
        expectedDraftVersion: 2,
        correlationId: "correlation-id-invalido",
      }),
      (error) => error.code === "CONFIGURATION_PUBLICATION_FAILED"
        && !error.message.includes("uuid"),
    );
    const rolledBack = (await owner.query(
      `SELECT e.configuracao_ativa_versao,
              (SELECT count(*)::int FROM configuracoes_revisoes r WHERE r.empresa_id = e.id) AS revisions,
              (SELECT count(*)::int FROM logs_auditoria a WHERE a.empresa_id = e.id AND a.acao = 'configuration.publish') AS audits
         FROM empresas e WHERE e.id = $1`,
      [rollbackTenantId],
    )).rows[0];
    assert.deepEqual(rolledBack, { configuracao_ativa_versao: null, revisions: 0, audits: 0 });
  } finally {
    for (const tenantId of tenantIds) {
      await owner.query("DELETE FROM logs_auditoria WHERE empresa_id = $1", [tenantId]).catch(() => {});
      await owner.query("UPDATE empresas SET configuracao_ativa_versao = NULL WHERE id = $1", [tenantId]).catch(() => {});
      await owner.query("DELETE FROM empresas WHERE id = $1", [tenantId]).catch(() => {});
    }
    if (actorId) await owner.query("DELETE FROM usuarios WHERE id = $1", [actorId]).catch(() => {});
    owner.release();
    await appPool.end();
    await ownerPool.end();
  }
});
