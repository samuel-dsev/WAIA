import { withTenantTransaction } from '../../infra/postgres/transaction.js';
import { verifyCompiledTenantRuntimeConfigV2 } from '../configuration/compiler.js';
import { AUDIO_MONTHLY_SECONDS, AUDIO_PRICE_PER_MINUTE_USD } from './audio-policy.js';

/** All quota changes and dispatch claims are serialized in PostgreSQL. Text is
 * stored only on the original message, so the existing privacy lifecycle owns it. */
export class PostgresAudioRepository {
  constructor(pool, { clock = () => new Date() } = {}) { this.pool = pool; this.clock = clock; }
  tenant(input, fn) { return withTenantTransaction(this.pool, input, ({ client }) => fn(client)); }

  async source(client, { empresaId, messageId, configVersion }) {
    // The company lock also serializes recovery of abandoned reservations in
    // other chats, without reversing conversation/account lock order.
    await client.query('SELECT id FROM empresas WHERE id=$1 FOR UPDATE', [empresaId]);
    const row = (await client.query(`SELECT m.*,e.timezone,e.status AS company_status,e.deleted_at AS company_deleted,
      e.configuracao_runtime_modo,e.versao_configuracao,e.configuracao_ativa_versao,r.configuracao_compilada AS compiled,
      c.status AS conversation_status,c.modo_atendimento,c.operador_usuario_id,
      ct.deleted_at AS contact_deleted,ct.anonimizado_at,ct.bloqueado,ct.bot_pausado,ct.consentimento_status,ct.exclusao_solicitada_at,
      n.status AS number_status,n.deleted_at AS number_deleted
      FROM mensagens m JOIN empresas e ON e.id=m.empresa_id
      JOIN conversas c ON c.empresa_id=m.empresa_id AND c.id=m.conversa_id
      JOIN contatos ct ON ct.empresa_id=m.empresa_id AND ct.id=m.contato_id
      JOIN numeros_whatsapp n ON n.empresa_id=m.empresa_id AND n.id=m.numero_whatsapp_id
      LEFT JOIN configuracoes_revisoes r ON r.empresa_id=e.id AND r.config_version=e.configuracao_ativa_versao
      WHERE m.empresa_id=$1 AND m.id=$2 FOR UPDATE OF c,m`, [empresaId, messageId])).rows[0];
    const compiled = row?.compiled;
    const allowed = Boolean(row && row.tipo === 'audio' && row.direcao === 'entrada'
      && !row.redacted_at && (!row.expires_at || new Date(row.expires_at) > this.clock())
      && row.company_status === 'ativa' && !row.company_deleted && row.configuracao_runtime_modo === 'versionado'
      && Number(row.versao_configuracao) === Number(row.configuracao_ativa_versao)
      && row.conversation_status === 'aberta' && row.modo_atendimento === 'bot' && !row.operador_usuario_id
      && !row.contact_deleted && !row.anonimizado_at && !row.bloqueado && !row.bot_pausado
      && row.consentimento_status !== 'revogado' && !row.exclusao_solicitada_at
      && row.number_status === 'ativo' && !row.number_deleted
      && compiled && verifyCompiledTenantRuntimeConfigV2(compiled) && compiled.empresaId === empresaId
      && compiled.configVersion === configVersion && compiled.configuration.modules.includes('ai_freeform')
      && compiled.configuration.ai.enabled && compiled.configuration.ai.audioTranscriptionEnabled === true
      && compiled.configuration.ai.provider === 'openai' && compiled.configuration.ai.keyMode !== 'simulated');
    return { allowed, row };
  }

  eligible(input) { return this.tenant(input, async client => (await this.source(client, input)).allowed); }

