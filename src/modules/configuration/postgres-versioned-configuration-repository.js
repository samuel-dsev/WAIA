import { withTenantTransaction } from "../../infra/postgres/transaction.js";

function mapDraft(row) {
  if (!row) return null;
  return {
    empresaId: row.empresa_id,
    draftVersion: Number(row.draft_version),
    schemaVersion: Number(row.schema_version),
    configuration: row.configuracao,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTenant(row) {
  if (!row) return null;
  return {
    empresaId: row.id,
    configurationVersion: Number(row.versao_configuracao),
    runtimeMode: row.configuracao_runtime_modo,
    activeConfigurationVersion: row.configuracao_ativa_versao == null ? null : Number(row.configuracao_ativa_versao),
    publishedAt: row.publicada_at,
  };
}

export class PostgresVersionedConfigurationRepository {
  constructor(pool, { transactionRunner = withTenantTransaction } = {}) {
    if (!pool?.connect) throw new TypeError("pool PostgreSQL é obrigatório.");
    if (typeof transactionRunner !== "function") throw new TypeError("transactionRunner deve ser uma função.");
    this.pool = pool;
    this.transactionRunner = transactionRunner;
  }

  readDraft({ empresaId }) {
    return this.transactionRunner(this.pool, { empresaId }, async ({ client }) => mapDraft((await client.query(
      `SELECT empresa_id, draft_version, schema_version, configuracao,
              created_by, updated_by, created_at, updated_at
         FROM configuracoes_rascunho
        WHERE empresa_id = $1`,
      [empresaId],
    )).rows[0]));
  }

  async saveDraftAtomic({
    empresaId,
    expectedDraftVersion,
    schemaVersion,
    configuration,
    actorId,
    auditId,
    correlationId,
    occurredAt,
  }) {
    return this.transactionRunner(this.pool, { empresaId, usuarioId: actorId }, async ({ client }) => {
      let result;
      if (expectedDraftVersion === 0) {
        result = await client.query(
          `INSERT INTO configuracoes_rascunho
             (empresa_id, draft_version, schema_version, configuracao, created_by, updated_by, created_at, updated_at)
           VALUES ($1, 1, $2, $3::jsonb, $4, $4, now(), now())
           ON CONFLICT (empresa_id) DO NOTHING
           RETURNING empresa_id, draft_version, schema_version, configuracao,
                     created_by, updated_by, created_at, updated_at`,
          [empresaId, schemaVersion, JSON.stringify(configuration), actorId],
        );
      } else {
        result = await client.query(
          `UPDATE configuracoes_rascunho
              SET draft_version = draft_version + 1,
                  schema_version = $3,
                  configuracao = $4::jsonb,
                  updated_by = $5,
                  updated_at = now()
            WHERE empresa_id = $1 AND draft_version = $2
          RETURNING empresa_id, draft_version, schema_version, configuracao,
                    created_by, updated_by, created_at, updated_at`,
          [empresaId, expectedDraftVersion, schemaVersion, JSON.stringify(configuration), actorId],
        );
      }
      const saved = mapDraft(result.rows[0]);
      if (saved) {
        await client.query(
          `INSERT INTO logs_auditoria
             (id, empresa_id, ator_usuario_id, acao, recurso_tipo, recurso_id,
              resultado, campos_alterados_redigidos, correlation_id, occurred_at)
           VALUES ($1, $2, $3, $4, 'configuration_draft', $5,
                   'sucesso', $6::jsonb, $7, $8)`,
          [
            auditId,
            empresaId,
            actorId,
            expectedDraftVersion === 0 ? "configuration.draft.create" : "configuration.draft.update",
            String(saved.draftVersion),
            JSON.stringify({ fields: ["draft_version", "schema_version", "configuration"] }),
            correlationId || null,
            occurredAt,
          ],
        );
        return { saved: true, draft: saved, currentDraftVersion: saved.draftVersion };
      }
      const current = (await client.query(
        "SELECT draft_version FROM configuracoes_rascunho WHERE empresa_id = $1",
        [empresaId],
      )).rows[0];
      return { saved: false, draft: null, currentDraftVersion: current ? Number(current.draft_version) : 0 };
    });
  }

  withPublicationTransaction({ empresaId, actorId }, callback) {
    if (typeof callback !== "function") throw new TypeError("callback de publicação é obrigatório.");
    return this.transactionRunner(this.pool, { empresaId, usuarioId: actorId }, callback);
  }

  async lockPublicationState({ empresaId, transaction }) {
    const tenant = mapTenant((await transaction.client.query(
      `SELECT id, versao_configuracao, configuracao_runtime_modo,
              configuracao_ativa_versao, publicada_at
         FROM empresas
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [empresaId],
    )).rows[0]);
    if (!tenant) return { tenant: null, draft: null };
    const draft = mapDraft((await transaction.client.query(
      `SELECT empresa_id, draft_version, schema_version, configuracao,
              created_by, updated_by, created_at, updated_at
         FROM configuracoes_rascunho
        WHERE empresa_id = $1
        FOR UPDATE`,
      [empresaId],
    )).rows[0]);
    return { tenant, draft };
  }

  async insertPublishedRevision({ empresaId, compiled, actorId, publishedAt, transaction }) {
    const result = await transaction.client.query(
      `INSERT INTO configuracoes_revisoes
         (empresa_id, config_version, schema_version, compiler_version,
          source_draft_version, checksum_algorithm, checksum,
          configuracao_compilada, publicada_por, publicada_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
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
    );
    return result.rows[0];
  }

  async activatePublishedRevision({ empresaId, configVersion, publishedAt, transaction }) {
    const result = await transaction.client.query(
      `UPDATE empresas
          SET configuracao_runtime_modo = 'versionado',
              configuracao_ativa_versao = $2,
              versao_configuracao = $2,
              publicada_at = $3,
              updated_at = $3
        WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, versao_configuracao, configuracao_runtime_modo,
                configuracao_ativa_versao, publicada_at`,
      [empresaId, configVersion, publishedAt],
    );
    return mapTenant(result.rows[0]);
  }

  async writePublicationAudit({ auditId, empresaId, actorId, configVersion, correlationId, occurredAt, transaction }) {
    await transaction.client.query(
      `INSERT INTO logs_auditoria
         (id, empresa_id, ator_usuario_id, acao, recurso_tipo, recurso_id,
          resultado, campos_alterados_redigidos, correlation_id, occurred_at)
       VALUES ($1, $2, $3, 'configuration.publish', 'configuration_revision', $4,
               'sucesso', $5::jsonb, $6, $7)`,
      [
        auditId,
        empresaId,
        actorId,
        String(configVersion),
        JSON.stringify({ fields: ["configuracao_runtime_modo", "configuracao_ativa_versao", "versao_configuracao", "publicada_at"] }),
        correlationId || null,
        occurredAt,
      ],
    );
  }
}
