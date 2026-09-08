import test from "node:test";
import assert from "node:assert/strict";
import { PostgresOnboardingRepository } from "../src/modules/onboarding/postgres-onboarding-repository.js";

const TENANT_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TENANT_ID = "00000000-0000-4000-8000-0000000000a2";
const ACTOR_ID = "00000000-0000-4000-8000-0000000000b1";
const NOW = new Date("2026-09-01T15:00:00.000Z");

function progressHarness() {
  const calls = [];
  let row = null;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("INSERT INTO onboarding_progressos")) {
        if (row) return { rows: [], rowCount: 0 };
        row = {
          empresa_id: params[0], schema_version: 2, etapa_atual: params[1],
          progresso: JSON.parse(params[2]), revision: 1, updated_by: params[3],
          created_at: NOW, updated_at: NOW,
        };
        return { rows: [structuredClone(row)], rowCount: 1 };
      }
      if (sql.includes("UPDATE onboarding_progressos")) {
        if (!row || row.empresa_id !== params[0] || row.revision !== params[1]) return { rows: [], rowCount: 0 };
        row = {
          ...row, etapa_atual: params[2], progresso: JSON.parse(params[3]),
          revision: row.revision + 1, updated_by: params[4], updated_at: NOW,
        };
        return { rows: [structuredClone(row)], rowCount: 1 };
      }
      if (sql.includes("SELECT revision FROM onboarding_progressos")) {
        return { rows: row && row.empresa_id === params[0] ? [{ revision: row.revision }] : [] };
      }
      if (sql.includes("FROM onboarding_progressos")) return { rows: row ? [structuredClone(row)] : [] };
      return { rows: [] };
    },
  };
  const contexts = [];
  const transactionRunner = async (_pool, context, callback) => {
    contexts.push(context);
    return callback({ client, tenantId: context.empresaId });
  };
  const repository = new PostgresOnboardingRepository({ connect() {} }, { transactionRunner });
  return { repository, calls, contexts };
}

test("progresso do onboarding usa revisão otimista e persiste somente metadados de conclusão", async () => {
  const { repository, calls, contexts } = progressHarness();
  const first = await repository.saveProgressAtomic({
    empresaId: TENANT_ID,
    expectedRevision: 0,
    currentStep: 2,
    completedSteps: [{ step: 1, completedAt: "2026-09-01T14:00:00-01:00" }],
    actorId: ACTOR_ID,
    auditId: "00000000-0000-4000-8000-0000000000c1",
    correlationId: "00000000-0000-4000-8000-0000000000c2",
    occurredAt: NOW,
  });
  assert.equal(first.saved, true);
  assert.equal(first.currentRevision, 1);
  assert.deepEqual(first.progress.completedSteps, [{ step: 1, completedAt: "2026-09-01T15:00:00.000Z" }]);

  const conflict = await repository.saveProgressAtomic({
    empresaId: TENANT_ID,
    expectedRevision: 0,
    currentStep: 3,
    completedSteps: [{ step: 1, completedAt: "2026-09-01T15:00:00.000Z" }],
    actorId: ACTOR_ID,
  });
  assert.deepEqual(conflict, { saved: false, progress: null, currentRevision: 1 });

  const updated = await repository.saveProgressAtomic({
    empresaId: TENANT_ID,
    expectedRevision: 1,
    currentStep: 3,
    completedSteps: [
      { step: 2, completedAt: "2026-09-01T15:00:00.000Z" },
      { step: 1, completedAt: "2026-09-01T15:00:00.000Z" },
    ],
    actorId: ACTOR_ID,
  });
  assert.equal(updated.currentRevision, 2);
  assert.deepEqual(updated.progress.completedSteps.map(({ step }) => step), [1, 2]);
  assert.equal(contexts.every(({ empresaId }) => empresaId === TENANT_ID), true);
  assert.equal(calls.filter(({ sql }) => /onboarding_progressos/u.test(sql)).every(({ params }) => params[0] === TENANT_ID), true);
  const progressAudits = calls.filter(({ sql }) => /INSERT INTO logs_auditoria/u.test(sql));
  assert.equal(progressAudits.length, 2);
  assert.equal(progressAudits.every(({ params }) => params[1] === TENANT_ID), true);
  assert.equal(progressAudits.every(({ params }) => JSON.stringify(params).includes("completedAt") === false), true);
  assert.deepEqual(JSON.parse(progressAudits[0].params[3]), {
    fields: ["etapa_atual", "revision", "completed_steps"],
  });

  await assert.rejects(
    repository.saveProgressAtomic({
      empresaId: TENANT_ID,
      expectedRevision: 2,
      currentStep: 11,
      completedSteps: [],
    }),
    /currentStep/u,
  );
  await assert.rejects(
    repository.saveProgressAtomic({
      empresaId: TENANT_ID,
      expectedRevision: 2,
      currentStep: 3,
      completedSteps: [{ step: 1, completedAt: NOW.toISOString(), payload: "não permitido" }],
    }),
    /metadado não permitido/u,
  );
});

