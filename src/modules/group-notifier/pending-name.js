import { randomUUID } from "node:crypto";
import { verifyCompiledTenantRuntimeConfigV2 } from "../configuration/compiler.js";
import { parseQualification, asksOnlyForCustomerName } from "./qualification.js";
import { queueLeadImages } from "./delivery-images.js";

export const LEAD_NAME_WAIT_MS = 15 * 60_000;

async function pendingReply(client, empresaId, replyId) {
  return (await client.query(`SELECT m.*,c.modo_atendimento,c.status AS conversation_status,c.lock_version,
      c.operador_usuario_id,ct.telefone_normalizado,ct.bloqueado,ct.bot_pausado,ct.deleted_at AS contact_deleted,
      ct.anonimizado_at,ct.consentimento_status,ct.exclusao_solicitada_at,
      n.status AS number_status,n.deleted_at AS number_deleted,
      e.status AS company_status,e.deleted_at AS company_deleted,e.configuracao_runtime_modo,
      e.versao_configuracao,e.configuracao_ativa_versao,cr.configuracao_compilada AS compiled,
      r.enabled AS route_enabled,r.group_id,r.revision AS route_revision,r.sender_phone,
      source.sequence AS source_sequence,source.redacted_at AS source_redacted,source.expires_at AS source_expires
    FROM mensagens m JOIN conversas c ON c.empresa_id=m.empresa_id AND c.id=m.conversa_id
    JOIN contatos ct ON ct.empresa_id=c.empresa_id AND ct.id=c.contato_id
    JOIN numeros_whatsapp n ON n.empresa_id=c.empresa_id AND n.id=c.numero_whatsapp_id
    JOIN empresas e ON e.id=c.empresa_id
    JOIN mensagens source ON source.empresa_id=m.empresa_id AND source.id=m.source_message_id AND source.conversa_id=m.conversa_id
    LEFT JOIN configuracoes_revisoes cr ON cr.empresa_id=e.id AND cr.config_version=e.configuracao_ativa_versao
    LEFT JOIN group_notifier_routes r ON r.empresa_id=e.id
    WHERE m.empresa_id=$1 AND m.id=$2 AND m.direcao='saida' AND m.origem_resposta='ia'
      AND m.outbound_payload ? 'pendingNameQualification'
    FOR UPDATE OF c,m`, [empresaId, replyId])).rows[0];
}

function pendingCard(row, empresaId, now) {
  const compiled = row?.compiled, data = row?.outbound_payload?.pendingNameQualification;
  if (!row || !data || row.redacted_at || row.expires_at && new Date(row.expires_at) <= now
    || !row.external_message_id || !row.sent_at || !["enviada", "entregue", "lida"].includes(row.status)
    || row.source_redacted || row.source_expires && new Date(row.source_expires) <= now
    || row.company_status !== "ativa" || row.company_deleted || row.configuracao_runtime_modo !== "versionado"
    || Number(row.versao_configuracao) !== Number(row.configuracao_ativa_versao)
    || row.modo_atendimento !== "bot" || row.conversation_status !== "aberta" || row.operador_usuario_id
    || row.bloqueado || row.bot_pausado || row.contact_deleted || row.anonimizado_at
    || row.consentimento_status === "revogado" || row.exclusao_solicitada_at
    || row.number_status !== "ativo" || row.number_deleted
    || !compiled || !verifyCompiledTenantRuntimeConfigV2(compiled) || compiled.empresaId !== empresaId
    || compiled.configVersion !== data.configVersion || !compiled.configuration.ai.enabled
    || compiled.configuration.ai.leadQualificationEnabled !== true || !asksOnlyForCustomerName(row.corpo)) return null;
  return parseQualification({ status: "awaiting_name", name: data.name, summary: data.summary, qualification: data.qualification },
    { configVersion: data.configVersion, allowMissingName: true });
}

