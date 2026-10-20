import { acknowledgeQualification } from "../group-notifier/acknowledge-qualification.js";
import { acknowledgeNonLeadHandoff } from "../group-notifier/acknowledge-non-lead.js";
/** Acknowledgement, interest note and pause commit together. Human ownership wins. */
export async function acknowledgeReply(client, { empresaId, replyId, externalMessageId }) {
  if (typeof externalMessageId !== "string" || !externalMessageId.trim()) {
    throw Object.assign(new Error("Provedor não confirmou o identificador da mensagem."), { code: "BOT_REPLY_SEND_ID_MISSING", retryable: false });
  }
  const interest = (await client.query(
    `SELECT m.id, m.conversa_id, m.contato_id, m.numero_whatsapp_id, m.correlation_id,
            m.outbound_payload, c.modo_atendimento
       FROM mensagens m JOIN conversas c ON c.empresa_id=m.empresa_id AND c.id=m.conversa_id
      WHERE m.empresa_id=$1 AND m.id=$2 AND m.direcao='saida' AND m.origem_resposta='ia'
        AND m.redacted_at IS NULL AND (m.outbound_payload ? 'salesInterest' OR m.outbound_payload ? 'leadQualification' OR m.outbound_payload ? 'nonLeadHandoff')
      FOR UPDATE OF c, m`, [empresaId, replyId],
  )).rows[0];
  const result = await client.query(
    `UPDATE mensagens SET external_message_id=$3,
       status=CASE WHEN status IN ('entregue','lida') THEN status ELSE 'enviada' END, sent_at=COALESCE(sent_at,now()),
       error_code=NULL, error_sanitized=NULL
     WHERE empresa_id=$1 AND id=$2 AND direcao='saida'
       AND (external_message_id IS NULL OR external_message_id=$3)`, [empresaId, replyId, externalMessageId],
  );
  if (result.rowCount && interest?.outbound_payload?.leadQualification) await acknowledgeQualification(client, { empresaId, replyId });
  if (result.rowCount && interest?.outbound_payload?.nonLeadHandoff) await acknowledgeNonLeadHandoff(client, { empresaId, replyId });
  if (!result.rowCount || !interest?.outbound_payload?.salesInterest || interest.outbound_payload.salesInterest.completedAt) return result;
  const products = interest.outbound_payload.salesInterest.products;
  if (!Array.isArray(products) || !products.length || products.length > 3
    || products.some((item) => typeof item.id !== "string" || !item.id || item.id.length > 200 || typeof item.name !== "string" || !item.name || item.name.length > 200)) {
    throw Object.assign(new Error("Interesse comercial inválido."), { code: "SALES_INTEREST_INVALID" });
  }
  const sequence = (await client.query(
    `UPDATE conversas SET next_sequence=next_sequence+1,
       modo_atendimento=CASE WHEN modo_atendimento='bot' THEN 'pausado' ELSE modo_atendimento END,
       lock_version=lock_version+1, updated_at=now()
     WHERE empresa_id=$1 AND id=$2 RETURNING next_sequence-1 AS sequence`, [empresaId, interest.conversa_id],
  )).rows[0].sequence;
  await client.query(
    `INSERT INTO mensagens (empresa_id,conversa_id,contato_id,numero_whatsapp_id,direcao,tipo,corpo,status,sequence,correlation_id,origem_resposta)
     VALUES ($1,$2,$3,$4,'interna','sistema',$5,'recebida',$6,$7,'sistema')`,
    [empresaId, interest.conversa_id, interest.contato_id, interest.numero_whatsapp_id,
      `Interesse comercial registrado: ${products.map((item) => item.name).join(", ")}. Atendimento encaminhado à equipe no painel. Consulte os dados do cliente e as dúvidas no histórico da conversa.`,
      sequence, interest.correlation_id],
  );
  await client.query(
    `UPDATE mensagens SET outbound_payload=jsonb_set(outbound_payload,'{salesInterest,completedAt}',to_jsonb(now()::text))
      WHERE empresa_id=$1 AND id=$2`, [empresaId, replyId],
  );
  return result;
}
