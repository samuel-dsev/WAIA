import { verifyCompiledTenantRuntimeConfigV2 } from "../configuration/compiler.js";

// Called inside the existing response-ack transaction, before commit.
export async function acknowledgeQualification(client, { empresaId, replyId }) {
  const row = (await client.query(`SELECT m.conversa_id,m.contato_id,m.outbound_payload,ct.telefone_normalizado,
    cr.configuracao_compilada AS compiled,r.group_id,r.revision,r.sender_phone,r.enabled
    FROM mensagens m JOIN conversas c ON c.empresa_id=m.empresa_id AND c.id=m.conversa_id
    JOIN contatos ct ON ct.empresa_id=m.empresa_id AND ct.id=m.contato_id
    JOIN empresas e ON e.id=m.empresa_id
    LEFT JOIN configuracoes_revisoes cr ON cr.empresa_id=e.id AND cr.config_version=e.configuracao_ativa_versao
    LEFT JOIN group_notifier_routes r ON r.empresa_id=e.id
    WHERE m.empresa_id=$1 AND m.id=$2 AND m.outbound_payload ? 'leadQualification'
      AND m.direcao='saida' AND m.external_message_id IS NOT NULL AND m.redacted_at IS NULL
      AND c.status='aberta' AND c.modo_atendimento='bot' AND e.status='ativa' AND e.deleted_at IS NULL
      AND e.configuracao_runtime_modo='versionado' AND e.versao_configuracao=e.configuracao_ativa_versao
      AND ct.deleted_at IS NULL AND ct.anonimizado_at IS NULL AND NOT ct.bloqueado AND NOT ct.bot_pausado
    FOR UPDATE OF c,m`, [empresaId, replyId])).rows[0];
  if (!row) return;
  const lead = row.outbound_payload.leadQualification;
  const compiled = row.compiled;
  if (!compiled || !verifyCompiledTenantRuntimeConfigV2(compiled) || compiled.empresaId !== empresaId
    || compiled.configVersion !== lead.configVersion || compiled.configuration.ai.leadQualificationEnabled !== true) return;
  for (const [key, min, max] of [["name", 2, 200], ["summary", 10, 1600], ["qualification", 3, 300]]) {
    if (typeof lead[key] !== "string" || lead[key].trim().length < min || lead[key].length > max) throw Object.assign(new Error("Triagem inválida."), { code: "LEAD_QUALIFICATION_INVALID" });
  }
  const created = (await client.query(`INSERT INTO qualified_leads(empresa_id,conversa_id,contato_id,reply_id,config_version,name,summary,qualification,phone)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(empresa_id,conversa_id) DO NOTHING RETURNING id`,
  [empresaId, row.conversa_id, row.contato_id, replyId, lead.configVersion, lead.name, lead.summary, lead.qualification, row.telefone_normalizado])).rows[0];
  if (!created) return;
  if (row.enabled) await client.query(`INSERT INTO group_notifier_deliveries(empresa_id,lead_id,group_id,route_revision,sender_phone)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT(empresa_id,lead_id) DO NOTHING`, [empresaId, created.id, row.group_id, row.revision, row.sender_phone]);
  await client.query(`UPDATE conversas SET modo_atendimento='pausado',lock_version=lock_version+1,updated_at=now()
    WHERE empresa_id=$1 AND id=$2 AND modo_atendimento='bot'`, [empresaId, row.conversa_id]);
}
