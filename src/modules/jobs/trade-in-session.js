import { withTenantTransaction } from "../../infra/postgres/transaction.js";
import { normalizeTradeInEvaluation } from "../business/trade-in-evaluation.js";

export function loadTradeInEvaluationSession(pool, { empresaId, conversationId, messageId }) {
  return withTenantTransaction(pool, { empresaId }, async ({ client }) => {
    const { rows } = await client.query(
      "SELECT m.outbound_payload->'tradeInEvaluation' AS state, NOT EXISTS ("
      + "SELECT 1 FROM mensagens newer WHERE newer.empresa_id=m.empresa_id AND newer.conversa_id=m.conversa_id "
      + "AND newer.direcao='saida' AND newer.sequence>m.sequence AND newer.sequence<anchor.sequence "
      + "AND newer.redacted_at IS NULL AND newer.external_message_id IS NOT NULL AND newer.status IN ('enviada','entregue','lida')) AS direct "
      + "FROM mensagens m JOIN mensagens anchor ON anchor.empresa_id=m.empresa_id AND anchor.conversa_id=m.conversa_id AND anchor.id=$3 "
      + "WHERE m.empresa_id=$1 AND m.conversa_id=$2 AND m.sequence<anchor.sequence AND m.direcao='saida' "
      + "AND anchor.direcao='entrada' AND anchor.redacted_at IS NULL AND m.redacted_at IS NULL "
      + "AND (m.expires_at IS NULL OR m.expires_at>now()) AND m.external_message_id IS NOT NULL "
      + "AND m.status IN ('enviada','entregue','lida') AND m.outbound_payload ? 'tradeInEvaluation' ORDER BY m.sequence",
      [empresaId, conversationId, messageId],
    );
    let session = null, visitAccepted = false, humanReviewAccepted = false;
    for (const row of rows) {
      const state = normalizeTradeInEvaluation(row.state);
      if (!state || ["declined", "completed"].includes(state.step)) {
        session = null; visitAccepted = false; humanReviewAccepted = false;
      } else {
        if (state.step === "visit_requested") visitAccepted = true;
        if (state.step === "human_review_requested") humanReviewAccepted = true;
        session = { ...state, direct: row.direct };
      }
    }
    return session ? { ...session, visitAccepted, humanReviewAccepted } : null;
  });
}
