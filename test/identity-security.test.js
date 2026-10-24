import test from 'node:test';
import assert from 'node:assert/strict';
import {base32,totp,verifyTotp} from '../src/modules/auth/totp.js';
import {evaluateAccess} from '../src/modules/auth/permissions.js';
import {requireTenantAccess,requirePlatformAdmin} from '../src/modules/admin/authorization.js';
import {IdentitySecurity} from '../src/modules/auth/identity-security.js';
test('TOTP corresponde aos vetores SHA1 da RFC 6238 e recusa replay',()=>{
  const secret=Buffer.from('12345678901234567890');
  for(const [time,code] of [[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']])
    assert.equal(totp(secret,Math.floor(time/30),8),code);
  assert.equal(base32(Buffer.from('foo')),'MZXW6');
  const now=new Date(59000),code=totp(secret,1);
  assert.equal(verifyTotp(secret,code,now),1);
  assert.equal(verifyTotp(secret,code,now,1),null);
  assert.equal(verifyTotp(secret,'wrong',now),null);
});
test('matriz customer ignora poder global e reserva cobranca/segredos/propriedade',()=>{
  const auth={audience:'customer',platformRole:'platform_admin',memberships:[{empresaId:'a',role:'tenant_operator',status:'active'},
    {empresaId:'b',role:'tenant_admin',status:'active',companyStatus:'ativa',owner:true,permissions:['attendance.read']}]};
  for(const op of ['team.read','billing.manage','credentials.read_masked','credentials.manage','ownership.transfer']) assert.equal(evaluateAccess(auth,op,'a'),false);
  assert.equal(evaluateAccess(auth,'conversations.read','a'),false);
  assert.equal(evaluateAccess(auth,'attendance.read','b'),true);
  assert.equal(evaluateAccess(auth,'team.manage','b',{targetRole:'tenant_operator'}),false);
  assert.equal(evaluateAccess(auth,'team.manage','b',{targetRole:'tenant_admin'}),false);
  assert.equal(evaluateAccess(auth,'credentials.manage','b'),false);
  auth.memberships[1].permissions=['credentials.manage','*'];assert.equal(evaluateAccess(auth,'credentials.manage','b'),false);
  assert.equal(evaluateAccess(auth,'ownership.transfer','b'),false);
  assert.equal(evaluateAccess(auth,'tenant.read','c'),false);
  assert.throws(()=>requirePlatformAdmin({...auth,user:{id:'u'}}));
});

function securityFixture({role='nenhum',challengeAudience='customer',sessionAudience='customer'}={}) {
  const queries=[],now=new Date(),user={id:'00000000-0000-4000-8000-000000000001',password_hash:'synthetic-hash',
    papel_plataforma:role,status:'ativo',mfa_habilitado:true,security_version:1};
  const session={id:'00000000-0000-4000-8000-000000000002',audience:sessionAudience,mfa_verified_at:now};
  const challenge={id:'00000000-0000-4000-8000-000000000003',audience:challengeAudience,purpose:'login',
    security_version:1,attempts:0,consumed_at:null,expires_at:new Date(now.getTime()+300000)};
  const client={release(){},async query(sql,params){
    queries.push({sql,params});
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.includes('set_config('))return {rows:[]};
    if(sql.includes('SELECT usuario_id FROM identity_challenges'))return {rows:[{usuario_id:user.id}]};
    if(sql.includes('SELECT * FROM identity_challenges'))return {rows:[challenge]};
    if(sql.includes('SELECT * FROM usuarios'))return {rows:[{...user}]};
    if(sql.includes('SELECT * FROM auth_sessions'))return {rows:[session]};
    throw Error('Unexpected mutation or factor check');
  }};
  const security=new IdentitySecurity({pool:{async connect(){return client;}},codecs:{admin:{issue(){}},customer:{issue(){}}},
    limiter:{async consume(){return {allowed:true};}},clock:()=>now});
  return {security,user,queries,session};
}
test('MFA nega audience admin a cliente na emissão e após rebaixamento de challenge',async()=>{
  const {security,user,queries}=securityFixture({challengeAudience:'admin'});
  await assert.rejects(security.login({userId:user.id,passwordHash:user.password_hash,audience:'admin'}),{code:'MFA_INVALID'});
  await assert.rejects(security.complete({challenge:'c'.repeat(43),code:'123456',audience:'admin'}),{code:'MFA_INVALID'});
  assert.equal(queries.some(({sql})=>sql.startsWith('INSERT')||sql.startsWith('UPDATE')),false);
});
test('MFA recusa challenge de outra audience e purpose desconhecido antes do fator',async()=>{
  const {security,queries}=securityFixture({role:'administrador',challengeAudience:'customer'});
  await assert.rejects(security.complete({challenge:'c'.repeat(43),code:'123456',audience:'admin'}),{code:'MFA_INVALID'});
  const n=queries.length;
  await assert.rejects(security.complete({challenge:'c'.repeat(43),code:'123456',audience:'admin',purpose:'elevate'}),{code:'MFA_INVALID'});
  assert.equal(queries.length,n);
});
test('segurança pessoal vincula a audience da sessão persistida ao contexto autenticado',async()=>{
  const {security,user,session,queries}=securityFixture({sessionAudience:'admin'});
  await assert.rejects(security.sessions({user:{id:user.id},sessionId:session.id,audience:'customer'}),{code:'MFA_INVALID'});
  const query=queries.find(({sql})=>sql.includes('SELECT * FROM auth_sessions'));
  assert.equal(query.params.at(-1),'customer');
});
test('MFA valida TTL por audience sem aceitar prazo inválido ou propriedade desconhecida',()=>{
  const options={clock:()=>new Date('2026-10-23T12:00:00Z')};
  const security=new IdentitySecurity({...options,sessionMs:180000,sessionMsByAudience:{admin:60000,customer:120000}});
  assert.deepEqual(security.sessionMsByAudience,{admin:60000,customer:120000});
  for(const sessionMsByAudience of [{admin:59999},{customer:1.5},{admin:Number.MAX_SAFE_INTEGER},{other:60000},[]]) {
    assert.throws(()=>new IdentitySecurity({...options,sessionMsByAudience}),TypeError);
  }
});
test('MFA emite sessão com prazo configurado para sua própria audience',async()=>{
  const now=new Date('2026-10-23T12:00:00Z'),secret=Buffer.from('12345678901234567890');
  for(const audience of ['admin','customer']) {
    let expiration;
    const user={id:'00000000-0000-4000-8000-000000000001',papel_plataforma:'administrador',
      mfa_habilitado:true,mfa_envelope:{},mfa_last_counter:null,security_version:1};
    const client={release(){},async query(sql,params){
      if(sql.includes('SELECT usuario_id FROM identity_challenges'))return {rows:[{usuario_id:user.id}]};
      if(sql.includes('SELECT * FROM usuarios'))return {rows:[user]};
      if(sql.includes('SELECT * FROM identity_challenges'))return {rows:[{id:'challenge-id',audience,purpose:'login',security_version:1,
        attempts:0,consumed_at:null,expires_at:new Date(now.getTime()+300000)}]};
      if(sql.includes('INSERT INTO auth_sessions')){expiration=params[5];return {rows:[{id:'session-id',expires_at:expiration}]};}
      return {rows:[],rowCount:1};
    }};
    const codec={issue:()=>({tokenHash:Buffer.from('synthetic-token-hash')})};
    const security=new IdentitySecurity({pool:{async connect(){return client;}},codecs:{admin:codec,customer:codec},
      limiter:{async consume(){return {allowed:true};}},clock:()=>now,sessionMsByAudience:{admin:60000,customer:120000}});
    security.open=()=>secret.toString('base64');
    await security.complete({challenge:'c'.repeat(43),code:totp(secret,Math.floor(now.getTime()/30000)),audience});
    assert.equal(expiration.getTime()-now.getTime(),audience==='admin'?60000:120000);
  }
});
test('adaptador admin preserva leituras, escrita administrativa e concessao explicita',()=>{
  const auth={user:{id:'u'},audience:'admin',memberships:[{empresaId:'a',role:'operador',permissions:['special']},{empresaId:'b',role:'administrador'}]};
  assert.ok(requireTenantAccess(auth,'a'));
  assert.throws(()=>requireTenantAccess(auth,'a',{write:true}));
  assert.ok(requireTenantAccess(auth,'a',{write:true,permission:'special'}));
  assert.ok(requireTenantAccess(auth,'b',{write:true}));
  assert.throws(()=>requireTenantAccess({...auth,audience:'customer'},'b'));
  assert.throws(()=>requireTenantAccess({user:{id:'u'},memberships:[{empresaId:'a',role:'unknown'}]},'a'));
});
