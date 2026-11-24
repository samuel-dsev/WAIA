import { verifyCompiledTenantRuntimeConfigV2 } from "../configuration/compiler.js";

export const LEAD_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

export async function readGroupDelivery(client, id) {
  return (await client.query(`SELECT d.*,l.name,coalesce(l.summary,h.summary) AS summary,
    CASE WHEN h.id IS NOT NULL THEN 'Baixa qualificação — triagem incompleta após follow-up.' ELSE l.qualification END AS qualification,
    coalesce(l.phone,h.phone) AS phone,coalesce(l.redacted_at,h.redacted_at) AS redacted_at,coalesce(l.config_version,h.config_version) AS config_version,
    coalesce(l.conversa_id,h.conversa_id) AS conversa_id,
    (EXISTS(SELECT 1 FROM qualified_leads q WHERE q.empresa_id=h.empresa_id AND q.conversa_id=h.conversa_id)
      OR EXISTS(SELECT 1 FROM mensagens source WHERE source.empresa_id=h.empresa_id AND source.id=ANY(h.source_message_ids)
        AND (source.redacted_at IS NOT NULL OR source.expires_at<=now()))) AS superseded,
    (l.id IS NOT NULL AND EXISTS(SELECT 1 FROM follow_up_cycles f JOIN follow_up_actions a ON a.empresa_id=f.empresa_id AND a.cycle_id=f.id
      WHERE f.empresa_id=l.empresa_id AND f.conversa_id=l.conversa_id AND a.state='accepted')) AS follow_up_recovered,
    e.nome_exibicao AS company_name,e.status AS company_status,e.deleted_at AS company_deleted,
    e.configuracao_runtime_modo,e.versao_configuracao,e.configuracao_ativa_versao,
    c.status AS conversation_status,ct.deleted_at AS contact_deleted,ct.bloqueado AS blocked,ct.anonimizado_at,
    ct.bot_pausado AS contact_paused,n.status AS number_status,n.deleted_at AS number_deleted,
    r.enabled AS route_enabled,r.group_id AS current_group,r.revision AS current_revision,r.sender_phone AS current_sender,
    s.desired,s.phone AS actual_sender,s.phase,s.lease_until,cr.configuracao_compilada AS compiled
    FROM group_notifier_deliveries d LEFT JOIN qualified_leads l ON l.empresa_id=d.empresa_id AND l.id=d.lead_id
    LEFT JOIN follow_up_handoffs h ON h.empresa_id=d.empresa_id AND h.id=d.follow_up_handoff_id
    JOIN empresas e ON e.id=d.empresa_id JOIN conversas c ON c.empresa_id=d.empresa_id AND c.id=coalesce(l.conversa_id,h.conversa_id)
    JOIN contatos ct ON ct.empresa_id=d.empresa_id AND ct.id=coalesce(l.contato_id,h.contato_id)
    JOIN numeros_whatsapp n ON n.empresa_id=c.empresa_id AND n.id=c.numero_whatsapp_id
    LEFT JOIN group_notifier_routes r ON r.empresa_id=d.empresa_id JOIN group_notifier_connection s ON s.id
    LEFT JOIN configuracoes_revisoes cr ON cr.empresa_id=e.id AND cr.config_version=e.configuracao_ativa_versao
    WHERE d.id=$1 FOR UPDATE OF d`, [id])).rows[0];
}

export function groupDeliveryAllowed(row) {
  return Boolean(row && row.configuracao_runtime_modo === "versionado" && Number(row.versao_configuracao) === Number(row.configuracao_ativa_versao)
    && row.compiled && verifyCompiledTenantRuntimeConfigV2(row.compiled)
    && row.compiled.empresaId === row.empresa_id && row.compiled.configVersion === Number(row.config_version)
    && row.compiled.configuration.ai.enabled && (row.follow_up_handoff_id ? !row.superseded : row.compiled.configuration.ai.leadQualificationEnabled === true)
    && row.company_status === "ativa" && !row.company_deleted && row.conversation_status === "aberta"
    && !row.contact_deleted && !row.blocked && !row.anonimizado_at && !row.contact_paused && !row.redacted_at
    && row.number_status === "ativo" && !row.number_deleted && row.route_enabled
    && row.current_group === row.group_id && Number(row.current_revision) === Number(row.route_revision)
    && row.current_sender === row.sender_phone && row.actual_sender === row.sender_phone);
}

/** Called inside an ack transaction, or for a later image in the same named lead.
 * Row locking serializes photo arrivals with notifier completion and retries. */