  async releaseReserved(client, { empresaId, messageId = null, expiredBefore = null }) {
    const { rows } = await client.query(`SELECT * FROM audio_transcription_usage WHERE empresa_id=$1 AND status='reserved'
      AND ($2::uuid IS NULL OR message_id=$2) AND ($3::timestamptz IS NULL OR lease_until<=$3) FOR UPDATE`, [empresaId, messageId, expiredBefore]);
    for (const usage of rows) {
      await client.query('UPDATE audio_quota_accounts SET seconds_reserved=seconds_reserved-$3,updated_at=now() WHERE empresa_id=$1 AND periodo=$2', [empresaId, usage.periodo, usage.seconds]);
      await client.query("UPDATE audio_transcription_usage SET status='cancelled',updated_at=now() WHERE empresa_id=$1 AND id=$2", [empresaId, usage.id]);
      await client.query(`UPDATE mensagens SET audio_transcription_status='failed',updated_at=now()
        WHERE empresa_id=$1 AND id=$2 AND audio_transcription_status='processing'`, [empresaId, usage.message_id]);
    }
  }

  cancelPending(input) {
    return this.tenant(input, async client => {
      await this.source(client, input);
      await this.releaseReserved(client, input);
    });
  }

  reject(input, status) {
    return this.tenant(input, async client => {
      if (!(await this.source(client, input)).allowed) return { blocked: true };
      await client.query(`UPDATE mensagens SET audio_transcription_status=$3,updated_at=now()
        WHERE empresa_id=$1 AND id=$2 AND audio_transcription_status IS NULL`, [input.empresaId, input.messageId, status]);
      return { status };
    });
  }

  reserve(input) {
    if (!Number.isSafeInteger(input.seconds) || input.seconds < 1 || input.seconds > AUDIO_MONTHLY_SECONDS) throw new TypeError('Duração inválida.');
    return this.tenant(input, async client => {
      const { allowed, row } = await this.source(client, input);
      if (!allowed) return { blocked: true };
      await this.releaseReserved(client, { empresaId: input.empresaId, expiredBefore: this.clock() });
      if (row.audio_transcription_status && row.audio_transcription_status !== 'processing') {
        return { status: row.audio_transcription_status, text: row.audio_transcription || null };
      }
      const existing = (await client.query('SELECT * FROM audio_transcription_usage WHERE empresa_id=$1 AND message_id=$2 FOR UPDATE',
        [input.empresaId, input.messageId])).rows[0];
      if (existing) {
        if (existing.status === 'reserved') return { allowed: true, reservationId: existing.id };
        if (existing.status === 'started' && new Date(existing.lease_until) > this.clock()) return { deferUntil: new Date(existing.lease_until).toISOString() };
        if (existing.status === 'started') {
          await client.query("UPDATE audio_transcription_usage SET status='uncertain',updated_at=now() WHERE empresa_id=$1 AND id=$2", [input.empresaId, existing.id]);
          await client.query("UPDATE mensagens SET audio_transcription_status='uncertain',updated_at=now() WHERE empresa_id=$1 AND id=$2", [input.empresaId, input.messageId]);
        }
        return { status: existing.status === 'started' ? 'uncertain' : existing.status };
      }
      const period = (await client.query("SELECT date_trunc('month',$1::timestamptz AT TIME ZONE $2)::date::text AS period", [this.clock(), row.timezone])).rows[0].period;
      await client.query('INSERT INTO audio_quota_accounts(empresa_id,periodo) VALUES($1,$2) ON CONFLICT DO NOTHING', [input.empresaId, period]);
      const account = (await client.query('SELECT * FROM audio_quota_accounts WHERE empresa_id=$1 AND periodo=$2 FOR UPDATE', [input.empresaId, period])).rows[0];
      if (account.seconds_used + account.seconds_reserved + input.seconds > AUDIO_MONTHLY_SECONDS) {
        await client.query("UPDATE mensagens SET audio_transcription_status='quota_exceeded',updated_at=now() WHERE empresa_id=$1 AND id=$2", [input.empresaId, input.messageId]);
        return { status: 'quota_exceeded' };
      }
      const reservation = (await client.query(`INSERT INTO audio_transcription_usage(empresa_id,message_id,periodo,seconds,status,config_version,lease_until)
        VALUES($1,$2,$3,$4,'reserved',$5,$6) RETURNING id`, [input.empresaId, input.messageId, period, input.seconds, input.configVersion,
        new Date(+this.clock() + 120_000)])).rows[0];
      await client.query('UPDATE audio_quota_accounts SET seconds_reserved=seconds_reserved+$3,updated_at=now() WHERE empresa_id=$1 AND periodo=$2', [input.empresaId, period, input.seconds]);
      await client.query("UPDATE mensagens SET audio_transcription_status='processing',audio_duration_seconds=$3,updated_at=now() WHERE empresa_id=$1 AND id=$2", [input.empresaId, input.messageId, input.seconds]);
      return { allowed: true, reservationId: reservation.id };
    });
  }

