import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAiConfigResolver, MemoryAiLedger, MemoryAiSecretResolver, MemoryPricingCatalog,
  MemoryResponsesClientFactory, MultiTenantAiService } from '../src/modules/ai/index.js';
import { EMPTY_PROPERTY_FILTERS } from '../src/modules/business/real-estate-catalog.js';
import { catalogAdContext } from '../src/modules/whatsapp/ad-referral.js';
import { propertyItem, propertyCatalog } from './support/real-estate-fixtures.js';

const catalog = { ...propertyCatalog(propertyItem(1), propertyItem(2)), salesMode: true };
const collecting = { status: 'collecting', name: null, summary: null, qualification: null };
function service(output, history = [], config = {}) {
  const factory = new MemoryResponsesClientFactory(async () => ({ output_text: JSON.stringify(output), usage: { input_tokens: 10, output_tokens: 10 } }));
  const ai = new MultiTenantAiService({
    configResolver: new MemoryAiConfigResolver([{ empresaId: 'test', enabled: true, provider: 'openai', model: 'test', keyType: 'shared',
      prompt: 'Você é uma assistente imobiliária. Não confirme visitas; encaminhe ao corretor.',
      contextualServiceEnabled: true, leadQualificationEnabled: true, leadQualificationCriteria: 'Nome e pedido ou aceite explícito de visita.',
      allowedContextKeys: ['catalog'], version: 2, maxOutputTokens: 1200, ...config }]),
    conversationService: { async getHistory() { return history; } }, clientFactory: factory,
    secretResolver: new MemoryAiSecretResolver({ sharedSecret: 'synthetic' }), ledger: new MemoryAiLedger(),
    pricingCatalog: new MemoryPricingCatalog({ test: { inputPerMillion: 1, outputPerMillion: 1, version: 'test' } }), logger: { warn() {}, info() {} },
  });
  return { ai, factory };
}
const output = (action, text, ids = [], filters = EMPTY_PROPERTY_FILTERS, leadQualification = collecting) => ({ text, catalogAction: action, productIds: ids, filters, leadQualification });
const request = message => ({ empresaId: 'test', conversationId: 'chat', correlationId: 'c', messageId: 'current', message, context: { catalog } });

test('IA imobiliária: schema próprio, contexto factual sem URLs das fotos e busca de aluguel', async () => {
  const { ai, factory } = service(output('browse', 'Algum chamou sua atenção?', [], { ...EMPTY_PROPERTY_FILTERS, operation: 'rent', city: 'Taubaté', maxPrice: 2600 }));
  const result = await ai.reply(request('Quero opções para alugar em Taubaté até 2600'));
  assert.equal(result.source, 'ai'); assert.equal(result.messages.length, 3);
  assert.match(result.messages[0].text, /Aluguel mensal: R\$\s*2\.500,00/u);
  assert.doesNotMatch(result.messages[0].text, /500\.000/u);
  const call = factory.requests[0].request;
  assert.match(call.instructions, /CATÁLOGO IMOBILIÁRIO VALIDADO/u);
  assert.ok(!call.text.format.schema.properties.catalogAction.enum.includes('finance'));
  assert.doesNotMatch(JSON.stringify(call.input), /101-grande\.jpg/u);
  assert.match(JSON.stringify(call.input), /photoCount/u);
  assert.equal(result.leadQualification, undefined);
});

test('IA imobiliária: pedido explícito de fotos envia somente a galeria escolhida', async () => {
  const { ai } = service(output('products', 'Gostou e tem interesse em uma visita com um corretor?', [propertyItem(2).id]));
  const result = await ai.reply(request('Envie as fotos da casa referência 2'));
  assert.equal(result.source, 'ai'); assert.equal(result.messages.length, 2);
  assert.ok(result.messages.every(part => part.imageUrl.includes('/2/')));
  assert.match(result.messages.at(-1).text, /visita/u);
  assert.equal(result.leadQualification, undefined);
});

test('IA imobiliária: galeria sem consentimento não dispara fotos nem qualifica', async () => {
  const { ai, factory } = service(output('products', 'Quer uma visita?', [propertyItem(1).id]));
  const result = await ai.reply(request('Qual é o valor da casa referência 1?'));
  assert.equal(factory.requests.length, 2); assert.equal(result.source, 'fallback');
  assert.equal(result.messages, undefined); assert.equal(result.leadQualification, undefined);
});

test('anúncio imobiliário: referência é cruzada com catálogo atual e não consulta URL enviada', () => {
  const ad = catalogAdContext({ sourceUrl: 'https://untrusted.test', body: 'Casa REF #2 em Taubaté' }, catalog, { current: true });
  assert.equal(ad.productId, propertyItem(2).id);
  const missing = catalogAdContext({ body: 'Imóvel referência 999' }, catalog, { current: true });
  assert.equal(missing.productId, null);
  assert.equal(catalogAdContext({ body: 'REF #1 e REF #2' }, catalog).match, 'ambiguous');
});

const ownerHistory = [
  {id:'intent',sequence:1,direction:'inbound',type:'text',body:'Quero colocar meu apartamento para locação.'},
  {id:'photo',sequence:2,direction:'inbound',type:'image',body:'',mediaStorageKey:'synthetic-photo'},
  {id:'address',sequence:3,direction:'inbound',type:'text',body:'Rua Sintética 20, bairro Exemplo, Taubaté.'},
  {id:'price-question',sequence:4,direction:'outbound',type:'text',body:'Qual valor mensal pretende pedir pela locação?',status:'sent'},
];
const ownerConfig={leadImageHandoffEnabled:true,tradeInEvaluationEnabled:false,
  leadQualificationCriteria:'Captação: intenção de locação, fotos recebidas, localização, valor esperado e nome informado.'};

