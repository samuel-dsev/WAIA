import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { VersionedKeyring } from "../src/security/versioned-keyring.js";
import { withTenantTransaction } from "../src/infra/postgres/transaction.js";
import { compileTenantRuntimeConfigV2 } from "../src/modules/configuration/compiler.js";
import { PostgresJobHandlerRepository } from "../src/modules/jobs/handlers.js";
import { PostgresGroupNotifierRepository } from "../src/modules/group-notifier/postgres-repository.js";
import { PostgresOnboardingRepository } from "../src/modules/onboarding/postgres-onboarding-repository.js";
import { QUALIFICATION_CRITERIA } from "../src/modules/group-notifier/qualification.js";

test("PostgreSQL real: leads, outbox, sessão cifrada e lease isolados por empresa", {
  skip: process.env.RUN_GROUP_NOTIFIER_POSTGRES !== "true",
}, async (t) => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const keyring = new VersionedKeyring({ activeVersion: "test", keys: { test: randomBytes(32) } });
  t.after(async () => { keyring.destroy(); await pool.end(); await owner.end(); });
  const database = (await owner.query("SELECT current_database() AS name")).rows[0].name;
  assert.match(database, /^waia_gn_test_[0-9a-f]{12}$/u, "Este teste exige banco temporário exclusivo.");
  assert.equal((await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper, false);
  const actorId = (await owner.query(`INSERT INTO usuarios(email,nome,password_hash,papel_plataforma) VALUES ($1,'Admin teste','synthetic','administrador') RETURNING id`, [`${randomUUID()}@example.test`])).rows[0].id;
  const config = { schemaVersion: 2, identity: { name: "Escritório teste" }, modules: ["ai_freeform", "human_handoff"],
    menu: { text: "Como ajudar?", options: [{ id: "human", label: "Falar com equipe", action: "human_handoff.request", params: {} }] },
    ai: { enabled: true, provider: "openai", model: "test-model", prompt: "Triagem operacional para análise humana.", leadQualificationEnabled: true, leadQualificationCriteria: QUALIFICATION_CRITERIA } };
  const repo = new PostgresGroupNotifierRepository(pool, keyring), handlers = new PostgresJobHandlerRepository(pool);
  const tenants = [];
  for (const label of ["A", "B"]) {
    const empresaId = (await owner.query(`INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES ($1,$2,$2,'ativa') RETURNING id`, [`gn-${randomUUID()}`, `Empresa ${label}`])).rows[0].id;
    const compiled = compileTenantRuntimeConfigV2(config, { empresaId, configVersion: 1, draftVersion: 1 });
    await owner.query(`INSERT INTO configuracoes_revisoes(empresa_id,config_version,schema_version,compiler_version,source_draft_version,checksum,configuracao_compilada,publicada_por)
      VALUES ($1,1,2,1,1,$2,$3::jsonb,$4)`, [empresaId, compiled.checksum, JSON.stringify(compiled), actorId]);
    await owner.query("UPDATE empresas SET configuracao_runtime_modo='versionado',versao_configuracao=1,configuracao_ativa_versao=1 WHERE id=$1", [empresaId]);
    const contactId = (await owner.query(`INSERT INTO contatos(empresa_id,telefone_normalizado) VALUES ($1,$2) RETURNING id`, [empresaId, label === "A" ? "5511000000001" : "5511000000002"])).rows[0].id;
    const numeroWhatsappId = (await owner.query(`INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status) VALUES ($1,$2,'ativo') RETURNING id`, [empresaId, randomUUID()])).rows[0].id;
    tenants.push({ empresaId, contactId, numeroWhatsappId });
  }
  const [a, b] = tenants;
  const groupA = "120363000000001@g.us", groupB = "120363000000002@g.us", sender = "+5511000000099";
  await repo.configure(sender, actorId);
  let leaseOwner = randomUUID(), control = await repo.lease(leaseOwner);
  const epoch = Number(control.epoch);
  await repo.publish(leaseOwner, epoch, { phase: "connected" });
  await repo.cacheGroups(leaseOwner, epoch, [{ id: groupA, name: "Grupo A" }, { id: groupB, name: "Grupo B" }]);

  await t.test("grupos exclusivos, versão otimista e readiness por empresa", async () => {
    await repo.saveRoute(a.empresaId, { groupId: groupA, enabled: true, revision: 0 }, actorId);
    await assert.rejects(repo.saveRoute(b.empresaId, { groupId: groupA, enabled: true, revision: 0 }, actorId), { code: "GROUP_ALREADY_ASSIGNED" });
    await repo.saveRoute(b.empresaId, { groupId: groupB, enabled: true, revision: 0 }, actorId);
    await assert.rejects(repo.saveRoute(a.empresaId, { groupId: groupA, enabled: true, revision: 0 }, actorId), { code: "ROUTE_VERSION_CONFLICT" });
    assert.equal((await new PostgresOnboardingRepository(pool).readReadinessSnapshot({ empresaId: a.empresaId })).leadNotifications.destinationConfigured, true);
    assert.equal((await repo.route(b.empresaId)).groupId, groupB);
  });

  const provider = { initAuthCreds: () => ({ key: Buffer.from("synthetic-private-session") }),
    BufferJSON: { replacer: (_key, value) => value, reviver: (_key, value) => value?.type === "Buffer" ? Buffer.from(value.data) : value },
    proto: { Message: { AppStateSyncKeyData: { fromObject: (value) => value } } } };
  await t.test("sessão e Signal keys sobrevivem ao novo adapter, sem plaintext no banco", async () => {
    const store = repo.authStore(leaseOwner, epoch), state = await store.open(provider);
    await store.saveCredentials(state.creds);
    await state.keys.set({ session: { synthetic: Buffer.from("synthetic-private-key") } });
    const raw = (await owner.query("SELECT envelope::text FROM group_notifier_auth")).rows;
    assert.equal(raw.length, 2); assert.ok(raw.every((row) => !row.envelope.includes("synthetic-private")));
    const restored = await repo.authStore(leaseOwner, epoch).open(provider);
    assert.deepEqual(restored.creds.key, Buffer.from("synthetic-private-session"));
    assert.deepEqual((await restored.keys.get("session", ["synthetic"])).synthetic, Buffer.from("synthetic-private-key"));
    const cyclic = {}; cyclic.self = cyclic;
    await assert.rejects(state.keys.set({ session: { rollback: { safe: true } }, "sender-key": { broken: cyclic } }));
    assert.equal((await restored.keys.get("session", ["rollback"])).rollback, undefined, "Falha em uma categoria reverte o lote inteiro.");
    await repo.publish(leaseOwner, epoch, { phase: "qr", qr: "synthetic-private-qr", qrAt: Date.now() });
    assert.equal((await repo.status(actorId)).qr, "synthetic-private-qr");
    assert.ok(!(await owner.query("SELECT qr_envelope::text AS value FROM group_notifier_connection")).rows[0].value.includes("synthetic-private"));
    await repo.publish(leaseOwner, epoch, { phase: "connected" });
  });

  async function prepare(tenant) {
    const conversationId = (await owner.query(`INSERT INTO conversas(empresa_id,contato_id,numero_whatsapp_id,next_sequence) VALUES ($1,$2,$3,2) RETURNING id`, [tenant.empresaId, tenant.contactId, tenant.numeroWhatsappId])).rows[0].id;
    const messageId = (await owner.query(`INSERT INTO mensagens(empresa_id,conversa_id,contato_id,numero_whatsapp_id,direcao,tipo,corpo,status,sequence,correlation_id)
      VALUES ($1,$2,$3,$4,'entrada','texto','Nome: Ana Silva. Relata atraso do imóvel.','processando',1,$5) RETURNING id`, [tenant.empresaId, conversationId, tenant.contactId, tenant.numeroWhatsappId, randomUUID()])).rows[0].id;
    const reply = await handlers.prepareReply({ empresaId: tenant.empresaId, origin: "ai",
      message: { id: messageId, conversationId, contactId: tenant.contactId, numeroWhatsappId: tenant.numeroWhatsappId, correlationId: randomUUID() },
      reply: { text: "Aguarde a análise humana.", sendNotBefore: new Date().toISOString(), leadQualification: {
        name: "Ana Silva", summary: "Relata atraso de entrega do imóvel e deseja análise do escritório.", qualification: "Demanda imobiliária; requer análise humana.", configVersion: 1,
      } } });
    return { ...tenant, conversationId, messageId, replyId: reply.id };
  }
  async function acknowledge(item) { await handlers.markReplySent({ empresaId: item.empresaId, replyId: item.replyId, externalMessageId: `wamid.${item.replyId}` }); }
  async function archive(item) { await owner.query("UPDATE conversas SET status='arquivada' WHERE id=$1", [item.conversationId]); }

  let firstA, firstB;
  await t.test("confirmação cria ficha e outbox atomicamente, pausa sem duplicar e usa telefone real", async () => {
    firstA = await prepare(a);
    assert.equal((await repo.leads(a.empresaId)).length, 0);
    await acknowledge(firstA); await acknowledge(firstA);
    const leads = await repo.leads(a.empresaId); assert.equal(leads.length, 1);
    assert.equal(leads[0].phone, "5511000000001"); assert.equal(leads[0].notificationStatus, "pending");
    assert.equal((await owner.query("SELECT modo_atendimento AS mode FROM conversas WHERE id=$1", [firstA.conversationId])).rows[0].mode, "pausado");
    firstB = await prepare(b); await acknowledge(firstB);
    const delivery = await repo.candidate(leaseOwner, epoch);
    assert.equal(delivery.group_id, groupA);
    const send = await repo.beginSend(leaseOwner, epoch, delivery.id);
    assert.equal(send.company_name, "Empresa A"); assert.equal(send.group_id, groupA); assert.equal(send.phone, "5511000000001");
  });

  await t.test("RLS oculta outra empresa e todo material da sessão; FKs rejeitam ligação cruzada", async () => {
    const result = await withTenantTransaction(pool, { empresaId: b.empresaId }, async ({ client }) => ({
      leads: (await client.query("SELECT empresa_id FROM qualified_leads")).rows,
      auth: (await client.query("SELECT * FROM group_notifier_auth")).rows,
      sender: (await client.query("SELECT * FROM group_notifier_connection")).rows,
      groups: (await client.query("SELECT * FROM group_notifier_groups")).rows,
    }));
    assert.deepEqual(result.leads.map((lead) => lead.empresa_id), [b.empresaId]);
    assert.deepEqual(result.auth, []); assert.deepEqual(result.sender, []); assert.deepEqual(result.groups, []);
    await assert.rejects(withTenantTransaction(pool, { empresaId: b.empresaId }, ({ client }) => client.query(`INSERT INTO qualified_leads(empresa_id,conversa_id,contato_id,reply_id,config_version)
      VALUES($1,$2,$3,$4,1)`, [b.empresaId, firstA.conversationId, b.contactId, firstB.replyId])), { code: "23503" });
    assert.equal((await repo.leads(a.empresaId)).length, 1);
  });

  await t.test("lease exclusivo, fencing e recuperação de envio interrompido sem retry", async () => {
    const nextOwner = randomUUID(); assert.equal(await repo.lease(nextOwner), null);
    const staleStore = repo.authStore(leaseOwner, epoch); await staleStore.open(provider);
    await owner.query("UPDATE group_notifier_connection SET lease_until=now()-interval '1 second'");
    assert.ok(await repo.lease(nextOwner));
    await assert.rejects(staleStore.saveCredentials({ private: "synthetic" }), { code: "NOTIFIER_LEASE_LOST" });
    leaseOwner = nextOwner;
    await repo.recover(leaseOwner, epoch);
    assert.equal((await repo.leads(a.empresaId))[0].notificationStatus, "unconfirmed");
    const candidate = await repo.candidate(leaseOwner, epoch); assert.equal(candidate.group_id, groupB);
    await repo.beginSend(leaseOwner, epoch, candidate.id); await repo.complete(leaseOwner, candidate.id, { messageId: "wamid.group.synthetic" });
    assert.equal((await repo.leads(b.empresaId))[0].notificationStatus, "accepted");
    assert.equal(await repo.candidate(leaseOwner, epoch), null);
  });

  await t.test("posse humana anterior à confirmação impede conclusão automática", async () => {
    await archive(firstA); const manual = await prepare(a);
    await owner.query("UPDATE conversas SET modo_atendimento='humano' WHERE id=$1", [manual.conversationId]);
    await acknowledge(manual);
    assert.equal((await repo.leads(a.empresaId)).length, 1);
    await archive(manual);
  });

  await t.test("suspensão e mudança de destino cancelam somente pendências da empresa", async () => {
    const pending = await prepare(a); await acknowledge(pending);
    const candidate = await repo.candidate(leaseOwner, epoch);
    await owner.query("UPDATE empresas SET status='suspensa' WHERE id=$1", [a.empresaId]);
    assert.equal(await repo.beginSend(leaseOwner, epoch, candidate.id), null);
    assert.equal((await repo.leads(a.empresaId))[0].notificationStatus, "cancelled");
    await owner.query("UPDATE empresas SET status='ativa' WHERE id=$1", [a.empresaId]); await archive(pending);
    const another = await prepare(a); await acknowledge(another);
    await repo.publish(leaseOwner, epoch, { phase: "disconnected" });
    await repo.saveRoute(a.empresaId, { groupId: groupA, enabled: false, revision: 1 }, actorId);
    assert.equal((await repo.leads(a.empresaId))[0].notificationStatus, "cancelled");
    await repo.publish(leaseOwner, epoch, { phase: "connected" });
    await repo.saveRoute(a.empresaId, { groupId: groupA, enabled: true, revision: 2 }, actorId);
    await archive(another);
  });

  await t.test("anonimização de contato e retenção da mensagem removem cópias do resumo", async () => {
    const item = await prepare(a); await acknowledge(item);
    await owner.query("UPDATE mensagens SET corpo=NULL,outbound_payload='{}',redacted_at=now() WHERE id=$1", [item.replyId]);
    const lead = (await owner.query("SELECT name,summary,phone,redacted_at FROM qualified_leads WHERE reply_id=$1", [item.replyId])).rows[0];
    assert.equal(lead.name, null); assert.equal(lead.summary, null); assert.equal(lead.phone, null); assert.ok(lead.redacted_at);
    await owner.query("UPDATE contatos SET deleted_at=now() WHERE id=$1", [b.contactId]);
    assert.equal((await repo.leads(b.empresaId)).length, 0);
    assert.ok((await owner.query("SELECT redacted_at FROM qualified_leads WHERE empresa_id=$1", [b.empresaId])).rows.every((row) => row.redacted_at));
  });

  await t.test("revogação apaga material cifrado e invalida leituras/escritas da sessão anterior", async () => {
    const store = repo.authStore(leaseOwner, epoch); await store.open(provider);
    await repo.revoke(actorId);
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM group_notifier_auth")).rows[0].n, 0);
    await assert.rejects(store.saveCredentials({ key: "old" }), { code: "NOTIFIER_LEASE_LOST" });
  });

  await t.test("processo dedicado inicia sem WhatsApp e encerra liberando o lease", async () => {
    await repo.release(leaseOwner);
    await owner.query("UPDATE group_notifier_connection SET heartbeat_at=NULL");
    const child = spawn(process.execPath, ["src/group-notifier.js"], { env: { ...process.env,
      MASTER_KEYRING: JSON.stringify({ activeVersion: "smoke", keys: { smoke: randomBytes(32).toString("base64") } }),
    }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { output += data; });
    const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    try {
      let alive = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const state = (await owner.query("SELECT phase,heartbeat_at,lease_owner FROM group_notifier_connection")).rows[0];
        if (state.heartbeat_at && state.phase === "disconnected" && state.lease_owner) { alive = true; break; }
        if (child.exitCode !== null) break;
        await delay(100);
      }
      assert.equal(alive, true, "Processo deve assumir a conexão sem abrir socket quando desired=false.");
      child.kill("SIGTERM");
      const stopped = await Promise.race([exit, delay(5000).then(() => null)]);
      assert.deepEqual(stopped, { code: 0, signal: null });
      assert.equal((await owner.query("SELECT lease_owner FROM group_notifier_connection")).rows[0].lease_owner, null);
      assert.equal(output, "");
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exit; } }
  });
});
