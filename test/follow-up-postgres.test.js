import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { withPlatformTransaction, withTenantTransaction } from '../src/infra/postgres/transaction.js';
import { FollowUpRepository } from '../src/modules/follow-up/repository.js';
import { compileTenantRuntimeConfigV2 } from '../src/modules/configuration/compiler.js';
import { readGroupDelivery, groupDeliveryAllowed } from '../src/modules/group-notifier/delivery-images.js';
import { handleFollowUpDecline } from '../src/modules/follow-up/decline.js';

test('follow-up PostgreSQL: opt-in, relógio, persistência, cancelamento, isolamento e fichas', { skip: process.env.RUN_POSTGRES_INTEGRATION !== 'true' }, async t => {
  assert.equal(process.env.NODE_ENV, 'test');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL }), client = await pool.connect();
  let serial = 0, now = new Date(); const anchor = new Date(now);
  const txpool = { async connect() { const id = `follow_up_${++serial}`; return { async query(sql,args) {
    if (sql === 'BEGIN') return client.query(`SAVEPOINT ${id}`);
    if (sql === 'COMMIT') return client.query(`RELEASE SAVEPOINT ${id}`);
    if (sql === 'ROLLBACK') { await client.query(`ROLLBACK TO SAVEPOINT ${id}`); return client.query(`RELEASE SAVEPOINT ${id}`); }
    return client.query(sql,args);
  }, release() {} }; } };
  const query = (...args) => withPlatformTransaction(txpool, {}, tx => tx.client.query(...args));
  const repo = new FollowUpRepository({ pool: txpool, clock: () => now });
  try {
    assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, 'waia_v2_upgrade');
    await client.query('BEGIN');
    const actor = (await query(`INSERT INTO usuarios(email,nome,password_hash,papel_plataforma) VALUES($1,'Follow-up fixture','synthetic','administrador') RETURNING id`, [`${randomUUID()}@example.test`])).rows[0].id;
    const auth = { audience: 'admin', platformRole: 'platform_admin', user: { id: actor } };
    const a = (await query(`INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1,'Follow-up fixture','Follow-up fixture','ativa') RETURNING id`, [`fu-${randomUUID()}`])).rows[0].id;
    const b = (await query(`INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1,'Isolada','Isolada','ativa') RETURNING id`, [`fu-${randomUUID()}`])).rows[0].id;
    const compiled = compileTenantRuntimeConfigV2({ schemaVersion: 2, identity: { name: 'Fictícia' }, modules: ['ai_freeform','human_handoff'],
      menu: { text: 'Como ajudar?', options: [{ id: 'human', label: 'Equipe', action: 'human_handoff.request', params: {} }] },
      ai: { enabled: true, provider: 'openai', model: 'synthetic', prompt: 'Atenda perguntas sobre veículos.' } }, { empresaId: a, configVersion: 1, draftVersion: 1 });
    await query(`INSERT INTO configuracoes_revisoes(empresa_id,config_version,schema_version,compiler_version,source_draft_version,checksum,configuracao_compilada,publicada_por)
      VALUES($1,1,2,1,1,$2,$3,$4)`, [a, compiled.checksum, compiled, actor]);
    await query("UPDATE empresas SET configuracao_runtime_modo='versionado',versao_configuracao=1,configuracao_ativa_versao=1 WHERE id=$1", [a]);
    const number = (await query(`INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status) VALUES($1,$2,'ativo') RETURNING id`, [a, randomUUID()])).rows[0].id;
    async function conversation(inbounds = 1, ageDays = 0) {
      const contact = (await query('INSERT INTO contatos(empresa_id,telefone_normalizado) VALUES($1,$2) RETURNING id', [a, `5511${String(serial++).padStart(7,'0')}`])).rows[0].id;
      const c = (await query('INSERT INTO conversas(empresa_id,contato_id,numero_whatsapp_id) VALUES($1,$2,$3) RETURNING id', [a, contact, number])).rows[0].id;
      const messages = [];
      for (let i = 0; i < inbounds; i++) messages.push(await add(c, contact, 'entrada', i ? 'Prefiro automático.' : 'Procuro hatch.', ageDays));
      await add(c, contact, 'saida', 'Qual faixa de preço prefere?', ageDays);
      return { id: c, contact, messages };
    }
    async function add(c, contact, direction, body, ageDays = 0) {
      const seq = (await query('UPDATE conversas SET next_sequence=next_sequence+1 WHERE empresa_id=$1 AND id=$2 RETURNING next_sequence-1 AS n', [a,c])).rows[0].n;
      return (await query(`INSERT INTO mensagens(empresa_id,conversa_id,contato_id,numero_whatsapp_id,direcao,tipo,corpo,status,sequence,correlation_id,created_at,provider_timestamp,external_message_id)
        VALUES($1,$2,$3,$4,$5,'texto',$6,$7,$8,$9,$10,$10,$11) RETURNING *`, [a,c,contact,number,direction,body,direction === 'saida' ? 'enviada' : 'respondida',seq,randomUUID(),new Date(+now - ageDays * 86400000), direction === 'saida' ? `fixture-${randomUUID()}` : null])).rows[0];
    }
    async function enable(c) { return repo.toggle(auth,a,c.id,{enabled:true,expectedVersion:0}); }
    async function actions(c) { return (await query(`SELECT a.* FROM follow_up_actions a JOIN follow_up_cycles f ON f.empresa_id=a.empresa_id AND f.id=a.cycle_id WHERE a.empresa_id=$1 AND f.conversa_id=$2 ORDER BY slot`, [a,c.id])).rows; }
    const draft = { text: 'Ainda deseja ajuda com o hatch?', summary: 'Cliente procura hatch e prefere câmbio automático; orçamento não informado.' };
    await t.test('empresa/contatos novos desligados, habilitação explícita e versão otimista', async () => {
      const c = await conversation();
      assert.equal((await repo.read(auth,a,c.id)).contact.enabled,false);
      assert.equal((await repo.read(auth,a)).settings.enabled,false);
      await assert.rejects(enable(c), {code:'FOLLOW_UP_COMPANY_DISABLED'});
      await repo.saveSettings(auth,a,{enabled:true,profile:'test',expectedVersion:0});
      await assert.rejects(repo.saveSettings(auth,a,{enabled:true,profile:'test',expectedVersion:0}), {code:'FOLLOW_UP_CONFLICT'});
      assert.equal((await repo.read(auth,a,c.id)).contact.enabled,false);
      await query("UPDATE conversas SET modo_atendimento='pausado' WHERE empresa_id=$1 AND id=$2",[a,c.id]);
      await assert.rejects(enable(c), {code:'FOLLOW_UP_BOT_REQUIRED'});
    });
    await t.test('contador inicia agora mesmo com histórico antigo; não envia texto fora de 24h', async () => {
      const c = await conversation(2,30); await enable(c); const [action] = await actions(c);
      assert.equal(+action.due_at - +now, 120000); now = new Date(+anchor + 120000);
      const snapshot = await repo.snapshot(a,action.id); assert.equal(snapshot.inWindow,false);
      await repo.prepare(a,action.id,snapshot,draft);
      assert.equal((await actions(c))[0].reason,'APPROVED_TEMPLATE_REQUIRED');
    });
    await t.test('duas empresas isoladas e referência de job somente IDs', async () => {
      const count = await withTenantTransaction(txpool,{empresaId:b},async tx => (await tx.client.query('SELECT * FROM follow_up_cycles WHERE empresa_id=$1',[a])).rowCount);
      assert.equal(count,0);
      const jobs = (await query("SELECT payload::text AS payload FROM outbox_jobs WHERE empresa_id=$1 AND job_type='process_follow_up'",[a])).rows;
      assert.ok(jobs.every(j => !j.payload.includes('hatch') && !j.payload.includes('5511')));
    });
    await t.test('resposta recebida entre geração e claim cancela efeito sem alterar bot', async () => {
      const c = await conversation(); await enable(c); const [action] = await actions(c); now = new Date(+now + 120000);
      await repo.prepare(a,action.id,await repo.snapshot(a,action.id),draft);
      await add(c.id,c.contact,'entrada','Até 60 mil.');
      assert.equal((await repo.claim(a,action.id)).allowed,undefined);
      assert.equal((await actions(c))[0].reason,'CUSTOMER_REPLIED');
      assert.equal((await query('SELECT modo_atendimento FROM conversas WHERE id=$1',[c.id])).rows[0].modo_atendimento,'bot');
    });
    await t.test('claim único, reinício preserva contador; resultado incerto cancela o restante', async () => {
      const c = await conversation(); await enable(c); const [action] = await actions(c); now = new Date(+now+120000);
      await repo.prepare(a,action.id,await repo.snapshot(a,action.id),draft);
      const claim = await repo.claim(a,action.id); assert.equal(claim.allowed,true);
      const restarted = new FollowUpRepository({pool:txpool,clock:()=>now});
      assert.equal((await restarted.claim(a,action.id)).uncertain,true);
      assert.equal((await repo.read(auth,a,c.id)).contact.state,'uncertain');
      assert.ok((await actions(c)).slice(1).every(a=>a.state==='cancelled'));
    });
    await t.test('pausa humana cancela e devolver ao bot não reativa nem acumula disparos', async () => {
      const c = await conversation(); await enable(c);
      await query("UPDATE conversas SET modo_atendimento='pausado',lock_version=lock_version+1 WHERE id=$1",[c.id]);
      await query("UPDATE conversas SET modo_atendimento='bot',lock_version=lock_version+1 WHERE id=$1",[c.id]);
      assert.equal((await repo.read(auth,a,c.id)).contact.enabled,false);
      assert.ok((await actions(c)).every(a=>a.state==='cancelled'));
    });
    await t.test('dia quatro: sem resposta adicional não cria ficha e preserva modo bot', async () => {
      const c = await conversation(); await enable(c); const action = (await actions(c))[4]; now = new Date(+now+1200000);
      await repo.prepare(a,action.id,await repo.snapshot(a,action.id),{text:'',summary:''});
      assert.equal((await query('SELECT 1 FROM follow_up_handoffs WHERE conversa_id=$1',[c.id])).rowCount,0);
      assert.equal((await query('SELECT modo_atendimento FROM conversas WHERE id=$1',[c.id])).rows[0].modo_atendimento,'bot');
    });
    await t.test('dia quatro: interação mínima gera ficha tipada sem nome fictício e destino pendente', async () => {
      const c = await conversation(2); await enable(c); const action = (await actions(c))[4]; now = new Date(+now+1200000);
      await repo.prepare(a,action.id,await repo.snapshot(a,action.id),draft);
      const card = (await query('SELECT * FROM follow_up_handoffs WHERE conversa_id=$1',[c.id])).rows[0];
      assert.match(card.summary,/automático/);
      assert.equal((await query('SELECT 1 FROM qualified_leads WHERE conversa_id=$1',[c.id])).rowCount,0);
      assert.equal((await repo.read(auth,a,c.id)).contact.notificationStatus,'awaiting_route');
      await query(`INSERT INTO group_notifier_routes(empresa_id,group_id,group_name,sender_phone,enabled) VALUES($1,$2,'Grupo fictício','+5511000000099',true)`,[a,`120363${Date.now()}@g.us`]);
      const delivery=(await query(`INSERT INTO group_notifier_deliveries(empresa_id,follow_up_handoff_id,group_id,route_revision,sender_phone)
        SELECT $1,$2,group_id,revision,sender_phone FROM group_notifier_routes WHERE empresa_id=$1 RETURNING id`,[a,card.id])).rows[0];
      await query("UPDATE group_notifier_connection SET phone='+5511000000099' WHERE id");
      const read=await withPlatformTransaction(txpool,{},tx=>readGroupDelivery(tx.client,delivery.id));
      assert.equal(read.name,null);assert.equal(read.follow_up_handoff_id,card.id);assert.equal(groupDeliveryAllowed(read),true);
      await query("UPDATE mensagens SET redacted_at=now() WHERE id=$1",[c.messages[0].id]);
      assert.equal((await query('SELECT summary FROM follow_up_handoffs WHERE id=$1',[card.id])).rows[0].summary,null);
      const redacted=await withPlatformTransaction(txpool,{},tx=>readGroupDelivery(tx.client,delivery.id));assert.equal(groupDeliveryAllowed(redacted),false);
    });
    await t.test('desinteresse fica restrito ao follow-up; cortesia é enviável com prova da pausa própria', async () => {
      const c = await conversation(); await enable(c); const [action] = await actions(c); now = new Date(+now+120000);
      await repo.prepare(a,action.id,await repo.snapshot(a,action.id),draft);
      const claim=await repo.claim(a,action.id); await repo.finish(a,action.id,claim.messageId,`fixture-${randomUUID()}`);
      const m=await add(c.id,c.contact,'entrada','não obrigado');
      let sends=0;
      const input={empresaId:a,message:{id:m.id,conversationId:c.id,contactId:c.contact,numeroWhatsappId:number,sequence:Number(m.sequence),text:m.corpo,correlationId:randomUUID()},metaGateway:{sendReply:async()=>{sends++;return{messages:[{id:'fixture-decline'}]};}}};
      const handled=await handleFollowUpDecline(repo,input);assert.equal(handled.replied,true);
      await handleFollowUpDecline(repo,input);assert.equal(sends,1);
      const courtesy=(await query('SELECT corpo FROM mensagens WHERE source_message_id=$1',[m.id])).rows[0];assert.match(courtesy.corpo,/disposição/);
      assert.equal((await repo.read(auth,a,c.id)).contact.state,'declined');
      assert.equal((await query('SELECT 1 FROM follow_up_handoffs WHERE conversa_id=$1',[c.id])).rowCount,0);
      const untouched = await conversation(); const msg = await add(untouched.id,untouched.contact,'entrada','não obrigado');
      assert.equal(await handleFollowUpDecline(repo,{empresaId:a,message:{conversationId:untouched.id,id:msg.id,text:msg.corpo,sequence:Number(msg.sequence)},metaGateway:{sendReply:()=>assert.fail('Sem opt-in não pode interceptar')}}),null);
      assert.equal((await query('SELECT modo_atendimento FROM conversas WHERE id=$1',[untouched.id])).rows[0].modo_atendimento,'bot');
    });
    await t.test('horas personalizadas persistem sete mensagens, remoção e fechamento independente',async()=>{
      const version=(await repo.read(auth,a)).settings.version;
      const values=[0.5,2,6,24,48,72,90];
      await repo.saveSettings(auth,a,{enabled:true,profile:'custom',periodsHours:values,closeAfterHours:96,expectedVersion:version});
      const c=await conversation();await enable(c);const created=await actions(c);
      assert.equal(created.length,8);assert.deepEqual(created.slice(0,-1).map(row=>(+row.due_at-+now)/3600000),values);
      assert.equal(created[7].is_closure,true);assert.equal(created[4].is_closure,false);
      now=new Date(+now+48*3600000);
      const snapshot=await repo.snapshot(a,created[4].id);assert.equal(snapshot.row.slot,4);assert.equal(snapshot.row.is_closure,false);
      await repo.prepare(a,created[4].id,snapshot,draft); // no template: blocked, never mistaken for closure
      assert.equal((await query('SELECT 1 FROM follow_up_handoffs WHERE conversa_id=$1',[c.id])).rowCount,0);
      await repo.saveSettings(auth,a,{enabled:true,profile:'custom',periodsHours:[2,24],closeAfterHours:96,expectedVersion:version+1});
      assert.equal((await repo.read(auth,a,c.id)).contact.enabled,false);
      const other=await conversation();await enable(other);assert.equal((await actions(other)).length,3);
    });
    await t.test('template contextual aprovado pode reativar histórico antigo sem texto livre',async()=>{
      const version=(await repo.read(auth,a)).settings.version;
      await repo.saveSettings(auth,a,{enabled:true,profile:'test',templates:[{name:'retomar',language:'pt_BR'},null,null,null],expectedVersion:version});
      const c=await conversation(2,30);await enable(c);const [action]=await actions(c);now=new Date(+now+120000);
      const snapshot=await repo.snapshot(a,action.id);
      const template={name:'retomar',language:'pt_BR',body:'Olá! Sobre seu atendimento: {{1}}',footer:'',wabaId:'fixture',fingerprint:'verified-fixture'};
      await repo.prepare(a,action.id,snapshot,draft,template);
      const claim=await repo.claim(a,action.id,template);assert.equal(claim.allowed,true);
      assert.equal(claim.template.name,'retomar');assert.equal(claim.parameter,draft.text);
      await repo.finish(a,action.id,claim.messageId,`fixture-${randomUUID()}`);
      assert.equal((await actions(c))[0].state,'accepted');
    });
  } finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
});