test("snapshot de readiness é tenant-scoped e nunca seleciona payloads de credenciais", async () => {
  const calls = [];
  const row = {
    empresa_id: TENANT_ID,
    tenant_status: "rascunho",
    versao_configuracao: 1,
    configuracao_runtime_modo: "versionado",
    configuracao_ativa_versao: null,
    draft_version: 4,
    administrator_count: 1,
    primary_number_id: "00000000-0000-4000-8000-0000000000d1",
    primary_number_status: "ativo",
    primary_phone_number_id: "phone-sintetico",
    primary_waba_id: "waba-sintetico",
    primary_numero_e164: "+5511999999999",
    access_token_configured: true,
    application_valid: true,
    credential_references: ["credential:00000000-0000-4000-8000-0000000000e1"],
    credentials: [{
      reference: "credential:00000000-0000-4000-8000-0000000000e1",
      provider: "openai",
      status: "active",
      configured: true,
    }],
    integrations: [{ reference: "integration:00000000-0000-4000-8000-0000000000f1", type: "google_sheets", status: "saudavel" }],
  };
  const client = { async query(sql, params) { calls.push({ sql, params }); return { rows: [row] }; } };
  const repository = new PostgresOnboardingRepository({ connect() {} }, {
    transactionRunner: async (_pool, context, callback) => callback({ client, tenantId: context.empresaId }),
  });

  const snapshot = await repository.readReadinessSnapshot({ empresaId: TENANT_ID });
  assert.equal(snapshot.tenant.status, "draft");
  assert.equal(snapshot.draftVersion, 4);
  assert.equal(snapshot.nextConfigurationVersion, 2);
  assert.equal(snapshot.administratorCount, 1);
  assert.equal(snapshot.whatsapp.primaryNumber.phoneNumberId, "phone-sintetico");
  assert.equal(snapshot.whatsapp.primaryNumber.numeroE164, "+5511999999999");
  assert.equal(snapshot.whatsapp.accessTokenConfigured, true);
  assert.equal(snapshot.whatsapp.applicationValid, true);
  assert.deepEqual(snapshot.credentialReferences, ["credential:00000000-0000-4000-8000-0000000000e1"]);
  assert.deepEqual(snapshot.credentials, [{
    reference: "credential:00000000-0000-4000-8000-0000000000e1",
    provider: "openai",
    status: "active",
    configured: true,
  }]);
  assert.deepEqual(snapshot.integrations, [{
    id: "integration:00000000-0000-4000-8000-0000000000f1",
    reference: "integration:00000000-0000-4000-8000-0000000000f1",
    type: "google_sheets",
    status: "healthy",
  }]);
  assert.equal(snapshot.environment, "production");
  assert.equal(Object.isFrozen(snapshot.credentialReferences), true);

  const query = calls[0];
  assert.deepEqual(query.params, [TENANT_ID]);
  assert.match(query.sql, /FROM empresas e[^]*WHERE e\.id = \$1/u);
  for (const alias of ["cr", "ue", "nw", "ce", "am", "i"]) {
    assert.match(query.sql, new RegExp(`${alias}\\.empresa_id = e\\.id`, "u"));
  }
  assert.doesNotMatch(query.sql, /secret_ciphertext|secret_nonce|secret_tag|valor_mascarado|configuracao_compilada/iu);
});

test("alvo Meta do preflight é resolvido pelo número principal dentro do tenant", async () => {
  const calls = [];
  const row = {
    number_id: "00000000-0000-4000-8000-0000000000d1",
    application_id: "00000000-0000-4000-8000-0000000000d2",
  };
  const client = { async query(sql, params) { calls.push({ sql, params }); return { rows: [row] }; } };
  const repository = new PostgresOnboardingRepository({ connect() {} }, {
    transactionRunner: async (_pool, context, callback) => callback({ client, tenantId: context.empresaId }),
  });
  assert.deepEqual(await repository.readPreflightTargets({ empresaId: TENANT_ID }), {
    meta: {
      empresaId: TENANT_ID,
      applicationId: row.application_id,
      numberId: row.number_id,
    },
  });
  assert.deepEqual(calls[0].params, [TENANT_ID]);
  assert.match(calls[0].sql, /nw\.empresa_id = \$1/u);
  assert.match(calls[0].sql, /nw\.principal/u);
  assert.doesNotMatch(calls[0].sql, /access_token|secret|credencial/iu);
});

