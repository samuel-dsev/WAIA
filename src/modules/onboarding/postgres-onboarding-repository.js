import { withTenantTransaction } from "../../infra/postgres/transaction.js";

const STATUS_FROM_DB = Object.freeze({
  rascunho: "draft",
  ativa: "active",
  suspensa: "suspended",
  arquivada: "archived",
});

function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${field} deve ser um inteiro entre ${min} e ${max}.`);
  }
  return value;
}

function completionMetadata(value) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 10) {
    throw new TypeError("completedSteps deve ser uma lista de no máximo 10 etapas.");
  }
  const seen = new Set();
  const normalized = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.getPrototypeOf(entry) !== Object.prototype) {
      throw new TypeError(`completedSteps[${index}] deve ser um objeto.`);
    }
    const keys = Object.keys(entry);
    if (keys.some((key) => !["step", "completedAt"].includes(key))) {
      throw new TypeError(`completedSteps[${index}] contém metadado não permitido.`);
    }
    const step = integer(entry.step, `completedSteps[${index}].step`, { min: 1, max: 10 });
    if (seen.has(step)) throw new TypeError(`A etapa ${step} está duplicada.`);
    seen.add(step);
    if (typeof entry.completedAt !== "string") {
      throw new TypeError(`completedSteps[${index}].completedAt deve ser uma data ISO.`);
    }
    const completedAt = new Date(entry.completedAt);
    if (Number.isNaN(completedAt.getTime())) {
      throw new TypeError(`completedSteps[${index}].completedAt deve ser uma data ISO.`);
    }
    return Object.freeze({ step, completedAt: completedAt.toISOString() });
  });
  normalized.sort((left, right) => left.step - right.step);
  return Object.freeze(normalized);
}

function progressDocument(value) {
  const input = value == null ? {} : value;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("Progresso persistido inválido.");
  }
  if (Object.keys(input).some((key) => key !== "completedSteps")) {
    throw new TypeError("Progresso persistido contém metadado não permitido.");
  }
  return Object.freeze({ completedSteps: completionMetadata(input.completedSteps) });
}

function mapProgress(row) {
  if (!row) return null;
  const document = progressDocument(row.progresso);
  return Object.freeze({
    empresaId: row.empresa_id,
    schemaVersion: Number(row.schema_version),
    currentStep: Number(row.etapa_atual),
    completedSteps: document.completedSteps,
    revision: Number(row.revision),
    updatedBy: row.updated_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapDraft(row) {
  if (!row) return null;
  return Object.freeze({
    empresaId: row.empresa_id,
    draftVersion: Number(row.draft_version),
    schemaVersion: Number(row.schema_version),
    configuration: structuredClone(row.configuracao),
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapTenant(row) {
  if (!row) return null;
  return Object.freeze({
    empresaId: row.id,
    status: STATUS_FROM_DB[row.status] || row.status,
    configurationVersion: Number(row.versao_configuracao),
    runtimeMode: row.configuracao_runtime_modo,
    activeConfigurationVersion: row.configuracao_ativa_versao == null
      ? null
      : Number(row.configuracao_ativa_versao),
    publishedAt: row.publicada_at,
  });
}

function integrationStatus(value) {
  if (value === "saudavel") return "healthy";
  if (value === "simulada") return "simulated";
  return "unavailable";
}

function mapReadiness(row, { environment, platformAiCredentialConfigured }) {
  if (!row) return null;
  const primaryNumber = row.primary_number_id == null
    ? null
    : Object.freeze({
      id: String(row.primary_number_id),
      primary: true,
      status: row.primary_number_status,
      phoneNumberId: row.primary_phone_number_id,
      wabaId: row.primary_waba_id,
      numeroE164: row.primary_numero_e164,
    });
  const integrations = (row.integrations || []).map((integration) => Object.freeze({
    id: integration.reference,
    reference: integration.reference,
    status: integrationStatus(integration.status),
  }));
  return Object.freeze({
    tenant: Object.freeze({
      empresaId: row.empresa_id,
      status: STATUS_FROM_DB[row.tenant_status] || row.tenant_status,
      runtimeMode: row.configuracao_runtime_modo,
      configurationVersion: Number(row.versao_configuracao),
      activeConfigurationVersion: row.configuracao_ativa_versao == null
        ? null
        : Number(row.configuracao_ativa_versao),
    }),
    draftVersion: row.draft_version == null ? 0 : Number(row.draft_version),
    nextConfigurationVersion: Number(row.versao_configuracao) + 1,
    administratorCount: Number(row.administrator_count || 0),
    whatsapp: Object.freeze({
      primaryNumber,
      accessTokenConfigured: row.access_token_configured === true,
      applicationValid: row.application_valid === true,
    }),
    credentialReferences: Object.freeze([...(row.credential_references || [])]),
    integrations: Object.freeze(integrations),
    platformAiCredentialConfigured,
    environment,
  });
}

function assertTransaction(transaction, empresaId) {
  if (!transaction?.client?.query) throw new TypeError("Transação PostgreSQL é obrigatória.");
  if (transaction.tenantId && transaction.tenantId !== empresaId) {
    throw new TypeError("A transação pertence a outra empresa.");
  }
  return transaction;
}

export class PostgresOnboardingRepository {
  constructor(pool, {
    transactionRunner = withTenantTransaction,
    environment = "production",
    platformAiCredentialConfigured = false,
  } = {}) {
    if (!pool?.connect) throw new TypeError("pool PostgreSQL é obrigatório.");
    if (typeof transactionRunner !== "function") throw new TypeError("transactionRunner deve ser uma função.");
    if (!["development", "production", "test"].includes(environment)) {
      throw new TypeError("environment deve ser development, production ou test.");
    }
    if (typeof platformAiCredentialConfigured !== "boolean") {
      throw new TypeError("platformAiCredentialConfigured deve ser booleano.");
    }
    this.pool = pool;
    this.transactionRunner = transactionRunner;
    this.environment = environment;
    this.platformAiCredentialConfigured = platformAiCredentialConfigured;
  }

  readProgress({ empresaId }) {
    return this.transactionRunner(this.pool, { empresaId }, async ({ client }) => mapProgress((await client.query(
      `SELECT empresa_id, schema_version, etapa_atual, progresso, revision,
              updated_by, created_at, updated_at
         FROM onboarding_progressos
        WHERE empresa_id = $1`,
      [empresaId],
    )).rows[0]));
  }

  async saveProgressAtomic({
    empresaId,
    expectedRevision,
    currentStep,
    completedSteps,
    actorId,
    auditId = null,
    correlationId = null,
    occurredAt = null,
  }) {
    const expected = integer(expectedRevision, "expectedRevision", { min: 0 });
    const step = integer(currentStep, "currentStep", { min: 1, max: 10 });
    const document = { completedSteps: completionMetadata(completedSteps) };
    return this.transactionRunner(this.pool, { empresaId, usuarioId: actorId }, async ({ client }) => {
      const result = expected === 0
        ? await client.query(
          `INSERT INTO onboarding_progressos
             (empresa_id, schema_version, etapa_atual, progresso, revision, updated_by)
           VALUES ($1, 2, $2, $3::jsonb, 1, $4)
           ON CONFLICT (empresa_id) DO NOTHING
           RETURNING empresa_id, schema_version, etapa_atual, progresso, revision,
                     updated_by, created_at, updated_at`,
          [empresaId, step, JSON.stringify(document), actorId || null],
        )
        : await client.query(
          `UPDATE onboarding_progressos
              SET etapa_atual = $3,
                  progresso = $4::jsonb,
                  revision = revision + 1,
                  updated_by = $5
            WHERE empresa_id = $1 AND revision = $2
          RETURNING empresa_id, schema_version, etapa_atual, progresso, revision,
                    updated_by, created_at, updated_at`,
          [empresaId, expected, step, JSON.stringify(document), actorId || null],
        );
      const progress = mapProgress(result.rows[0]);
      if (progress) {
        await client.query(
          `INSERT INTO logs_auditoria
             (id, empresa_id, ator_usuario_id, acao, recurso_tipo, recurso_id,
              resultado, campos_alterados_redigidos, correlation_id, occurred_at)
           VALUES (COALESCE($1::uuid, gen_random_uuid()),$2::uuid,$3::uuid,'onboarding.step.update',
                   'onboarding_progress',$2::uuid::text,'sucesso',$4::jsonb,$5::uuid,
                   COALESCE($6::timestamptz, now()))`,
          [
            auditId,
            empresaId,
            actorId || null,
            JSON.stringify({ fields: ["etapa_atual", "revision", "completed_steps"] }),
            correlationId,
            occurredAt,
          ],
        );
        return Object.freeze({ saved: true, progress, currentRevision: progress.revision });
      }
      const current = (await client.query(
        "SELECT revision FROM onboarding_progressos WHERE empresa_id = $1",
        [empresaId],
      )).rows[0];
      return Object.freeze({
        saved: false,
        progress: null,
        currentRevision: current ? Number(current.revision) : 0,
      });
    });
  }

  readReadinessSnapshot({ empresaId, transaction } = {}) {
    const read = async ({ client }) => mapReadiness((await client.query(
      `SELECT
         e.id AS empresa_id,
         e.status AS tenant_status,
         e.versao_configuracao,
         e.configuracao_runtime_modo,
         e.configuracao_ativa_versao,
         (SELECT cr.draft_version FROM configuracoes_rascunho cr
           WHERE cr.empresa_id = e.id) AS draft_version,
         (SELECT count(*)::int FROM usuarios_empresas ue
           WHERE ue.empresa_id = e.id AND ue.papel = 'administrador' AND ue.status = 'ativo') AS administrator_count,
         (SELECT nw.id FROM numeros_whatsapp nw
           WHERE nw.empresa_id = e.id AND nw.principal AND nw.deleted_at IS NULL
           ORDER BY (nw.status = 'ativo') DESC, nw.created_at DESC, nw.id LIMIT 1) AS primary_number_id,
         (SELECT nw.status FROM numeros_whatsapp nw
           WHERE nw.empresa_id = e.id AND nw.principal AND nw.deleted_at IS NULL
           ORDER BY (nw.status = 'ativo') DESC, nw.created_at DESC, nw.id LIMIT 1) AS primary_number_status,
         (SELECT nw.phone_number_id FROM numeros_whatsapp nw
           WHERE nw.empresa_id = e.id AND nw.principal AND nw.deleted_at IS NULL
           ORDER BY (nw.status = 'ativo') DESC, nw.created_at DESC, nw.id LIMIT 1) AS primary_phone_number_id,
         (SELECT nw.waba_id FROM numeros_whatsapp nw
           WHERE nw.empresa_id = e.id AND nw.principal AND nw.deleted_at IS NULL
           ORDER BY (nw.status = 'ativo') DESC, nw.created_at DESC, nw.id LIMIT 1) AS primary_waba_id,
         (SELECT nw.numero_e164 FROM numeros_whatsapp nw
           WHERE nw.empresa_id = e.id AND nw.principal AND nw.deleted_at IS NULL
           ORDER BY (nw.status = 'ativo') DESC, nw.created_at DESC, nw.id LIMIT 1) AS primary_numero_e164,
         EXISTS (
           SELECT 1 FROM numeros_whatsapp nw
           JOIN credenciais_empresa ce
             ON ce.empresa_id = nw.empresa_id
            AND ce.provedor = 'meta'
            AND ce.finalidade IN ('whatsapp', 'whatsapp:' || nw.id::text)
            AND ce.status = 'ativa'
           WHERE nw.empresa_id = e.id AND nw.principal AND nw.status = 'ativo' AND nw.deleted_at IS NULL
         ) AS access_token_configured,
         EXISTS (
           SELECT 1 FROM integracoes mi
            WHERE mi.empresa_id = e.id AND mi.tipo = 'meta' AND mi.habilitada
              AND mi.status = 'saudavel' AND mi.deleted_at IS NULL
         ) AS application_valid,
         COALESCE((
           SELECT array_agg('credential:' || ce.id::text ORDER BY ce.id)
             FROM credenciais_empresa ce
            WHERE ce.empresa_id = e.id AND ce.status = 'ativa'
         ), ARRAY[]::text[]) AS credential_references,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'reference', 'integration:' || i.id::text,
             'status', i.status
           ) ORDER BY i.id)
             FROM integracoes i
            WHERE i.empresa_id = e.id AND i.habilitada AND i.deleted_at IS NULL
         ), '[]'::jsonb) AS integrations
       FROM empresas e
       WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [empresaId],
    )).rows[0], {
      environment: this.environment,
      platformAiCredentialConfigured: this.platformAiCredentialConfigured,
    });

    if (transaction) return read(assertTransaction(transaction, empresaId));
    return this.transactionRunner(this.pool, { empresaId }, read);
  }

  withActivationTransaction({ empresaId, actorId }, callback) {
    if (typeof callback !== "function") throw new TypeError("callback de ativação é obrigatório.");
    return this.transactionRunner(this.pool, { empresaId, usuarioId: actorId }, callback);
  }

  withPublicationTransaction(context, callback) {
    return this.withActivationTransaction(context, callback);
  }

  async lockActivationState({ empresaId, transaction }) {
    const tx = assertTransaction(transaction, empresaId);
    const tenant = mapTenant((await tx.client.query(
      `SELECT id, status, versao_configuracao, configuracao_runtime_modo,
              configuracao_ativa_versao, publicada_at
         FROM empresas
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [empresaId],
    )).rows[0]);
    if (!tenant) return Object.freeze({ tenant: null, draft: null });
    const draft = mapDraft((await tx.client.query(
      `SELECT empresa_id, draft_version, schema_version, configuracao,
              created_by, updated_by, created_at, updated_at
         FROM configuracoes_rascunho
        WHERE empresa_id = $1
        FOR UPDATE`,
      [empresaId],
    )).rows[0]);
    return Object.freeze({ tenant, draft });
  }

  lockPublicationState(input) {
    return this.lockActivationState(input);
  }

  async insertPublishedRevision({ empresaId, compiled, actorId, publishedAt, transaction }) {
    if (!compiled || typeof compiled !== "object" || compiled.empresaId !== empresaId) {
      throw new TypeError("A revisão compilada pertence a outra empresa.");
    }
    const tx = assertTransaction(transaction, empresaId);
    return (await tx.client.query(
      `INSERT INTO configuracoes_revisoes
         (empresa_id, config_version, schema_version, compiler_version,
          source_draft_version, checksum_algorithm, checksum,
          configuracao_compilada, publicada_por, publicada_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
       RETURNING empresa_id, config_version, schema_version, compiler_version,
                 source_draft_version, checksum_algorithm, checksum,
                 configuracao_compilada, publicada_por, publicada_at`,
      [
        empresaId,
        compiled.configVersion,
        compiled.schemaVersion,
        compiled.compilerVersion,
        compiled.draftVersion,
        compiled.checksumAlgorithm,
        compiled.checksum,
        JSON.stringify(compiled),
        actorId,
        publishedAt,
      ],
    )).rows[0] || null;
  }

  async setActiveRevision({ empresaId, configVersion, publishedAt, transaction }) {
    const tx = assertTransaction(transaction, empresaId);
    return mapTenant((await tx.client.query(
      `UPDATE empresas
          SET configuracao_runtime_modo = 'versionado',
              configuracao_ativa_versao = $2,
              versao_configuracao = $2,
              publicada_at = $3,
              updated_at = $3
        WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, status, versao_configuracao, configuracao_runtime_modo,
                configuracao_ativa_versao, publicada_at`,
      [empresaId, configVersion, publishedAt],
    )).rows[0]);
  }

  async setTenantActive({ empresaId, configVersion, activatedAt, transaction }) {
    const tx = assertTransaction(transaction, empresaId);
    return mapTenant((await tx.client.query(
      `UPDATE empresas
          SET status = 'ativa', updated_at = $3
        WHERE id = $1
          AND configuracao_runtime_modo = 'versionado'
          AND configuracao_ativa_versao = $2
          AND deleted_at IS NULL
      RETURNING id, status, versao_configuracao, configuracao_runtime_modo,
                configuracao_ativa_versao, publicada_at`,
      [empresaId, configVersion, activatedAt],
    )).rows[0]);
  }

  activateTenant(input) {
    return this.setTenantActive(input);
  }

  async #writeAudit({ auditId, empresaId, actorId, action, resource, resourceId, changedFields, correlationId, occurredAt, transaction }) {
    const tx = assertTransaction(transaction, empresaId);
    await tx.client.query(
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
        correlationId || null,
        occurredAt,
      ],
    );
  }

  writePublicationAudit({ configVersion, ...input }) {
    return this.#writeAudit({
      ...input,
      action: "configuration.publish",
      resource: "configuration_revision",
      resourceId: configVersion,
      changedFields: ["configuracao_runtime_modo", "configuracao_ativa_versao", "versao_configuracao", "publicada_at"],
    });
  }

  writeActivationAudit({ configVersion, ...input }) {
    return this.#writeAudit({
      ...input,
      action: "tenant.activate",
      resource: "tenant",
      resourceId: input.empresaId,
      changedFields: ["status", "configuracao_ativa_versao", "versao_configuracao", "publicada_at", "config_version"],
    });
  }
}
