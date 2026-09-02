import assert from "node:assert/strict";
import test from "node:test";
import { PostgresFlowRepository } from "../src/modules/flows/postgres-flow-repository.js";

const EMPRESA_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "10000000-0000-4000-8000-000000000002";
const FLOW_ID = "10000000-0000-4000-8000-000000000003";
const VERSION_ID = "10000000-0000-4000-8000-000000000004";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000005";
const CONTACT_ID = "10000000-0000-4000-8000-000000000006";
const SUBMISSION_ID = "10000000-0000-4000-8000-000000000007";

function definition() {
  return {
    key: "cadastro",
    name: "Cadastro",
    version: 1,
    startStepId: "inicio",
    steps: [
      { id: "inicio", type: "message", message: "Vamos começar", nextStepId: "fim" },
      { id: "fim", type: "completion", message: "Concluído" },
    ],
  };
}

function fixture(handler) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return handler(sql, params, calls);
    },
  };
  const transactionRunner = async (_pool, context, callback) => callback({
    client,
    tenantId: context.empresaId,
    userId: context.usuarioId || null,
    isPlatformAdmin: false,
  });
  const repository = new PostgresFlowRepository({ connect() {} }, {
    transactionRunner,
    idGenerator: (() => {
      const ids = [FLOW_ID, VERSION_ID, SUBMISSION_ID];
      return () => ids.shift() || "10000000-0000-4000-8000-000000000099";
    })(),
  });
  return { repository, calls };
}

test("publica definitions na mesma configVersion e devolve flowVersionId opaco", async () => {
  const { repository, calls } = fixture(async (sql) => {
    if (sql.includes("INSERT INTO fluxos")) {
      return { rows: [{ id: FLOW_ID, empresa_id: EMPRESA_ID, flow_key: "cadastro", nome: "Cadastro", revision: 1 }] };
    }
    if (sql.includes("FROM fluxo_versoes fv") && sql.includes("fv.versao = $3")) return { rows: [] };
    if (sql.includes("INSERT INTO fluxo_versoes")) {
      return { rows: [{
        fluxo_versao_id: VERSION_ID,
        fluxo_id: FLOW_ID,
        flow_key: "cadastro",
        versao: 1,
        schema_version: 1,
        checksum: "a".repeat(64),
        definicao: definition(),
        publicada_por: ACTOR_ID,
        publicada_at: new Date("2026-09-01T15:00:00.000Z"),
      }] };
    }
    return { rows: [] };
  });

  const published = await repository.publishDefinitions({
    empresaId: EMPRESA_ID,
    configVersion: 5,
    definitions: [definition()],
    actorId: ACTOR_ID,
    publishedAt: new Date("2026-09-01T15:00:00.000Z"),
  });

  assert.equal(published[0].flowVersionId, VERSION_ID);
  assert.equal(published[0].configurationVersion, 5);
  const bridge = calls.find(({ sql }) => sql.includes("INSERT INTO configuracoes_fluxos_publicados"));
  assert.deepEqual(bridge.params.slice(0, 4), [EMPRESA_ID, 5, FLOW_ID, VERSION_ID]);
  const audit = calls.find(({ sql }) => sql.includes("INSERT INTO logs_auditoria"));
  assert.deepEqual(audit.params.slice(1, 6), [
    EMPRESA_ID, ACTOR_ID, "flow.definition.publish", "flow_version", VERSION_ID,
  ]);
});

