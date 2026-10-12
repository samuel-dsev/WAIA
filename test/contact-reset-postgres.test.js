import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresAdminRepository } from "../src/modules/admin/postgres-admin-repository.js";
import { PostgresWebhookRepository } from "../src/infra/postgres/repositories/webhook-repository.js";

test("PostgreSQL: exclusão reinicia o próximo webhook e preserva deduplicação e outro tenant", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "true",
}, async () => {
  assert.ok(process.env.DATABASE_URL);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    const suffix = randomUUID();
    const empresaId = (await client.query(
      "INSERT INTO empresas (slug, nome, nome_exibicao, status) VALUES ($1,'Contato reset','Contato reset','ativa') RETURNING id",
      [`contact-reset-${suffix}`],
    )).rows[0].id;
    const otherEmpresaId = (await client.query(
      "INSERT INTO empresas (slug, nome, nome_exibicao, status) VALUES ($1,'Outra empresa','Outra empresa','ativa') RETURNING id",
      [`contact-reset-other-${suffix}`],
    )).rows[0].id;
    const numberId = (await client.query(
      "INSERT INTO numeros_whatsapp (empresa_id, phone_number_id, status) VALUES ($1,$2,'ativo') RETURNING id",
      [empresaId, suffix],
    )).rows[0].id;
    const otherContactId = (await client.query(
      "INSERT INTO contatos (empresa_id, telefone_normalizado, nome) VALUES ($1,'5511000000001','Outra empresa') RETURNING id",
      [otherEmpresaId],
    )).rows[0].id;
    const transaction = { client, tenantId: empresaId, isPlatformAdmin: true };
    const webhook = new PostgresWebhookRepository(pool);
    const repository = new PostgresAdminRepository(pool);
    const input = {
      empresaId, numeroWhatsappId: numberId, correlationId: randomUUID(),
      event: { externalMessageId: `old-${suffix}`, senderPhone: "5511000000001", messageType: "text", text: "Sou o cliente anterior", occurredAt: new Date().toISOString() },
    };
    const previous = await webhook.insertInboundMessage(transaction, input);
    const oldContactId = (await client.query("SELECT contato_id FROM conversas WHERE id = $1", [previous.conversationId])).rows[0].contato_id;
    await client.query("UPDATE contatos SET nome = 'Cliente anterior' WHERE id = $1", [oldContactId]);
    await client.query("UPDATE estados_conversa SET state_data = '{\"handoffResumeAt\":\"2099-01-01\",\"name\":\"Cliente anterior\"}'::jsonb WHERE conversa_id = $1", [previous.conversationId]);
    await client.query(
      "INSERT INTO outbox_jobs (empresa_id, conversa_id, mensagem_id, job_type, dedup_key, correlation_id, status) VALUES ($1,$2,$3,'process_inbound_message',$4,$5,'em_publicacao')",
      [empresaId, previous.conversationId, previous.messageId, suffix, randomUUID()],
    );
    await assert.rejects(repository.forgetContact({ empresaId, id: oldContactId, transaction }), (error) => error.status === 409);
    assert.equal((await client.query("SELECT corpo FROM mensagens WHERE id = $1", [previous.messageId])).rows[0].corpo, input.event.text);
    assert.equal(await repository.forgetContact({ empresaId, id: otherContactId, transaction }), false);
    await client.query("UPDATE outbox_jobs SET status = 'publicado' WHERE empresa_id = $1", [empresaId]);
    assert.equal(await repository.forgetContact({ empresaId, id: oldContactId, transaction }), true);
    assert.equal((await client.query("SELECT corpo FROM mensagens WHERE id = $1", [previous.messageId])).rows[0].corpo, null);
    assert.deepEqual((await client.query("SELECT state_data FROM estados_conversa WHERE conversa_id = $1", [previous.conversationId])).rows[0].state_data, {});
    assert.equal((await client.query("SELECT status FROM outbox_jobs WHERE empresa_id = $1", [empresaId])).rows[0].status, "concluido");
    assert.equal((await client.query("SELECT nome FROM contatos WHERE id = $1", [otherContactId])).rows[0].nome, "Outra empresa");
    assert.equal((await webhook.insertInboundMessage(transaction, input)).inserted, false);
    const next = await webhook.insertInboundMessage(transaction, { ...input, event: { ...input.event, externalMessageId: `new-${suffix}`, text: "Olá" } });
    assert.notEqual(next.conversationId, previous.conversationId);
    const contact = (await client.query("SELECT ct.* FROM contatos ct JOIN conversas c ON c.empresa_id = ct.empresa_id AND c.contato_id = ct.id WHERE c.id = $1", [next.conversationId])).rows[0];
    assert.notEqual(contact.id, oldContactId);
    assert.equal(contact.nome, null);
    assert.equal(contact.bot_pausado, false);
    assert.equal(contact.bloqueado, false);
    assert.deepEqual((await client.query("SELECT state_data FROM estados_conversa WHERE conversa_id = $1", [next.conversationId])).rows[0].state_data, {});
    assert.equal((await client.query("SELECT count(*)::int total FROM mensagens WHERE conversa_id = $1", [next.conversationId])).rows[0].total, 1);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
