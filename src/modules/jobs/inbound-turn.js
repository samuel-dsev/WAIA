import { withTenantTransaction } from "../../infra/postgres/transaction.js";

export const INBOUND_COOLDOWN_MS = 15_000;

/** The oldest job may answer the newest text in a burst. Its source sequence is
 * the durable watermark, so later jobs neither repeat nor lose that turn. */
export function loadInboundTurn(pool, { empresaId, conversationId, messageId }) {
  return withTenantTransaction(pool, { empresaId }, async ({ client }) => {
    const { rows } = await client.query(`WITH anchor AS (
      SELECT * FROM mensagens WHERE empresa_id=$1 AND conversa_id=$2 AND id=$3
        AND direcao='entrada' AND redacted_at IS NULL
    ), boundary AS (
      SELECT coalesce(max(source.sequence),0) AS sequence FROM mensagens reply
      JOIN mensagens source ON source.empresa_id=reply.empresa_id AND source.id=reply.source_message_id
      WHERE reply.empresa_id=$1 AND reply.conversa_id=$2 AND reply.direcao='saida'
        AND reply.external_message_id IS NOT NULL AND reply.status IN ('enviada','entregue','lida')
        AND reply.redacted_at IS NULL
    ) SELECT m.id,m.sequence,m.corpo,m.created_at FROM mensagens m,anchor a,boundary b
      WHERE m.empresa_id=$1 AND m.conversa_id=$2 AND m.direcao='entrada' AND m.tipo='texto'
        AND a.sequence>b.sequence AND m.sequence>b.sequence AND m.redacted_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at>now())
        AND m.outbound_payload->>'conversationGeneration' IS NOT DISTINCT FROM a.outbound_payload->>'conversationGeneration'
        AND NOT EXISTS (SELECT 1 FROM mensagens barrier WHERE barrier.empresa_id=$1 AND barrier.conversa_id=$2
          AND barrier.direcao='entrada' AND barrier.tipo<>'texto' AND barrier.redacted_at IS NULL
          AND barrier.sequence BETWEEN least(a.sequence,m.sequence) AND greatest(a.sequence,m.sequence))
      ORDER BY m.sequence`, [empresaId, conversationId, messageId]);
    if (!rows.length) return null;
    return { messageId: rows.at(-1).id, sequence: Number(rows.at(-1).sequence),
      readyAt: new Date(new Date(rows.at(-1).created_at).getTime() + INBOUND_COOLDOWN_MS).toISOString(),
      messages: rows.map((row) => ({ id: row.id, text: row.corpo || "" })) };
  });
}