test("início resolve flowKey na configuração publicada e persiste a pinagem completa", async () => {
  const startedAt = new Date("2026-09-01T16:00:00.000Z");
  const { repository, calls } = fixture(async (sql, params) => {
    if (sql.includes("FROM fluxos f") && sql.includes("configuracoes_fluxos_publicados")) {
      assert.deepEqual(params, [EMPRESA_ID, "cadastro", 5]);
      return { rows: [{
        fluxo_versao_id: VERSION_ID,
        fluxo_id: FLOW_ID,
        flow_key: "cadastro",
        versao: 1,
        config_version: 5,
        schema_version: 1,
        checksum: "b".repeat(64),
        definicao: definition(),
        publicada_por: ACTOR_ID,
        publicada_at: startedAt,
      }] };
    }
    if (sql.includes("INSERT INTO fluxo_submissoes")) {
      return { rows: [{
        id: SUBMISSION_ID,
        empresa_id: EMPRESA_ID,
        fluxo_id: FLOW_ID,
        fluxo_versao_id: VERSION_ID,
        versao_fluxo: 1,
        config_version: 5,
        conversa_id: CONVERSATION_ID,
        contato_id: CONTACT_ID,
        status: params[8],
        passo_atual_key: params[9],
        dados_coletados: JSON.parse(params[10]),
        revision: 1,
        iniciada_at: startedAt,
        expires_at: new Date("2027-09-01T16:00:00.000Z"),
        finalizada_at: params[12],
        anonymized_at: null,
        created_at: startedAt,
        updated_at: startedAt,
      }] };
    }
    return { rows: [] };
  });

  const result = await repository.startSubmission({
    empresaId: EMPRESA_ID,
    flowKey: "cadastro",
    configurationVersion: 5,
    conversationId: CONVERSATION_ID,
    contactId: CONTACT_ID,
    expectedFlowVersionId: VERSION_ID,
    initialState: {
      schemaVersion: 1,
      flowKey: "cadastro",
      flowVersion: 1,
      flowVersionId: VERSION_ID,
      status: "waiting_input",
      currentStepId: "inicio",
      answers: {},
    },
    startedAt,
  });

  assert.equal(result.submission.flowVersionId, VERSION_ID);
  assert.equal(result.submission.configurationVersion, 5);
  assert.equal(result.submission.status, "waiting");
  assert.equal(result.submission.data.flowVersionId, VERSION_ID);
  assert.equal(result.version.definition.startStepId, "inicio");
  const insertion = calls.find(({ sql }) => sql.includes("INSERT INTO fluxo_submissoes"));
  assert.deepEqual(insertion.params.slice(1, 11), [
    EMPRESA_ID, FLOW_ID, VERSION_ID, 1, 5, CONVERSATION_ID, CONTACT_ID,
    "aguardando", "inicio", JSON.stringify({
      schemaVersion: 1,
      flowKey: "cadastro",
      flowVersion: 1,
      flowVersionId: VERSION_ID,
      status: "waiting_input",
      currentStepId: "inicio",
      answers: {},
    }),
  ]);
});

test("início falha fechado se a revisão resolvida divergir da revisão executada", async () => {
  const { repository, calls } = fixture(async (sql) => {
    if (sql.includes("FROM fluxos f") && sql.includes("configuracoes_fluxos_publicados")) {
      return { rows: [{
        fluxo_versao_id: VERSION_ID,
        fluxo_id: FLOW_ID,
        flow_key: "cadastro",
        versao: 1,
        config_version: 5,
        schema_version: 1,
        checksum: "b".repeat(64),
        definicao: definition(),
        publicada_por: ACTOR_ID,
        publicada_at: new Date(),
      }] };
    }
    return { rows: [] };
  });

  await assert.rejects(
    repository.startSubmission({
      empresaId: EMPRESA_ID,
      flowKey: "cadastro",
      configurationVersion: 5,
      conversationId: CONVERSATION_ID,
      contactId: CONTACT_ID,
      expectedFlowVersionId: "10000000-0000-4000-8000-000000000098",
      initialState: {
        flowKey: "cadastro",
        flowVersion: 1,
        flowVersionId: "10000000-0000-4000-8000-000000000098",
        status: "waiting_input",
      },
    }),
    (error) => error.code === "FLOW_VERSION_PIN_MISMATCH",
  );
  assert.equal(calls.some(({ sql }) => sql.includes("INSERT INTO fluxo_submissoes")), false);
});

test("saveSubmission exige flowVersionId pinado e nunca reabre estado terminal", async () => {
  const { repository } = fixture(async (sql) => {
    if (sql.includes("UPDATE fluxo_submissoes")) return { rows: [] };
    if (sql.includes("SELECT revision, status, fluxo_versao_id")) {
      return { rows: [{ revision: 4, status: "concluida", fluxo_versao_id: VERSION_ID }] };
    }
    return { rows: [] };
  });

  await assert.rejects(
    repository.saveSubmission({
      empresaId: EMPRESA_ID,
      submissionId: SUBMISSION_ID,
      flowVersionId: VERSION_ID,
      expectedRevision: 4,
      status: "active",
      currentStepId: "inicio",
      data: {},
    }),
    (error) => error.code === "FLOW_SUBMISSION_TERMINAL",
  );
});

test("retenção anonimiza em lote e devolve somente chaves a apagar no media store", async () => {
  const { repository, calls } = fixture(async (sql) => {
    if (sql.includes("WITH candidates AS MATERIALIZED")) {
      return { rows: [{
        submission_ids: [SUBMISSION_ID],
        storage_keys: ["tenant/flow/document.pdf"],
        document_count: 1,
      }] };
    }
    return { rows: [] };
  });

  const result = await repository.anonymizeExpired({
    empresaId: EMPRESA_ID,
    before: new Date("2027-09-02T00:00:00.000Z"),
    limit: 50,
  });

  assert.deepEqual(result, {
    submissionIds: [SUBMISSION_ID],
    storageKeys: ["tenant/flow/document.pdf"],
    documentCount: 1,
  });
  const retention = calls.find(({ sql }) => sql.includes("WITH candidates AS MATERIALIZED"));
  assert.match(retention.sql, /FOR UPDATE SKIP LOCKED/u);
  assert.match(retention.sql, /dados_coletados = '\{\}'::jsonb/u);
  assert.match(retention.sql, /storage_key = NULL/u);
});