  start(input) {
    return this.tenant(input, async client => {
      const { allowed } = await this.source(client, input);
      const usage = (await client.query("SELECT * FROM audio_transcription_usage WHERE empresa_id=$1 AND id=$2 AND message_id=$3 AND status='reserved' FOR UPDATE",
        [input.empresaId, input.reservationId, input.messageId])).rows[0];
      if (!usage) return false;
      // Recompute the calendar before dispatch; a reservation from the previous
      // month is cancelled and can never be charged to the new month's quota.
      const samePeriod = (await client.query(`SELECT $2::date=date_trunc('month',$3::timestamptz AT TIME ZONE timezone)::date AS same
        FROM empresas WHERE id=$1`, [input.empresaId, usage.periodo, this.clock()])).rows[0]?.same;
      await client.query(`UPDATE audio_quota_accounts SET seconds_reserved=seconds_reserved-$3,
        seconds_used=seconds_used+$4,updated_at=now() WHERE empresa_id=$1 AND periodo=$2`, [input.empresaId, usage.periodo, usage.seconds, allowed && samePeriod ? usage.seconds : 0]);
      await client.query(`UPDATE audio_transcription_usage SET status=$3,started_at=CASE WHEN $3='started' THEN now() ELSE NULL END,
        estimated_cost_usd=$4,lease_until=$5,updated_at=now() WHERE empresa_id=$1 AND id=$2`,
      [input.empresaId, usage.id, allowed && samePeriod ? 'started' : 'cancelled', allowed && samePeriod ? usage.seconds / 60 * AUDIO_PRICE_PER_MINUTE_USD : 0, new Date(+this.clock()+120_000)]);
      if (!allowed || !samePeriod) await client.query(`UPDATE mensagens SET audio_transcription_status='failed',updated_at=now()
        WHERE empresa_id=$1 AND id=$2 AND audio_transcription_status='processing'`, [input.empresaId, input.messageId]);
      return allowed && samePeriod;
    });
  }

  finish(input, { status, text = null, providerSeconds = null }) {
    if (!['completed','failed','uncertain','empty'].includes(status)) throw new TypeError('Estado inválido.');
    return this.tenant(input, async client => {
      const { allowed } = await this.source(client, input);
      const result = await client.query(`UPDATE audio_transcription_usage SET status=$4,provider_seconds=$5,completed_at=now(),updated_at=now()
        WHERE empresa_id=$1 AND id=$2 AND message_id=$3 AND status='started' RETURNING id`,
      [input.empresaId, input.reservationId, input.messageId, status, providerSeconds]);
      if (!result.rowCount) return { blocked: true };
      if (!allowed) {
        await client.query(`UPDATE mensagens SET audio_transcription_status='failed',updated_at=now()
          WHERE empresa_id=$1 AND id=$2 AND audio_transcription_status='processing'`, [input.empresaId, input.messageId]);
        return { blocked: true };
      }
      await client.query('UPDATE mensagens SET audio_transcription=$3,audio_transcription_status=$4,updated_at=now() WHERE empresa_id=$1 AND id=$2',
        [input.empresaId, input.messageId, status === 'completed' ? text : null, status]);
      return { status, text: status === 'completed' ? text : null };
    });
  }
}
