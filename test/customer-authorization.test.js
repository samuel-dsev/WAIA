import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { evaluateAccess, permissionsFor, hasPermission, requirePermission, effectiveCustomerCapabilities,
  CUSTOMER_CAPABILITIES, requireCustomerAccess } from '../src/modules/auth/permissions.js';
import { AccountService } from '../src/modules/accounts/account-service.js';
import { TeamService } from '../src/modules/accounts/team-service.js';
import { createAccountRouter, createCustomerRouter } from '../src/modules/accounts/http.js';
import { normalizedAdminAuth } from '../src/modules/admin/authorization.js';

const companyId = randomUUID();
const member = (extra={}) => ({empresaId:companyId,status:'ativo',companyStatus:'ativa',role:'tenant_admin',owner:true,permissions:[],...extra});
const principal = (membership=member(), extra={}) => ({audience:'customer',platformRole:'platform_admin',memberships:[membership],...extra});
const closed = {code:'ADMIN_PROVISIONING_REQUIRED',status:403};

test('normalização administrativa nunca promove audience ausente, inválida ou customer', () => {
  for(const audience of [undefined,null,'','anything','customer']) {
    assert.throws(()=>normalizedAdminAuth({user:{id:'platform'},platformRole:'platform_admin',audience}),{status:403});
  }
  assert.equal(normalizedAdminAuth({user:{id:'platform'},platformRole:'platform_admin',audience:'admin'}).audience,'admin');
});

test('customer aceita somente capacidades explícitas; owner, role, wildcard e legacy não concedem técnico', () => {
  const auth=principal(member({permissions:['*','credentials.manage','configuration.publish','team.manage','ownership.transfer','attendance.read']}));
  for(const operation of ['credentials.manage','credentials.read_masked','connections.manage','team.read','team.manage',
    'tenant.update','tenant.read','configuration.publish','ownership.transfer','billing.manage','exports.create']) {
    assert.equal(evaluateAccess(auth,operation,companyId),false,operation);
    assert.equal(evaluateAccess(auth,operation,companyId,{legacy:{write:true,permission:operation}}),false,operation);
    assert.equal(hasPermission(auth,operation,companyId),false,operation);
    assert.throws(()=>requirePermission(auth,operation,companyId));
  }
  assert.deepEqual(permissionsFor(auth,companyId),['attendance.read']);
  assert.equal(evaluateAccess(auth,'attendance.read',companyId),true);
  assert.equal(evaluateAccess(auth,'attendance.edit',companyId),false);
  assert.equal(evaluateAccess(auth,'attendance.read',randomUUID()),false);
  assert.equal(evaluateAccess(principal(member()),'attendance.read',companyId),false);
});

test('vínculos e identidades suspensos negam capacidades; suspensão empresa mantém apenas read/draft', () => {
  const all={permissions:[...CUSTOMER_CAPABILITIES],enabledCapabilities:[...CUSTOMER_CAPABILITIES]};
  for(const status of ['suspenso','suspended','pendente',undefined]) {
    const auth=principal(member({...all,status}));
    assert.deepEqual(permissionsFor(auth,companyId),[]);
    assert.equal(evaluateAccess(auth,'attendance.read',companyId),false);
  }
  assert.deepEqual(permissionsFor(principal(member(all),{user:{status:'suspenso'}}),companyId),[]);
  for(const companyStatus of ['suspenso','suspensa','suspended','rascunho',undefined]) {
    const suspended=principal(member({...all,companyStatus}));
    assert.deepEqual(permissionsFor(suspended,companyId),['attendance.read','attendance.edit','conversations.read','leads.read']);
    for(const operation of ['attendance.simulate','attendance.publish','conversations.reply','conversations.pause'])
      assert.equal(evaluateAccess(suspended,operation,companyId),false);
  }
  assert.deepEqual(permissionsFor(principal(member({...all,companyStatus:'arquivada'})),companyId),[]);
  assert.deepEqual(effectiveCustomerCapabilities(member({permissions:[...CUSTOMER_CAPABILITIES]})),
    ['attendance.read','attendance.edit','attendance.simulate','attendance.publish']);
});

