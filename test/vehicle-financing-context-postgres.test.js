import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresWebhookRepository} from '../src/infra/postgres/repositories/webhook-repository.js';
import {PostgresJobHandlerRepository,createWorkerHandlers} from '../src/modules/jobs/handlers.js';
import {ConversationService} from '../src/modules/conversations/conversation-service.js';
import {PostgresConversationRepository} from '../src/modules/conversations/postgres-conversation-repository.js';
import {PostgresTenantDefinitionRepository} from '../src/tenants/postgres-config-loader.js';
import {compileTenantRuntimeConfigV2} from '../src/modules/configuration/index.js';
import {WebsiteCatalogIntegration} from '../src/integrations/website-catalog/integration.js';
import {fetchWebsiteStock} from '../src/integrations/website-catalog/stock.js';
import {MemoryAiConfigResolver,MemoryAiLedger,MemoryAiSecretResolver,MemoryPricingCatalog,MemoryResponsesClientFactory,MultiTenantAiService} from '../src/modules/ai/index.js';

test('PostgreSQL: anúncio, pergunta enviada, foto e Onix preservam a simulação correta após restart sem repetir envio',{
 skip:process.env.RUN_POSTGRES_INTEGRATION!=='true',
},async()=>{
 assert.match(new URL(process.env.DATABASE_URL).pathname,/^\/waia_v2_/u);
 const owner=new pg.Pool({connectionString:process.env.DATABASE_MIGRATOR_URL,options:'-c app.is_platform_admin=true'}),pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
 let empresaId,actorId;
 try{
  empresaId=(await owner.query("INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1,'Contexto sintético','Contexto sintético','ativa') RETURNING id",['model-context-'+randomUUID()])).rows[0].id;
  actorId=(await owner.query("INSERT INTO usuarios(email,nome,password_hash,papel_plataforma) VALUES($1,'Contexto sintético','synthetic','administrador') RETURNING id",[randomUUID()+'@example.test'])).rows[0].id;
  const integrationId=(await owner.query("INSERT INTO integracoes(empresa_id,tipo,nome,habilitada) VALUES($1,'website_catalog','Site sintético',true) RETURNING id",[empresaId])).rows[0].id;
  const compiled=compileTenantRuntimeConfigV2({schemaVersion:2,identity:{name:'Contexto sintético'},modules:['catalog','ai_freeform','human_handoff'],menu:{text:'Menu',options:[]},
   ai:{enabled:true,provider:'openai',model:'test',maxOutputTokens:1000,prompt:'Continue a triagem pelo modelo informado.',contextualServiceEnabled:true,responseDelayEnabled:false,leadQualificationEnabled:true,leadQualificationCriteria:'Nome, modelo e dados de financiamento.',tradeInEvaluationEnabled:true,leadImageHandoffEnabled:true},
   integrations:[{id:integrationId,type:'website_catalog',name:'Site sintético',enabled:true}]},{empresaId,configVersion:1,draftVersion:1});
  await owner.query('INSERT INTO configuracoes_revisoes(empresa_id,config_version,schema_version,compiler_version,source_draft_version,checksum,configuracao_compilada,publicada_por) VALUES($1,1,2,1,1,$2,$3::jsonb,$4)',[empresaId,compiled.checksum,JSON.stringify(compiled),actorId]);
  await owner.query("UPDATE empresas SET configuracao_runtime_modo='versionado',versao_configuracao=1,configuracao_ativa_versao=1 WHERE id=$1",[empresaId]);
  const stockDefaults={km:73000,cambio:'Manual',combustivel:'Flex',cor:'Prata',descricao:'<p>Veículo sintético para teste de atendimento.</p>'};
  const fakeStock='<script>\nwindow.VEICULOS = '+JSON.stringify([{...stockDefaults,id:56,titulo:'ÔNIX JOY',modelo:'ÔNIX JOY',ano:2019,preco:55900,imagens:['/storage/veiculos/test-onix.jpg']},{...stockDefaults,id:66,titulo:'HB20 COMFORT 1.0 2017',modelo:'HB20 COMFORT 1.0 2017',ano:2017,preco:54900,imagens:['/storage/veiculos/test-hb20.jpg']}])+';\n</script>';
  const integration=new WebsiteCatalogIntegration({pool,fetchStock:()=>fetchWebsiteStock({fetchImpl:async()=>new Response(fakeStock,{headers:{'Content-Type':'text/html'}})})});
  const sync=await integration.syncTenant(empresaId);assert.equal(sync.health,'healthy',JSON.stringify(sync));
  const numberId=(await owner.query("INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status) VALUES($1,$2,'ativo') RETURNING id",[empresaId,randomUUID()])).rows[0].id;
  const webhooks=new PostgresWebhookRepository(pool),repository=new PostgresJobHandlerRepository(pool);
  const inbound=(text,type='text',adReferral)=>webhooks.withTenantTransaction({empresaId},tx=>webhooks.insertInboundMessage(tx,{empresaId,numeroWhatsappId:numberId,correlationId:randomUUID(),event:{externalMessageId:'wamid.'+randomUUID(),messageType:type,text,senderPhone:'5511000000001',occurredAt:new Date(),...(type==='image'?{mediaId:'fictional-photo'}:{}),...(adReferral?{adReferral}:{})}}));
  const sent=async(input,text)=>{
   const message=await repository.inboundMessage({empresaId,messageId:input.messageId});
   const reply=await repository.prepareReply({empresaId,message,origin:'ai',reply:{text,inboundTurnSequence:message.sequence}});
   await repository.markReplySent({empresaId,replyId:reply.id,externalMessageId:'wamid.'+randomUUID()});
  };
  const ad={source_type:'ad',headline:'HYUNDAI HB20 COMFORT',body:'MOTOR FLEX, ANO 2017, CÂMBIO MANUAL.'};
  const first=await inbound('Aceita veículo na troca?','text',ad);
  await sent(first,'Aceitamos veículo na troca, sujeito à avaliação. Quer enviar fotos do seu veículo?');
  const request=await inbound('Boa tarde gostaria de fazer uma simulação');
  await sent(request,'Você já tem algum modelo em mente para fazermos a simulação?');
  const photo=await inbound('','image');
  await owner.query("UPDATE mensagens SET media_storage_key='fictional/already-stored',media_mime_type='image/jpeg',media_size_bytes=30,media_sha256=repeat('a',64),media_stored_at=now() WHERE empresa_id=$1 AND id=$2",[empresaId,photo.messageId]);
  const named=await inbound('Ônix');
  const onix={id:'turim:56',name:'ÔNIX JOY',year:2019},hb={id:'turim:66',name:'HB20 COMFORT 1.0 2017',year:2017};
  const conversationService=new ConversationService({repository:new PostgresConversationRepository(pool)});
  let calls=0;const deliveries=[];
  const aiService=new MultiTenantAiService({configResolver:new MemoryAiConfigResolver([{empresaId,enabled:true,provider:'openai',model:'test',keyType:'shared',version:1,prompt:'Continue a triagem pelo modelo informado.',contextualServiceEnabled:true,leadQualificationEnabled:true,leadQualificationCriteria:'Nome, modelo e dados de financiamento.',tradeInEvaluationEnabled:true,leadImageHandoffEnabled:true,allowedContextKeys:['identity','catalog','adContext','tradeInEvaluation']}]),conversationService,
   clientFactory:new MemoryResponsesClientFactory(async call=>{
    calls++;assert.match(call.instructions,/MODELO INFORMADO PARA A SIMULAÇÃO/u);
    assert.ok(call.input.some(p=>p.role==='assistant'&&p.content.includes('modelo em mente')));
    assert.ok(call.input.some(p=>p.role==='user'&&p.content==='Ônix'));
    assert.ok(call.input.some(p=>p.role==='user'&&p.content.includes('Imagem recebida')));
    assert.ok(call.input.some(p=>p.role==='developer'&&p.content.includes('"productId": "turim:66"')));
    return{output_text:JSON.stringify({turnIntent:'answer',text:'Para a simulação do Onix Joy, informe CPF e nascimento. Entrada é opcional.',catalogAction:'finance',productIds:[onix.id],filters:{category:null,minPrice:null,maxPrice:null},leadQualification:{status:'collecting',name:null,summary:null,qualification:null},tradeInEvaluation:null,customerService:{downPayment:{status:'not_informed',amount:null,evidence:null},warranty:{status:'none',requestEvidence:null,offerEvidence:null,consentEvidence:null},tradeInRequest:{status:'none',requestEvidence:null}}}),usage:{input_tokens:10,output_tokens:10}};
   }),secretResolver:new MemoryAiSecretResolver({sharedSecret:'fake'}),ledger:new MemoryAiLedger(),pricingCatalog:new MemoryPricingCatalog({test:{inputPerMillion:1,outputPerMillion:1,version:'test'}}),logger:{info(){},warn(){}}});
  let now=Date.now()+30_000;
  const dependencies={repository,conversationService,aiService,clock:()=>new Date(now),logger:{info(){},warn(){}},
   tenantDefinitionRepository:new PostgresTenantDefinitionRepository(pool),
   metaGateway:{async sendReply(_context,reply){deliveries.push(reply);return{id:'wamid.'+randomUUID()};}}};
  const job={empresaId,conversationId:first.conversationId,messageId:photo.messageId};
  let outcome=await createWorkerHandlers(dependencies).process_inbound_message(job);
  if(outcome.deferUntil){now=Date.parse(outcome.deferUntil);outcome=await createWorkerHandlers(dependencies).process_inbound_message(job);}
  assert.equal(outcome.replied,true,JSON.stringify(outcome));
  assert.equal(calls,1);assert.equal(deliveries.length,1);assert.match(deliveries[0].text,/CPF/u);
  const restarted=new PostgresJobHandlerRepository(pool);
  assert.equal((await owner.query('SELECT modo_atendimento FROM conversas WHERE id=$1',[first.conversationId])).rows[0].modo_atendimento,'bot');
  assert.equal((await owner.query('SELECT count(*)::int AS count FROM qualified_leads WHERE empresa_id=$1',[empresaId])).rows[0].count,0);
  await createWorkerHandlers({...dependencies,repository:restarted}).process_inbound_message({...job,messageId:named.messageId});
  assert.equal(calls,1);assert.equal(deliveries.length,1);
  const next=await inbound('Ônix joy 2019');
  const scope={empresaId,conversationId:first.conversationId,messageId:next.messageId};
  assert.deepEqual(await restarted.financingSession(scope),{productId:onix.id,productIds:[onix.id],status:'pending'});
  assert.equal(await restarted.adReferral({...scope,empresaId:randomUUID()}),null);
 }finally{
  if(empresaId){for(const table of ['outbox_jobs','mensagens','estados_conversa','conversas','contatos','numeros_whatsapp','integracoes'])await owner.query(`DELETE FROM ${table} WHERE empresa_id=$1`,[empresaId]);await owner.query('DELETE FROM empresas WHERE id=$1',[empresaId]);}
  if(actorId)await owner.query('DELETE FROM usuarios WHERE id=$1',[actorId]);
  await pool.end();await owner.end();
 }
});
