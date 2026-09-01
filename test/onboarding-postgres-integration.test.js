import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  CAPABILITY_CATALOG_V2,
  PostgresVersionedConfigurationRepository,
  VersionedConfigurationService,
  actionOwnerV2,
  compileTenantRuntimeConfigV2,
  validateActionParamsV2,
} from "../src/modules/configuration/index.js";
import {
  OnboardingService,
  PostgresOnboardingRepository,
  ReadinessService,
} from "../src/modules/onboarding/index.js";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "true";

function readyConfiguration() {
  return {
    schemaVersion: 2,
    identity: {
      name: "Empresa Onboarding Sintética",
      displayName: "Onboarding Sintético",
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
    },
    retention: { messagesDays: 365, logsDays: 90 },
    modules: ["catalog"],
    menu: {
      text: "Escolha uma opção:",
      options: [{ id: "catalogo", label: "Catálogo", action: "catalog.list", params: {} }],
    },
    integrations: [],
  };
}

function createServices(appPool) {
  const configurationService = new VersionedConfigurationService(
    new PostgresVersionedConfigurationRepository(appPool),
  );
  const repository = new PostgresOnboardingRepository(appPool, {
    environment: "test",
    platformAiCredentialConfigured: false,
  });
  const readinessService = new ReadinessService({
    compiler: compileTenantRuntimeConfigV2,
    capabilityCatalog: CAPABILITY_CATALOG_V2,
    actionOwner: actionOwnerV2,
    validateActionParams: validateActionParamsV2,
    flowRuntimeAvailable: false,
  });
  return {
    configurationService,
    onboardingService: new OnboardingService({ repository, configurationService, readinessService }),
  };
}

