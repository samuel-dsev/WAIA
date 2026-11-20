import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingWebsiteFinancingModel} from '../src/modules/business/vehicle-financing-context.js';
import {hasWebsiteFinancingConsent} from '../src/modules/business/website-catalog-interaction.js';
const onix={id:'turim:56',name:'ÔNIX JOY',year:2019};
const hb={id:'turim:66',name:'HB20 COMFORT 1.0 2017',year:2017};
const catalog={source:{type:'website_catalog',status:'healthy'},items:[hb,onix],adContext:{match:'unique',productId:hb.id}};
const question='Você já tem algum modelo em mente para fazermos a simulação?';
const entries=[{role:'user',content:'Aceita veículo na troca?'},{role:'assistant',content:'Podemos avaliar o seu carro por fotos. Quer enviar?'},
 {role:'user',content:'Boa tarde, gostaria de fazer uma simulação.'},{role:'assistant',content:question}];

test('nome responde à pergunta de modelo para simular, com acento, foto e contingências anteriores',()=>{
 for(const message of ['Ônix','Onix','Ônix joy 2019','É o Onix Joy 2019','O Onix da foto','Ônix Joy 2019. Sou Caio. Nascimento 01/01/1990.']){
  for(const history of [entries,[...entries,{role:'user',content:'[Imagem recebida do cliente; arquivo armazenado; sem análise visual.]'},
   {role:'assistant',content:'Pode confirmar sua resposta para eu continuar?\n\nPode confirmar sua resposta para eu continuar? '+question}]]){
   const found=pendingWebsiteFinancingModel(catalog,message,history);
   assert.deepEqual(found?.productIds,[onix.id],message);
   assert.equal(found.requestEvidence,'Boa tarde, gostaria de fazer uma simulação.');
   assert.equal(hasWebsiteFinancingConsent(catalog,message,onix.id,history),true);
   assert.equal(hasWebsiteFinancingConsent(catalog,message,hb.id,history),false);
  }
 }
});

test('escolha textual não autoriza simulação fora da pergunta correta ou em nova solicitação',()=>{
 for(const message of ['Não','Não quero simular','Talvez Onix','Qual o endereço?','Envie fotos do Onix','Onix 2017','Qual o motor do Onix?','Onix ou HB20']){
  assert.equal(pendingWebsiteFinancingModel(catalog,message,entries),null,message);
 }
 for(const last of ['Qual modelo chamou sua atenção?','Qual modelo do seu carro para avaliação?','Você prefere fotos do Onix ou simulação?']){
  assert.equal(pendingWebsiteFinancingModel(catalog,'Onix',[...entries,{role:'assistant',content:last}]),null);
 }
 assert.equal(pendingWebsiteFinancingModel(catalog,'Onix',[...entries,{role:'user',content:'Quero cancelar a simulação.'}]),null);
 assert.equal(pendingWebsiteFinancingModel({...catalog,source:{...catalog.source,status:'unavailable'}},'Onix',entries),null);
});

test('duas unidades exigem distinção real e ano/versão escritos resolvem sem trocar pelo anúncio',()=>{
 const many={...catalog,items:[...catalog.items,{id:'turim:57',name:'ONIX LT',year:2020}]};
 assert.equal(pendingWebsiteFinancingModel(many,'Onix',entries),null);
 assert.deepEqual(pendingWebsiteFinancingModel(many,'Onix Joy 2019',entries)?.productIds,[onix.id]);
 assert.deepEqual(pendingWebsiteFinancingModel(many,'Onix 2020',entries)?.productIds,['turim:57']);
 assert.equal(pendingWebsiteFinancingModel(many,'Onix 2018',entries),null);
});
