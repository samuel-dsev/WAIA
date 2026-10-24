import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import express from 'express';
import pg from 'pg';
import { createM1Fixture, decodeBase32, fixturePassword } from './m1-fixtures.js';
import { AccessRepository } from '../../src/modules/access/access-repository.js';
import { AccessService } from '../../src/modules/access/access-service.js';
import { AdminService } from '../../src/modules/admin/admin-service.js';
import { PostgresAdminRepository } from '../../src/modules/admin/postgres-admin-repository.js';
import { createAdminRouter, adminErrorMiddleware } from '../../src/modules/admin/index.js';
import { createAuthMiddleware, requireCsrf, authErrorMiddleware } from '../../src/modules/auth/http.js';

export async function createM2Fixture() {
  const f=await createM1Fixture('m2-access');
  const accessPool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:6});
  const repository=new AccessRepository({pool:accessPool,security:f.security,clock:f.clock});
  const service=new AccessService({repository,keyring:f.keyring,origin:'http://localhost',limiter:f.limiter,clock:f.clock});
  const admin=await f.makeUser('admin',{platform:true,login:false});
  const backup=await f.makeUser('backup',{platform:true,login:false});
  const challenge=await f.authService.login({email:admin.email,password:fixturePassword,ip:'m2-admin'});
  assert.ok(challenge.enrollment);
  const adminSecret=decodeBase32(challenge.enrollment.secret);
  const adminIssued=await f.authService.completeMfa({challenge:challenge.challenge,code:f.code(adminSecret),ip:'m2-admin'});
  const actor=adminIssued.principal;
  const fresh=async()=>f.security.reauthenticate(actor,{password:fixturePassword,code:f.code(adminSecret)},'m2-fresh');
  const remember=result=>{
    if(result?.user?.id && !f.ids.includes(result.user.id))f.ids.push(result.user.id);
    return result;
  };
  const create=async(body,key=randomUUID())=>remember(await service.create(actor,body,key));
  const legacyService=new AdminService({repository:new PostgresAdminRepository(accessPool)});
  const app=express();app.use(express.json());
  app.use('/legacy',createAdminRouter({adminService:legacyService,
    authenticate:createAuthMiddleware({authService:f.authService}),csrf:requireCsrf({authService:f.authService})}));
  app.use(authErrorMiddleware);app.use(adminErrorMiddleware);
  app.use((_error,_req,res,_next)=>res.status(503).json({code:'UNAVAILABLE'}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const legacyRequest=async(url,{method='POST',body}={})=>{
    const response=await fetch(base+url,{method,headers:{origin:base,'content-type':'application/json',
      cookie:`waia_session=${adminIssued.credentials.sessionToken}`,'x-csrf-token':adminIssued.credentials.csrfToken},
      ...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,text:await response.text()};
  };
  const close=async()=>{
    server.close();await once(server,'close');
    try {
      await f.owner.query('DELETE FROM access_admin_requests WHERE actor_id=ANY($1::uuid[])',[f.ids]);
      await f.owner.query('DELETE FROM logs_auditoria WHERE ator_usuario_id=ANY($1::uuid[]) OR recurso_id=ANY($2::text[])',[f.ids,f.ids]);
    } finally {await accessPool.end();await f.close();}
  };
  return {...f,accessPool,accessRepository:repository,access:service,admin,backup,actor,adminIssued,adminSecret,fresh,remember,create,legacyService,legacyRequest,close};
}