test("publicação e ativação expõem primitivas transacionais, tenant-scoped e auditadas", async () => {
  const calls = [];
  const compiled = {
    empresaId: TENANT_ID,
    schemaVersion: 2,
    compilerVersion: 1,
    configVersion: 2,
    draftVersion: 4,
    checksumAlgorithm: "sha256",
    checksum: "a".repeat(64),
    configuration: {},
  };
  const tenantRow = {
    id: TENANT_ID,
    status: "rascunho",
    versao_configuracao: 2,
    configuracao_runtime_modo: "versionado",
    configuracao_ativa_versao: 2,
    publicada_at: NOW,
  };
  const draftRow = {
    empresa_id: TENANT_ID, draft_version: 4, schema_version: 2, configuracao: {},
    created_by: ACTOR_ID, updated_by: ACTOR_ID, created_at: NOW, updated_at: NOW,
  };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/FROM empresas[^]*FOR UPDATE/u.test(sql)) return { rows: [tenantRow] };
      if (/FROM configuracoes_rascunho[^]*FOR UPDATE/u.test(sql)) return { rows: [draftRow] };
      if (/INSERT INTO configuracoes_revisoes/u.test(sql)) return { rows: [{ empresa_id: TENANT_ID, config_version: 2 }] };
      if (/UPDATE empresas/u.test(sql)) return { rows: [{ ...tenantRow, status: sql.includes("status = 'ativa'") ? "ativa" : tenantRow.status }] };
      return { rows: [] };
    },
  };
  const contexts = [];
  const repository = new PostgresOnboardingRepository({ connect() {} }, {
    transactionRunner: async (_pool, context, callback) => {
      contexts.push(context);
      return callback({ client, tenantId: context.empresaId });
    },
  });

  await repository.withActivationTransaction({ empresaId: TENANT_ID, actorId: ACTOR_ID }, async (transaction) => {
    const locked = await repository.lockActivationState({ empresaId: TENANT_ID, transaction });
    assert.equal(locked.draft.draftVersion, 4);
    await repository.insertPublishedRevision({ empresaId: TENANT_ID, compiled, actorId: ACTOR_ID, publishedAt: NOW, transaction });
    await repository.setActiveRevision({ empresaId: TENANT_ID, configVersion: 2, publishedAt: NOW, transaction });
    const active = await repository.activateTenant({ empresaId: TENANT_ID, configVersion: 2, activatedAt: NOW, transaction });
    assert.equal(active.status, "active");
    await repository.writePublicationAudit({
      auditId: "00000000-0000-4000-8000-0000000000c1",
      empresaId: TENANT_ID, actorId: ACTOR_ID, configVersion: 2,
      correlationId: null, occurredAt: NOW, transaction,
    });
    await repository.writeActivationAudit({
      auditId: "00000000-0000-4000-8000-0000000000c2",
      empresaId: TENANT_ID, actorId: ACTOR_ID, configVersion: 2,
      correlationId: null, occurredAt: NOW, transaction,
    });
  });

  assert.deepEqual(contexts[0], { empresaId: TENANT_ID, usuarioId: ACTOR_ID });
  const relevant = calls.filter(({ sql }) => /empresas|configuracoes_rascunho|configuracoes_revisoes|logs_auditoria/u.test(sql));
  assert.equal(relevant.every(({ params }) => params.includes(TENANT_ID)), true);
  const auditCalls = calls.filter(({ sql }) => /INSERT INTO logs_auditoria/u.test(sql));
  assert.equal(auditCalls.length, 2);
  assert.equal(JSON.stringify(auditCalls).includes(compiled.checksum), false);
  await assert.rejects(
    repository.setActiveRevision({ empresaId: OTHER_TENANT_ID, configVersion: 2, publishedAt: NOW, transaction: { client, tenantId: TENANT_ID } }),
    /outra empresa/u,
  );
  await assert.rejects(
    repository.insertPublishedRevision({
      empresaId: TENANT_ID,
      compiled: { ...compiled, empresaId: OTHER_TENANT_ID },
      actorId: ACTOR_ID,
      publishedAt: NOW,
      transaction: { client, tenantId: TENANT_ID },
    }),
    /outra empresa/u,
  );
});