export async function queueLeadImages(client, { empresaId, conversationId, messageId }) {
  const lead = (await client.query(`SELECT l.id,l.config_version,l.name,r.group_id,r.revision,r.sender_phone,cr.configuracao_compilada AS compiled,
      anchor.sequence FROM qualified_leads l JOIN empresas e ON e.id=l.empresa_id
      JOIN configuracoes_revisoes cr ON cr.empresa_id=e.id AND cr.config_version=e.configuracao_ativa_versao
      JOIN group_notifier_routes r ON r.empresa_id=l.empresa_id AND r.enabled
      JOIN mensagens anchor ON anchor.empresa_id=l.empresa_id AND anchor.conversa_id=l.conversa_id AND anchor.id=$3
      JOIN contatos ct ON ct.empresa_id=l.empresa_id AND ct.id=l.contato_id
      JOIN conversas c ON c.empresa_id=l.empresa_id AND c.id=l.conversa_id
    WHERE l.empresa_id=$1 AND l.conversa_id=$2 AND l.redacted_at IS NULL
      AND e.status='ativa' AND e.deleted_at IS NULL AND e.configuracao_runtime_modo='versionado'
      AND e.versao_configuracao=e.configuracao_ativa_versao AND l.config_version=e.configuracao_ativa_versao
      AND ct.deleted_at IS NULL AND ct.anonimizado_at IS NULL AND NOT ct.bloqueado AND NOT ct.bot_pausado
      AND c.status='aberta' AND anchor.direcao='entrada' AND anchor.redacted_at IS NULL
      AND (anchor.expires_at IS NULL OR anchor.expires_at>now())`, [empresaId, conversationId, messageId])).rows[0];
  if (!lead || !verifyCompiledTenantRuntimeConfigV2(lead.compiled) || lead.compiled.empresaId !== empresaId
    || lead.compiled.configuration.ai.leadImageHandoffEnabled !== true) return { queued: 0 };
  await client.query(`INSERT INTO group_notifier_deliveries(empresa_id,lead_id,group_id,route_revision,sender_phone)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(empresa_id,lead_id) DO NOTHING`, [empresaId, lead.id, lead.group_id, lead.revision, lead.sender_phone]);
  const delivery = (await client.query(`SELECT * FROM group_notifier_deliveries WHERE empresa_id=$1 AND lead_id=$2 FOR UPDATE`, [empresaId, lead.id])).rows[0];
  if (!["pending", "sending", "accepted"].includes(delivery.status) || delivery.group_id !== lead.group_id
    || Number(delivery.route_revision) !== Number(lead.revision) || delivery.sender_phone !== lead.sender_phone) return { queued: 0 };
  const images = (await client.query(`SELECT m.id FROM mensagens m WHERE m.empresa_id=$1 AND m.conversa_id=$2
    AND m.direcao='entrada' AND m.tipo='imagem' AND m.sequence<=$3 AND m.redacted_at IS NULL
    AND (m.expires_at IS NULL OR m.expires_at>now()) AND m.media_storage_key IS NOT NULL
    AND m.media_mime_type=ANY($5::text[]) AND m.media_sha256 ~ '^[a-f0-9]{64}$' AND m.media_size_bytes>0
    AND NOT EXISTS(SELECT 1 FROM group_notifier_delivery_parts p WHERE p.empresa_id=m.empresa_id AND p.delivery_id=$4 AND p.source_message_id=m.id)
    ORDER BY m.sequence`, [empresaId, conversationId, lead.sequence, delivery.id, LEAD_IMAGE_MIME_TYPES])).rows;
  if (!images.length) return { queued: 0 };
  const last = (await client.query(`SELECT max(position) AS position FROM group_notifier_delivery_parts WHERE empresa_id=$1 AND delivery_id=$2`, [empresaId, delivery.id])).rows[0];
  let position = last.position === null ? 0 : Number(last.position) + 1;
  if (position === 0 || delivery.status === "accepted") {
    await client.query(`INSERT INTO group_notifier_delivery_parts(empresa_id,delivery_id,position,kind) VALUES($1,$2,$3,'summary')`, [empresaId, delivery.id, position++]);
  }
  for (const image of images) await client.query(`INSERT INTO group_notifier_delivery_parts(empresa_id,delivery_id,position,kind,source_message_id)
    VALUES($1,$2,$3,'image',$4)`, [empresaId, delivery.id, position++, image.id]);
  if (delivery.status === "accepted") await client.query(`UPDATE group_notifier_deliveries SET status='pending',error_code=NULL,available_at=now(),updated_at=now() WHERE id=$1`, [delivery.id]);
  return { queued: images.length };
}
