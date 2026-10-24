import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService, MemoryAuthRateLimiter, MemoryAuthRepository, createSessionTokenCodec, hashPassword } from '../src/modules/auth/index.js';

const email='admin@example.invalid', password='senha-sintetica-forte-123';
async function fixture({platformRole='platform_admin',securityEnabled=true}={}) {
  const codec=createSessionTokenCodec({pepper:'p'.repeat(40)});
  const repository=new MemoryAuthRepository({environment:'test',users:[{id:'u1',email,name:'Admin',
    passwordHash:await hashPassword(password),status:'active',platformRole,mfaEnabled:true,securityVersion:1}],
    memberships:[{userId:'u1',empresaId:'a',role:'tenant_admin',status:'active',companyStatus:'suspensa'},
      {userId:'u1',empresaId:'b',role:'tenant_admin',status:'suspended'},
      {userId:'u1',empresaId:'c',role:'tenant_admin'}]});
  const calls=[], audit=[];
  // Adapter isolates AuthService; the real TOTP implementation is covered separately.
  const security={
    async login(input) {calls.push(input);return {mfaRequired:true,challenge:'synthetic-challenge'};},
    async complete(input) {
      calls.push(input);assert.equal(input.audience,'admin');assert.equal(input.purpose,'login');
      assert.equal(input.challenge,'synthetic-challenge');assert.equal(input.code,'654321');
      const user=await repository.findUserById('u1'),issued=codec.issue(),now=new Date();
      const session=await repository.createSession({userId:user.id,tokenHash:issued.tokenHash,expectedPasswordHash:user.passwordHash,
        createdAt:now,expiresAt:new Date(now.getTime()+3600000),mfaVerifiedAt:now});
      assert.ok(session);return {issued,session:{expires_at:session.expiresAt}};
    },
  };
  const service=new AuthService({repository,tokenCodec:codec,rateLimiter:new MemoryAuthRateLimiter({environment:'test'}),
    audit:event=>audit.push(event),security:securityEnabled?security:null});
  const login=async(value=password)=>{
    const challenge=await service.login({email,password:value});
    assert.equal(challenge.mfaRequired,true);assert.equal(challenge.credentials,undefined);
    return service.completeMfa({challenge:challenge.challenge,code:'654321'});
  };
  return {service,repository,codec,login,calls,audit};
}

test('admin só emite sessão após segundo fator e projeta vínculos explicitamente ativos',async()=>{
  const {service,login,audit}=await fixture(),result=await login();
  assert.equal(service.verifyCsrf({sessionToken:result.credentials.sessionToken,csrfToken:result.credentials.csrfToken}),true);
  const principal=await service.authenticate(result.credentials.sessionToken);
  assert.equal(principal.audience,'admin');assert.equal(principal.platformRole,'platform_admin');
  assert.deepEqual(principal.memberships.map(m=>({id:m.empresaId,status:m.status,company:m.companyStatus})),
    [{id:'a',status:'active',company:'suspensa'}]);
  await service.logout({sessionId:principal.sessionId,userId:principal.user.id});
  await assert.rejects(service.authenticate(result.credentials.sessionToken),{code:'AUTHENTICATION_REQUIRED'});
  assert.doesNotMatch(JSON.stringify(audit),/senha-sintetica/);
});

test('cliente e tenant_admin não obtêm challenge/sessão admin mesmo com senha e MFA válidos',async()=>{
  for(const platformRole of [null,'tenant_admin','tenant_operator']) {
    const {service,repository,calls}=await fixture({platformRole});
    await assert.rejects(service.login({email,password}),{code:'INVALID_CREDENTIALS'});
    assert.equal(calls.length,0);assert.equal(repository.sessions.size,0);
  }
});

test('admin sem serviço de segundo fator falha fechado; payload não escolhe purpose/audience',async()=>{
  const unavailable=await fixture({securityEnabled:false});
  await assert.rejects(unavailable.service.login({email,password}),{code:'AUTHENTICATION_REQUIRED'});
  const {service,calls}=await fixture();
  await service.completeMfa({challenge:'synthetic-challenge',code:'654321',audience:'customer',purpose:'enroll',auth:{}});
  assert.equal(calls[0].audience,'admin');assert.equal(calls[0].purpose,'login');assert.equal(calls[0].auth,undefined);
});

test('rebaixamento e mudança de versão impedem autenticar uma sessão já emitida',async()=>{
  const {service,repository,login}=await fixture(),result=await login(),user=repository.users.get(email);
  user.platformRole=null;
  await assert.rejects(service.authenticate(result.credentials.sessionToken),{code:'AUTHENTICATION_REQUIRED'});
  user.platformRole='platform_admin';user.securityVersion++;
  await assert.rejects(service.authenticate(result.credentials.sessionToken),{code:'AUTHENTICATION_REQUIRED'});
});

test('troca própria admin preserva só sessão corrente com nova versão e auditoria transacional',async()=>{
  const {service,repository,login}=await fixture(),kept=await login(),revoked=await login(),newPassword='senha-sintetica-nova-456';
  await assert.rejects(service.changePassword({sessionId:kept.principal.sessionId,userId:'u1',currentPassword:'incorreta',newPassword}),{code:'INVALID_CREDENTIALS'});
  await service.changePassword({sessionId:kept.principal.sessionId,userId:'u1',currentPassword:password,newPassword});
  await service.authenticate(kept.credentials.sessionToken);
  await assert.rejects(service.authenticate(revoked.credentials.sessionToken),{code:'AUTHENTICATION_REQUIRED'});
  await assert.rejects(service.login({email,password}),{code:'INVALID_CREDENTIALS'});
  assert.equal((await login(newPassword)).principal.user.id,'u1');
  assert.equal(repository.audit.some(event=>event.action==='auth.password_changed'),true);
  assert.equal(repository.users.get(email).securityVersion,2);
});