// Only an acknowledged, actually sent name question can start this clock.
export async function acknowledgePendingName(client, { empresaId, replyId }) {
  const row = await pendingReply(client, empresaId, replyId);
  if (!pendingCard(row, empresaId, new Date())) return;
  const due = new Date(new Date(row.sent_at).getTime() + LEAD_NAME_WAIT_MS);
  await client.query(`INSERT INTO outbox_jobs(empresa_id,conversa_id,job_type,dedup_key,payload,disponivel_at,correlation_id)
    VALUES($1,$2,'process_lead_name_timeout',$3,$4::jsonb,$5,$6)
    ON CONFLICT(empresa_id,dedup_key) DO NOTHING`, [empresaId, row.conversa_id, `lead-name:${replyId}`,
    JSON.stringify({ replyId, generation: String(row.lock_version), payloadVersion: 1 }), due, randomUUID()]);
}

// Runs in a tenant transaction. No outbound customer message or AI call is needed.
export async function completeLeadNameTimeout(client, { empresaId, conversationId, replyId, generation, now = new Date() }) {
  if (typeof replyId !== "string" || !/^[0-9a-f-]{36}$/iu.test(replyId) || generation == null) return { skipped: true };
  await client.query("SELECT id FROM empresas WHERE id=$1 FOR SHARE", [empresaId]);
  const row = await pendingReply(client, empresaId, replyId);
  const card = pendingCard(row, empresaId, now);
  if (!card || row.conversa_id !== conversationId || String(row.lock_version) !== String(generation)) return { skipped: true };
  const due = new Date(new Date(row.sent_at).getTime() + LEAD_NAME_WAIT_MS);
  if (now < due) return { deferUntil: due.toISOString() };
  const anchor = Math.max(Number(row.source_sequence), Number(row.outbound_payload.inboundTurnSequence) || 0);
  const changed = (await client.query(`SELECT 1 FROM mensagens WHERE empresa_id=$1 AND conversa_id=$2
    AND (direcao='entrada' AND (sequence>$3 OR redacted_at IS NOT NULL OR expires_at<=$4)
      OR sequence>$5 AND direcao='saida' AND origem_resposta<>'ia') LIMIT 1`,
  [empresaId, conversationId, anchor, now, row.sequence])).rowCount;
  if (changed || !row.route_enabled) return { skipped: true };
  const lead = (await client.query(`INSERT INTO qualified_leads(empresa_id,conversa_id,contato_id,reply_id,config_version,name,summary,qualification,phone)
    VALUES($1,$2,$3,$4,$5,NULL,$6,$7,$8) ON CONFLICT(empresa_id,conversa_id) DO NOTHING RETURNING id`,
  [empresaId, conversationId, row.contato_id, replyId, card.configVersion, card.summary, card.qualification, row.telefone_normalizado])).rows[0];
  if (!lead) return { skipped: true };
  await client.query(`INSERT INTO group_notifier_deliveries(empresa_id,lead_id,group_id,route_revision,sender_phone)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(empresa_id,lead_id) DO NOTHING`,
  [empresaId, lead.id, row.group_id, row.route_revision, row.sender_phone]);
  if (row.compiled.configuration.ai.leadImageHandoffEnabled === true) {
    const lastInbound = (await client.query(`SELECT id FROM mensagens WHERE empresa_id=$1 AND conversa_id=$2
      AND direcao='entrada' AND sequence<=$3 ORDER BY sequence DESC LIMIT 1`, [empresaId, conversationId, anchor])).rows[0];
    if (lastInbound) await queueLeadImages(client, { empresaId, conversationId, messageId: lastInbound.id });
  }
  await client.query(`UPDATE conversas SET modo_atendimento='pausado',lock_version=lock_version+1,updated_at=now()
    WHERE empresa_id=$1 AND id=$2 AND modo_atendimento='bot'`, [empresaId, conversationId]);
  // Closing the triage cancels both prepared and future follow-up actions.
  await client.query(`UPDATE follow_up_cycles SET enabled=false,state='cancelled',reason='LEAD_WITHOUT_NAME',version=version+1,updated_at=now()
    WHERE empresa_id=$1 AND conversa_id=$2 AND enabled`, [empresaId, conversationId]);
  await client.query(`UPDATE follow_up_actions a SET state='cancelled',reason='LEAD_WITHOUT_NAME',updated_at=now()
    FROM follow_up_cycles f WHERE f.empresa_id=$1 AND f.conversa_id=$2 AND a.empresa_id=f.empresa_id AND a.cycle_id=f.id
      AND a.state IN ('pending','prepared')`, [empresaId, conversationId]);
  return { handedOff: true };
}
