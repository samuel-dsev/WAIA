import { randomUUID } from 'node:crypto';
import { withTenantTransaction } from '../../infra/postgres/transaction.js';
import { requireTenantAccess, requirePlatformAdmin } from '../admin/authorization.js';
const readCompanyPolicy = async () => ({ legacy: true });
import { readChannelExecutionGate } from './stable-policy.js';
import { verifyCompiledTenantRuntimeConfigV2 } from '../configuration/compiler.js';
import { scheduleOptions, parseFollowUp, settingsSchema, contactSchema, followUpError, declinesFollowUp, AVAILABILITY_MESSAGE } from './policy.js';

const missing = () => followUpError('FOLLOW_UP_NOT_FOUND', 'Conversa não encontrada.', 404);
const conflict = () => followUpError('FOLLOW_UP_CONFLICT', 'O follow-up mudou. Atualize a conversa.');
const allowed = (_rights, settings) => settings?.legacy_pilot === true;
const defaults = { enabled: false, profile: 'test', version: 0 };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);

export class FollowUpRepository {
  constructor({ pool, clock = () => new Date() }) { Object.assign(this, { pool, clock }); }
  tenant(empresaId, fn) { return withTenantTransaction(this.pool, { empresaId }, ({ client }) => fn(client)); }
  async access(auth, empresaId, write, settings, fn) {
    if (!uuid(empresaId)) throw missing();
    if (auth?.audience === 'customer') throw followUpError('FOLLOW_UP_ACCESS_DENIED','Use o painel administrativo.',403);
    const actor = settings && write ? requirePlatformAdmin(auth) : requireTenantAccess(auth, empresaId, { permission: write ? 'conversations.update' : 'conversations.read' });
    return withTenantTransaction(this.pool, { empresaId, usuarioId: actor.actorId }, async ({ client }) => {
      if (!(await client.query(`SELECT id FROM empresas WHERE id=$1 AND deleted_at IS NULL FOR ${write ? 'UPDATE' : 'SHARE'}`, [empresaId])).rowCount) throw missing();
      if (actor.platformRole !== 'platform_admin') {
        const member = (await client.query(`SELECT 1 FROM usuarios_empresas m JOIN usuarios u ON u.id=m.usuario_id
          WHERE m.empresa_id=$1 AND m.usuario_id=$2 AND m.status='ativo' AND u.status='ativo' AND u.deleted_at IS NULL
          AND m.permissoes @> $3::text[] FOR SHARE OF m,u`, [empresaId, actor.actorId, [write ? 'conversations.update' : 'conversations.read']])).rowCount;
        if (!member) throw followUpError('FOLLOW_UP_ACCESS_DENIED', 'Acesso indisponível.', 403);
      }
      return fn(client, actor.platformRole === 'platform_admin');
    });
  }
  async audit(client, empresaId, actorId, action, id) {
    await client.query(`INSERT INTO logs_auditoria(empresa_id,ator_usuario_id,acao,recurso_tipo,recurso_id,resultado,campos_alterados_redigidos)
      VALUES($1,$2,$3,'follow_up',$4,'sucesso','{"fields":["enabled","profile"]}')`, [empresaId, actorId, action, id]);
  }
  async settings(client, empresaId) {
    const row = (await client.query('SELECT * FROM follow_up_settings WHERE empresa_id=$1', [empresaId])).rows[0];
    return row || { ...defaults };
  }
  async lastCycle(client, empresaId, conversationId) {
    return (await client.query(`SELECT * FROM follow_up_cycles WHERE empresa_id=$1 AND conversa_id=$2 ORDER BY version DESC LIMIT 1`, [empresaId, conversationId])).rows[0];
  }
  async view(client, empresaId, conversationId) {
    const settings = await this.settings(client, empresaId), cycle = conversationId ? await this.lastCycle(client, empresaId, conversationId) : null;
    const actions = cycle ? (await client.query(`SELECT slot,is_closure AS "isClosure",due_at AS "dueAt",state,reason FROM follow_up_actions WHERE empresa_id=$1 AND cycle_id=$2 ORDER BY slot`, [empresaId, cycle.id])).rows : [];
    const handoff = cycle ? (await client.query(`SELECT h.id,d.status FROM follow_up_handoffs h LEFT JOIN group_notifier_deliveries d ON d.empresa_id=h.empresa_id AND d.follow_up_handoff_id=h.id
      WHERE h.empresa_id=$1 AND h.cycle_id=$2 AND h.redacted_at IS NULL`, [empresaId, cycle.id])).rows[0] : null;
    const schedule = settings.periods_hours ? { periodsHours: settings.periods_hours, closeAfterHours: settings.close_after_hours } : scheduleOptions(settings);
    return { settings: { enabled: settings.enabled, profile: settings.profile, version: Number(settings.version), ...schedule, templates: settings.templates || [null,null,null,null] },
      contact: { enabled: cycle?.enabled === true, version: Number(cycle?.version || 0), state: cycle?.state || 'disabled', reason: cycle?.reason || null,
        startedAt: cycle?.started_at || null, profile: cycle?.profile || settings.profile, actions, notificationStatus: handoff ? handoff.status || 'awaiting_route' : null } };
  }
  read(auth, empresaId, conversationId) {
    return this.access(auth, empresaId, false, false, async client => {
      if (conversationId && !await this.conversation(client, empresaId, conversationId)) throw missing();
      return this.view(client, empresaId, conversationId);
    });
  }
  saveSettings(auth, empresaId, body) {
    const input = parseFollowUp(settingsSchema, body);
    return this.access(auth, empresaId, true, true, async (client, platform) => {
      const current = await this.settings(client, empresaId);
      if (Number(current.version) !== input.expectedVersion) throw conflict();
      const rights = await readCompanyPolicy(client, empresaId, this.clock());
      const legacyPilot = rights.legacy && platform;
      const schedule = scheduleOptions(input);
      const templates = input.templates || current.templates || [];
      if (input.templates && input.templates.length !== schedule.periodsHours.length) throw followUpError('FOLLOW_UP_INVALID','Defina um template opcional para cada período.',422);
      if (input.enabled && !allowed(rights, { legacy_pilot: legacyPilot })) throw followUpError('FOLLOW_UP_RESOURCE_DENIED', 'Follow-up indisponível neste plano.', 403);
      if (input.enabled && !await this.activeConfiguration(client, empresaId)) throw followUpError('FOLLOW_UP_BOT_REQUIRED', 'Ative o bot da empresa antes do follow-up.');
      await client.query(`INSERT INTO follow_up_settings(empresa_id,enabled,profile,legacy_pilot,templates,periods_hours,close_after_hours) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
        ON CONFLICT(empresa_id) DO UPDATE SET enabled=$2,profile=$3,legacy_pilot=$4,templates=$5::jsonb,periods_hours=$6,close_after_hours=$7,version=follow_up_settings.version+1,updated_at=now()`,
      [empresaId, input.enabled, input.profile, legacyPilot, JSON.stringify(schedule.periodsHours.map((_,i)=>templates[i] || null)), schedule.periodsHours, schedule.closeAfterHours]);
      // A configuration change never replays an old cycle or enables a contact.
      await client.query(`UPDATE follow_up_cycles SET enabled=false,state='cancelled',reason='SETTINGS_CHANGED',version=version+1,updated_at=now() WHERE empresa_id=$1 AND enabled`, [empresaId]);
      await client.query(`UPDATE follow_up_actions SET state='cancelled',reason='SETTINGS_CHANGED' WHERE empresa_id=$1 AND state IN ('pending','prepared')`, [empresaId]);
      await this.audit(client, empresaId, auth.user.id, 'follow_up.settings', empresaId);
      return this.view(client, empresaId);
    });
  }
  async conversation(client, empresaId, id, lock = false) {
    if (!uuid(id)) throw missing();
    return (await client.query(`SELECT c.*,ct.telefone_normalizado AS phone,ct.bot_pausado,ct.bloqueado,ct.consentimento_status,ct.exclusao_solicitada_at,
      n.status AS number_status,n.deleted_at AS number_deleted FROM conversas c JOIN contatos ct ON ct.empresa_id=c.empresa_id AND ct.id=c.contato_id
      JOIN numeros_whatsapp n ON n.empresa_id=c.empresa_id AND n.id=c.numero_whatsapp_id
      WHERE c.empresa_id=$1 AND c.id=$2 AND ct.deleted_at IS NULL AND ct.anonimizado_at IS NULL
      ${lock ? 'FOR UPDATE OF c' : ''}`, [empresaId, id])).rows[0];
  }
  async activeConfiguration(client, empresaId) {
    const row = (await client.query(`SELECT e.configuracao_ativa_versao AS version,r.configuracao_compilada AS compiled
      FROM empresas e JOIN configuracoes_revisoes r ON r.empresa_id=e.id AND r.config_version=e.configuracao_ativa_versao
      WHERE e.id=$1 AND e.status='ativa' AND e.deleted_at IS NULL AND e.configuracao_runtime_modo='versionado'
      AND e.versao_configuracao=e.configuracao_ativa_versao`, [empresaId])).rows[0];
    return row && verifyCompiledTenantRuntimeConfigV2(row.compiled) && row.compiled.empresaId === empresaId
      && row.compiled.configuration.ai.enabled === true ? row : null;
  }
  async cancel(client, empresaId, cycleId, reason, state = 'cancelled') {
    await client.query(`UPDATE follow_up_cycles SET enabled=false,state=$4,reason=$3,version=version+1,updated_at=now() WHERE empresa_id=$1 AND id=$2`, [empresaId, cycleId, reason, state]);
    await client.query(`UPDATE follow_up_actions SET state='cancelled',reason=$3,updated_at=now() WHERE empresa_id=$1 AND cycle_id=$2 AND state IN ('pending','prepared')`, [empresaId, cycleId, reason]);
    await client.query(`UPDATE mensagens m SET status='ignorada_duplicidade' FROM follow_up_actions a WHERE a.empresa_id=$1
      AND a.cycle_id=$2 AND a.message_id=m.id AND a.state='cancelled' AND m.external_message_id IS NULL AND m.status='enfileirada'`, [empresaId, cycleId]);
  }
  toggle(auth, empresaId, conversationId, body) {
    const input = parseFollowUp(contactSchema, body);
    return this.access(auth, empresaId, true, false, async client => {
      const c = await this.conversation(client, empresaId, conversationId, true);
      if (!c) throw missing();
      const old = await this.lastCycle(client, empresaId, conversationId);
      if (Number(old?.version || 0) !== input.expectedVersion) throw conflict();
      if (old?.enabled === input.enabled) return this.view(client, empresaId, conversationId);
      if (old?.enabled) await this.cancel(client, empresaId, old.id, 'CONTACT_DISABLED');
      if (input.enabled) {
        const settings = await this.settings(client, empresaId), rights = await readCompanyPolicy(client, empresaId, this.clock());
        if (!settings.enabled || !allowed(rights, settings)) throw followUpError('FOLLOW_UP_COMPANY_DISABLED', 'Habilite o follow-up da empresa primeiro.');
        if (!await this.activeConfiguration(client, empresaId) || c.modo_atendimento !== 'bot' || c.status !== 'aberta' || c.bot_pausado || c.bloqueado
          || c.consentimento_status === 'revogado' || c.exclusao_solicitada_at || c.number_status !== 'ativo' || c.number_deleted)
          throw followUpError('FOLLOW_UP_BOT_REQUIRED', 'O contato precisa estar com o bot ativo e disponível.');
        const source = (await client.query(`SELECT 1 FROM mensagens WHERE empresa_id=$1 AND conversa_id=$2 AND direcao='entrada' AND redacted_at IS NULL
          AND (expires_at IS NULL OR expires_at>$3) AND NOT coalesce(outbound_payload->>'historical','false')='true' LIMIT 1`, [empresaId, conversationId, this.clock()])).rowCount;
        if (!source) throw followUpError('FOLLOW_UP_CONTEXT_REQUIRED', 'A conversa precisa ter histórico disponível.');
        if ((await client.query('SELECT 1 FROM qualified_leads WHERE empresa_id=$1 AND conversa_id=$2', [empresaId, conversationId])).rowCount)
          throw followUpError('FOLLOW_UP_ALREADY_COMPLETED', 'A triagem deste contato já foi concluída.');
        const id = randomUUID(), start = this.clock();
        if ((await client.query(`SELECT 1 FROM follow_up_cycles WHERE empresa_id=$1 AND contato_id=$2 AND enabled`, [empresaId,c.contato_id])).rowCount)
          throw followUpError('FOLLOW_UP_CONTACT_ACTIVE','Este contato já tem follow-up em outra conversa.');
        await client.query(`INSERT INTO follow_up_cycles(id,empresa_id,conversa_id,contato_id,profile,generation,version,started_at,periods_hours,close_after_hours)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, empresaId, conversationId, c.contato_id, settings.profile, c.lock_version, Number(old?.version || 0) + 1, start, settings.periods_hours, settings.close_after_hours]);
        const hours = [...settings.periods_hours, settings.close_after_hours];
        for (const [slot, hour] of hours.entries()) {
          const due = new Date(+start + Math.round(hour*3600000));
          const actionId = randomUUID();
          await client.query(`INSERT INTO follow_up_actions(id,empresa_id,cycle_id,slot,due_at,is_closure) VALUES($1,$2,$3,$4,$5,$6)`, [actionId, empresaId, id, slot, due, slot === hours.length-1]);
          await client.query(`INSERT INTO outbox_jobs(empresa_id,conversa_id,job_type,dedup_key,payload,disponivel_at,correlation_id)
            VALUES($1,$2,'process_follow_up',$3,$4::jsonb,$5,$6)`, [empresaId, conversationId, `follow-up:${actionId}`, JSON.stringify({ actionId, payloadVersion: 1 }), due, randomUUID()]);
        }
      }
      await this.audit(client, empresaId, auth.user.id, input.enabled ? 'follow_up.enabled' : 'follow_up.disabled', conversationId);
      return this.view(client, empresaId, conversationId);
    });
  }
  async guard(client, empresaId, actionId) {
    await client.query('SELECT id FROM empresas WHERE id=$1 FOR SHARE', [empresaId]);
    const source = (await client.query(`SELECT c.conversa_id FROM follow_up_actions a JOIN follow_up_cycles c ON c.empresa_id=a.empresa_id AND c.id=a.cycle_id WHERE a.empresa_id=$1 AND a.id=$2`, [empresaId, actionId])).rows[0];
    if (!source) return { blocked: true };
    const c = await this.conversation(client, empresaId, source.conversa_id, true);
    const row = (await client.query(`SELECT a.*,f.enabled,f.state AS cycle_state,f.generation,f.conversa_id,f.contato_id,f.profile,f.periods_hours,f.close_after_hours
      FROM follow_up_actions a JOIN follow_up_cycles f ON f.empresa_id=a.empresa_id AND f.id=a.cycle_id WHERE a.empresa_id=$1 AND a.id=$2 FOR UPDATE OF a,f`, [empresaId, actionId])).rows[0];
    if (['started','uncertain'].includes(row.state)) {
      await client.query("UPDATE follow_up_actions SET state='uncertain',reason='SEND_RECONCILIATION_REQUIRED' WHERE empresa_id=$1 AND id=$2", [empresaId, actionId]);
      await this.cancel(client, empresaId, row.cycle_id, 'SEND_RECONCILIATION_REQUIRED', 'uncertain');
      return { blocked: true, uncertain: true };
    }
    if (!['pending','prepared'].includes(row.state)) return { blocked: true };
    if (new Date(row.due_at) > this.clock()) return { deferUntil: new Date(row.due_at).toISOString() };
    const schedule = [...row.periods_hours,row.close_after_hours].map(h=>Math.round(h*3600000));
    const deadline = !row.is_closure ? new Date(new Date(row.due_at).getTime() + schedule[row.slot + 1] - schedule[row.slot]) : null;
    if (deadline && this.clock() >= deadline) {
      await client.query("UPDATE follow_up_actions SET state='cancelled',reason='SLOT_EXPIRED' WHERE empresa_id=$1 AND id=$2", [empresaId, actionId]); return { blocked: true };
    }
    const settings = await this.settings(client, empresaId), config = await this.activeConfiguration(client, empresaId), rights = await readCompanyPolicy(client, empresaId, this.clock());
    if (!c || !row.enabled || row.cycle_state !== 'active' || !settings.enabled || !allowed(rights, settings) || !config
      || c.modo_atendimento !== 'bot' || Number(c.lock_version) !== Number(row.generation) || c.status !== 'aberta' || c.bot_pausado || c.bloqueado
      || c.consentimento_status === 'revogado' || c.exclusao_solicitada_at || c.number_status !== 'ativo' || c.number_deleted) {
      await this.cancel(client, empresaId, row.cycle_id, 'AUTOMATION_UNAVAILABLE'); return { blocked: true };
    }
    const channel = await readChannelExecutionGate(client, { empresaId, numberId: c.numero_whatsapp_id, requiredResource: 'F02' });
    if (!channel.allowed) { await this.cancel(client, empresaId, row.cycle_id, 'CHANNEL_UNAVAILABLE'); return { blocked: true }; }
    const messages = (await client.query(`SELECT id,direcao,tipo,corpo,sequence,status,source_message_id,outbound_payload,external_message_id,
        coalesce(provider_timestamp,created_at) AS sent_at,created_at FROM mensagens WHERE empresa_id=$1 AND conversa_id=$2
        AND redacted_at IS NULL AND (expires_at IS NULL OR expires_at>$3) AND (direcao='entrada' OR status IN ('enviada','entregue','lida'))
        AND NOT coalesce(outbound_payload->>'historical','false')='true' ORDER BY sequence`, [empresaId, c.id, this.clock()])).rows;
    const inbound = messages.filter(m => m.direcao === 'entrada'), lastInbound = inbound.at(-1), last = messages.at(-1);
    if (!lastInbound || !last?.corpo) { await this.cancel(client, empresaId, row.cycle_id, 'CONTEXT_UNAVAILABLE'); return { blocked: true }; }
    // Wait for the normal worker; never race an unanswered customer message.
    if (last.direcao === 'entrada') return { deferUntil: new Date(this.clock().getTime() + 30_000).toISOString() };
    const watermark = Number((await client.query(`SELECT max(sequence) AS sequence FROM mensagens WHERE empresa_id=$1 AND conversa_id=$2 AND ($3::uuid IS NULL OR id<>$3)`, [empresaId, c.id, row.message_id])).rows[0].sequence);
    return { row, conversation: c, config, messages, inbound, lastInbound, watermark, templateDescriptor: settings.templates?.[row.slot] || null,
      inWindow: new Date(lastInbound.sent_at) <= this.clock()
      && this.clock().getTime() - new Date(lastInbound.sent_at).getTime() < 86_400_000 };
  }
  snapshot(empresaId, actionId) { return this.tenant(empresaId, client => this.guard(client, empresaId, actionId)); }
  prepare(empresaId, actionId, snapshot, draft, template = null) {
    return this.tenant(empresaId, async client => {
      const current = await this.guard(client, empresaId, actionId);
      if (!current.row) return current;
      const { row, conversation: c } = current;
      if (current.watermark !== snapshot.watermark || Number(current.config.version) !== Number(snapshot.config.version)) {
        await client.query("UPDATE follow_up_actions SET state='cancelled',reason='CONTEXT_CHANGED' WHERE empresa_id=$1 AND id=$2", [empresaId, actionId]); return { blocked: true };
      }
      if (row.is_closure) {
        if (current.inbound.length > 1) {
          const handoff = (await client.query(`INSERT INTO follow_up_handoffs(empresa_id,cycle_id,conversa_id,contato_id,config_version,summary,phone,source_message_ids)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(empresa_id,cycle_id) DO NOTHING RETURNING id`, [empresaId, row.cycle_id, c.id, c.contato_id, current.config.version, draft.summary, c.phone, current.messages.map(m => m.id)])).rows[0];
          if (handoff) await client.query(`INSERT INTO group_notifier_deliveries(empresa_id,follow_up_handoff_id,group_id,route_revision,sender_phone)
            SELECT $1,$2,group_id,revision,sender_phone FROM group_notifier_routes WHERE empresa_id=$1 AND enabled`, [empresaId, handoff.id]);
        }
        await this.cancel(client, empresaId, row.cycle_id, current.inbound.length > 1 ? 'LOW_QUALIFICATION' : 'NO_REPLY', 'exhausted');
        await client.query("UPDATE follow_up_actions SET state='completed',reason=$3 WHERE empresa_id=$1 AND id=$2", [empresaId, actionId, current.inbound.length > 1 ? 'LOW_QUALIFICATION' : 'NO_REPLY']);
        return { completed: true };
      }
      // Fail closed outside the provider's service window. No free-form bypass.
      if (!current.inWindow && (!template || template.name !== current.templateDescriptor?.name || template.language !== current.templateDescriptor?.language)) {
        await client.query("UPDATE follow_up_actions SET state='blocked',reason='APPROVED_TEMPLATE_REQUIRED' WHERE empresa_id=$1 AND id=$2", [empresaId, actionId]); return { blocked: true };
      }
      if (row.message_id) return { prepared: true };
      const sequence = (await client.query('UPDATE conversas SET next_sequence=next_sequence+1 WHERE empresa_id=$1 AND id=$2 RETURNING next_sequence-1 AS sequence', [empresaId, c.id])).rows[0].sequence;
      const displayedText = template ? template.body.replace(/\{\{\s*1\s*\}\}/u,draft.text) + (template.footer ? `\n${template.footer}` : '') : draft.text;
      const msg = (await client.query(`INSERT INTO mensagens(empresa_id,conversa_id,contato_id,numero_whatsapp_id,direcao,tipo,corpo,status,origem_resposta,sequence,correlation_id,outbound_payload)
        VALUES($1,$2,$3,$4,'saida','texto',$5,'enfileirada','ia',$6,$7,$8::jsonb) RETURNING id`, [empresaId, c.id, c.contato_id, c.numero_whatsapp_id, displayedText, sequence, randomUUID(), JSON.stringify({ followUpActionId: actionId, conversationGeneration: Number(row.generation),
          ...(uuid(draft.requestId) ? { followUpAiRequestId: draft.requestId } : {}),
          ...(template ? { followUpTemplate: template, followUpParameter: draft.text } : {}) })])).rows[0];
      await client.query(`UPDATE follow_up_actions SET state='prepared',watermark=$3,message_id=$4,config_version=$5 WHERE empresa_id=$1 AND id=$2`, [empresaId, actionId, current.watermark, msg.id, current.config.version]);
      return { prepared: true };
    });
  }
  claim(empresaId, actionId, template = null) {
    return this.tenant(empresaId, async client => {
      const current = await this.guard(client, empresaId, actionId);
      if (!current.row) return current;
      const { row, conversation: c } = current;
      const m = (await client.query(`SELECT corpo,outbound_payload FROM mensagens WHERE empresa_id=$1 AND id=$2 AND redacted_at IS NULL AND (expires_at IS NULL OR expires_at>$3) AND external_message_id IS NULL`, [empresaId, row.message_id, this.clock()])).rows[0];
      const storedTemplate = m?.outbound_payload?.followUpTemplate;
      const validTemplate = template && storedTemplate?.fingerprint === template.fingerprint && template.name === current.templateDescriptor?.name && template.language === current.templateDescriptor?.language;
      if (row.state !== 'prepared' || row.watermark != current.watermark || row.config_version != current.config.version
        || (storedTemplate ? !validTemplate : !current.inWindow)) {
        await client.query("UPDATE follow_up_actions SET state='cancelled',reason='DISPATCH_CHANGED' WHERE empresa_id=$1 AND id=$2", [empresaId, actionId]); return { blocked: true };
      }
      if (!m?.corpo) return { blocked: true };
      await client.query("UPDATE follow_up_actions SET state='started',updated_at=now() WHERE empresa_id=$1 AND id=$2", [empresaId, actionId]);
      return { allowed: true, messageId: row.message_id, numberId: c.numero_whatsapp_id, phone: c.phone, text: m.corpo,
        ...(storedTemplate ? { template: storedTemplate, parameter: m.outbound_payload.followUpParameter } : {}) };
    });
  }
  finish(empresaId, actionId, messageId, externalId) {
    return this.tenant(empresaId, async client => {
      await client.query(`UPDATE follow_up_actions SET state=$3,reason=$4,updated_at=now() WHERE empresa_id=$1 AND id=$2 AND state='started'`, [empresaId, actionId, externalId ? 'accepted' : 'uncertain', externalId ? null : 'SEND_RECONCILIATION_REQUIRED']);
      await client.query(`UPDATE mensagens SET external_message_id=$3,status=$4,sent_at=CASE WHEN $3::text IS NOT NULL THEN now() ELSE sent_at END,error_code=$5
        WHERE empresa_id=$1 AND id=$2 AND external_message_id IS NULL`, [empresaId, messageId, externalId || null, externalId ? 'enviada' : 'processando', externalId ? null : 'FOLLOW_UP_SEND_UNCERTAIN']);
      if (!externalId) { const a = (await client.query('SELECT cycle_id FROM follow_up_actions WHERE empresa_id=$1 AND id=$2', [empresaId, actionId])).rows[0]; if (a) await this.cancel(client, empresaId, a.cycle_id, 'SEND_RECONCILIATION_REQUIRED', 'uncertain'); }
    });
  }
}