test('roles e wildcard administrativos só têm bypass com audience admin; customer N:N usa seu vínculo', () => {
  assert.equal(evaluateAccess({audience:'admin',platformRole:'platform_admin'},'credentials.manage',companyId),true);
  assert.equal(evaluateAccess({platformRole:'platform_admin'},'credentials.manage',companyId),false);
  assert.throws(()=>requireCustomerAccess({audience:'admin',platformRole:'platform_admin'},'attendance.read',companyId));
  const second=randomUUID();
  const auth=principal(member({permissions:['attendance.read']}));
  auth.memberships.push(member({empresaId:second,permissions:['attendance.edit'],owner:false,role:'tenant_operator'}));
  assert.deepEqual(permissionsFor(auth,companyId),['attendance.read']);
  assert.deepEqual(permissionsFor(auth,second),['attendance.edit']);
  assert.equal(requireCustomerAccess(auth,'attendance.read',companyId).empresaId,companyId);
});

test('signup e criação direta de empresa recusam antes de tocar repositório, limite ou corpo', async () => {
  const unavailable=new Proxy({}, {get(){throw Error('must not access repository');}});
  const service=new AccountService({repository:unavailable,origin:'http://localhost',companyLimit:99,
    limiter:{consume(){throw Error('must not access limiter');}}});
  await assert.rejects(service.register({platformRole:'platform_admin'},'127.0.0.1'),closed);
  await assert.rejects(service.createCompany({user:{id:'arbitrary'}},{name:'company'},'key'),closed);
  await assert.rejects(service.register(null),closed);
});

test('equipe legada recusa todos caminhos públicos de banco e convites mesmo chamada direta', async () => {
  const pool=new Proxy({}, {get(){throw Error('must not touch database');}});
  const service=new TeamService({pool});
  for(const name of ['audit','identity','principal','run','list','mail','invite','revokeInvite','member',
    'accept','transfer','revokeTransfer','acceptTransfer']) {
    await assert.rejects(async()=>service[name]({},{}),closed,name);
  }
});

test('rotas fechadas recusam service permissivo sem autenticar ou chamar implementação legada', async () => {
  const calls=[];
  const permissive=new Proxy({origin:'http://localhost',sessionMs:3600000}, {
    get(target,key){if(key in target)return target[key];return ()=>{calls.push(key);return {};};},
  });
  const app=express();app.use(express.json());
  app.use('/account',createAccountRouter({service:permissive,secure:false}));
  app.use('/app',createCustomerRouter({service:permissive}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}`;
  try {
    for(const [method,path] of [['POST','/account/register'],['POST','/account/invitations/accept'],
      ['POST','/account/ownership/accept'],['POST','/app/companies'],['GET',`/app/companies/${companyId}/team`],
      ['POST',`/app/companies/${companyId}/team/invitations`],['PATCH',`/app/companies/${companyId}/team/members/${randomUUID()}`],
      ['DELETE',`/app/companies/${companyId}/team/invitations/${randomUUID()}`],['POST',`/app/companies/${companyId}/team/ownership`],
      ['DELETE',`/app/companies/${companyId}/team/ownership/${randomUUID()}`]]) {
      const response=await fetch(url+path,{method,headers:{origin:permissive.origin}});
      assert.equal(response.status,403,path);
      assert.equal((await response.json()).code,closed.code,path);
    }
    assert.deepEqual(calls,[]);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('listagem sanitiza capacidades e exige leitura para abrir empresa vinculada', async () => {
  const auth={user:{id:randomUUID()},sessionId:randomUUID()};
  const noReadId=randomUUID();
  let received;
  const service=new AccountService({origin:'http://localhost',repository:{async listCompanies(userId,context){
    received={userId,context};return [
      {id:companyId,name:'Demo',status:'suspenso',membershipStatus:'ativo',owner:true,role:'administrador',
        permissions:['attendance.read','attendance.edit','attendance.publish','credentials.manage']},
      {id:noReadId,name:'Sem leitura',status:'ativo',membershipStatus:'ativo',permissions:['attendance.edit']},
      {id:randomUUID(),name:'Revogado',status:'ativo',membershipStatus:'suspenso',permissions:['attendance.read']},
    ];
  }}});
  const companies=await service.companies(auth);
  assert.equal(received.userId,auth.user.id);assert.equal(received.context.sessionId,auth.sessionId);
  assert.equal(companies.length,2);
  assert.deepEqual(Object.keys(companies[0]),['id','name','status','effectiveCapabilities']);
  assert.deepEqual(companies[0].effectiveCapabilities,['attendance.read','attendance.edit']);
  assert.equal((await service.company(auth,companyId)).id,companyId);
  await assert.rejects(service.company(auth,companies[1].id),{status:403});
  await assert.rejects(service.company(auth,randomUUID()),{status:404});
});
