import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { withPlatformTransaction, withTenantTransaction } from '../src/infra/postgres/transaction.js';
import { compileTenantRuntimeConfigV2 } from '../src/modules/configuration/compiler.js';
import { PostgresAudioRepository } from '../src/modules/audio/postgres-audio-repository.js';
import { PostgresJobHandlerRepository } from '../src/modules/jobs/handlers.js';
import { PostgresConversationRepository } from '../src/modules/conversations/postgres-conversation-repository.js';
import { PostgresAdminRepository } from '../src/modules/admin/postgres-admin-repository.js';
import { loadInboundTurn } from '../src/modules/jobs/inbound-turn.js';

test('PostgreSQL: áudio tem quota mensal atômica, isolamento, recuperação sem recobrança e privacidade', {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== 'true',
}, async t => {
  assert.equal(process.env.NODE_ENV, 'test');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'waia_v2_upgrade');
  const query = (...args) => withPlatformTransaction(pool, {}, tx => tx.client.query(...args));
  const companies = [];
  let actor, serial = 0, now = new Date('2026-11-25T15:00:00Z');
  const repo = new PostgresAudioRepository(pool, { clock: () => now });
  const jobs = new PostgresJobHandlerRepository(pool, { clock: () => now });
  async function company() {
    const empresaId = (await query("INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1,'Áudio sintético','Áudio sintético','ativa') RETURNING id", [`audio-${randomUUID()}`])).rows[0].id;
    companies.push(empresaId);
    const config = { schemaVersion: 2, identity: { name: 'Empresa sintética' }, modules: ['ai_freeform'], menu: { text: 'Olá', options: [] },
      ai: { enabled: true, provider: 'openai', model: 'synthetic', prompt: 'Atenda a empresa.', audioTranscriptionEnabled: true } };
    const compiled = compileTenantRuntimeConfigV2(config, { empresaId, configVersion: 1, draftVersion: 1 });
    await query(`INSERT INTO configuracoes_revisoes(empresa_id,config_version,schema_version,compiler_version,source_draft_version,checksum,configuracao_compilada,publicada_por)
      VALUES($1,1,2,1,1,$2,$3,$4)`, [empresaId, compiled.checksum, compiled, actor]);
    await query("UPDATE empresas SET configuracao_runtime_modo='versionado',versao_configuracao=1,configuracao_ativa_versao=1 WHERE id=$1", [empresaId]);
    const numberId = (await query("INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status) VALUES($1,$2,'ativo') RETURNING id", [empresaId, randomUUID()])).rows[0].id;
    return { empresaId, numberId, compiled };
  }
  async function message(tenant, { conversation, type = 'audio', text = null } = {}) {
    const { empresaId, numberId } = tenant;
    const contactId = conversation?.contactId || (await query('INSERT INTO contatos(empresa_id,telefone_normalizado) VALUES($1,$2) RETURNING id', [empresaId, `5511${String(serial++).padStart(7,'0')}`])).rows[0].id;
    const conversationId = conversation?.conversationId || (await query('INSERT INTO conversas(empresa_id,contato_id,numero_whatsapp_id) VALUES($1,$2,$3) RETURNING id', [empresaId, contactId, numberId])).rows[0].id;
    const sequence = (await query('UPDATE conversas SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence-1 AS sequence', [conversationId])).rows[0].sequence;
    const messageId = (await query(`INSERT INTO mensagens(empresa_id,conversa_id,contato_id,numero_whatsapp_id,direcao,tipo,corpo,status,sequence,correlation_id,media_external_id)
      VALUES($1,$2,$3,$4,'entrada',$5,$6,'enfileirada',$7,$8,$9) RETURNING id`, [empresaId, conversationId, contactId, numberId, type, text, sequence, randomUUID(), type === 'audio' ? randomUUID() : null])).rows[0].id;
    return { ...tenant, contactId, conversationId, messageId, configVersion: 1, sequence: Number(sequence) };
  }
  const account = async c => (await query('SELECT periodo::text,seconds_used,seconds_reserved FROM audio_quota_accounts WHERE empresa_id=$1 ORDER BY periodo DESC', [c.empresaId])).rows;
  const row = async c => (await query('SELECT * FROM mensagens WHERE empresa_id=$1 AND id=$2', [c.empresaId, c.messageId])).rows[0];
  const reserve = (c, seconds) => repo.reserve({ ...c, seconds });
  const start = (c, r) => repo.start({ ...c, reservationId: r.reservationId });
  const finish = (c, r, data = {}) => repo.finish({ ...c, reservationId: r.reservationId }, { status: 'completed', text: 'Sou Ana, de Taubaté. Qual o endereço?', ...data });
  async function disableAudio(c) {
    const config = structuredClone(c.compiled.configuration); config.ai.audioTranscriptionEnabled = false;
    const disabled = compileTenantRuntimeConfigV2(config, { empresaId: c.empresaId, configVersion: 2, draftVersion: 1 });
    await query(`INSERT INTO configuracoes_revisoes(empresa_id,config_version,schema_version,compiler_version,source_draft_version,checksum,configuracao_compilada,publicada_por)
      VALUES($1,2,2,1,1,$2,$3,$4)`, [c.empresaId, disabled.checksum, disabled, actor]);
    await query('UPDATE empresas SET configuracao_ativa_versao=2,versao_configuracao=2 WHERE id=$1', [c.empresaId]);
  }
  try {
    actor = (await query("INSERT INTO usuarios(email,nome,password_hash,papel_plataforma) VALUES($1,'Audio fixture','synthetic','administrador') RETURNING id", [`${randomUUID()}@example.test`])).rows[0].id;
    await t.test('duas conversas concorrentes disputam o mesmo saldo; cada mensagem só pode iniciar uma vez', async () => {
      const tenant = await company(), [a,b] = await Promise.all([message(tenant),message(tenant)]);
      const results = await Promise.all([reserve(a,1000),reserve(b,1000)]);
      assert.equal(results.filter(r => r.allowed).length, 1); assert.equal(results.filter(r => r.status === 'quota_exceeded').length, 1);
      const index = results.findIndex(r => r.allowed), source = [a,b][index], reservation = results[index];
      assert.equal((await Promise.all(Array.from({ length: 6 }, () => start(source,reservation)))).filter(Boolean).length, 1);
      await finish(source,reservation); const saved = await row(source);
      assert.equal(saved.tipo, 'audio'); assert.equal(saved.corpo, null); assert.equal(saved.audio_transcription_status, 'completed');
      assert.equal((await reserve(source,1000)).text, saved.audio_transcription);
      const next = await message(tenant), remaining = await reserve(next,800); assert.equal(remaining.allowed, true);
      assert.equal(await start(next,remaining), true); await finish(next,remaining);
      assert.equal((await reserve(await message(tenant),1)).status, 'quota_exceeded');
      assert.deepEqual((await account(tenant))[0], { periodo: '2026-11-01', seconds_used: 1800, seconds_reserved: 0 });
      const other = await company(), foreign = await message(other);
      assert.equal((await reserve(foreign,1800)).allowed, true);
      assert.deepEqual(await repo.eligible({ ...foreign, empresaId: tenant.empresaId }), false);
      assert.equal((await reserve({ ...foreign, empresaId: tenant.empresaId },1)).blocked, true);
    });
    await t.test('reinício após POST não repete áudio e mantém contabilização conservadora quando o resultado é incerto', async () => {
      const c = await message(await company()), r = await reserve(c,45); assert.equal(await start(c,r), true);
      assert.ok((await reserve(c,45)).deferUntil); now = new Date(+now+121_000);
      assert.equal((await reserve(c,45)).status, 'uncertain'); assert.equal((await reserve(c,45)).status, 'uncertain');
      assert.equal(await start(c,r), false); assert.equal((await account(c))[0].seconds_used, 45);
      assert.equal((await row(c)).audio_transcription, null);
    });
    await t.test('reservas abandonadas antes do POST liberam saldo; cancelar uma reserva não devolve chamadas já iniciadas', async () => {
      const c = await message(await company());
      const abandoned = await reserve(c,1800); assert.equal(abandoned.allowed,true);
      now = new Date(+now+121_000);
      const next = await message(c), replacement = await reserve(next,1800); assert.equal(replacement.allowed,true);
      assert.equal(await start(c,abandoned),false);
      assert.equal((await row(c)).audio_transcription_status,'failed');
      assert.equal(await start(next,replacement),true);
      await repo.cancelPending(next);
      assert.equal((await account(c))[0].seconds_used,1800);
      const d = await message(await company()); await reserve(d,60); await repo.cancelPending(d);
      assert.equal((await account(d))[0].seconds_reserved,0);
    });
    await t.test('quota renova no calendário da empresa, sem acumular saldo nem mover reserva antiga para outro mês', async () => {
      const tenant = await company(); now = new Date('2026-12-01T02:59:59Z');
      const old = await message(tenant), r = await reserve(old,1800); assert.equal(await start(old,r), true); await finish(old,r);
      now = new Date('2026-12-01T03:00:00Z'); const fresh = await message(tenant), renewal = await reserve(fresh,1800);
      assert.equal(renewal.allowed, true); assert.equal(await start(fresh,renewal), true);
      assert.deepEqual((await account(tenant)).map(a => a.periodo), ['2026-12-01','2026-11-01']);
      now = new Date('2026-12-31T23:00:00Z'); const cancellation = await message(await company()), pending = await reserve(cancellation,60);
      now = new Date('2027-01-01T03:00:00Z'); assert.equal(await start(cancellation,pending), false);
      assert.equal((await account(cancellation))[0].seconds_used, 0); assert.equal((await account(cancellation))[0].seconds_reserved, 0);
      assert.equal((await row(cancellation)).audio_transcription_status, 'failed');
      now = new Date('2026-11-25T15:00:00Z');
    });
    await t.test('pausa, posse humana, bloqueio, privacidade, expiração e configuração desativada impedem a cobrança', async () => {
      for (const [sql, undo] of [
        ["UPDATE conversas SET modo_atendimento='pausado' WHERE id=$1", "UPDATE conversas SET modo_atendimento='bot' WHERE id=$1"],
        ["UPDATE contatos SET bloqueado=true WHERE id=$2", "UPDATE contatos SET bloqueado=false WHERE id=$2"],
        ["UPDATE contatos SET bot_pausado=true WHERE id=$2", "UPDATE contatos SET bot_pausado=false WHERE id=$2"],
        ["UPDATE contatos SET consentimento_status='revogado' WHERE id=$2", "UPDATE contatos SET consentimento_status='nao_informado' WHERE id=$2"],
        ["UPDATE contatos SET deleted_at=now() WHERE id=$2", "UPDATE contatos SET deleted_at=NULL WHERE id=$2"],
        ["UPDATE mensagens SET expires_at='2026-11-01' WHERE id=$3", "UPDATE mensagens SET expires_at=NULL WHERE id=$3"],
      ]) {
        const c = await message(await company());
        const index = Number(/\$(\d+)/.exec(sql)[1]) - 1;
        const args = [[c.conversationId,c.contactId,c.messageId][index]];
        await query(sql.replace(/\$\d+/g,'$1'),args);
        assert.equal((await reserve(c,30)).blocked, true);
        await query(undo.replace(/\$\d+/g,'$1'),args);
      }
      const c = await message(await company()), r = await reserve(c,30);
      await query("UPDATE conversas SET modo_atendimento='pausado' WHERE id=$1", [c.conversationId]);
      assert.equal(await start(c,r), false); assert.equal((await account(c))[0].seconds_reserved, 0);
      const d = await message(await company());
      await disableAudio(d);
      assert.equal((await reserve(d,30)).blocked, true);
    });
    await t.test('resultado que chega após pausa ou exclusão não grava texto nem autoriza resposta', async () => {
      for (const action of ['pause','forget','config']) {
        const c = await message(await company()), r = await reserve(c,30); await start(c,r);
        if (action === 'pause') await query("UPDATE conversas SET modo_atendimento='pausado' WHERE id=$1", [c.conversationId]);
        else if (action === 'forget') await new PostgresAdminRepository(pool).forgetContact({ empresaId: c.empresaId, id: c.contactId });
        else await disableAudio(c);
        assert.equal((await finish(c,r)).blocked, true); assert.equal((await row(c)).audio_transcription, null);
        assert.equal((await account(c))[0].seconds_used, 30);
      }
    });
    await t.test('histórico do painel, worker e agrupamento usam a mesma mensagem e retenção apaga a transcrição', async () => {
      const c = await message(await company()), r = await reserve(c,22); await start(c,r); await finish(c,r);
      const original = await jobs.inboundMessage(c);
      await jobs.markMediaStored({ empresaId: c.empresaId, messageId: c.messageId, mediaId: original.mediaId,
        stored: { storageKey: `${c.empresaId}/${c.messageId}`, mimeType: 'audio/ogg', sizeBytes: 512, sha256: 'a'.repeat(64) } });
      assert.equal((await row(c)).media_mime_type,'audio/ogg');
      const following = await message(c, { conversation: c, type: 'texto', text: 'E qual o horário?' });
      const turn = await loadInboundTurn(pool, { ...c, includeAudio: true });
      assert.equal(turn.messageId, following.messageId); assert.equal(turn.messages[0].type, 'audio');
      assert.equal(turn.messages[0].audioTranscription, (await row(c)).audio_transcription);
      assert.equal((await jobs.inboundMessage(c)).audioTranscription, (await row(c)).audio_transcription);
      const admin = new PostgresAdminRepository(pool);
      const usage = await admin.list({ resource: 'audio-usage', empresaId: c.empresaId, filters: {}, limit: 1, page: 1, sort: 'period', direction: 'desc' });
      assert.equal(usage.items[0].usedSeconds, 22); assert.equal(usage.items[0].monthlyLimitSeconds, 1800);
      const history = await admin.list({ resource: 'messages', empresaId: c.empresaId, filters: { conversationId: c.conversationId }, limit: 20, page: 1, sort: 'sequence', direction: 'asc' });
      assert.equal(history.items[0].audioTranscription, (await row(c)).audio_transcription);
      const reply = await jobs.prepareReply({ empresaId: c.empresaId, origin: 'ai', message: await jobs.inboundMessage(following),
        reply: { text: 'Resposta sintética', inboundTurnSequence: following.sequence, inboundTurnIncludesAudio: true } });
      assert.equal((await jobs.preparedReply({ empresaId: c.empresaId, messageId: following.messageId })).inboundTurnIncludesAudio, true);
      assert.equal(await jobs.canSendBotReply({ empresaId: c.empresaId, messageId: following.messageId }), true);
      await disableAudio(c);
      assert.equal(await jobs.canSendBotReply({ empresaId: c.empresaId, messageId: following.messageId }), false);
      assert.ok(reply.id);
      await new PostgresConversationRepository(pool).anonymizeMessagesBefore({ empresaId: c.empresaId, before: new Date('2100-01-01'), limit: 20, redactedAt: new Date() });
      const redacted = await row(c); assert.equal(redacted.audio_transcription, null); assert.equal(redacted.audio_transcription_status, null);
      assert.equal((await account(c))[0].seconds_used, 22);
    });
    await t.test('RLS não permite ler o consumo de outra empresa', async () => {
      const app = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      try {
        const foreign = companies[0], own = companies.at(-1);
        assert.equal((await withTenantTransaction(app, { empresaId: own }, ({ client }) => client.query('SELECT * FROM audio_quota_accounts WHERE empresa_id=$1', [foreign]))).rowCount, 0);
        assert.equal((await withTenantTransaction(app, { empresaId: own }, ({ client }) => client.query('SELECT * FROM audio_transcription_usage WHERE empresa_id=$1', [foreign]))).rowCount, 0);
      } finally { await app.end(); }
    });
  } finally {
    try {
      for (const empresaId of companies) await withPlatformTransaction(pool, {}, async ({ client }) => {
        await client.query("UPDATE empresas SET configuracao_runtime_modo='legado',configuracao_ativa_versao=NULL WHERE id=$1", [empresaId]);
        for (const table of ['audio_transcription_usage','audio_quota_accounts','mensagens','estados_conversa','conversas','contatos','numeros_whatsapp']) {
          await client.query(`DELETE FROM ${table} WHERE empresa_id=$1`, [empresaId]);
        }
        await client.query('DELETE FROM empresas WHERE id=$1', [empresaId]);
      });
      if (actor) await query('DELETE FROM usuarios WHERE id=$1', [actor]);
    } finally { await pool.end(); }
  }
});
