import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresJobHandlerRepository } from '../src/modules/jobs/handlers.js';
import { ConversationService } from '../src/modules/conversations/conversation-service.js';
import { PostgresConversationRepository } from '../src/modules/conversations/postgres-conversation-repository.js';
import { ConversationHandoffRepository } from '../src/modules/business/repositories.js';

test('M6 PostgreSQL: guarda operacional e prova CAS de handoff persistida por inbound', {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== 'true',
}, async () => {
  for (const target of [process.env.DATABASE_URL, process.env.DATABASE_MIGRATOR_URL]) assert.match(new URL(target).pathname, /^\/waia_v2_/);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, options: '-c app.is_platform_admin=true' });
  let empresaId;
  try {
    empresaId = (await owner.query("INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1,'M6 sintética','M6 sintética','ativa') RETURNING id", [`m6-worker-${randomUUID()}`])).rows[0].id;
    const contactId = (await owner.query("INSERT INTO contatos(empresa_id,telefone_normalizado) VALUES($1,'5511000000001') RETURNING id", [empresaId])).rows[0].id;
    const numberId = (await owner.query("INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status) VALUES($1,$2,'ativo') RETURNING id", [empresaId, randomUUID()])).rows[0].id;
    const conversationId = (await owner.query('INSERT INTO conversas(empresa_id,contato_id,numero_whatsapp_id,next_sequence) VALUES($1,$2,$3,2) RETURNING id', [empresaId, contactId, numberId])).rows[0].id;
    const correlationId = randomUUID();
    const messageId = (await owner.query(`INSERT INTO mensagens(empresa_id,conversa_id,contato_id,numero_whatsapp_id,direcao,tipo,corpo,status,sequence,correlation_id)
      VALUES($1,$2,$3,$4,'entrada','texto','Mensagem sintética','processando',1,$5) RETURNING id`, [empresaId, conversationId, contactId, numberId, correlationId])).rows[0].id;
    const repository = new PostgresJobHandlerRepository(pool);
    const reference = { empresaId, messageId };
    assert.equal(await repository.canSendBotReply(reference), true);
    const cases = [
      ['empresas', "status='suspensa'", "status='ativa'", empresaId],
      ['empresas', 'deleted_at=now()', 'deleted_at=NULL', empresaId],
      ['contatos', 'bloqueado=true', 'bloqueado=false', contactId],
      ['contatos', 'bot_pausado=true', 'bot_pausado=false', contactId],
      ['contatos', 'anonimizado_at=now()', 'anonimizado_at=NULL', contactId],
      ['contatos', 'deleted_at=now()', 'deleted_at=NULL', contactId],
      ['conversas', "modo_atendimento='humano'", "modo_atendimento='bot'", conversationId],
      ['conversas', "modo_atendimento='pausado'", "modo_atendimento='bot'", conversationId],
      ['conversas', "status='arquivada'", "status='aberta'", conversationId],
      ['numeros_whatsapp', 'deleted_at=now()', 'deleted_at=NULL', numberId],
      ['mensagens', 'redacted_at=now()', 'redacted_at=NULL', messageId],
    ];
    for (const [table, blocked, restored, id] of cases) {
      await owner.query(`UPDATE ${table} SET ${blocked} WHERE id=$1`, [id]);
      assert.equal(await repository.canSendBotReply(reference), false, `${table}:${blocked}`);
      await owner.query(`UPDATE ${table} SET ${restored} WHERE id=$1`, [id]);
      assert.equal(await repository.canSendBotReply(reference), true);
    }
    const conversations = new ConversationService({ repository: new PostgresConversationRepository(pool) });
    const handoff = new ConversationHandoffRepository(conversations);
    const before = await conversations.getConversation({ empresaId, conversationId });
    const paused = await handoff.request({ empresaId, conversationId, expectedVersion: before.version });
    assert.equal(paused.mode, 'paused'); assert.equal(paused.version, before.version + 1);
    const proof = paused.version;
    // A version alone cannot grant sending without its server-held checkpoint.
    assert.equal(await repository.canSendBotReply({ ...reference, handoffPauseVersion: proof }), false);
    const saved = await repository.prepareReply({ empresaId,
      message: { id: messageId, conversationId, contactId, numeroWhatsappId: numberId, correlationId },
      reply: { text: 'A equipe continuará o atendimento.', handoffPauseVersion: proof }, origin: 'deterministic_flow' });
    assert.equal(saved.handoffPauseVersion, proof);
    const restored = await new PostgresJobHandlerRepository(pool).preparedReply(reference);
    assert.equal(restored.handoffPauseVersion, proof);
    assert.equal(await repository.canSendBotReply(reference), false);
    assert.equal(await repository.canSendBotReply({ ...reference, handoffPauseVersion: proof }), true);
    assert.equal(await repository.canSendBotReply({ ...reference, handoffPauseVersion: proof + 1 }), false);
    assert.equal(await repository.canSendBotReply({ ...reference, messageId: randomUUID(), handoffPauseVersion: proof }), false);
    assert.equal(await repository.canSendBotReply({ ...reference, empresaId: randomUUID(), handoffPauseVersion: proof }), false);
    await conversations.pauseBot({ empresaId, conversationId });
    assert.equal(await repository.canSendBotReply({ ...reference, handoffPauseVersion: proof }), false);
    await assert.rejects(handoff.request({ empresaId, conversationId, expectedVersion: proof }));
    const current = await conversations.getConversation({ empresaId, conversationId });
    assert.equal(current.mode, 'paused'); assert.equal(current.version, proof + 1);
    await conversations.resumeBot({ empresaId, conversationId });
    assert.equal(await repository.canSendBotReply({ ...reference, handoffPauseVersion: proof }), false);
    const observed = await conversations.getConversation({ empresaId, conversationId });
    await owner.query("UPDATE conversas SET modo_atendimento='humano',lock_version=lock_version+1 WHERE id=$1", [conversationId]);
    await assert.rejects(handoff.request({ empresaId, conversationId, expectedVersion: observed.version }));
    assert.equal((await conversations.getConversation({ empresaId, conversationId })).mode, 'human');
  } finally {
    if (empresaId) {
      for (const table of ['mensagens', 'conversas', 'contatos', 'numeros_whatsapp']) await owner.query(`DELETE FROM ${table} WHERE empresa_id=$1`, [empresaId]);
      await owner.query('DELETE FROM empresas WHERE id=$1', [empresaId]);
    }
    await pool.end(); await owner.end();
  }
});
