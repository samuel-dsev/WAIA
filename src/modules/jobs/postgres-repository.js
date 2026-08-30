import { withPlatformTransaction, withTenantTransaction } from "../../infra/postgres/transaction.js";
import { sanitizeJobError } from "./job-reference.js";

function rowToReference(row) {
  return {
    jobId: row.id,
    empresaId: row.empresa_id,
    conversationId: row.conversa_id,
    messageId: row.mensagem_id,
    statusEventId: row.payload?.statusEventId || null,
    type: row.job_type,
    correlationId: row.correlation_id,
    payloadVersion: Number(row.payload?.payloadVersion || 1),
  };
}

export class PostgresOutboxDispatchRepository {
  constructor(pool) {
    this.pool = pool;
  }

  claimBatch({ limit = 100, leaseMs = 30_000, reconcileAfterMs = 300_000 } = {}) {
    return withPlatformTransaction(this.pool, {}, async ({ client }) => {
      const result = await client.query(
        `WITH ranked AS (
           SELECT id,
                  row_number() OVER (PARTITION BY empresa_id ORDER BY created_at, id) AS tenant_rank
             FROM outbox_jobs
            WHERE (status = 'pendente' AND disponivel_at <= now())
               OR (status = 'em_publicacao' AND locked_until < now())
               OR (status = 'publicado' AND published_at < now() - ($3 * interval '1 millisecond'))
         ), locked AS (
           SELECT o.id
             FROM outbox_jobs o
             JOIN ranked r ON r.id = o.id
            ORDER BY r.tenant_rank, o.created_at, o.id
            LIMIT $1
            FOR UPDATE OF o SKIP LOCKED
         )
         UPDATE outbox_jobs o
            SET status = 'em_publicacao',
                locked_until = now() + ($2 * interval '1 millisecond'),
                tentativas = tentativas + 1,
                error_sanitized = NULL
           FROM locked
          WHERE o.id = locked.id
         RETURNING o.*`,
        [limit, leaseMs, reconcileAfterMs],
      );
      return result.rows.map(rowToReference);
    });
  }

  markPublished(reference) {
    return withPlatformTransaction(this.pool, {}, ({ client }) => client.query(
      `UPDATE outbox_jobs
          SET status = 'publicado', published_at = now(), locked_until = NULL
        WHERE empresa_id = $1 AND id = $2 AND status = 'em_publicacao'`,
      [reference.empresaId, reference.jobId],
    ));
  }

  release(reference, { delayMs = 1_000, error } = {}) {
    const sanitized = sanitizeJobError(error);
    return withPlatformTransaction(this.pool, {}, ({ client }) => client.query(
      `UPDATE outbox_jobs
          SET status = 'pendente',
              disponivel_at = now() + ($3 * interval '1 millisecond'),
              locked_until = NULL,
              error_sanitized = $4
        WHERE empresa_id = $1 AND id = $2 AND status = 'em_publicacao'`,
      [reference.empresaId, reference.jobId, delayMs, sanitized.message],
    ));
  }
}

export class PostgresJobRepository {
  constructor(pool) {
    this.pool = pool;
  }

  claim(reference, { attempt = 1, leaseMs = 30_000 } = {}) {
    return withTenantTransaction(this.pool, { empresaId: reference.empresaId }, async ({ client }) => {
      const current = await client.query(
        `SELECT id, status FROM outbox_jobs WHERE empresa_id = $1 AND id = $2 FOR UPDATE`,
        [reference.empresaId, reference.jobId],
      );
      if (!current.rows[0]) return { outcome: "missing" };
      if (current.rows[0].status === "concluido") return { outcome: "completed" };
      if (current.rows[0].status === "falhou") return { outcome: "failed" };

      const result = await client.query(
        `UPDATE outbox_jobs current_job
            SET status = 'em_publicacao',
                locked_until = now() + ($4 * interval '1 millisecond'),
                tentativas = GREATEST(tentativas, $3),
                error_sanitized = NULL
          WHERE current_job.empresa_id = $1
            AND current_job.id = $2
            AND (current_job.status = 'publicado'
              OR (current_job.status = 'em_publicacao' AND current_job.locked_until < now()))
            AND NOT EXISTS (
              SELECT 1 FROM outbox_jobs earlier
               WHERE earlier.empresa_id = current_job.empresa_id
                 AND earlier.conversa_id = current_job.conversa_id
                 AND current_job.conversa_id IS NOT NULL
                 AND (earlier.created_at, earlier.id) < (current_job.created_at, current_job.id)
                 AND earlier.status NOT IN ('concluido', 'falhou')
            )
        RETURNING current_job.*`,
        [reference.empresaId, reference.jobId, attempt, leaseMs],
      );
      if (!result.rows[0]) return { outcome: "busy" };
      if (["process_inbound_message", "send_human_message"].includes(result.rows[0].job_type) && result.rows[0].mensagem_id) {
        await client.query(
          `UPDATE mensagens
              SET status = 'processando', processing_at = COALESCE(processing_at, now()),
                  tentativas = GREATEST(tentativas, $3), error_code = NULL, error_sanitized = NULL
            WHERE empresa_id = $1 AND id = $2
              AND status IN ('recebida', 'enfileirada', 'processando', 'falhou')`,
          [reference.empresaId, result.rows[0].mensagem_id, attempt],
        );
      }
      return { outcome: "claimed", record: result.rows[0] };
    });
  }

