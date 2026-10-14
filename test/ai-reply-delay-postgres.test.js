import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresJobHandlerRepository } from "../src/modules/jobs/handlers.js";
import { PostgresJobRepository } from "../src/modules/jobs/postgres-repository.js";

test("PostgreSQL real: prazo persiste, job aguarda e permissão de envio é revalidada", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "true",
}, async () => {
  assert.ok(process.env.DATABASE_URL); assert.ok(process.env.DATABASE_MIGRATOR_URL);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  let empresaId;
  try {
    empresaId = (await owner.query("INSERT INTO empresas (slug,nome,nome_exibicao,status) VALUES ($1,'Espera IA','Espera IA','ativa') RETURNING id", ["ai-delay-" + randomUUID()])).rows[0].id;
    const contactId = (await owner.query("INSERT INTO contatos (empresa_id,telefone_normalizado) VALUES ($1,'5511000000001') RETURNING id", [empresaId])).rows[0].id;
    const numberId = (await owner.query("INSERT INTO numeros_whatsapp (empresa_id,phone_number_id,status) VALUES ($1,$2,'ativo') RETURNING id", [empresaId, randomUUID()])).rows[0].id;
    const conversationId = (await owner.query("INSERT INTO conversas (empresa_id,contato_id,numero_whatsapp_id,correlation_id) VALUES ($1,$2,$3,$4) RETURNING id", [empresaId, contactId, numberId, randomUUID()])).rows[0].id;
    const messageId = (await owner.query("INSERT INTO mensagens (empresa_id,conversa_id,contato_id,numero_whatsapp_id,direcao,tipo,corpo,status,sequence,correlation_id) VALUES ($1,$2,$3,$4,'entrada','texto','Teste','processando',1,$5) RETURNING id", [empresaId, conversationId, contactId, numberId, randomUUID()])).rows[0].id;
    await owner.query("UPDATE conversas SET next_sequence=2 WHERE id=$1", [conversationId]);
    const jobId = (await owner.query("INSERT INTO outbox_jobs (empresa_id,conversa_id,mensagem_id,job_type,dedup_key,status,correlation_id) VALUES ($1,$2,$3,'process_inbound_message',$4,'em_publicacao',$5) RETURNING id", [empresaId, conversationId, messageId, randomUUID(), randomUUID()])).rows[0].id;
    const sendNotBefore = new Date(Date.now() + 45_000).toISOString();
    const handlers = new PostgresJobHandlerRepository(pool);
    const first = await handlers.prepareReply({ empresaId, message: { id: messageId, conversationId, contactId, numeroWhatsappId: numberId, correlationId: randomUUID() }, reply: { text: "Resposta pronta", sendNotBefore }, origin: "ai" });
    assert.equal(first.sendNotBefore, sendNotBefore);
    assert.equal((await new PostgresJobHandlerRepository(pool).preparedReply({ empresaId, messageId })).sendNotBefore, sendNotBefore);
    const jobs = new PostgresJobRepository(pool), reference = { empresaId, jobId, messageId, conversationId };
    await jobs.defer(reference, { until: sendNotBefore });
    assert.equal((await jobs.claim(reference)).outcome, "deferred");
    assert.equal(await handlers.canSendBotReply({ empresaId, messageId }), true);
    await owner.query("UPDATE conversas SET modo_atendimento='pausado' WHERE id=$1", [conversationId]);
    assert.equal(await handlers.canSendBotReply({ empresaId, messageId }), false);
    await handlers.cancelPreparedReply({ empresaId, messageId });
    assert.equal((await handlers.preparedReply({ empresaId, messageId })).status, "ignorada_duplicidade");
    await owner.query("UPDATE conversas SET modo_atendimento='bot' WHERE id=$1", [conversationId]);
    await owner.query("UPDATE contatos SET bot_pausado=true WHERE id=$1", [contactId]);
    assert.equal(await handlers.canSendBotReply({ empresaId, messageId }), false);
    assert.equal(await handlers.canSendBotReply({ empresaId: randomUUID(), messageId }), false);
    // Exercise the product batch in the same isolated synthetic tenant.
    const sequence = Number((await owner.query("UPDATE conversas SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence-1 AS sequence", [conversationId])).rows[0].sequence);
    const batchMessageId = (await owner.query("INSERT INTO mensagens (empresa_id,conversa_id,contato_id,numero_whatsapp_id,direcao,tipo,corpo,status,sequence,correlation_id) VALUES ($1,$2,$3,$4,'entrada','texto','Catálogo','processando',$5,$6) RETURNING id", [empresaId, conversationId, contactId, numberId, sequence, randomUUID()])).rows[0].id;
    const batchInput = { empresaId, message: { id: batchMessageId, conversationId, contactId, numeroWhatsappId: numberId, correlationId: randomUUID() },
      reply: { text: "Catálogo", sendNotBefore,
        catalogBrowse: { filters: { category: null, minPrice: 1000, maxPrice: 5000 }, priorSeenProductIds: ["older"] },
        messages: ["A", "B", "C"].map((text) => ({ text, imageUrl: `https://example.com/${text}.jpg`, catalogProductId: text })) }, origin: "ai" };
    const batch = await handlers.prepareReply(batchInput);
    assert.equal(batch.messages.length, 3);
    assert.deepEqual(batch.messages.map((part) => part.text), ["A", "B", "C"]);
    assert.deepEqual((await handlers.prepareReply(batchInput)).messages.map((part) => part.id), batch.messages.map((part) => part.id));
    assert.deepEqual(await handlers.catalogBrowseState({ empresaId, conversationId }), { filters: { category: null, minPrice: 1000, maxPrice: 5000 }, seenProductIds: [], presentedProductIds: [] });
    assert.equal(await handlers.catalogBrowseState({ empresaId: randomUUID(), conversationId }), null);
    assert.equal(await handlers.catalogBrowseState({ empresaId, conversationId: randomUUID() }), null);
    assert.equal((await handlers.preparedReply({ empresaId: randomUUID(), messageId: batchMessageId })), undefined);
    await handlers.markReplySent({ empresaId, replyId: batch.messages[0].id, externalMessageId: "wamid." + randomUUID() });
    const hydrated = await new PostgresJobHandlerRepository(pool).preparedReply({ empresaId, messageId: batchMessageId });
    assert.ok(hydrated.messages[0].externalMessageId); assert.equal(hydrated.messages[1].externalMessageId, null);
    assert.equal(hydrated.messages[0].catalogProductId, "A");
    assert.deepEqual(await new PostgresJobHandlerRepository(pool).catalogBrowseState({ empresaId, conversationId }), { filters: { category: null, minPrice: 1000, maxPrice: 5000 }, seenProductIds: ["A"], presentedProductIds: ["A"] });
    assert.equal(hydrated.sendNotBefore, sendNotBefore);
    await handlers.cancelPreparedReply({ empresaId, messageId: batchMessageId });
    const cancelled = await handlers.preparedReply({ empresaId, messageId: batchMessageId });
    assert.equal(cancelled.messages[0].status, "enviada");
    assert.deepEqual(cancelled.messages.slice(1).map((part) => part.status), ["ignorada_duplicidade", "ignorada_duplicidade"]);
    assert.deepEqual((await handlers.catalogBrowseState({ empresaId, conversationId })).seenProductIds, ["A"]);
    const stored = (await owner.query("SELECT tipo, sequence FROM mensagens WHERE empresa_id=$1 AND id=ANY($2::uuid[]) ORDER BY sequence", [empresaId, batch.messages.map((part) => part.id)])).rows;
    assert.deepEqual(stored.map((part) => part.tipo), ["imagem", "imagem", "imagem"]);
    assert.deepEqual(stored.map((part) => Number(part.sequence)), [sequence+1, sequence+2, sequence+3]);
    await owner.query("UPDATE contatos SET bot_pausado=false WHERE id=$1", [contactId]);
    assert.equal(await handlers.canSendBotReply({ empresaId, messageId: batchMessageId }), true);
    // Commercial page: intro + three product cards + question, all committed together.
    const pageSequence = Number((await owner.query("UPDATE conversas SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence-1 AS sequence", [conversationId])).rows[0].sequence);
    const pageMessageId = (await owner.query("INSERT INTO mensagens (empresa_id,conversa_id,contato_id,numero_whatsapp_id,direcao,tipo,corpo,status,sequence,correlation_id) VALUES ($1,$2,$3,$4,'entrada','texto','Mais opções','processando',$5,$6) RETURNING id", [empresaId, conversationId, contactId, numberId, pageSequence, randomUUID()])).rows[0].id;
    const pageInput = { empresaId, message: { id: pageMessageId, conversationId, contactId, numeroWhatsappId: numberId, correlationId: randomUUID() }, origin: "ai", reply: {
      text: "Página", catalogBrowse: { filters: { category: null, minPrice: null, maxPrice: 8000 }, priorSeenProductIds: [] },
      messages: [{ text: "Vou te mostrar mais opções." }, ...["D", "E", "F"].map((id) => ({ text: "Ficha " + id, imageUrl: `https://example.com/${id}.jpg`, catalogProductId: id })), { text: "Por qual modelo você se interessou?" }],
    } };
    const page = await handlers.prepareReply(pageInput);
    assert.equal(page.messages.length, 5);
    assert.deepEqual((await handlers.prepareReply(pageInput)).messages.map((part) => part.id), page.messages.map((part) => part.id));
    await handlers.markReplySent({ empresaId, replyId: page.messages[0].id, externalMessageId: "wamid." + randomUUID() });
    assert.deepEqual(await handlers.catalogBrowseState({ empresaId, conversationId }), { filters: { category: null, minPrice: null, maxPrice: 8000 }, seenProductIds: [], presentedProductIds: ["A"] });
    await handlers.markReplySent({ empresaId, replyId: page.messages[1].id, externalMessageId: "wamid." + randomUUID() });
    assert.deepEqual((await handlers.catalogBrowseState({ empresaId, conversationId })).seenProductIds, ["D"]);
    assert.deepEqual((await handlers.catalogBrowseState({ empresaId, conversationId })).presentedProductIds, ["A", "D"]);
    await handlers.cancelPreparedReply({ empresaId, messageId: pageMessageId });
    assert.deepEqual((await handlers.catalogBrowseState({ empresaId, conversationId })).seenProductIds, ["D"]);
    assert.deepEqual((await handlers.catalogBrowseState({ empresaId, conversationId })).presentedProductIds, ["A", "D"]);
    // A later provider rejection must permit a future attempt; cancellation remains excluded.
    await owner.query("UPDATE mensagens SET status='falhou' WHERE empresa_id=$1 AND id=$2", [empresaId, batch.messages[0].id]);
    assert.deepEqual((await handlers.catalogBrowseState({ empresaId, conversationId })).seenProductIds, ["D"]);
    const pageTypes = (await owner.query("SELECT tipo FROM mensagens WHERE empresa_id=$1 AND id=ANY($2::uuid[]) ORDER BY sequence", [empresaId, page.messages.map((part) => part.id)])).rows;
    assert.deepEqual(pageTypes.map((row) => row.tipo), ["texto", "imagem", "imagem", "imagem", "texto"]);
    await owner.query("UPDATE empresas SET status='suspensa' WHERE id=$1", [empresaId]);
    assert.equal(await handlers.canSendBotReply({ empresaId, messageId: batchMessageId }), false);
  } finally {
    if (empresaId) {
      for (const table of ["outbox_jobs", "mensagens", "conversas", "contatos", "numeros_whatsapp"]) await owner.query(`DELETE FROM ${table} WHERE empresa_id=$1`, [empresaId]);
      await owner.query("DELETE FROM empresas WHERE id=$1", [empresaId]);
    }
    await pool.end(); await owner.end();
  }
});
