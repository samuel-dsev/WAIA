import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { enabled, fixturePassword, decodeBase32 } from './support/m1-fixtures.js';
import { createM2Fixture } from './support/m2-fixtures.js';

const digest=token=>createHash('sha256').update(token).digest();
const denied=error=>[401,403].includes(error?.status);
const conflict=error=>error?.status===409;

test('M2 PostgreSQL: provisionamento administrativo, ativação e ataques', {skip:!enabled},async t=>{
  const f=await createM2Fixture();
  const email=suffix=>`${f.prefix}-${suffix}@waia.example`;
  const get=id=>f.access.get(f.actor,id);
  const material=id=>f.owner.query('SELECT * FROM usuarios WHERE id=$1',[id]).then(r=>r.rows[0]);
  const activatePassword='M2-activation-password-12345';
  let aurora,horizonte,zero,one,two,old,activationToken,blockedToken;
  try {
    aurora=await f.makeCompany('aurora');horizonte=await f.makeCompany('horizonte');
    old=await f.makeUser('existing');

    await t.test('admin cria acesso pendente sem empresa, sem senha/token no DTO',async()=>{
      const result=await f.create({name:'Sem empresa',email:email('zero'),companies:[]});zero=result.user;
      assert.equal(result.existing,false);assert.equal(zero.activationStatus,'pending');assert.deepEqual(zero.companies,[]);
      const row=await material(zero.id);assert.equal(row.activation_required,true);assert.equal(row.papel_plataforma,'nenhum');
      for(const key of ['password','passwordHash','password_hash','token','digest','envelope','url','initialPassword'])assert.equal(result[key]??zero[key],undefined);
    });
    await t.test('admin cria uma e duas empresas por vínculo N:N, sem owner automático',async()=>{
      one=(await f.create({name:'Uma empresa',email:email('one'),companies:[{empresaId:aurora.id,capabilities:['attendance.read']}]})).user;
      two=(await f.create({name:'Duas empresas',email:email('two'),companies:[
        {empresaId:aurora.id,capabilities:['attendance.read','attendance.edit']},
        {empresaId:horizonte.id,capabilities:['attendance.read']},
      ]})).user;
      assert.equal(one.companies.length,1);assert.equal(two.companies.length,2);
      assert.equal((await f.owner.query('SELECT * FROM company_owners WHERE usuario_id=ANY($1::uuid[])',[[one.id,two.id]])).rowCount,0);
      assert.equal((await f.owner.query('SELECT papel FROM usuarios_empresas WHERE usuario_id=$1',[two.id])).rows.every(r=>r.papel==='operador'),true);
    });
    await t.test('idempotência repete resposta e payload diferente conflita sem segunda identidade',async()=>{
      const key=randomUUID(),body={name:'Idempotente',email:email('idempotent'),companies:[]};
      const first=await f.create(body,key),repeat=await f.create(body,key);
      assert.deepEqual(JSON.parse(JSON.stringify(repeat)),JSON.parse(JSON.stringify(first)));
      await assert.rejects(f.create({...body,name:'Outro nome'},key),conflict);
      assert.equal((await f.owner.query('SELECT id FROM usuarios WHERE email=$1',[body.email])).rowCount,1);
    });
    await t.test('mesmo e-mail concorrente reutiliza identidade sem redefinir senha ou MFA',async()=>{
      const body={name:'Concorrente',email:email('concurrent'),companies:[]};
      const results=await Promise.all([f.create(body),f.create({...body,email:body.email.toUpperCase()})]);
      assert.equal(results[0].user.id,results[1].user.id);
      assert.equal((await f.owner.query('SELECT id FROM usuarios WHERE email=$1',[body.email])).rowCount,1);
      const before=await material(old.id);
      await f.create({name:'Não sobrescrever',email:old.email,companies:[{empresaId:aurora.id,capabilities:['attendance.read']}]});
      const after=await material(old.id);
      for(const field of ['password_hash','mfa_habilitado','mfa_envelope','nome','activation_required'])assert.deepEqual(after[field],before[field]);
    });
    await t.test('cliente não administra, e admin customer não herda autoridade global',async()=>{
      await assert.rejects(async()=>f.access.list(old.auth,{}),denied);
      await assert.rejects(f.access.create({...f.actor,audience:'customer'}, {name:'Injected',email:email('injected'),companies:[]},randomUUID()),denied);
      assert.equal((await f.owner.query('SELECT id FROM usuarios WHERE email=$1',[email('injected')])).rowCount,0);
    });
    await t.test('DTO rejeita papel, senha permanente, wildcard e capacidades técnicas',async()=>{
      for(const extra of [{platformRole:'platform_admin'},{password:fixturePassword},{initialPassword:fixturePassword},{owner:true}]) {
        await assert.rejects(f.create({name:'Injected',email:email(`bad-${randomUUID()}`),companies:[],...extra}),{status:422});
      }
      for(const capability of ['*','credentials.manage','unknown.operation'])await assert.rejects(f.create({
        name:'Injected',email:email(`caps-${randomUUID()}`),companies:[{empresaId:aurora.id,capabilities:[capability]}],
      }),{status:422});
    });
    await t.test('listagem/paginação e seção empresa mostram somente vínculos da empresa pedida',async()=>{
      const list=await f.access.list(f.actor,{search:email('two'),page:1,pageSize:1});
      assert.equal(list.items.length,1);assert.equal(list.items[0].id,two.id);assert.ok(list.pagination);
      const company=await f.access.list(f.actor,{empresaId:horizonte.id,page:1,pageSize:25});
      assert.ok(company.items.some(u=>u.id===two.id));assert.equal(company.items.some(u=>u.id===one.id),false);
    });
    await t.test('pendente é recusado por login HTTP, serviço, repositório e emissão SQL de sessão',async()=>{
      const row=await material(zero.id);
      await assert.rejects(f.service.login({email:zero.email,password:fixturePassword},'pending-login'),denied);
      const response=await f.request('/account/login',{method:'POST',body:{email:zero.email,password:fixturePassword}});
      assert.equal(response.status,401);assert.equal(response.headers.get('set-cookie'),null);
      await assert.rejects(f.repository.login({userId:zero.id,passwordHash:row.password_hash,tokenHash:f.codec.issue().tokenHash,
        now:f.clock(),expiresAt:new Date(f.clock().getTime()+3600000)}),denied);
      await assert.rejects(f.security.login({userId:zero.id,passwordHash:row.password_hash,audience:'customer'}),denied);
      await assert.rejects(f.owner.query(`INSERT INTO auth_sessions(usuario_id,token_hash,audience,security_version,expires_at)
        VALUES($1,$2,'customer',$3,$4)`,[zero.id,f.codec.issue().tokenHash,row.security_version,new Date(f.clock().getTime()+3600000)]),{code:'23514'});
    });
    await t.test('token administrativo tem purpose próprio, digest e envelope cifrado',async()=>{
      activationToken=await f.mailToken(zero.email,'activate');
      const token=(await f.owner.query('SELECT * FROM account_tokens WHERE digest=$1',[digest(activationToken)])).rows[0];
      assert.equal(token.purpose,'activate');assert.equal(token.consumed_at,null);
      const envelope=(await f.owner.query('SELECT envelope FROM account_email_outbox WHERE token_id=$1',[token.id])).rows[0]?.envelope;
      // Sent mail may have its envelope erased; no stored cleartext is acceptable.
      assert.equal(JSON.stringify(envelope).includes(activationToken),false);
      await assert.rejects(f.service.reset({token:activationToken,password:activatePassword},'wrong-purpose'),{status:422});
      await assert.rejects(f.service.verify({token:activationToken},'wrong-purpose'),{status:422});
    });
    await t.test('GET de scanner e payload de papel não consomem ativação',async()=>{
      const before=(await f.owner.query('SELECT consumed_at FROM account_tokens WHERE digest=$1',[digest(activationToken)])).rows[0];
      const scanner=await f.request(`/account/activate?token=${activationToken}`);
      assert.ok(scanner.status>=400);
      const attack=await f.request('/account/activate',{method:'POST',body:{token:activationToken,password:activatePassword,platformRole:'administrador'}});
      assert.equal(attack.status,422);
      assert.deepEqual((await f.owner.query('SELECT consumed_at FROM account_tokens WHERE digest=$1',[digest(activationToken)])).rows[0],before);
    });
    await t.test('ativação válida confirma senha/e-mail e só libera identidade já autorizada',async()=>{
      const before=await material(zero.id);
      const response=await f.request('/account/activate',{method:'POST',body:{token:activationToken,password:activatePassword}});
      assert.equal(response.status,204);
      const cookie=response.headers.get('set-cookie');if(cookie)assert.match(cookie,/waia_customer_session=;/);
      const after=await material(zero.id);
      assert.equal(after.activation_required,false);assert.ok(after.email_verified_at);assert.notEqual(after.password_hash,before.password_hash);
      assert.equal(after.papel_plataforma,'nenhum');assert.ok(after.security_version>before.security_version);
      assert.equal((await f.owner.query('SELECT * FROM usuarios_empresas WHERE usuario_id=$1',[zero.id])).rowCount,0);
      const issued=await f.service.login({email:zero.email,password:activatePassword},'activated-login');assert.ok(issued.token);
    });
    await t.test('ativação é de uso único inclusive sob concorrência',async()=>{
      const token=await f.mailToken(one.email,'activate');
      const results=await Promise.all([1,2].map(()=>f.request('/account/activate',{method:'POST',body:{token,password:activatePassword}})));
      assert.equal(results.filter(r=>r.status===204).length,1);assert.equal(results.filter(r=>r.status===422).length,1);
      assert.equal((await f.request('/account/activate',{method:'POST',body:{token:activationToken,password:activatePassword}})).status,422);
    });
    await t.test('reenvio invalida geração anterior e expiração recusa token antigo',async()=>{
      const oldToken=await f.mailToken(two.email,'activate');
      const current=await get(two.id);
      await f.access.activation(f.actor,two.id,{expectedVersion:current.version},randomUUID());
      const newer=await f.mailToken(two.email,'activate');assert.notEqual(newer,oldToken);
      assert.equal((await f.request('/account/activate',{method:'POST',body:{token:oldToken,password:activatePassword}})).status,422);
      await f.owner.query('UPDATE account_tokens SET expires_at=$2 WHERE digest=$1',[digest(newer),new Date(f.clock().getTime()-1)]);
      assert.equal((await f.request('/account/activate',{method:'POST',body:{token:newer,password:activatePassword}})).status,422);
    });
    await t.test('bloquear/reabrir pendente mantém necessidade de ativação e invalida link anterior',async()=>{
      let current=await get(two.id);
      await f.access.activation(f.actor,two.id,{expectedVersion:current.version},randomUUID());blockedToken=await f.mailToken(two.email,'activate');
      current=await get(two.id);await f.access.setStatus(f.actor,two.id,{status:'bloqueado',expectedVersion:current.version},randomUUID());
      assert.equal((await f.request('/account/activate',{method:'POST',body:{token:blockedToken,password:activatePassword}})).status,422);
      current=await get(two.id);await f.access.setStatus(f.actor,two.id,{status:'ativo',expectedVersion:current.version},randomUUID());
      assert.equal((await material(two.id)).activation_required,true);
      await assert.rejects(f.service.login({email:two.email,password:fixturePassword},'reopened-pending'),denied);
    });
    await t.test('recuperação pública não contorna conta pendente nem emite reset de ativação',async()=>{
      const before=(await f.owner.query("SELECT count(*)::int n FROM account_tokens WHERE usuario_id=$1 AND purpose='reset'",[two.id])).rows[0].n;
      await f.service.requestToken({email:two.email},'reset','pending-reset');
      const after=(await f.owner.query("SELECT count(*)::int n FROM account_tokens WHERE usuario_id=$1 AND purpose='reset'",[two.id])).rows[0].n;
      assert.equal(after,before);
    });
    await t.test('ativação de identidade ativa é recusada e nunca reseta MFA existente',async()=>{
      const challenge=await f.security.setup(old.auth,fixturePassword,'existing-factor');
      const secret=decodeBase32(challenge.enrollment.secret);
      await f.security.complete({auth:old.auth,challenge:challenge.challenge,code:f.code(secret),purpose:'enroll',audience:'customer',ip:'existing-factor'});
      const before=await material(old.id),current=await get(old.id);
      await assert.rejects(f.access.activation(f.actor,old.id,{expectedVersion:current.version},randomUUID()),conflict);
      await f.create({name:'Preservar MFA',email:old.email,companies:[]});
      const after=await material(old.id);
      for(const field of ['password_hash','mfa_habilitado','mfa_envelope'])assert.deepEqual(after[field],before[field]);
    });
    await t.test('vínculos aceitam capacidades independentes e versão antiga retorna conflito',async()=>{
      let current=await get(one.id);
      await f.access.putCompany(f.actor,one.id,horizonte.id,{status:'ativo',capabilities:['attendance.read'],expectedVersion:current.version},randomUUID());
      await assert.rejects(f.access.putCompany(f.actor,one.id,aurora.id,{status:'ativo',capabilities:['attendance.edit'],expectedVersion:current.version},randomUUID()),conflict);
      current=await get(one.id);assert.equal(current.companies.length,2);
      const auroraLink=current.companies.find(c=>c.empresaId===aurora.id),horizonteLink=current.companies.find(c=>c.empresaId===horizonte.id);
      assert.deepEqual(auroraLink.capabilities,['attendance.read']);assert.deepEqual(horizonteLink.capabilities,['attendance.read']);
    });
    await t.test('suspensão de vínculo afeta só uma empresa e remoção preserva identidade/história',async()=>{
      let current=await get(one.id);
      await f.access.putCompany(f.actor,one.id,horizonte.id,{status:'suspenso',capabilities:['attendance.read'],expectedVersion:current.version},randomUUID());
      const issued=await f.service.login({email:one.email,password:activatePassword},'one-customer');
      const auth=await f.service.authenticate(issued.token);
      assert.deepEqual((await f.service.companies(auth)).map(c=>c.id),[aurora.id]);
      current=await get(one.id);await f.access.removeCompany(f.actor,one.id,horizonte.id,{expectedVersion:current.version},randomUUID());
      assert.ok(await material(one.id));assert.equal((await get(one.id)).companies.length,1);
    });
    await t.test('owner legado impede suspensão/remoção sem transferência implícita',async()=>{
      const owner=await f.makeUser('legacy-owner');
      await f.link(owner,horizonte,{role:'administrador'});
      await f.owner.query('INSERT INTO company_owners(empresa_id,usuario_id) VALUES($1,$2)',[horizonte.id,owner.id]);
      let current=await get(owner.id);
      await f.access.putCompany(f.actor,owner.id,horizonte.id,{status:'ativo',capabilities:['attendance.read','attendance.edit'],expectedVersion:current.version},randomUUID());
      assert.equal((await f.owner.query('SELECT papel FROM usuarios_empresas WHERE usuario_id=$1 AND empresa_id=$2',[owner.id,horizonte.id])).rows[0].papel,'administrador');
      current=await get(owner.id);
      await assert.rejects(f.access.putCompany(f.actor,owner.id,horizonte.id,{status:'suspenso',capabilities:['attendance.read'],expectedVersion:current.version},randomUUID()),conflict);
      await assert.rejects(f.access.removeCompany(f.actor,owner.id,horizonte.id,{expectedVersion:current.version},randomUUID()),conflict);
      assert.equal((await f.owner.query('SELECT usuario_id FROM company_owners WHERE empresa_id=$1',[horizonte.id])).rows[0].usuario_id,owner.id);
    });
    await t.test('reautenticação vencida bloqueia mudança e revalida sessão/ator no banco',async()=>{
      f.advance(600001);
      const current=await get(zero.id);
      await assert.rejects(f.access.revokeSessions(f.actor,zero.id,{expectedVersion:current.version},randomUUID()),{status:403});
      await f.fresh();
      await f.access.revokeSessions(f.actor,zero.id,{expectedVersion:(await get(zero.id)).version},randomUUID());
    });
    await t.test('reauth HTTP exige origem/CSRF e libera a mesma operação idempotente só após MFA válido',async()=>{
      f.advance(660000);
      const current=await get(zero.id),key=randomUUID(),body={expectedVersion:current.version};
      await assert.rejects(f.access.revokeSessions(f.actor,zero.id,body,key),{status:403});
      const headers={cookie:`waia_session=${f.adminIssued.credentials.sessionToken}`,
        'x-csrf-token':f.adminIssued.credentials.csrfToken};
      const factor={password:fixturePassword,code:f.code(f.adminSecret)};
      const before=(await f.owner.query('SELECT mfa_last_counter FROM usuarios WHERE id=$1',[f.admin.id])).rows[0].mfa_last_counter;
      const wrongOrigin=await f.request('/admin/reauthenticate',{method:'POST',headers,body:factor,origin:'https://evil.invalid'});
      assert.equal(wrongOrigin.status,403);
      const wrongCsrf=await f.request('/admin/reauthenticate',{method:'POST',headers:{...headers,'x-csrf-token':'wrong'},body:factor});
      assert.equal(wrongCsrf.status,403);
      assert.equal((await f.owner.query('SELECT mfa_last_counter FROM usuarios WHERE id=$1',[f.admin.id])).rows[0].mfa_last_counter,before);
      const legitimate=await f.request('/admin/reauthenticate',{method:'POST',headers,body:factor});
      assert.equal(legitimate.status,204);
      const result=await f.access.revokeSessions(f.actor,zero.id,body,key);
      assert.equal(result.user.version,current.version+1);
      const repeated=await f.access.revokeSessions(f.actor,zero.id,body,key);
      assert.deepEqual(JSON.parse(JSON.stringify(repeated)),JSON.parse(JSON.stringify(result)));
      assert.equal((await get(zero.id)).version,current.version+1);
      await f.fresh();
    });
    await t.test('revogação administrativa encerra sessões de cliente sem redefinir MFA/senha',async()=>{
      const issued=await f.service.login({email:zero.email,password:activatePassword},'before-revoke');
      const before=await material(zero.id),current=await get(zero.id);
      await f.access.revokeSessions(f.actor,zero.id,{expectedVersion:current.version},randomUUID());
      await assert.rejects(f.service.authenticate(issued.token),denied);
      const after=await material(zero.id);assert.equal(after.password_hash,before.password_hash);assert.equal(after.mfa_habilitado,before.mfa_habilitado);
    });
    await t.test('bloqueio global invalida sessões e reabertura não as ressuscita',async()=>{
      const issued=await f.service.login({email:zero.email,password:activatePassword},'before-global-block');
      await f.access.setStatus(f.actor,zero.id,{status:'bloqueado',expectedVersion:(await get(zero.id)).version},randomUUID());
      await assert.rejects(f.service.authenticate(issued.token),denied);
      await f.access.setStatus(f.actor,zero.id,{status:'ativo',expectedVersion:(await get(zero.id)).version},randomUUID());
      await assert.rejects(f.service.authenticate(issued.token),denied);
    });
    await t.test('recuperação administrativa exige identidade confirmada e não remove MFA',async()=>{
      const current=await get(old.id),before=await material(old.id);
      await assert.rejects(async()=>f.access.reset(f.actor,old.id,{expectedVersion:current.version,identityConfirmed:false},randomUUID()),{status:422});
      await f.access.reset(f.actor,old.id,{expectedVersion:current.version,identityConfirmed:true},randomUUID());
      const token=await f.mailToken(old.email,'reset');
      await f.service.reset({token,password:'M2-reset-password-12345'},'admin-assisted-reset');
      const after=await material(old.id);assert.equal(after.mfa_habilitado,true);assert.deepEqual(after.mfa_envelope,before.mfa_envelope);
    });
    await t.test('último administrador global não pode ser bloqueado pelo serviço',async()=>{
      await f.owner.query("UPDATE usuarios SET status='bloqueado' WHERE id=$1",[f.backup.id]);
      try {await assert.rejects(f.access.setStatus(f.actor,f.admin.id,{status:'bloqueado',expectedVersion:(await get(f.admin.id)).version},randomUUID()),conflict);}
      finally {await f.owner.query("UPDATE usuarios SET status='ativo' WHERE id=$1",[f.backup.id]);}
    });
    await t.test('falha de auditoria reverte identidade, vínculos, token/outbox e idempotência',async()=>{
      const identifier=`m2_audit_${randomUUID().replaceAll('-','')}`,targetEmail=email('audit-rollback'),key=randomUUID();
      await f.owner.query(`CREATE FUNCTION ${identifier}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'M2_SYNTHETIC_AUDIT_FAILURE'; END $$`);
      await f.owner.query(`CREATE TRIGGER ${identifier} BEFORE INSERT ON logs_auditoria FOR EACH ROW WHEN (NEW.ator_usuario_id='${f.admin.id}'::uuid) EXECUTE FUNCTION ${identifier}()`);
      try {
        await assert.rejects(f.create({name:'Rollback',email:targetEmail,companies:[{empresaId:aurora.id,capabilities:['attendance.read']}]},key));
        assert.equal((await f.owner.query('SELECT id FROM usuarios WHERE email=$1',[targetEmail])).rowCount,0);
        assert.equal((await f.owner.query('SELECT * FROM access_admin_requests WHERE actor_id=$1 AND request_key=$2',[f.admin.id,key])).rowCount,0);
      } finally {
        await f.owner.query(`DROP TRIGGER ${identifier} ON logs_auditoria`);await f.owner.query(`DROP FUNCTION ${identifier}()`);
      }
    });
    await t.test('falha de auditoria na ativação preserva flag/senha/token para nova tentativa',async()=>{
      const pending=(await f.create({name:'Ativação rollback',email:email('activation-rollback'),companies:[]})).user;
      const token=await f.mailToken(pending.email,'activate'),before=await material(pending.id),identifier=`m2_activate_${randomUUID().replaceAll('-','')}`;
      await f.owner.query(`CREATE FUNCTION ${identifier}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'M2_SYNTHETIC_ACTIVATION_AUDIT_FAILURE'; END $$`);
      await f.owner.query(`CREATE TRIGGER ${identifier} BEFORE INSERT ON account_audit FOR EACH ROW WHEN (NEW.usuario_id='${pending.id}'::uuid) EXECUTE FUNCTION ${identifier}()`);
      try {
        const response=await f.request('/account/activate',{method:'POST',body:{token,password:activatePassword}});
        assert.equal(response.status,503);assert.equal(JSON.stringify(response.body).includes('SYNTHETIC'),false);
        const after=await material(pending.id);assert.equal(after.password_hash,before.password_hash);assert.equal(after.activation_required,true);
        assert.equal((await f.owner.query('SELECT consumed_at FROM account_tokens WHERE digest=$1',[digest(token)])).rows[0].consumed_at,null);
      } finally {await f.owner.query(`DROP TRIGGER ${identifier} ON account_audit`);await f.owner.query(`DROP FUNCTION ${identifier}()`);}
      assert.equal((await f.request('/account/activate',{method:'POST',body:{token,password:activatePassword}})).status,204);
    });
    await t.test('CRUD legado de users/memberships não contorna novo serviço por chamadas diretas',async()=>{
      for(const resource of ['users','memberships'])for(const method of ['create','update','remove'])await assert.rejects(f.legacyService[method]({
        auth:f.actor,empresaId:aurora.id,resource,id:old.id,body:resource==='users'?{name:'Bypass',email:email('legacy'),initialPassword:fixturePassword,role:'tenant_admin',status:'active',permissions:[]}:
          {userId:old.id,role:'tenant_admin',status:'active',permissions:['attendance.publish']},
      }),error=>[403,409].includes(error?.status));
    });
    await t.test('CRUD legado também recusa POST/PATCH/DELETE HTTP autenticado',async()=>{
      for(const resource of ['users','memberships'])for(const method of ['POST','PATCH','DELETE']) {
        const response=await f.legacyRequest(`/legacy/tenants/${aurora.id}/${resource}${method==='POST'?'':`/${old.id}`}`,{method,body:{}});
        assert.ok([403,409].includes(response.status));assert.equal(response.text.includes('password_hash'),false);
      }
    });
    await t.test('falha de transporte é limitada e DTO accepted não alega entrega real',async()=>{
      const pending=(await f.create({name:'Entrega sintética',email:email('delivery'),companies:[]})).user;
      for(let attempt=0;attempt<5;attempt++) {
        f.advance(61000);await f.service.deliverNext({async send(){throw Error('synthetic-provider-sensitive-detail');}});
      }
      const failed=await get(pending.id);assert.equal(failed.delivery.status,'failed');assert.equal(failed.delivery.attempts,5);
      assert.equal(JSON.stringify(failed).includes('synthetic-provider-sensitive-detail'),false);
      await f.access.activation(f.actor,pending.id,{expectedVersion:failed.version},randomUUID());
      await f.mailToken(pending.email,'activate');
      const accepted=await get(pending.id);assert.equal(accepted.delivery.status,'accepted');
      assert.equal(accepted.delivery.deliveredAt,undefined);assert.equal(accepted.delivery.readAt,undefined);
    });
  } finally {await f.close();}
});
