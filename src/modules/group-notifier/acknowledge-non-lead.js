import { verifyCompiledTenantRuntimeConfigV2 } from "../configuration/compiler.js";

/** Yield to the human queue after provider confirmation, without a lead or group outbox. */
export async function acknowledgeNonLeadHandoff(client, { empresaId, replyId }) {
  const row = (await client.query(`SELECT m.conversa_id,m.corpo,m.outbound_payload,cr.configuracao_compilada AS compiled
    FROM mensagens m JOIN conversas c ON c.empresa_id=m.empresa_id AND c.id=m.conversa_id
    JOIN contatos ct ON ct.empresa_id=m.empresa_id AND ct.id=m.contato_id
    JOIN empresas e ON e.id=m.empresa_id
    LEFT JOIN configuracoes_revisoes cr ON cr.empresa_id=e.id AND cr.config_version=e.configuracao_ativa_versao
    WHERE m.empresa_id=$1 AND m.id=$2 AND m.outbound_payload ? 'nonLeadHandoff'
      AND m.direcao='saida' AND m.origem_resposta='ia' AND m.external_message_id IS NOT NULL AND m.redacted_at IS NULL
      AND c.status='aberta' AND c.modo_atendimento='bot' AND e.status='ativa' AND e.deleted_at IS NULL
      AND e.configuracao_runtime_modo='versionado' AND e.versao_configuracao=e.configuracao_ativa_versao
      AND ct.deleted_at IS NULL AND ct.anonimizado_at IS NULL AND NOT ct.bloqueado AND NOT ct.bot_pausado
    FOR UPDATE OF c,m`, [empresaId, replyId])).rows[0];
  if (!row) return;
  const compiled = row.compiled, metadata = row.outbound_payload.nonLeadHandoff;
  if (!compiled || !verifyCompiledTenantRuntimeConfigV2(compiled) || compiled.empresaId !== empresaId
    || compiled.configVersion !== metadata.configVersion || compiled.configuration.ai.leadIntakeOnlyEnabled !== true
    || compiled.configuration.humanHandoff.message !== row.corpo || metadata.completedAt) return;
  await client.query(`UPDATE conversas SET modo_atendimento='pausado',lock_version=lock_version+1,updated_at=now()
    WHERE empresa_id=$1 AND id=$2 AND modo_atendimento='bot'`, [empresaId, row.conversa_id]);
  await client.query(`UPDATE mensagens SET outbound_payload=jsonb_set(outbound_payload,'{nonLeadHandoff,completedAt}',to_jsonb(now()::text))
    WHERE empresa_id=$1 AND id=$2`, [empresaId, replyId]);
}
