import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {compileTenantRuntimeConfigV2} from "../src/modules/configuration/compiler.js";
import {PostgresJobHandlerRepository} from "../src/modules/jobs/handlers.js";
import {notificationText} from "../src/modules/group-notifier/qualification.js";
import {appendCustomerServiceData} from "../src/modules/business/contextual-vehicle-service.js";
import {PostgresAiConfigResolver} from "../src/modules/ai/postgres-adapters.js";

test("PostgreSQL: confirmação persiste a ficha completa com dados coletados sem duplicá-la", {
  skip:process.env.RUN_POSTGRES_INTEGRATION!=="true",
},async()=>{
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  const owner=new pg.Pool({connectionString:process.env.DATABASE_MIGRATOR_URL,options:'-c app.is_platform_admin=true'});
  let empresaId,actorId;
  try {
    assert.match(new URL(process.env.DATABASE_URL).pathname,/^\/waia_v2_/u);
    actorId=(await owner.query("INSERT INTO usuarios(email,nome,password_hash,papel_plataforma) VALUES($1,'Teste ficha','synthetic','administrador') RETURNING id",[`${randomUUID()}@example.test`])).rows[0].id;
    empresaId=(await owner.query("INSERT INTO empresas(slug,nome,nome_exibicao,status) VALUES($1,'Ficha sintética','Ficha sintética','ativa') RETURNING id",[`card-data-${randomUUID()}`])).rows[0].id;
    const compiled=compileTenantRuntimeConfigV2({schemaVersion:2,identity:{name:'Ficha sintética'},modules:['ai_freeform','human_handoff'],
      menu:{text:'Olá',options:[]},ai:{enabled:true,provider:'openai',model:'test-model',prompt:'Faça a triagem e preserve os dados fornecidos.',
        contextualServiceEnabled:true,leadQualificationEnabled:true,leadQualificationCriteria:'Nome e dados de simulação após aceite.'}},
    {empresaId,configVersion:1,draftVersion:1});
    await owner.query(`INSERT INTO configuracoes_revisoes(empresa_id,config_version,schema_version,compiler_version,source_draft_version,checksum,configuracao_compilada,publicada_por)
      VALUES($1,1,2,1,1,$2,$3::jsonb,$4)`,[empresaId,compiled.checksum,JSON.stringify(compiled),actorId]);
    await owner.query("UPDATE empresas SET configuracao_runtime_modo='versionado',versao_configuracao=1,configuracao_ativa_versao=1 WHERE id=$1",[empresaId]);
    assert.equal((await new PostgresAiConfigResolver(pool).getAiConfig({empresaId})).contextualServiceEnabled,true);
    const contactId=(await owner.query("INSERT INTO contatos(empresa_id,telefone_normalizado) VALUES($1,'5511000000001') RETURNING id",[empresaId])).rows[0].id;
    const numberId=(await owner.query("INSERT INTO numeros_whatsapp(empresa_id,phone_number_id,status) VALUES($1,$2,'ativo') RETURNING id",[empresaId,randomUUID()])).rows[0].id;
    const conversationId=(await owner.query("INSERT INTO conversas(empresa_id,contato_id,numero_whatsapp_id,next_sequence) VALUES($1,$2,$3,2) RETURNING id",[empresaId,contactId,numberId])).rows[0].id;
    const messageId=(await owner.query(`INSERT INTO mensagens(empresa_id,conversa_id,contato_id,numero_whatsapp_id,direcao,tipo,corpo,status,sequence,correlation_id)
      VALUES($1,$2,$3,$4,'entrada','texto','Dados fictícios informados após aceite','processando',1,$5) RETURNING id`,[empresaId,conversationId,contactId,numberId,randomUUID()])).rows[0].id;
    const summary=appendCustomerServiceData({summary:'Simulação de HB20 Sense 1.0.\nDados coletados:\nNome: Ana Teste\nCidade: Taubaté\nCPF: 000.000.000-00\nNascimento: 01/01/1990\nTroca: sem veículo.'},
      {downPayment:{status:'amount',amount:'R$ 10.000,00'},warrantyAccepted:true},{financing:true,photoHistoryLine:'Últimos modelos com fotos no atendimento: HB20 Sense 1.0'}).summary;
    const qualification='Aceite confirmado; dados de simulação fornecidos. Equipe deve avaliar condições com entrada e sem troca.';
    const repository=new PostgresJobHandlerRepository(pool);
    const prepared=await repository.prepareReply({empresaId,origin:'ai',
      message:{id:messageId,conversationId,contactId,numeroWhatsappId:numberId,correlationId:randomUUID()},
      reply:{text:'A equipe continuará por aqui.',leadQualification:{name:'Ana Teste',summary,qualification,configVersion:1}}});
    const source=(await owner.query('SELECT outbound_payload FROM mensagens WHERE empresa_id=$1 AND id=$2',[empresaId,prepared.id])).rows[0];
    assert.equal(source.outbound_payload.leadQualification.summary,summary);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM qualified_leads WHERE empresa_id=$1',[empresaId])).rows[0].n,0,'Não cria ficha antes da confirmação do envio.');
    for(let repeat=0;repeat<2;repeat++)await repository.markReplySent({empresaId,replyId:prepared.id,externalMessageId:`wamid.${prepared.id}`});
    const {rows}=await owner.query('SELECT name,summary,qualification,phone FROM qualified_leads WHERE empresa_id=$1 AND conversa_id=$2',[empresaId,conversationId]);
    assert.equal(rows.length,1);assert.equal(rows[0].summary,summary);assert.equal(rows[0].qualification,qualification);
    const text=notificationText({companyName:'Ficha sintética',...rows[0]});
    for(const value of ['Dados coletados:','CPF: 000.000.000-00','Nascimento: 01/01/1990','Taubaté','Valor de entrada: R$ 10.000,00','cobertura da garantia','Últimos modelos com fotos no atendimento:',qualification])assert.ok(text.includes(value));
    assert.equal((await owner.query('SELECT modo_atendimento FROM conversas WHERE empresa_id=$1 AND id=$2',[empresaId,conversationId])).rows[0].modo_atendimento,'pausado');
  } finally {
    if(empresaId){
      for(const table of ['group_notifier_deliveries','qualified_leads','mensagens','estados_conversa','conversas','contatos','numeros_whatsapp'])await owner.query(`DELETE FROM ${table} WHERE empresa_id=$1`,[empresaId]);
      await owner.query('DELETE FROM empresas WHERE id=$1',[empresaId]);
    }
    if(actorId)await owner.query('DELETE FROM usuarios WHERE id=$1',[actorId]);
    await pool.end();await owner.end();
  }
});