test("PostgreSQL bloqueia tenant incompleto e ativa publicação pronta atomicamente", { skip: !enabled }, async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL é obrigatória");
  assert.ok(process.env.DATABASE_MIGRATOR_URL, "DATABASE_MIGRATOR_URL é obrigatória");
  const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  const owner = await ownerPool.connect();
  const suffix = randomUUID();
  let actorId;
  let tenantId;

  try {
    actorId = (await owner.query(
      "INSERT INTO usuarios (email, nome, password_hash) VALUES ($1, 'Administrador sintético', 'hash-sintetico') RETURNING id",
      [`onboarding-${suffix}@example.invalid`],
    )).rows[0].id;
    tenantId = (await owner.query(
      `INSERT INTO empresas (slug, nome, nome_exibicao, status)
       VALUES ($1, 'Empresa Onboarding Sintética', 'Onboarding Sintético', 'rascunho')
       RETURNING id`,
      [`onboarding-${suffix}`],
    )).rows[0].id;
    const { configurationService, onboardingService } = createServices(appPool);
    await configurationService.saveDraft({
      empresaId: tenantId,
      actorId,
      expectedDraftVersion: 0,
      configuration: readyConfiguration(),
    });

    const blockedReadiness = await onboardingService.readiness({ empresaId: tenantId });
    assert.equal(blockedReadiness.ready, false);
    assert.ok(blockedReadiness.checks.some((check) => check.code === "TENANT_ADMIN_AVAILABLE" && check.state === "failed"));
    assert.ok(blockedReadiness.checks.some((check) => check.code === "WHATSAPP_PRIMARY_NUMBER_READY" && check.state === "failed"));
    await assert.rejects(
      onboardingService.activate({ empresaId: tenantId, actorId, expectedDraftVersion: 1 }),
      (error) => error.code === "TENANT_NOT_READY" && error.status === 409,
    );
    let state = (await owner.query(
      `SELECT status, configuracao_ativa_versao,
              (SELECT count(*)::int FROM configuracoes_revisoes r WHERE r.empresa_id = empresas.id) AS revisions
         FROM empresas WHERE id = $1`,
      [tenantId],
    )).rows[0];
    assert.deepEqual(state, { status: "rascunho", configuracao_ativa_versao: null, revisions: 0 });

    await owner.query(
      "INSERT INTO usuarios_empresas (empresa_id, usuario_id, papel, status) VALUES ($1,$2,'administrador','ativo')",
      [tenantId, actorId],
    );
    const numberId = (await owner.query(
      `INSERT INTO numeros_whatsapp
         (empresa_id, phone_number_id, waba_id, numero_e164, numero_mascarado, status, principal)
       VALUES ($1,$2,$3,$4,'••••0001','ativo',true)
       RETURNING id`,
      [tenantId, `phone-${suffix}`, `waba-${suffix}`, `+5511${String(Date.now()).slice(-8)}`],
    )).rows[0].id;
    await owner.query(
      `INSERT INTO credenciais_empresa
         (empresa_id, provedor, finalidade, secret_ciphertext, secret_kdf_salt,
          secret_nonce, secret_tag, key_version, valor_mascarado, created_by)
       VALUES ($1,'meta',$2,decode(repeat('11',32),'hex'),decode(repeat('22',16),'hex'),
               decode(repeat('33',12),'hex'),decode(repeat('44',16),'hex'),'v1','••••meta',$3)`,
      [tenantId, `whatsapp:${numberId}`, actorId],
    );
    await owner.query(
      `INSERT INTO integracoes
         (empresa_id, tipo, nome, habilitada, obrigatoria_para_confirmacao, status)
       VALUES ($1,'meta','Meta sintética',true,false,'saudavel')`,
      [tenantId],
    );

    const ready = await onboardingService.readiness({ empresaId: tenantId });
    assert.equal(ready.ready, true);
    const activated = await onboardingService.activate({
      empresaId: tenantId,
      actorId,
      expectedDraftVersion: 1,
      correlationId: randomUUID(),
    });
    assert.equal(activated.status, "active");
    state = (await owner.query(
      `SELECT status, configuracao_runtime_modo, configuracao_ativa_versao,
              (SELECT count(*)::int FROM configuracoes_revisoes r WHERE r.empresa_id = empresas.id) AS revisions,
              (SELECT count(*)::int FROM logs_auditoria a
                WHERE a.empresa_id = empresas.id AND a.acao IN ('configuration.publish','tenant.activate')) AS release_audits
         FROM empresas WHERE id = $1`,
      [tenantId],
    )).rows[0];
    assert.equal(state.status, "ativa");
    assert.equal(state.configuracao_runtime_modo, "versionado");
    assert.equal(Number(state.configuracao_ativa_versao), activated.configVersion);
    assert.equal(state.revisions, 1);
    assert.equal(state.release_audits, 2);

    const progress = await onboardingService.saveProgressStep({
      empresaId: tenantId,
      actorId,
      expectedRevision: 0,
      currentStep: 10,
      completedSteps: [{ step: 9, completedAt: "2026-09-01T12:00:00.000Z" }],
      correlationId: randomUUID(),
    });
    assert.equal(progress.revision, 1);
    const progressAudit = (await owner.query(
      "SELECT campos_alterados_redigidos FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'onboarding.step.update'",
      [tenantId],
    )).rows[0];
    assert.deepEqual(progressAudit.campos_alterados_redigidos.fields, ["etapa_atual", "revision", "completed_steps"]);

    await configurationService.saveDraft({
      empresaId: tenantId,
      actorId,
      expectedDraftVersion: 1,
      configuration: { schemaVersion: 2, identity: {} },
    });
    await assert.rejects(
      onboardingService.publish({ empresaId: tenantId, actorId, expectedDraftVersion: 2 }),
      (error) => error.code === "TENANT_NOT_READY",
    );
    const unchanged = (await owner.query(
      `SELECT status, configuracao_ativa_versao,
              (SELECT count(*)::int FROM configuracoes_revisoes r WHERE r.empresa_id = empresas.id) AS revisions
         FROM empresas WHERE id = $1`,
      [tenantId],
    )).rows[0];
    assert.equal(unchanged.status, "ativa");
    assert.equal(Number(unchanged.configuracao_ativa_versao), activated.configVersion);
    assert.equal(unchanged.revisions, 1);
  } finally {
    owner.release();
    await appPool.end();
    await ownerPool.end();
  }
});
