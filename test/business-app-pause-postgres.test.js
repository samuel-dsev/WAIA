import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { compileTenantRuntimeConfigV2 } from "../src/modules/configuration/compiler.js";
import { PostgresBusinessAppPause } from "../src/modules/meta/business-app-pause.js";
import { ConversationService } from "../src/modules/conversations/conversation-service.js";
import { PostgresConversationRepository } from "../src/modules/conversations/postgres-conversation-repository.js";
import { PostgresJobHandlerRepository } from "../src/modules/jobs/handlers.js";

test("PostgreSQL real: resposta pelo aplicativo pausa apenas a conversa, com isolamento e retomada manual", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "true",
}, async (t) => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  t.after(async () => { await pool.end(); await owner.end(); });
  const db = (await owner.query("SELECT current_database() AS name")).rows[0].name;
  assert.match(db, /^waia_gn_test_[0-9a-f]{12}$/u, "Exige banco temporário exclusivo.");
  const role = (await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const actor = (await owner.query("INSERT INTO usuarios(email,nome,password_hash,papel_plataforma) VALUES($1,'Teste','synthetic','administrador') RETURNING id", [`${randomUUID()}@example.test`])).rows[0].id;
  const fixtures = [];
  for (const enabled of [true, false]) {
    const empresaId = (await owner.query("INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1,'Teste','Teste','ativa') RETURNING id", [`app-pause-${randomUUID()}`])).rows[0].id;
    const compiled = compileTenantRuntimeConfigV2({ schemaVersion: 2, identity: { name: "Teste" }, modules: ["human_handoff"],
      menu: { text: "Olá", options: [{ id: "human", label: "Atendente", action: "human_handoff.request", params: {} }] },
      humanHandoff: { pauseOnBusinessAppMessage: enabled } }, { empresaId, configVersion: 1, draftVersion: 1 });
    await owner.query(`INSERT INTO configuracoes_revisoes(empresa_id,config_version,schema_version,compiler_version,source_draft_version,checksum,configuracao_compilada,publicada_por)
      VALUES($1,1,2,1,1,$2,$3::jsonb,$4)`, [empresaId, compiled.checksum, JSON.stringify(compiled), actor]);
    await owner.query("UPDATE empresas SET configuracao_runtime_modo='versionado',versao_configuracao=1,configuracao_ativa_versao=1 WHERE id=$1", [empresaId]);
    const credentials = [];
    for (const purpose of ["ycloud-webhook-secret", "ycloud-api-key"]) credentials.push((await owner.query(`INSERT INTO credenciais_empresa
      (empresa_id,provedor,finalidade,secret_ciphertext,secret_kdf_salt,secret_nonce,secret_tag,key_version,valor_mascarado)
      VALUES($1,'ycloud',$2,decode(repeat('11',32),'hex'),decode(repeat('22',16),'hex'),decode(repeat('33',12),'hex'),decode(repeat('44',16),'hex'),'test','synthetic') RETURNING id`, [empresaId, purpose])).rows[0].id);
    const appId = (await owner.query("INSERT INTO aplicativos_meta(empresa_id,nome,app_id,modo,estado,app_secret_credencial_id) VALUES($1,'Teste',$2,'ycloud','ativo',$3) RETURNING id", [empresaId, randomUUID(), credentials[0]])).rows[0].id;
    const numberId = (await owner.query("INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status,aplicativo_meta_id,access_token_credencial_id) VALUES($1,$2,'ativo',$3,$4) RETURNING id", [empresaId, randomUUID(), appId, credentials[1]])).rows[0].id;
    const conversation = new ConversationService({ repository: new PostgresConversationRepository(pool) });
    const { conversation: c } = await conversation.openOrResume({ empresaId, phone: "5511999990001", numeroWhatsappId: numberId });
    const { conversation: other } = await conversation.openOrResume({ empresaId, phone: "5511999990002", numeroWhatsappId: numberId });
    fixtures.push({ empresaId, appId, numberId, conversation, c, other });
  }
  const [a, b] = fixtures, pause = new PostgresBusinessAppPause(pool), handlers = new PostgresJobHandlerRepository(pool);
  const input = (f, overrides = {}) => ({ empresaId: f.empresaId, appId: f.appId, numberId: f.numberId,
    recipientPhone: "5511999990001", externalMessageId: `wamid.${randomUUID()}`, sentAt: new Date().toISOString(), ...overrides });
  const mode = async (f, id = f.c.id) => (await f.conversation.getConversation({ empresaId: f.empresaId, conversationId: id })).mode;

  await t.test("pausa isolada cancela permissão de resposta pendente e não cria lead", async () => {
    const incoming = await a.conversation.recordMessage({ empresaId: a.empresaId, conversationId: a.c.id, direction: "inbound", body: "Teste", correlationId: randomUUID() });
    assert.equal(await handlers.canSendBotReply({ empresaId: a.empresaId, messageId: incoming.id }), true);
    assert.deepEqual(await pause.receive(input(a)), { paused: true });
    assert.equal(await mode(a), "paused"); assert.equal(await mode(a, a.other.id), "bot"); assert.equal(await mode(b), "bot");
    assert.equal(await handlers.canSendBotReply({ empresaId: a.empresaId, messageId: incoming.id }), false);
    for (const table of ["qualified_leads", "group_notifier_deliveries", "outbox_jobs"]) assert.equal(Number((await owner.query(`SELECT count(*) FROM ${table} WHERE empresa_id=$1`, [a.empresaId])).rows[0].count), 0);
  });
  await t.test("desativado, outro tenant/número/aplicativo e contato inexistente não pausam", async () => {
    assert.deepEqual(await pause.receive(input(b)), { paused: false });
    for (const changes of [{ empresaId: b.empresaId }, { appId: b.appId }, { numberId: b.numberId }, { recipientPhone: "5511999999999" }]) assert.deepEqual(await pause.receive(input(a, changes)), { paused: false });
    assert.equal(await mode(b), "bot");
  });
  await t.test("duplicidade e eco anterior à retomada não devolvem conversa pausada", async () => {
    const echo = input(a);
    await Promise.all([pause.receive(echo), pause.receive(echo)]);
    assert.equal(Number((await owner.query("SELECT count(*) FROM mensagens WHERE external_message_id=$1", [echo.externalMessageId])).rows[0].count), 1);
    await a.conversation.resumeBot({ empresaId: a.empresaId, conversationId: a.c.id });
    await pause.receive(echo);
    assert.equal(await mode(a), "bot");
    assert.deepEqual(await pause.receive(input(a, { sentAt: new Date(Date.now() - 10000).toISOString() })), { paused: false });
    assert.equal(await mode(a), "bot");
    assert.deepEqual(await pause.receive(input(a)), { paused: true });
  });
  await t.test("eco correspondente a um envio da API é deduplicado", async () => {
    const echo = input(a);
    await a.conversation.recordMessage({ empresaId: a.empresaId, conversationId: a.c.id, direction: "outbound", body: "Resposta automática", origin: "deterministic_flow", externalMessageId: echo.externalMessageId, correlationId: randomUUID() });
    await a.conversation.resumeBot({ empresaId: a.empresaId, conversationId: a.c.id });
    assert.deepEqual(await pause.receive(echo), { paused: false });
    assert.equal(await mode(a), "bot");
  });
  await t.test("atendimento humano, histórico e responsável são preservados", async () => {
    await owner.query("INSERT INTO usuarios_empresas(empresa_id,usuario_id,papel,status) VALUES($1,$2,'administrador','ativo')", [a.empresaId, actor]);
    await a.conversation.handoffToHuman({ empresaId: a.empresaId, conversationId: a.c.id, operatorId: actor });
    await pause.receive(input(a));
    const c = await a.conversation.getConversation({ empresaId: a.empresaId, conversationId: a.c.id });
    assert.equal(c.mode, "human"); assert.equal(c.operatorId, actor);
    const history = await a.conversation.getHistory({ empresaId: a.empresaId, conversationId: a.c.id, limit: 100 });
    assert.ok(history.some((m) => m.body === "Teste"));
    assert.ok(history.some((m) => m.direction === "internal" && m.externalMessageId?.startsWith("wamid.")));
  });
});
