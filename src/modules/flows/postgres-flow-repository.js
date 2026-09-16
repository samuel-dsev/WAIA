import { randomUUID } from "node:crypto";
import { configurationChecksum } from "../configuration/stable-json.js";
import { withTenantTransaction } from "../../infra/postgres/transaction.js";

const STATUS_FROM_DB = Object.freeze({
  em_andamento: "active",
  aguardando: "waiting",
  concluida: "completed",
  cancelada: "cancelled",
  handoff: "handed_off",
  falha: "failed",
});
const STATUS_TO_DB = Object.freeze(Object.fromEntries(
  Object.entries(STATUS_FROM_DB).map(([database, domain]) => [domain, database]),
));
const LIVE_STATUSES = new Set(["active", "waiting"]);
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "handed_off", "failed"]);
const EXECUTION_STATUS_TO_DOMAIN = Object.freeze({
  waiting_input: "waiting",
  completed: "completed",
  handoff: "handed_off",
  cancelled: "cancelled",
});

function flowError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveInteger(value, field, { allowZero = false, max = Number.MAX_SAFE_INTEGER } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > max) {
    throw new TypeError(`${field} deve ser um inteiro entre ${minimum} e ${max}.`);
  }
  return value;
}

function plainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${field} deve ser um objeto simples.`);
  }
  return value;
}

function assertTransaction(transaction, empresaId) {
  if (!transaction?.client?.query) throw new TypeError("Transação PostgreSQL é obrigatória.");
  if (transaction.tenantId && transaction.tenantId !== empresaId) {
    throw new TypeError("A transação pertence a outra empresa.");
  }
  return transaction;
}

function mapVersion(row) {
  if (!row) return null;
  return Object.freeze({
    flowId: row.fluxo_id,
    flowKey: row.flow_key,
    flowVersionId: row.fluxo_versao_id || row.id,
    flowVersion: Number(row.versao),
    configurationVersion: row.config_version == null ? null : Number(row.config_version),
    schemaVersion: Number(row.schema_version),
    checksum: row.checksum,
    definition: structuredClone(row.definicao),
    publishedBy: row.publicada_por,
    publishedAt: row.publicada_at,
  });
}

function mapSubmission(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    empresaId: row.empresa_id,
    flowId: row.fluxo_id,
    flowVersionId: row.fluxo_versao_id,
    flowVersion: Number(row.versao_fluxo),
    configurationVersion: Number(row.config_version),
    conversationId: row.conversa_id,
    contactId: row.contato_id,
    status: STATUS_FROM_DB[row.status] || row.status,
    currentStepId: row.passo_atual_key,
    data: structuredClone(row.dados_coletados || {}),
    revision: Number(row.revision),
    startedAt: row.iniciada_at,
    finishedAt: row.finalizada_at,
    expiresAt: row.expires_at,
    anonymizedAt: row.anonymized_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapDocument(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    empresaId: row.empresa_id,
    submissionId: row.submissao_id,
    messageId: row.mensagem_id,
    field: row.campo_key,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    status: row.status === "armazenado" ? "stored" : "anonymized",
    expiresAt: row.expires_at,
    anonymizedAt: row.anonymized_at,
    createdAt: row.created_at,
  });
}

async function writeAudit(client, {
  auditId = randomUUID(), empresaId, actorId = null, action, resource,
  resourceId, changedFields, correlationId = null, occurredAt = new Date(),
}) {
  await client.query(
    `INSERT INTO logs_auditoria
       (id, empresa_id, ator_usuario_id, acao, recurso_tipo, recurso_id,
        resultado, campos_alterados_redigidos, correlation_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,'sucesso',$7::jsonb,$8,$9)`,
    [
      auditId,
      empresaId,
      actorId,
      action,
      resource,
      String(resourceId),
      JSON.stringify({ fields: changedFields }),
      correlationId,
      occurredAt,
    ],
  );
}

function normalizeDefinitions(definitions) {
  if (!Array.isArray(definitions) || definitions.length > 100) {
    throw new TypeError("definitions deve ser uma lista de no máximo 100 fluxos.");
  }
  const keys = new Set();
  return definitions.map((input, index) => {
    const definition = plainObject(input, `definitions[${index}]`);
    if (typeof definition.key !== "string" || !/^[a-z][a-z0-9._-]{0,79}$/u.test(definition.key)) {
      throw new TypeError(`definitions[${index}].key é inválida.`);
    }
    if (keys.has(definition.key)) throw new TypeError(`O fluxo ${definition.key} está duplicado.`);
    keys.add(definition.key);
    if (typeof definition.name !== "string" || !definition.name.trim() || definition.name.length > 160) {
      throw new TypeError(`definitions[${index}].name é inválido.`);
    }
    positiveInteger(definition.version, `definitions[${index}].version`, { max: 1_000_000 });
    return Object.freeze({
      key: definition.key,
      name: definition.name.trim(),
      version: definition.version,
      definition: structuredClone(definition),
      checksum: configurationChecksum(definition),
    });
  });
}

export class PostgresFlowRepository {
  constructor(pool, { transactionRunner = withTenantTransaction, idGenerator = randomUUID } = {}) {
    if (!pool?.connect) throw new TypeError("pool PostgreSQL é obrigatório.");
    if (typeof transactionRunner !== "function") throw new TypeError("transactionRunner deve ser uma função.");
    if (typeof idGenerator !== "function") throw new TypeError("idGenerator deve ser uma função.");
    this.pool = pool;
    this.transactionRunner = transactionRunner;
    this.idGenerator = idGenerator;
  }

  async publishDefinitions({
    empresaId,
    configVersion,
    definitions,
    actorId,
    publishedAt = new Date(),
    correlationId = null,
    transaction = null,
  }) {
    const normalized = normalizeDefinitions(definitions);
    const configurationVersion = positiveInteger(configVersion, "configVersion");
    const publish = async (tx) => {
      const { client } = assertTransaction(tx, empresaId);
      const published = [];
      for (const item of normalized) {
        const flow = (await client.query(
          `INSERT INTO fluxos
             (id, empresa_id, flow_key, nome, status, revision, created_by, updated_by)
           VALUES ($1,$2,$3,$4,'rascunho',1,$5,$5)
           ON CONFLICT (empresa_id, flow_key) DO UPDATE
             SET nome = EXCLUDED.nome,
                 revision = fluxos.revision + 1,
                 updated_by = EXCLUDED.updated_by,
                 deleted_at = NULL
           RETURNING id, empresa_id, flow_key, nome, revision`,
          [this.idGenerator(), empresaId, item.key, item.name, actorId],
        )).rows[0];
        const existing = (await client.query(
          `SELECT fv.id AS fluxo_versao_id, fv.fluxo_id, f.flow_key, fv.versao,
                  fv.schema_version, fv.checksum, fv.definicao,
                  fv.publicada_por, fv.publicada_at
             FROM fluxo_versoes fv
             JOIN fluxos f ON f.empresa_id = fv.empresa_id AND f.id = fv.fluxo_id
            WHERE fv.empresa_id = $1 AND fv.fluxo_id = $2 AND fv.versao = $3`,
          [empresaId, flow.id, item.version],
        )).rows[0];
        if (existing && existing.checksum !== item.checksum) {
          throw flowError("FLOW_VERSION_IMMUTABLE", `A versão ${item.version} de ${item.key} já foi publicada.`);
        }
        const version = existing || (await client.query(
          `INSERT INTO fluxo_versoes
             (id, empresa_id, fluxo_id, versao, schema_version, checksum,
              definicao, publicada_por, publicada_at)
           VALUES ($1,$2,$3,$4,1,$5,$6::jsonb,$7,$8)
           RETURNING id AS fluxo_versao_id, fluxo_id, $9::text AS flow_key, versao,
                     schema_version, checksum, definicao, publicada_por, publicada_at`,
          [
            this.idGenerator(), empresaId, flow.id, item.version, item.checksum,
            JSON.stringify(item.definition), actorId, publishedAt, item.key,
          ],
        )).rows[0];
        await client.query(
          `INSERT INTO configuracoes_fluxos_publicados
             (empresa_id, config_version, fluxo_id, fluxo_versao_id, vinculada_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [empresaId, configurationVersion, flow.id, version.fluxo_versao_id, publishedAt],
        );
        await client.query(
          `UPDATE fluxos
              SET status = 'ativo', ativa_versao_id = $3, updated_by = $4, updated_at = $5
            WHERE empresa_id = $1 AND id = $2`,
          [empresaId, flow.id, version.fluxo_versao_id, actorId, publishedAt],
        );
        await writeAudit(client, {
          empresaId,
          actorId,
          action: "flow.definition.publish",
          resource: "flow_version",
          resourceId: version.fluxo_versao_id,
          changedFields: ["flow_key", "version", "config_version", "checksum"],
          correlationId,
          occurredAt: publishedAt,
        });
        published.push(mapVersion({ ...version, config_version: configurationVersion }));
      }
      return Object.freeze(published);
    };
    if (transaction) return publish(transaction);
    return this.transactionRunner(this.pool, { empresaId, usuarioId: actorId }, publish);
  }

  findPublishedDefinition({ empresaId, flowKey, configurationVersion = null, transaction = null }) {
    const find = async ({ client }) => mapVersion((await client.query(
      `SELECT fv.id AS fluxo_versao_id, fv.fluxo_id, f.flow_key, fv.versao,
              cfp.config_version, fv.schema_version, fv.checksum, fv.definicao,
              fv.publicada_por, fv.publicada_at
         FROM fluxos f
         JOIN configuracoes_fluxos_publicados cfp
           ON cfp.empresa_id = f.empresa_id AND cfp.fluxo_id = f.id
         JOIN fluxo_versoes fv
           ON fv.empresa_id = cfp.empresa_id AND fv.id = cfp.fluxo_versao_id
        WHERE f.empresa_id = $1 AND f.flow_key = $2 AND f.status = 'ativo'
          AND f.deleted_at IS NULL
          AND ($3::bigint IS NULL OR cfp.config_version = $3)
        ORDER BY cfp.config_version DESC
        LIMIT 1`,
      [empresaId, flowKey, configurationVersion],
    )).rows[0]);
    if (transaction) return find(assertTransaction(transaction, empresaId));
    return this.transactionRunner(this.pool, { empresaId }, find);
  }

  findVersionById({ empresaId, flowVersionId, transaction = null }) {
    const find = async ({ client }) => mapVersion((await client.query(
      `SELECT fv.id AS fluxo_versao_id, fv.fluxo_id, f.flow_key, fv.versao,
              NULL::bigint AS config_version, fv.schema_version, fv.checksum,
              fv.definicao, fv.publicada_por, fv.publicada_at
         FROM fluxo_versoes fv
         JOIN fluxos f ON f.empresa_id = fv.empresa_id AND f.id = fv.fluxo_id
        WHERE fv.empresa_id = $1 AND fv.id = $2`,
      [empresaId, flowVersionId],
    )).rows[0]);
    if (transaction) return find(assertTransaction(transaction, empresaId));
    return this.transactionRunner(this.pool, { empresaId }, find);
  }

  async startSubmission({
    empresaId,
    flowKey,
    configurationVersion,
    conversationId,
    contactId,
    expectedFlowVersionId = null,
    initialState = null,
    submissionId = this.idGenerator(),
    actorId = null,
    correlationId = null,
    startedAt = new Date(),
  }) {
    const configVersion = positiveInteger(configurationVersion, "configurationVersion");
    return this.transactionRunner(this.pool, { empresaId, usuarioId: actorId }, async ({ client, ...context }) => {
      const transaction = { client, ...context };
      const version = await this.findPublishedDefinition({
        empresaId,
        flowKey,
        configurationVersion: configVersion,
        transaction,
      });
      if (!version) throw flowError("FLOW_DEFINITION_NOT_FOUND", "Fluxo publicado não encontrado.");
      if (expectedFlowVersionId != null && expectedFlowVersionId !== version.flowVersionId) {
        throw flowError("FLOW_VERSION_PIN_MISMATCH", "A revisão resolvida do fluxo foi alterada.");
      }
      let submissionStatus = "active";
      let currentStepId = version.definition.startStepId;
      let collectedData = {};
      if (initialState != null) {
        const state = plainObject(initialState, "initialState");
        if (state.flowVersionId !== version.flowVersionId
          || state.flowKey !== version.flowKey
          || Number(state.flowVersion) !== version.flowVersion) {
          throw flowError("FLOW_VERSION_PIN_MISMATCH", "O estado inicial pertence a outra revisão do fluxo.");
        }
        submissionStatus = EXECUTION_STATUS_TO_DOMAIN[state.status];
        if (!submissionStatus) throw new TypeError("initialState.status é inválido.");
        currentStepId = TERMINAL_STATUSES.has(submissionStatus) ? null : state.currentStepId;
        collectedData = structuredClone(state);
      }
      const databaseStatus = STATUS_TO_DB[submissionStatus];
      const finalizedAt = TERMINAL_STATUSES.has(submissionStatus) ? startedAt : null;
      const result = await client.query(
        `INSERT INTO fluxo_submissoes
           (id, empresa_id, fluxo_id, fluxo_versao_id, versao_fluxo, config_version,
            conversa_id, contato_id, status, passo_atual_key, dados_coletados,
            revision, iniciada_at, finalizada_at, expires_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,
                $10,$11::jsonb,1,$12::timestamptz,$13::timestamptz,
                $12::timestamptz + make_interval(days =>
                  (cr.configuracao_compilada #>> '{configuration,retention,messagesDays}')::integer
                )
           FROM empresas e
           JOIN configuracoes_revisoes cr
             ON cr.empresa_id = e.id AND cr.config_version = $6
          WHERE e.id = $2
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          submissionId, empresaId, version.flowId, version.flowVersionId,
          version.flowVersion, configVersion, conversationId, contactId,
          databaseStatus, currentStepId, JSON.stringify(collectedData), startedAt, finalizedAt,
        ],
      );
      const submission = mapSubmission(result.rows[0]);
      if (!submission) throw flowError("FLOW_SUBMISSION_ALREADY_ACTIVE", "A conversa já possui um fluxo em andamento.");
      await writeAudit(client, {
        empresaId,
        actorId,
        action: "flow.submission.start",
        resource: "flow_submission",
        resourceId: submission.id,
        changedFields: ["flow_version_id", "config_version", "status", "current_step_id", "data"],
        correlationId,
        occurredAt: startedAt,
      });
      return Object.freeze({ submission, version });
    });
  }

  findActiveSubmission({ empresaId, conversationId }) {
    return this.transactionRunner(this.pool, { empresaId }, async ({ client }) => {
      const row = (await client.query(
        `SELECT fs.*
           FROM fluxo_submissoes fs
          WHERE fs.empresa_id = $1 AND fs.conversa_id = $2
            AND fs.status IN ('em_andamento', 'aguardando')
            AND fs.anonymized_at IS NULL
          LIMIT 1`,
        [empresaId, conversationId],
      )).rows[0];
      const submission = mapSubmission(row);
      if (!submission) return null;
      const version = await this.findVersionById({
        empresaId,
        flowVersionId: submission.flowVersionId,
        transaction: { client, tenantId: empresaId },
      });
      return Object.freeze({ submission, version });
    });
  }

  async saveSubmission({
    empresaId,
    submissionId,
    flowVersionId,
    expectedRevision,
    status,
    currentStepId = null,
    data,
    actorId = null,
    correlationId = null,
    occurredAt = new Date(),
  }) {
    const revision = positiveInteger(expectedRevision, "expectedRevision");
    if (!LIVE_STATUSES.has(status) && !TERMINAL_STATUSES.has(status)) {
      throw new TypeError("status de submissão inválido.");
    }
    const normalizedData = structuredClone(plainObject(data, "data"));
    return this.transactionRunner(this.pool, { empresaId, usuarioId: actorId }, async ({ client }) => {
      const databaseStatus = STATUS_TO_DB[status];
      const result = await client.query(
        `UPDATE fluxo_submissoes
            SET status = $5,
                passo_atual_key = $6,
                dados_coletados = $7::jsonb,
                revision = revision + 1,
                finalizada_at = CASE
                  WHEN $5 IN ('concluida','cancelada','handoff','falha') THEN $8::timestamptz
                  ELSE NULL
                END,
                updated_at = $8::timestamptz
          WHERE empresa_id = $1 AND id = $2 AND fluxo_versao_id = $3
            AND revision = $4
            AND status IN ('em_andamento', 'aguardando')
            AND anonymized_at IS NULL
        RETURNING *`,
        [
          empresaId, submissionId, flowVersionId, revision, databaseStatus,
          TERMINAL_STATUSES.has(status) ? null : currentStepId,
          JSON.stringify(normalizedData), occurredAt,
        ],
      );
      const submission = mapSubmission(result.rows[0]);
      if (!submission) {
        const current = (await client.query(
          `SELECT revision, status, fluxo_versao_id
             FROM fluxo_submissoes WHERE empresa_id = $1 AND id = $2`,
          [empresaId, submissionId],
        )).rows[0];
        if (!current) throw flowError("FLOW_SUBMISSION_NOT_FOUND", "Submissão não encontrada.");
        if (current.fluxo_versao_id !== flowVersionId) {
          throw flowError("FLOW_VERSION_PIN_MISMATCH", "A submissão pertence a outra versão do fluxo.");
        }
        if (!["em_andamento", "aguardando"].includes(current.status)) {
          throw flowError("FLOW_SUBMISSION_TERMINAL", "Uma submissão finalizada não pode ser reaberta.");
        }
        throw flowError("FLOW_SUBMISSION_CONFLICT", `A revisão atual da submissão é ${Number(current.revision)}.`);
      }
      await writeAudit(client, {
        empresaId,
        actorId,
        action: `flow.submission.${status}`,
        resource: "flow_submission",
        resourceId: submission.id,
        changedFields: ["status", "current_step_id", "data", "revision"],
        correlationId,
        occurredAt,
      });
      return submission;
    });
  }

  completeSubmission(input) {
    return this.saveSubmission({ ...input, status: "completed" });
  }

  cancelSubmission(input) {
    return this.saveSubmission({ ...input, status: "cancelled" });
  }

  async attachDocument({
    empresaId,
    submissionId,
    documentId = this.idGenerator(),
    messageId = null,
    field,
    storageKey,
    mimeType,
    sizeBytes,
    sha256,
    actorId = null,
    correlationId = null,
    occurredAt = new Date(),
  }) {
    return this.transactionRunner(this.pool, { empresaId, usuarioId: actorId }, async ({ client }) => {
      const result = await client.query(
        `INSERT INTO fluxo_documentos
           (id, empresa_id, submissao_id, mensagem_id, campo_key, storage_key,
            mime_type, size_bytes, sha256, status, expires_at, created_at)
         SELECT $1,$2,fs.id,$3,$4,$5,$6,$7,$8,'armazenado',fs.expires_at,$9
           FROM fluxo_submissoes fs
          WHERE fs.empresa_id = $2 AND fs.id = $10
            AND fs.status IN ('em_andamento', 'aguardando')
            AND fs.anonymized_at IS NULL
         RETURNING *`,
        [
          documentId, empresaId, messageId, field, storageKey, mimeType,
          sizeBytes, sha256, occurredAt, submissionId,
        ],
      );
      const document = mapDocument(result.rows[0]);
      if (!document) throw flowError("FLOW_SUBMISSION_NOT_ACTIVE", "A submissão não aceita novos documentos.");
      await writeAudit(client, {
        empresaId,
        actorId,
        action: "flow.document.attach",
        resource: "flow_document",
        resourceId: document.id,
        changedFields: ["submission_id", "field", "mime_type", "size_bytes", "sha256"],
        correlationId,
        occurredAt,
      });
      return document;
    });
  }

  async anonymizeExpired({
    empresaId,
    before = new Date(),
    limit = 100,
    actorId = null,
    correlationId = null,
    auditId = this.idGenerator(),
  }) {
    const batchLimit = positiveInteger(limit, "limit", { max: 1_000 });
    return this.transactionRunner(this.pool, { empresaId, usuarioId: actorId }, async ({ client }) => {
      const result = (await client.query(
        `WITH candidates AS MATERIALIZED (
           SELECT fs.empresa_id, fs.id
             FROM fluxo_submissoes fs
            WHERE fs.empresa_id = $1 AND fs.expires_at <= $2
              AND fs.anonymized_at IS NULL
              AND fs.status IN ('concluida','cancelada','handoff','falha')
            ORDER BY fs.expires_at, fs.id
            FOR UPDATE SKIP LOCKED
            LIMIT $3
         ), document_candidates AS MATERIALIZED (
           SELECT fd.empresa_id, fd.id, fd.submissao_id, fd.storage_key
             FROM fluxo_documentos fd
             JOIN candidates c ON c.empresa_id = fd.empresa_id AND c.id = fd.submissao_id
            WHERE fd.status = 'armazenado'
         ), anonymized_documents AS (
           UPDATE fluxo_documentos fd
              SET mensagem_id = NULL, storage_key = NULL, mime_type = NULL,
                  size_bytes = NULL, sha256 = NULL, status = 'anonimizado',
                  anonymized_at = $2
             FROM document_candidates dc
            WHERE fd.empresa_id = dc.empresa_id AND fd.id = dc.id
           RETURNING fd.id
         ), anonymized_submissions AS (
           UPDATE fluxo_submissoes fs
              SET conversa_id = NULL, contato_id = NULL, passo_atual_key = NULL,
                  dados_coletados = '{}'::jsonb, anonymized_at = $2,
                  revision = revision + 1, updated_at = $2
             FROM candidates c
            WHERE fs.empresa_id = c.empresa_id AND fs.id = c.id
           RETURNING fs.id
         )
         SELECT
           COALESCE((SELECT array_agg(id ORDER BY id) FROM anonymized_submissions), ARRAY[]::uuid[]) AS submission_ids,
           COALESCE((SELECT array_agg(storage_key ORDER BY id) FROM document_candidates), ARRAY[]::text[]) AS storage_keys,
           (SELECT count(*)::int FROM anonymized_documents) AS document_count`,
        [empresaId, before, batchLimit],
      )).rows[0];
      const submissionIds = result?.submission_ids || [];
      const storageKeys = result?.storage_keys || [];
      if (submissionIds.length > 0) {
        await writeAudit(client, {
          auditId,
          empresaId,
          actorId,
          action: "flow.submission.anonymize",
          resource: "flow_retention_batch",
          resourceId: auditId,
          changedFields: ["conversation_id", "contact_id", "current_step_id", "data", "documents"],
          correlationId,
          occurredAt: before,
        });
      }
      return Object.freeze({
        submissionIds: Object.freeze([...submissionIds]),
        storageKeys: Object.freeze([...storageKeys]),
        documentCount: Number(result?.document_count || 0),
      });
    });
  }
}
