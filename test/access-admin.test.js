import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AccessService } from '../src/modules/access/access-service.js';
import { AccountRateLimiter } from '../src/modules/accounts/rate-limiter.js';
import { VersionedKeyring } from '../src/security/versioned-keyring.js';
import { decryptCredentialSecret } from '../src/security/credential-crypto.js';

const auth={audience:'admin',platformRole:'platform_admin',user:{id:'00000000-0000-4000-8000-000000000001'},sessionId:'00000000-0000-4000-8000-000000000002'};
const body={name:'Aurora Demo',email:'ana@waia.example',companies:[]};
function fixture() {
  const calls=[];
  const repository={};
  for(const method of ['list','get','create','setStatus','putCompany','removeCompany','revokeSessions'])repository[method]=async options=>{calls.push({method,options});return {ok:true};};
  repository.issue=async options=>{await options.rate();calls.push({method:'issue',options});return {ok:true};};
  const keyring=VersionedKeyring.fromBase64({activeVersion:'1',keys:{1:randomBytes(32).toString('base64')}});
  const service=new AccessService({repository,keyring,origin:'http://localhost',limiter:new AccountRateLimiter({environment:'test'})});
  return {service,calls,keyring};
}
test('M2 serviço nega customer e campos privilegiados antes do repositório',async()=>{
  const {service,calls}=fixture();
  assert.throws(()=>service.list({...auth,audience:'customer'}),{status:403});
  await assert.rejects(service.create({...auth,platformRole:null},body,randomUUID()),{status:403});
  for(const extra of [{platformRole:'administrador'},{owner:true},{password:'permanent-password-12345'},{activation_required:false}]) {
    await assert.rejects(service.create(auth,{...body,...extra},randomUUID()),{status:422});
  }
  assert.equal(calls.length,0);
});
test('M2 serviço rejeita capacidade desconhecida, técnica, wildcard e vínculo duplicado',async()=>{
  const {service,calls}=fixture(),empresaId=randomUUID();
  for(const capabilities of [['*'],['credentials.manage'],['conversations.read'],['attendance.read','attendance.read']]) {
    await assert.rejects(service.create(auth,{...body,companies:[{empresaId,capabilities}]},randomUUID()),{status:422});
  }
  await assert.rejects(service.create(auth,{...body,companies:[{empresaId,capabilities:[]},{empresaId,capabilities:[]}]},randomUUID()),{status:422});
  assert.equal(calls.length,0);
});
test('M2 material de ativação armazena só digest e envelope cifrado de finalidade própria',async()=>{
  const {service,calls,keyring}=fixture();await service.create(auth,body,randomUUID());
  const options=calls[0].options,material=options.material;
  const message=JSON.parse(decryptCredentialSecret({envelope:material.mail.envelope,keyring,
    binding:{empresaId:'platform-accounts',credentialId:material.mail.id,provider:'email',purpose:'account-delivery'}}));
  assert.equal(message.purpose,'activate');assert.equal(message.to,body.email);
  const token=new URLSearchParams(new URL(message.url).hash.slice(1)).get('activate');assert.match(token,/^[\w-]{43}$/);
  assert.deepEqual(material.token.digest,createHash('sha256').update(token).digest());
  assert.equal(JSON.stringify(options).includes(token),false);assert.match(options.passwordHash,/^\$scrypt\$/);
  assert.equal(options.input.password,undefined);assert.equal(material.token.purpose,'activate');
});
test('M2 DTO ordena capacidades e empresas para hash idempotente estável',async()=>{
  const {service,calls}=fixture(),a='00000000-0000-4000-8000-000000000003',b='00000000-0000-4000-8000-000000000004';
  const companies=[{empresaId:b,capabilities:['attendance.edit','attendance.read']},{empresaId:a,capabilities:['attendance.read']}];
  await service.create(auth,{...body,email:' ANA@WAIA.EXAMPLE ',companies},randomUUID());
  await service.create(auth,{...body,companies:[...companies].reverse().map(c=>({...c,capabilities:[...c.capabilities].reverse()}))},randomUUID());
  assert.equal(calls[0].options.payloadHash,calls[1].options.payloadHash);
  assert.equal(calls[0].options.input.email,body.email);assert.deepEqual(calls[0].options.input.companies.map(c=>c.empresaId),[a,b]);
});
test('M2 mutações exigem chave, versão e confirmação de identidade na recuperação',async()=>{
  const {service,calls}=fixture(),id=randomUUID();
  await assert.rejects(service.create(auth,body,'short'),{status:422});
  assert.throws(()=>service.setStatus(auth,id,{status:'bloqueado'},randomUUID()),{status:422});
  assert.throws(()=>service.reset(auth,id,{expectedVersion:1,identityConfirmed:false},randomUUID()),{status:422});
  assert.throws(()=>service.putCompany(auth,id,randomUUID(),{status:'ativo',expectedVersion:0,capabilities:[]},randomUUID()),{status:422});
  assert.equal(calls.length,0);
});
test('M2 reenvio limita tentativas e exige limiter disponível',async()=>{
  const {service,calls}=fixture(),id=randomUUID();
  for(let attempt=0;attempt<5;attempt++)await service.activation(auth,id,{expectedVersion:1},randomUUID());
  await assert.rejects(service.activation(auth,id,{expectedVersion:1},randomUUID()),{status:429});
  service.limiter=null;
  await assert.rejects(service.reset(auth,id,{expectedVersion:1,identityConfirmed:true},randomUUID()),{status:503});
  assert.equal(calls.length,5);
});