  complete(reference, { attempt = 1, result } = {}) {
    return withTenantTransaction(this.pool, { empresaId: reference.empresaId }, async ({ client }) => {
      await client.query(
        `UPDATE outbox_jobs
          SET status = 'concluido', completed_at = COALESCE(completed_at, now()),
              locked_until = NULL, tentativas = GREATEST(tentativas, $3), error_sanitized = NULL
        WHERE empresa_id = $1 AND id = $2 AND status <> 'concluido'`,
        [reference.empresaId, reference.jobId, attempt],
      );
      if (reference.type === "process_inbound_message" && reference.messageId) {
        await client.query(
          `UPDATE mensagens
              SET status = $3, responded_at = CASE WHEN $3 = 'respondida' THEN COALESCE(responded_at, now()) ELSE responded_at END
            WHERE empresa_id = $1 AND id = $2 AND status = 'processando'`,
          [reference.empresaId, reference.messageId, result?.replied ? "respondida" : "recebida"],
        );
      }
    });
  }

  retry(reference, { attempt = 1, error } = {}) {
    return withTenantTransaction(this.pool, { empresaId: reference.empresaId }, async ({ client }) => {
      await client.query(
        `UPDATE outbox_jobs
          SET status = 'publicado', locked_until = NULL,
              tentativas = GREATEST(tentativas, $3), error_sanitized = $4
        WHERE empresa_id = $1 AND id = $2 AND status <> 'concluido'`,
        [reference.empresaId, reference.jobId, attempt, error?.message || "Falha temporária."],
      );
      if (["process_inbound_message", "send_human_message"].includes(reference.type) && reference.messageId) {
        await client.query(
          `UPDATE mensagens
              SET status = 'enfileirada', tentativas = GREATEST(tentativas, $3),
                  error_code = $4, error_sanitized = $5
            WHERE empresa_id = $1 AND id = $2 AND status = 'processando'`,
          [reference.empresaId, reference.messageId, attempt, error?.code, error?.message],
        );
      }
    });
  }

  fail(reference, { attempt = 1, maxAttempts = attempt, error } = {}) {
    return withTenantTransaction(this.pool, { empresaId: reference.empresaId }, async ({ client }) => {
      await client.query(
        `UPDATE outbox_jobs
            SET status = 'falhou', locked_until = NULL,
                tentativas = GREATEST(tentativas, $3), error_sanitized = $4
          WHERE empresa_id = $1 AND id = $2 AND status <> 'concluido'`,
        [reference.empresaId, reference.jobId, attempt, error?.message || "Falha permanente."],
      );
      if (["process_inbound_message", "send_human_message"].includes(reference.type) && reference.messageId) {
        await client.query(
          `UPDATE mensagens
              SET status = 'falhou', tentativas = GREATEST(tentativas, $3),
                  error_code = $4, error_sanitized = $5
            WHERE empresa_id = $1 AND id = $2
              AND status NOT IN ('respondida', 'enviada', 'entregue', 'lida')`,
          [reference.empresaId, reference.messageId, attempt, error?.code, error?.message],
        );
      }
      await client.query(
        `INSERT INTO jobs_falhos (
           empresa_id, queue_job_id, job_type, conversa_id, mensagem_id,
           tentativas, max_tentativas, first_failure_at, last_failure_at,
           error_code, error_sanitized, payload_sanitized, correlation_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now(),$8,$9,$10::jsonb,$11)
         ON CONFLICT (queue_job_id) DO UPDATE SET
           tentativas = EXCLUDED.tentativas,
           max_tentativas = EXCLUDED.max_tentativas,
           last_failure_at = now(),
           error_code = EXCLUDED.error_code,
           error_sanitized = EXCLUDED.error_sanitized`,
        [
          reference.empresaId,
          `${reference.empresaId}:${reference.jobId}`,
          reference.type,
          reference.conversationId,
          reference.messageId,
          attempt,
          maxAttempts,
          error?.code || "JOB_PROCESSING_ERROR",
          error?.message || "Falha permanente.",
          JSON.stringify({
            jobId: reference.jobId,
            conversationId: reference.conversationId,
            messageId: reference.messageId,
            statusEventId: reference.statusEventId,
          }),
          reference.correlationId,
        ],
      );
    });
  }
}
