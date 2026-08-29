import { withPlatformTransaction } from "../infra/postgres/transaction.js";
import { redactSensitive } from "../security/redaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const uuid = (value) => UUID.test(String(value || "")) ? String(value) : null;

export function createPostgresOperationalLogSink(pool) {
  const pending = new Set();
  async function persist(record) {
    const safe = redactSensitive(record);
    const empresaId = uuid(safe.empresaId);
    const occurredAt = safe.timestamp || new Date().toISOString();
    const metadata = { ...safe };
    for (const key of ["timestamp", "severity", "service", "eventCode", "empresaId", "correlationId", "conversationId", "messageId", "jobId", "userId", "summary"]) delete metadata[key];
    await withPlatformTransaction(pool, {}, ({ client }) => client.query(
      `INSERT INTO logs_operacionais (
         empresa_id, severidade, categoria, servico, event_code, correlation_id,
         conversa_id, mensagem_id, job_id, usuario_id, resumo_sanitizado,
         metadata_sanitized, occurred_at, expires_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,
         $13::timestamptz + (COALESCE((SELECT retencao_logs_dias FROM empresas WHERE id = $1), 90) * interval '1 day')
       )`,
      [
        empresaId,
        safe.severity === "warn" ? "warning" : safe.severity,
        String(safe.category || "application").slice(0, 120),
        String(safe.service || "waia").slice(0, 120),
        String(safe.eventCode || "unknown_event").slice(0, 160),
        uuid(safe.correlationId), uuid(safe.conversationId), uuid(safe.messageId), uuid(safe.jobId), uuid(safe.userId),
        String(safe.summary || safe.eventCode || "Evento operacional").slice(0, 1_000),
        JSON.stringify(metadata), occurredAt,
      ],
    ));
  }
  return Object.freeze({
    write(record) {
      const task = persist(record).catch(() => {}).finally(() => pending.delete(task));
      pending.add(task);
    },
    async flush() { await Promise.allSettled([...pending]); },
  });
}
