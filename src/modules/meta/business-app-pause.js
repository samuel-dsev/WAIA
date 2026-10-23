import { withTenantTransaction } from "../../infra/postgres/transaction.js";
import { verifyCompiledTenantRuntimeConfigV2 } from "../configuration/compiler.js";

/** Authenticated phone-app echoes are control events, never inbound AI jobs. */
export class PostgresBusinessAppPause {
  constructor(pool) { this.pool = pool; }

  async receive({ empresaId, appId, numberId, recipientPhone, externalMessageId, sentAt }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const row = (await client.query(`SELECT c.id,c.contato_id,c.next_sequence,c.correlation_id,c.modo_atendimento,
          c.created_at,c.business_app_resumed_at,cr.configuracao_compilada AS compiled
        FROM conversas c JOIN contatos ct ON ct.empresa_id=c.empresa_id AND ct.id=c.contato_id
        JOIN numeros_whatsapp n ON n.empresa_id=c.empresa_id AND n.id=c.numero_whatsapp_id
        JOIN aplicativos_meta a ON a.empresa_id=n.empresa_id AND a.id=n.aplicativo_meta_id
        JOIN empresas e ON e.id=c.empresa_id
        JOIN configuracoes_revisoes cr ON cr.empresa_id=e.id AND cr.config_version=e.configuracao_ativa_versao
        WHERE c.empresa_id=$1 AND c.numero_whatsapp_id=$2 AND ct.telefone_normalizado=$3
          AND a.id=$4 AND a.modo='ycloud' AND a.estado='ativo' AND a.deleted_at IS NULL
          AND c.status='aberta' AND ct.deleted_at IS NULL AND ct.anonimizado_at IS NULL
          AND n.status='ativo' AND n.deleted_at IS NULL AND e.deleted_at IS NULL
          AND e.configuracao_runtime_modo='versionado' AND e.versao_configuracao=e.configuracao_ativa_versao
        FOR UPDATE OF c`, [empresaId, numberId, recipientPhone, appId])).rows[0];
      if (!row) return { paused: false };
      const compiled = row.compiled;
      if (!verifyCompiledTenantRuntimeConfigV2(compiled) || compiled.empresaId !== empresaId
        || compiled.configuration.humanHandoff.pauseOnBusinessAppMessage !== true) return { paused: false };
      const second = (value) => Math.floor(new Date(value).getTime() / 1000);
      // Provider timestamps may have only second precision. Exact duplicate IDs
      // are checked separately, including echoes retried after manual resumption.
      if (!Number.isFinite(second(sentAt)) || second(sentAt) < second(row.created_at)
        || (row.business_app_resumed_at && second(sentAt) < second(row.business_app_resumed_at))) return { paused: false };
      const inserted = (await client.query(`INSERT INTO mensagens
          (empresa_id,conversa_id,contato_id,numero_whatsapp_id,direcao,tipo,corpo,status,
           origem_resposta,sequence,external_message_id,provider_timestamp,correlation_id)
        VALUES ($1,$2,$3,$4,'interna','sistema','Mensagem enviada pelo WhatsApp Business. Automação mantida pausada nesta conversa.',
          'recebida','sistema',$5,$6,$7,$8)
        ON CONFLICT (empresa_id,external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING RETURNING id`,
      [empresaId, row.id, row.contato_id, numberId, row.next_sequence, externalMessageId, sentAt, row.correlation_id])).rows[0];
      if (!inserted) return { paused: false };
      await client.query(`UPDATE conversas SET next_sequence=next_sequence+1,
          modo_atendimento=CASE WHEN modo_atendimento='bot' THEN 'pausado' ELSE modo_atendimento END,
          lock_version=lock_version+1,updated_at=now() WHERE empresa_id=$1 AND id=$2`, [empresaId, row.id]);
      return { paused: row.modo_atendimento === "bot" };
    });
  }
}
