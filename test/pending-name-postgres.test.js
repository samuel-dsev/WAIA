import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { withPlatformTransaction, withTenantTransaction } from "../src/infra/postgres/transaction.js";
import { compileTenantRuntimeConfigV2 } from "../src/modules/configuration/compiler.js";
import { PostgresJobHandlerRepository } from "../src/modules/jobs/handlers.js";
import { PostgresJobRepository } from "../src/modules/jobs/postgres-repository.js";
import { LEAD_NAME_WAIT_MS } from "../src/modules/group-notifier/pending-name.js";
import { notificationText } from "../src/modules/group-notifier/qualification.js";

test("PostgreSQL: silêncio na última coleta de nome encaminha e pausa com isolamento e idempotência", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "true",
}, async t => {
  assert.equal(process.env.NODE_ENV, "test");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL }), client = await pool.connect();
  let serial = 0, now = new Date();
  const txpool = { async connect() {
    const name = `pending_name_${++serial}`;
    return { async query(sql, args) {
      if (sql === "BEGIN") return client.query(`SAVEPOINT ${name}`);
      if (sql === "COMMIT") return client.query(`RELEASE SAVEPOINT ${name}`);
      if (sql === "ROLLBACK") { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); return client.query(`RELEASE SAVEPOINT ${name}`); }
      return client.query(sql, args);
    }, release() {} };
  } };
  const query = (...args) => withPlatformTransaction(txpool, {}, tx => tx.client.query(...args));
  const repo = () => new PostgresJobHandlerRepository(txpool, { clock: () => now });
  try {
    assert.equal((await client.query("SELECT current_database() AS name")).rows[0].name, "waia_v2_upgrade");
    await client.query("BEGIN");
    const actor = (await query(`INSERT INTO usuarios(email,nome,password_hash,papel_plataforma)
      VALUES($1,'Nome pendente fixture','synthetic','administrador') RETURNING id`, [`${randomUUID()}@example.test`])).rows[0].id;
    async function company(label) {
      const empresaId = (await query("INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1,$2,$2,'ativa') RETURNING id", [`pending-${randomUUID()}`, label])).rows[0].id;
      const compiled = compileTenantRuntimeConfigV2({ schemaVersion: 2, identity: { name: label }, modules: ["ai_freeform", "human_handoff"],
        menu: { text: "Olá", options: [] }, ai: { enabled: true, provider: "openai", model: "synthetic", prompt: "Faça a triagem.",
          leadQualificationEnabled: true, leadQualificationCriteria: "Nome, pedido e dados completos.", leadImageHandoffEnabled: true,
          contextualServiceEnabled: true, tradeInEvaluationEnabled: false } },
      { empresaId, configVersion: 1, draftVersion: 1 });
      await query(`INSERT INTO configuracoes_revisoes(empresa_id,config_version,schema_version,compiler_version,source_draft_version,checksum,configuracao_compilada,publicada_por)
        VALUES($1,1,2,1,1,$2,$3,$4)`, [empresaId, compiled.checksum, compiled, actor]);
      await query("UPDATE empresas SET configuracao_runtime_modo='versionado',versao_configuracao=1,configuracao_ativa_versao=1 WHERE id=$1", [empresaId]);
      await query(`INSERT INTO group_notifier_routes(empresa_id,group_id,group_name,sender_phone,enabled)
        VALUES($1,$2,$3,'+5511000000099',true)`, [empresaId, `999999${serial++}@g.us`, label]);
      const numberId = (await query("INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status) VALUES($1,$2,'ativo') RETURNING id", [empresaId, randomUUID()])).rows[0].id;
      return { empresaId, numberId };
    }
    const a = await company("Empresa A"), b = await company("Empresa B");
    async function prepare(tenant = a, image = false) {
      const { empresaId, numberId } = tenant;
      const contactId = (await query("INSERT INTO contatos(empresa_id,telefone_normalizado) VALUES($1,$2) RETURNING id", [empresaId, `5511${String(serial++).padStart(7, "0")}`])).rows[0].id;
      const conversationId = (await query("INSERT INTO conversas(empresa_id,contato_id,numero_whatsapp_id,next_sequence) VALUES($1,$2,$3,2) RETURNING id", [empresaId, contactId, numberId])).rows[0].id;
      const source = (await query(`INSERT INTO mensagens(empresa_id,conversa_id,contato_id,numero_whatsapp_id,direcao,tipo,corpo,status,sequence,correlation_id)
        VALUES($1,$2,$3,$4,'entrada',$5,'Solicitação e dados fictícios completos','respondida',1,$6) RETURNING id`,
      [empresaId, conversationId, contactId, numberId, image ? "imagem" : "texto", randomUUID()])).rows[0].id;
      if (image) await query(`UPDATE mensagens SET media_storage_key='synthetic/photo',media_mime_type='image/jpeg',media_sha256=$2,media_size_bytes=123,media_stored_at=now() WHERE id=$1`, [source, "a".repeat(64)]);
      if (image) {
        await query(`INSERT INTO mensagens(empresa_id,conversa_id,contato_id,numero_whatsapp_id,direcao,tipo,corpo,status,sequence,correlation_id,
          media_storage_key,media_mime_type,media_sha256,media_size_bytes,media_stored_at)
          VALUES($1,$2,$3,$4,'entrada','imagem','','respondida',2,$5,'synthetic/photo2','image/jpeg',$6,123,now())`,
        [empresaId, conversationId, contactId, numberId, randomUUID(), "b".repeat(64)]);
        await query("UPDATE conversas SET next_sequence=3 WHERE id=$1", [conversationId]);
      }
      const card = { name: null, summary: "Dados coletados: pedido, cidade e informações obrigatórias conferidas.", qualification: "Todos os critérios operacionais atendidos, exceto nome.", configVersion: 1 };
      const reply = await repo().prepareReply({ empresaId, origin: "ai", message: { id: source, conversationId, contactId, numeroWhatsappId: numberId, correlationId: randomUUID() },
        reply: { text: "Para finalizar, qual é o seu nome?", pendingNameQualification: card, ...(image ? { inboundTurnSequence: 2 } : {}) } });
      const reference = { empresaId, conversationId };
      async function ack() { await repo().markReplySent({ empresaId, replyId: reply.id, externalMessageId: `synthetic.${reply.id}` }); }
      async function job() { return (await query("SELECT * FROM outbox_jobs WHERE empresa_id=$1 AND dedup_key=$2", [empresaId, `lead-name:${reply.id}`])).rows[0]; }
      async function counts() { return (await query(`SELECT (SELECT count(*)::int FROM qualified_leads WHERE conversa_id=$1) AS leads,
        (SELECT count(*)::int FROM group_notifier_deliveries d JOIN qualified_leads l ON l.id=d.lead_id WHERE l.conversa_id=$1) AS deliveries,
        (SELECT modo_atendimento FROM conversas WHERE id=$1) AS mode`, [conversationId])).rows[0]; }
      async function run() { return repo().completeLeadNameTimeout(reference, (await job()).payload); }
      return { ...tenant, contactId, conversationId, source, reply, card, reference, ack, job, counts, run };
    }
    await t.test("relógio começa no envio confirmado, aguarda prazo e sobrevive a reinício sem duplicar", async () => {
      const c = await prepare();
      assert.equal(await c.job(), undefined); assert.deepEqual(await c.counts(), { leads: 0, deliveries: 0, mode: "bot" });
      await c.ack(); const first = await c.job(); await c.ack(); assert.equal((await c.job()).id, first.id);
      const sent = (await query("SELECT sent_at FROM mensagens WHERE id=$1", [c.reply.id])).rows[0].sent_at;
      assert.equal(+first.disponivel_at - +sent, LEAD_NAME_WAIT_MS);
      assert.equal(JSON.stringify(first.payload).includes(c.card.summary), false);
      now = new Date(+sent + LEAD_NAME_WAIT_MS - 1); assert.ok((await c.run()).deferUntil);
      now = new Date(+first.disponivel_at); assert.deepEqual(await c.run(), { handedOff: true });
      await c.run(); assert.deepEqual(await c.counts(), { leads: 1, deliveries: 1, mode: "pausado" });
      const lead = (await query("SELECT name,summary,qualification,phone FROM qualified_leads WHERE conversa_id=$1", [c.conversationId])).rows[0];
      assert.equal(lead.name, null); assert.equal(lead.summary, c.card.summary); assert.equal(lead.qualification, c.card.qualification);
      assert.match(notificationText({ companyName: "Empresa A", ...lead }), /NOME NÃO INFORMADO/u);
    });
    await t.test("nova resposta cancela a ficha antiga, incluindo recusa, nome e mudança de assunto", async () => {
      for (const body of ["Ana Teste", "Não quero continuar", "Qual o endereço?"]) {
        const c = await prepare(); await c.ack(); now = new Date(+(await c.job()).disponivel_at);
        await query(`INSERT INTO mensagens(empresa_id,conversa_id,contato_id,numero_whatsapp_id,direcao,tipo,corpo,status,sequence,correlation_id)
          VALUES($1,$2,$3,$4,'entrada','texto',$5,'recebida',3,$6)`, [c.empresaId, c.conversationId, c.contactId, c.numberId, body, randomUUID()]);
        assert.deepEqual(await c.run(), { skipped: true }); assert.deepEqual(await c.counts(), { leads: 0, deliveries: 0, mode: "bot" });
      }
    });
    await t.test("pausa e retomada, bloqueio, exclusão, revisão e rota desabilitada invalidam pendência", async () => {
      const edits = [
        c => query("UPDATE conversas SET lock_version=lock_version+2 WHERE id=$1", [c.conversationId]),
        c => query("UPDATE conversas SET modo_atendimento='humano' WHERE id=$1", [c.conversationId]),
        c => query("UPDATE contatos SET bloqueado=true WHERE id=$1", [c.contactId]),
        c => query("UPDATE mensagens SET redacted_at=now() WHERE id=$1", [c.source]),
      ];
      for (const edit of edits) { const c = await prepare(); await c.ack(); now = new Date(+(await c.job()).disponivel_at); await edit(c); assert.equal((await c.run()).skipped, true); assert.equal((await c.counts()).leads, 0); }
      const c = await prepare(b); await c.ack(); now = new Date(+(await c.job()).disponivel_at);
      await query("UPDATE group_notifier_routes SET enabled=false WHERE empresa_id=$1", [b.empresaId]); assert.equal((await c.run()).skipped, true);
      await query("UPDATE group_notifier_routes SET enabled=true WHERE empresa_id=$1", [b.empresaId]);
      await query("UPDATE empresas SET versao_configuracao=2 WHERE id=$1", [b.empresaId]); assert.equal((await c.run()).skipped, true);
      await query("UPDATE empresas SET versao_configuracao=1 WHERE id=$1", [b.empresaId]);
    });
    await t.test("mesmo contato em empresas distintas não compartilha dados, timer ou pausa", async () => {
      const x = await prepare(a), y = await prepare(b);
      const phone = (await query("SELECT telefone_normalizado FROM contatos WHERE id=$1", [x.contactId])).rows[0].telefone_normalizado;
      await query("UPDATE contatos SET telefone_normalizado=$2 WHERE id=$1", [y.contactId, phone]);
      await x.ack(); await y.ack();
      now = new Date(+(await x.job()).disponivel_at + 1000);
      assert.equal((await repo().completeLeadNameTimeout(y.reference, (await x.job()).payload)).skipped, true);
      assert.deepEqual(await y.counts(), { leads: 0, deliveries: 0, mode: "bot" });
      assert.equal((await x.run()).handedOff, true); assert.deepEqual(await y.counts(), { leads: 0, deliveries: 0, mode: "bot" });
      const inaccessible = await withTenantTransaction(txpool, { empresaId: b.empresaId }, tx => tx.client.query("SELECT id FROM qualified_leads WHERE empresa_id=$1", [a.empresaId]));
      assert.equal(inaccessible.rowCount, 0);
    });
    await t.test("avaliação sem nome mantém anexos e timer futuro não bloqueia mensagens normais", async () => {
      const c = await prepare(a, true); await c.ack();
      const cycle = (await query(`INSERT INTO follow_up_cycles(empresa_id,conversa_id,contato_id,profile,generation)
        VALUES($1,$2,$3,'test',0) RETURNING id`, [a.empresaId, c.conversationId, c.contactId])).rows[0].id;
      await query(`INSERT INTO follow_up_actions(empresa_id,cycle_id,slot,due_at,state) VALUES($1,$2,0,now(),'prepared'),($1,$2,1,now(),'pending')`, [a.empresaId, cycle]);
      const next = (await query(`INSERT INTO outbox_jobs(empresa_id,conversa_id,mensagem_id,job_type,dedup_key,payload,correlation_id,status)
        VALUES($1,$2,$3,'process_inbound_message',$4,'{}',$5,'publicado') RETURNING id`, [a.empresaId, c.conversationId, c.source, randomUUID(), randomUUID()])).rows[0].id;
      assert.equal((await new PostgresJobRepository(txpool).claim({ empresaId: a.empresaId, jobId: next })).outcome, "claimed");
      now = new Date(+(await c.job()).disponivel_at); assert.equal((await c.run()).handedOff, true);
      assert.equal((await query(`SELECT p.kind FROM group_notifier_delivery_parts p JOIN group_notifier_deliveries d ON d.id=p.delivery_id
        JOIN qualified_leads l ON l.id=d.lead_id WHERE l.conversa_id=$1 AND p.kind='image'`, [c.conversationId])).rowCount, 2);
      assert.equal((await query("SELECT enabled FROM follow_up_cycles WHERE id=$1", [cycle])).rows[0].enabled, false);
      assert.ok((await query("SELECT state FROM follow_up_actions WHERE cycle_id=$1", [cycle])).rows.every(row => row.state === "cancelled"));
    });
  } finally {
    await client.query("ROLLBACK"); client.release(); await pool.end();
  }
});
