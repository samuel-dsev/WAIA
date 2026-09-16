import { withPlatformTransaction, withTenantTransaction } from "../infra/postgres/transaction.js";

export async function listRetentionPolicies(pool) {
  return withPlatformTransaction(pool, {}, async ({ client }) => (
    await client.query(
      `SELECT id AS empresa_id, retencao_mensagens_dias, retencao_logs_dias
         FROM empresas
        WHERE deleted_at IS NULL AND status <> 'arquivada'
        ORDER BY id`,
    )
  ).rows);
}

export async function cleanupExpiredLogs(pool, { empresaId, batchSize = 500 }) {
  return withTenantTransaction(pool, { empresaId }, async ({ client }) => {
    const result = await client.query(
      `WITH expired AS (
         SELECT id FROM logs_operacionais
          WHERE empresa_id = $1 AND expires_at <= now()
          ORDER BY expires_at, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM logs_operacionais logs
        USING expired
        WHERE logs.empresa_id = $1 AND logs.id = expired.id
       RETURNING logs.id`,
      [empresaId, batchSize],
    );
    return result.rowCount;
  });
}

export function createRetentionRunner({
  pool,
  conversationService,
  flowRepository = null,
  batchSize = 500,
  policies = () => listRetentionPolicies(pool),
  cleanupLogs = (policy) => cleanupExpiredLogs(pool, { empresaId: policy.empresa_id, batchSize }),
  mediaStore,
  logger = console,
} = {}) {
  if (typeof conversationService?.anonymizeExpired !== "function") throw new TypeError("conversationService.anonymizeExpired é obrigatório.");
  return Object.freeze({
    async runOnce() {
      const results = [];
      for (const policy of await policies()) {
        try {
          const messages = await conversationService.anonymizeExpired({
            empresaId: policy.empresa_id,
            retentionDays: Number(policy.retencao_mensagens_dias),
            batchSize,
          });
          let deletedMedia = 0;
          for (const storageKey of messages.mediaStorageKeys || []) {
            if (typeof mediaStore?.delete !== "function") continue;
            try {
              await mediaStore.delete({ empresaId: policy.empresa_id, storageKey });
              deletedMedia += 1;
            } catch (error) {
              logger.error?.("tenant_media_retention_failed", { empresaId: policy.empresa_id, storageKey, error });
            }
          }
          const deletedLogs = await cleanupLogs(policy);
          const flows = flowRepository?.anonymizeExpired
            ? await flowRepository.anonymizeExpired({
              empresaId: policy.empresa_id,
              before: new Date(),
              limit: batchSize,
            })
            : { submissionIds: [], storageKeys: [], documentCount: 0 };
          for (const storageKey of flows.storageKeys || []) {
            if (typeof mediaStore?.delete !== "function") continue;
            try {
              await mediaStore.delete({ empresaId: policy.empresa_id, storageKey });
              deletedMedia += 1;
            } catch (error) {
              logger.error?.("tenant_flow_media_retention_failed", { empresaId: policy.empresa_id, storageKey, error });
            }
          }
          results.push({
            empresaId: policy.empresa_id,
            anonymizedMessages: messages.anonymized,
            anonymizedFlowSubmissions: flows.submissionIds.length,
            anonymizedFlowDocuments: flows.documentCount,
            deletedMedia,
            deletedLogs,
          });
        } catch (error) {
          logger.error?.("tenant_retention_failed", { empresaId: policy.empresa_id, error });
        }
      }
      return results;
    },
  });
}

export function startRetentionScheduler(runner, { intervalMs = 3_600_000, logger = console } = {}) {
  let timer = null;
  let running = null;
  let closed = false;
  const schedule = () => {
    if (closed) return;
    timer = setTimeout(run, intervalMs);
    timer.unref?.();
  };
  const run = () => {
    if (closed || running) return running;
    running = runner.runOnce().catch((error) => logger.error?.("retention_cycle_failed", { error })).finally(() => {
      running = null;
      schedule();
    });
    return running;
  };
  run();
  return Object.freeze({
    runNow: run,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  });
}
