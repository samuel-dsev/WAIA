import test from 'node:test';
import assert from 'node:assert/strict';
import { deadlines, declinesFollowUp, parseDraft, FOLLOW_UP_INSTRUCTIONS, parseFollowUp, settingsSchema, scheduleOptions } from '../src/modules/follow-up/policy.js';
import { approvedFollowUpTemplate } from '../src/modules/follow-up/templates.js';
import { createMetaGateway } from '../src/integrations/meta/meta-gateway.js';
import { createFollowUpHandler } from '../src/modules/follow-up/worker.js';
import { notificationText } from '../src/modules/group-notifier/qualification.js';
import { followUpPrompt } from '../src/modules/follow-up/ai.js';

test('follow-up: prazos absolutos individuais, ativação de histórico antigo e fechamento separado', () => {
  const anchor = new Date('2026-11-20T12:00:00Z');
  assert.deepEqual(deadlines('test', anchor).map(d => (d - anchor) / 60000), [2, 5, 10, 15, 20]);
  assert.deepEqual(deadlines('standard', anchor).map(d => (d - anchor) / 3600000), [2, 24, 48, 72, 96]);
  assert.equal(deadlines('test', new Date(+anchor + 60_000))[0] - deadlines('test', anchor)[0], 60_000);
});
test('follow-up: recusa geral e não obrigado à retomada, sem confundir recusa de uma oferta', () => {
  for (const text of ['não obrigado', 'Não, obrigada!', 'não tenho mais interesse', 'sem interesse', 'pode encerrar', 'já comprei', 'não envie mensagens'])
    assert.equal(declinesFollowUp(text, 'Ainda deseja ajuda para continuar o atendimento?'), true, text);
  for (const [message, previous] of [['não obrigado', 'Deseja fotos do veículo?'], ['não', 'Deseja uma simulação de financiamento?'],
    ['não quero financiamento, quero comprar à vista', 'Ainda posso ajudar?'], ['sim', 'Ainda posso ajudar?']]) assert.equal(declinesFollowUp(message, previous), false);
});
test('follow-up: prompt separado usa histórico completo, não autoriza ferramentas e valida uma pergunta', () => {
  const request = followUpPrompt({ slot: 2, company: 'Fictícia', messages: [
    { direcao: 'entrada', corpo: 'Procuro um hatch automático' }, { direcao: 'saida', corpo: 'Qual faixa de valor prefere?' },
  ] });
  assert.equal(request.store, false); assert.match(request.input[0].content, /hatch automático/);
  assert.match(FOLLOW_UP_INSTRUCTIONS, /Não execute ferramentas/);
  assert.throws(() => parseDraft(JSON.stringify({ text: 'Olá? Tudo bem?', summary: 'Cliente busca hatch.' }), 0));
  assert.throws(() => parseDraft(JSON.stringify({ text: 'Quer retomar?', summary: 'CPF 123.456.789-01' }), 0));
  assert.equal(parseDraft(JSON.stringify({ text: 'Ainda quer ajuda com o hatch?', summary: 'Busca hatch automático, sem faixa de preço informada.' }), 0).text, 'Ainda quer ajuda com o hatch?');
});
function workerFixture({ slot = 0, inWindow = true, inboundCount = 1, sendFails = false, claimed = true } = {}) {
  const calls = [], snapshot = { row: { slot, is_closure: slot === 4, state: 'pending' }, conversation: { numero_whatsapp_id: 'number' }, config: { compiled: { configuration: { identity: { name: 'Fictícia' } } } },
    inbound: Array(inboundCount).fill({}), lastInbound: { id: 'source', corpo: 'Quero um hatch' }, messages: [], inWindow };
  const repository = { snapshot: async () => snapshot, prepare: async (...args) => { calls.push(['prepare', args[3]]); return slot === 4 ? { completed: true } : inWindow ? { prepared: true } : { blocked: true }; },
    claim: async () => { calls.push(['claim']); return { allowed: claimed, messageId: 'reply', phone: '5511000000000', numberId: 'number', text: 'Quer retomar?' }; },
    finish: async (...args) => calls.push(['finish', args[3]]) };
  const handler = createFollowUpHandler({ repository, aiService: { draftFollowUp: async () => { calls.push(['ai']); return { text: 'Quer retomar?', summary: 'Cliente interessado em hatch.' }; } },
    metaGateway: { sendReply: async () => { calls.push(['send']); if (sendFails) throw Error('timeout'); return { messages: [{ id: 'accepted' }] }; } } });
  const run = () => handler({ empresaId: 'company', conversationId: 'conversation' }, { payload: { actionId: 'action' } });
  return { calls, snapshot, repository, run };
}
test('follow-up: IA prepara, guarda vence envio e aceite do provedor é registrado separadamente', async () => {
  const f = workerFixture(); assert.equal((await f.run()).replied, true);
  assert.deepEqual(f.calls.map(c => c[0]), ['ai', 'prepare', 'claim', 'send', 'finish']);
  assert.equal(f.calls.at(-1)[1], 'accepted');
  const blocked = workerFixture({ claimed: false }); await blocked.run(); assert.equal(blocked.calls.some(c => c[0] === 'send'), false);
});
test('follow-up: fora de 24h bloqueia texto livre sem cobrar geração de IA', async () => {
  const f = workerFixture({ inWindow: false }); assert.equal((await f.run()).reason, 'approved_template_required');
  assert.deepEqual(f.calls.map(c => c[0]), ['prepare']);
});
test('follow-up: nenhuma resposta além da inicial não gera resumo nem quinta mensagem', async () => {
  const f = workerFixture({ slot: 4 }); assert.equal((await f.run()).completed, true);
  assert.deepEqual(f.calls.map(c => c[0]), ['prepare']);
});
test('follow-up: incompleto após interação gera somente resumo interno contextual', async () => {
  const f = workerFixture({ slot: 4, inboundCount: 2 }); assert.equal((await f.run()).completed, true);
  assert.deepEqual(f.calls.map(c => c[0]), ['ai', 'prepare']);
});
test('follow-up: envio incerto é registrado sem retry externo, pausa/retorno impedem envio', async () => {
  const f = workerFixture({ sendFails: true }); assert.equal((await f.run()).reconciliationRequired, true);
  assert.equal(f.calls.at(-1)[1], null); assert.equal(f.calls.filter(c => c[0] === 'send').length, 1);
  const cancelled = workerFixture(); cancelled.snapshot.row = null; await cancelled.run(); assert.deepEqual(cancelled.calls, []);
});
test('follow-up: fichas incompleta/recuperada distintas, ficha padrão preservada', () => {
  const input = { companyName: 'Fictícia', name: 'Ana', summary: 'Procura hatch automático.', qualification: 'Interesse em compra.', phone: '5511000000000' };
  assert.match(notificationText({ ...input, followUpHandoff: true }), /BAIXA QUALIFICAÇÃO/);
  assert.match(notificationText({ ...input, followUpRecovered: true }), /TRIAGEM CONCLUÍDA — BOA QUALIFICAÇÃO/);
  assert.equal(notificationText(input), `NOVO LEAD QUALIFICADO — Fictícia\n\nNome: Ana\nResumo do caso: Procura hatch automático.\nQualificação: Interesse em compra.\nWhatsApp: +5511000000000\n\nTriagem para análise humana.`);
});
test('follow-up: períodos em horas editáveis, adição, remoção, frações e fechamento posterior', () => {
  const parsed = parseFollowUp(settingsSchema, {enabled:true,profile:'custom',periodsHours:[0.5,2,6,24,48,72,90],closeAfterHours:96,expectedVersion:0});
  assert.deepEqual(scheduleOptions(parsed).periodsHours,[0.5,2,6,24,48,72,90]);
  assert.equal(scheduleOptions(parseFollowUp(settingsSchema,{enabled:true,profile:'custom',periodsHours:[],closeAfterHours:96,expectedVersion:0})).periodsHours.length,0);
  for(const periodsHours of [[2,1],[2,2],[-1],[NaN],Array.from({length:21},(_,i)=>i+1)])
    assert.throws(()=>parseFollowUp(settingsSchema,{enabled:true,profile:'custom',periodsHours,closeAfterHours:96,expectedVersion:0}));
  assert.throws(()=>parseFollowUp(settingsSchema,{enabled:true,profile:'custom',periodsHours:[2,96],closeAfterHours:96,expectedVersion:0}));
});
test('follow-up: templates aprovados são conferidos no provedor, com um parâmetro contextual',()=>{
  const data={name:'retomar',language:'pt_BR',wabaId:'123',status:'APPROVED',category:'MARKETING',components:[{type:'BODY',text:'Olá! Sobre seu atendimento: {{1}}'}]};
  assert.ok(approvedFollowUpTemplate(data,{name:'retomar',language:'pt_BR'},'123')?.fingerprint);
  for(const change of [{status:'PAUSED'},{wabaId:'other'},{language:'en'},{category:'AUTHENTICATION'},{components:[{type:'BODY',text:'{{1}} e {{2}}'}]}])
    assert.equal(approvedFollowUpTemplate({...data,...change},{name:'retomar',language:'pt_BR'},'123'),null);
});
test('follow-up: gateway YCloud consulta aprovação no WABA e envia template contextual pelo canal correto',async()=>{
  const calls=[],data={name:'retomar',language:'pt_BR',wabaId:'waba-test',status:'APPROVED',category:'MARKETING',components:[{type:'BODY',text:'Olá! Sobre seu atendimento: {{1}}'}]};
  const gateway=createMetaGateway({credentialResolver:{resolveMeta:async()=>({provider:'ycloud',accessToken:'synthetic',phoneNumberId:'number',phoneNumber:'+5511000000001',wabaId:'waba-test'})},
    fetchImpl:async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>options.method==='GET'?data:{wamid:'fixture-sent'}};}});
  const context={empresaId:'fixture',numeroWhatsappId:'number'},template=await gateway.readFollowUpTemplate(context,{name:'retomar',language:'pt_BR'});
  assert.ok(template);assert.match(calls[0].url,/whatsapp\/templates\/waba-test\/retomar\/pt_BR$/u);
  await gateway.sendFollowUpTemplate(context,{to:'5511000000002',template,text:'Ainda quer ajuda com o hatch?'});
  const body=JSON.parse(calls[1].options.body);assert.equal(body.type,'template');assert.equal(body.from,'+5511000000001');
  assert.equal(body.template.components[0].parameters[0].text,'Ainda quer ajuda com o hatch?');assert.equal(body.text,undefined);
  data.status='PAUSED';assert.equal(await gateway.readFollowUpTemplate(context,{name:'retomar',language:'pt_BR'}),null);
});
test('follow-up: falha da geração não envia nem expõe conteúdo privado no erro do job',async()=>{
  const snapshot={row:{state:'pending',slot:0},conversation:{id:'conversation',numero_whatsapp_id:'number'},config:{compiled:{configuration:{identity:{name:'Fictícia'}}}},lastInbound:{id:'source',corpo:'Cliente privado'},inbound:[{}],messages:[],inWindow:true};
  const handler=createFollowUpHandler({repository:{snapshot:async()=>snapshot},aiService:{draftFollowUp:async()=>{throw Error('Resposta inválida com informação privada do cliente');}},metaGateway:{sendReply:()=>assert.fail('Não pode enviar sem rascunho válido')}});
  await assert.rejects(handler({empresaId:'company'},{payload:{actionId:'action'}}),e=>e.code==='FOLLOW_UP_DRAFT_FAILED'&&!e.message.includes('privada'));
});