test('captação imobiliária: dados completos sem nome preparam espera com fotos e sem avaliação automotiva',async()=>{
  const card={status:'awaiting_name',name:null,summary:'Proprietário quer colocar apartamento para locação na Rua Sintética 20, bairro Exemplo, Taubaté, por R$ 1500 com condomínio incluso.',qualification:'Dados da captação completos, exceto nome.'};
  const answer='Para finalizar, como posso te chamar?';
  const {ai}=service(output('none',answer,[],EMPTY_PROPERTY_FILTERS,card),ownerHistory,ownerConfig);
  const result=await ai.reply(request('Estou pensando em 1500 já incluso o condomínio'));
  assert.equal(result.source,'ai');assert.equal(result.text,answer);assert.equal(result.leadQualification,undefined);
  assert.equal(result.pendingNameQualification.name,null);assert.match(result.pendingNameQualification.summary,/Imagens recebidas do cliente: 1/u);
  assert.equal(result.tradeInEvaluation,undefined);
});

test('captação imobiliária: valor com condomínio mantém pergunta compreendida após ficha parcial inválida',async()=>{
  const answer='Entendi: R$ 1.500 por mês, incluindo condomínio. Para finalizar, como posso te chamar?';
  for(const card of [{status:'qualified',name:null,summary:'Apartamento para locação por 1500 com condomínio.',qualification:'Captação para locação.'},
    {status:'collecting',name:null,summary:null}]){
    const {ai,factory}=service(output('none',answer,[],EMPTY_PROPERTY_FILTERS,card),ownerHistory,ownerConfig);
    const result=await ai.reply(request('Estou pensando em 1500 já incluso o condomínio'));
    assert.equal(result.source,'ai');assert.equal(result.text,answer);assert.equal(result.reason,'qualification_needs_information');
    assert.equal(result.leadQualification,undefined);assert.equal(result.messages,undefined);assert.equal(factory.requests.length,2);
    assert.match(factory.requests[0].request.instructions,/confirmou 1 imagem/u);
    assert.equal(factory.requests[0].request.text.format.schema.properties.tradeInEvaluation,undefined);
    assert.doesNotMatch(factory.requests[0].request.instructions,/EXCEÇÃO DE AVALIAÇÃO POR FOTOS/u);
  }
});

test('captação imobiliária: fotos e nome não substituem localização e valor publicados nos critérios',async()=>{
  const history=ownerHistory.slice(0,2);
  const {ai}=service(output('none','Recebi a foto. Qual é a localização do imóvel?'),history,ownerConfig);
  const result=await ai.reply(request('Sou Ana Teste.'));
  assert.equal(result.source,'ai');assert.equal(result.leadQualification,undefined);
  assert.equal(result.tradeInEvaluation,undefined);assert.match(result.text,/localização/u);
});

test('captação imobiliária completa: ficha e contagem das fotos sem habilitar avaliação automotiva',async()=>{
  const history=[...ownerHistory,{id:'value',sequence:5,direction:'inbound',type:'text',body:'R$ 1500 com condomínio incluso.'}];
  const card={status:'qualified',name:'Ana Teste',summary:'Ana Teste quer disponibilizar apartamento para locação na Rua Sintética 20, bairro Exemplo, Taubaté, por R$ 1500 mensais com condomínio incluso.',qualification:'Captação para locação.'};
  const closing='Obrigada, Ana Teste! Um de nossos corretores entrará em contato para continuar o atendimento do seu imóvel.';
  const {ai}=service(output('none',closing,[],EMPTY_PROPERTY_FILTERS,card),history,ownerConfig);
  const result=await ai.reply(request('Ana Teste'));
  assert.equal(result.source,'ai');assert.equal(result.text,closing);assert.equal(result.leadQualification.name,'Ana Teste');
  assert.match(result.leadQualification.summary,/Imagens recebidas do cliente: 1/u);
  assert.match(result.leadQualification.summary,/condomínio incluso/u);assert.equal(result.tradeInEvaluation,undefined);
});

test('ficha imobiliária inválida nunca conserva promessa de encaminhamento ou contato do corretor',async()=>{
  for(const text of ['Enviei suas fotos ao grupo. Como posso te chamar?',
    'Um corretor vai entrar em contato. Como posso te chamar?',
    'Suas fotos foram enviadas ao grupo. Como posso te chamar?',
    'Seu imóvel já está sendo analisado. Como posso te chamar?']){
    const card={status:'qualified',name:null,summary:'Apartamento para locação.',qualification:'Captação para locação.'};
    const {ai}=service(output('none',text,[],EMPTY_PROPERTY_FILTERS,card),ownerHistory,ownerConfig);
    const result=await ai.reply(request('Valor 1500'));
    assert.equal(result.source,'fallback');assert.equal(result.leadQualification,undefined);assert.notEqual(result.text,text);
  }
});

test('anexos não invalidam uma ficha cujo resumo já está no limite permitido',async()=>{
  const summary='Ana Teste disponibiliza apartamento para locação em Taubaté por 1500 com condomínio incluso. '.repeat(18).slice(0,1600);
  const closing='Obrigada, Ana Teste! Um de nossos corretores entrará em contato para continuar o atendimento.';
  const card={status:'qualified',name:'Ana Teste',summary,qualification:'Captação para locação.'};
  const {ai}=service(output('none',closing,[],EMPTY_PROPERTY_FILTERS,card),ownerHistory,ownerConfig);
  const result=await ai.reply(request('Ana Teste'));
  assert.equal(result.source,'ai');assert.equal(result.leadQualification.summary,summary.trim());
  assert.equal(result.text,closing);assert.equal(result.tradeInEvaluation,undefined);
});
