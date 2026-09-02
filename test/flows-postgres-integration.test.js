import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  PostgresVersionedConfigurationRepository,
  VersionedConfigurationService,
} from "../src/modules/configuration/index.js";
import { ConversationService, PostgresConversationRepository } from "../src/modules/conversations/index.js";
import { executeFlowAction, PostgresFlowRepository } from "../src/modules/flows/index.js";
import { OnboardingService, PostgresOnboardingRepository } from "../src/modules/onboarding/index.js";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "true";

function flowDefinition(version) {
  return {
    key: "triagem_sintetica",
    name: "Triagem sintética",
    version,
    startStepId: "escolha",
    steps: [
      {
        id: "escolha",
        type: "single_choice",
        message: `Escolha na versão ${version}.`,
        field: "destino",
        required: true,
        options: [{ id: "concluir", label: "Concluir", nextStepId: "fim" }],
      },
      { id: "fim", type: "completion", message: `Concluído na versão ${version}.` },
    ],
  };
}

function configuration(version) {
  return {
    schemaVersion: 2,
    identity: { name: "Empresa Fluxos PostgreSQL" },
    retention: { messagesDays: 1, logsDays: 1 },
    modules: ["flows"],
    menu: {
      text: "Escolha:",
      options: [{
        id: "triagem",
        label: "Triagem",
        action: "flows.start",
        params: { flowRef: "flow:triagem_sintetica" },
      }],
    },
    flows: { definitions: [flowDefinition(version)] },
  };
}

test("PostgreSQL publica, pina, continua e anonimiza fluxo sem cruzar tenants", { skip: !enabled }, async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL é obrigatória");
  assert.ok(process.env.DATABASE_MIGRATOR_URL, "DATABASE_MIGRATOR_URL é obrigatória");
  const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  const owner = await ownerPool.connect();
  const suffix = randomUUID();

  try {
    const actorId = (await owner.query(
      "INSERT INTO usuarios (email, nome, password_hash) VALUES ($1,'Autor de fluxos','hash-sintetico') RETURNING id",
      [`flows-${suffix}@example.invalid`],
    )).rows[0].id;
    const tenantId = (await owner.query(
      "INSERT INTO empresas (slug,nome,nome_exibicao,status) VALUES ($1,'Empresa Fluxos','Empresa Fluxos','rascunho') RETURNING id",
      [`flows-${suffix}`],
    )).rows[0].id;
    const otherTenantId = (await owner.query(
      "INSERT INTO empresas (slug,nome,nome_exibicao,status) VALUES ($1,'Outro Tenant','Outro Tenant','rascunho') RETURNING id",
      [`flows-other-${suffix}`],
    )).rows[0].id;
    const numberId = (await owner.query(
      `INSERT INTO numeros_whatsapp
         (empresa_id,phone_number_id,waba_id,numero_e164,status,principal)
       VALUES ($1,$2,$3,$4,'ativo',true) RETURNING id`,
      [tenantId, `phone-${suffix}`, `waba-${suffix}`, `+5511${String(Date.now()).slice(-8)}`],
    )).rows[0].id;

    const configurationService = new VersionedConfigurationService(
      new PostgresVersionedConfigurationRepository(appPool),
    );
    const flowRepository = new PostgresFlowRepository(appPool);
    const onboardingService = new OnboardingService({
      repository: new PostgresOnboardingRepository(appPool, { environment: "test" }),
      configurationService,
      readinessService: {
        evaluate: () => ({ ready: true, mode: "enforcement", checks: [] }),
      },
      flowPublisher: flowRepository,
    });
    await configurationService.saveDraft({
      empresaId: tenantId,
      actorId,
      expectedDraftVersion: 0,
      configuration: configuration(1),
    });
    const publishedV1 = await onboardingService.publish({
      empresaId: tenantId,
      actorId,
      expectedDraftVersion: 1,
      correlationId: randomUUID(),
    });
    const versionV1 = await flowRepository.findPublishedDefinition({
      empresaId: tenantId,
      flowKey: "triagem_sintetica",
      configurationVersion: publishedV1.configVersion,
    });
    assert.equal(versionV1.flowVersion, 1);

    const conversationService = new ConversationService({
      repository: new PostgresConversationRepository(appPool),
    });
    const opened = await conversationService.openOrResume({
      empresaId: tenantId,
      phone: "5511999990001",
      numeroWhatsappId: numberId,
      correlationId: randomUUID(),
    });
    const started = executeFlowAction({
      action: "flows.start",
      definition: versionV1.definition,
      flowVersionId: versionV1.flowVersionId,
    });
    const submissionV1 = await flowRepository.startSubmission({
      empresaId: tenantId,
      flowKey: "triagem_sintetica",
      configurationVersion: publishedV1.configVersion,
      conversationId: opened.conversation.id,
      contactId: opened.contact.id,
      expectedFlowVersionId: versionV1.flowVersionId,
      initialState: started.state,
      startedAt: new Date("2026-09-01T12:00:00.000Z"),
    });

    await configurationService.saveDraft({
      empresaId: tenantId,
      actorId,
      expectedDraftVersion: 1,
      configuration: configuration(2),
    });
    const publishedV2 = await onboardingService.publish({
      empresaId: tenantId,
      actorId,
      expectedDraftVersion: 2,
      correlationId: randomUUID(),
    });
    assert.ok(publishedV2.configVersion > publishedV1.configVersion);

    const active = await flowRepository.findActiveSubmission({
      empresaId: tenantId,
      conversationId: opened.conversation.id,
    });
    assert.equal(active.version.flowVersion, 1);
    assert.equal(active.submission.flowVersionId, submissionV1.submission.flowVersionId);
    const completed = executeFlowAction({
      action: "flows.continue",
      definition: active.version.definition,
      state: active.submission.data,
      input: { type: "selection", value: "concluir" },
    });
    assert.equal(completed.state.status, "completed");
    await flowRepository.saveSubmission({
      empresaId: tenantId,
      submissionId: active.submission.id,
      flowVersionId: active.submission.flowVersionId,
      expectedRevision: active.submission.revision,
      status: "completed",
      data: completed.state,
      occurredAt: new Date("2026-09-01T12:05:00.000Z"),
    });

    assert.equal(await flowRepository.findVersionById({
      empresaId: otherTenantId,
      flowVersionId: versionV1.flowVersionId,
    }), null);
    const retention = await flowRepository.anonymizeExpired({
      empresaId: tenantId,
      before: new Date("2026-09-03T12:00:00.000Z"),
      limit: 10,
    });
    assert.deepEqual(retention.submissionIds, [active.submission.id]);
    const persisted = (await owner.query(
      `SELECT fs.fluxo_versao_id, fs.config_version, fs.conversa_id, fs.dados_coletados,
              count(a.id)::int AS audits
         FROM fluxo_submissoes fs
         LEFT JOIN logs_auditoria a
           ON a.empresa_id = fs.empresa_id AND a.recurso_id = fs.id::text
        WHERE fs.empresa_id = $1 AND fs.id = $2
        GROUP BY fs.empresa_id, fs.id`,
      [tenantId, active.submission.id],
    )).rows[0];
    assert.equal(persisted.fluxo_versao_id, versionV1.flowVersionId);
    assert.equal(Number(persisted.config_version), publishedV1.configVersion);
    assert.equal(persisted.conversa_id, null);
    assert.deepEqual(persisted.dados_coletados, {});
    assert.ok(persisted.audits >= 2);
  } finally {
    owner.release();
    await appPool.end();
    await ownerPool.end();
  }
});
