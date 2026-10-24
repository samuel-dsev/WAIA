import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withTenantTransaction,withPlatformTransaction } from '../../infra/postgres/transaction.js';
import { encryptCredentialSecret } from '../../security/credential-crypto.js';
import { evaluateAccess } from '../auth/permissions.js';
import { AccountError } from './errors.js';
import { customerProvisioningDenied } from './account-service.js';
const digest=v=>createHash('sha256').update(v).digest();
const missing=()=>new AccountError('COMPANY_NOT_FOUND',404,'Empresa ou recurso não encontrado.');
const denied=()=>new AccountError('ACCESS_DENIED',403,'Você não tem permissão para esta operação.');
const conflict=()=>new AccountError('TEAM_CONFLICT',409,'A equipe mudou. Atualize a página antes de continuar.');
const role=r=>r==='administrador'?'tenant_admin':'tenant_operator';
const schemas={
  invite:z.object({email:z.string().trim().toLowerCase().email().max(254),role:z.enum(['administrador','operador'])}).strict(),
  member:z.object({role:z.enum(['administrador','operador']),status:z.enum(['ativo','suspenso']),permissions:z.array(z.enum(['credentials.manage','credentials.read_masked','connections.manage'])).max(3).default([])}).strict(),
  transfer:z.object({userId:z.string().uuid()}).strict(),token:z.object({token:z.string().regex(/^[\w-]{43}$/)}).strict(),
};
export class TeamService {
  constructor({pool,keyring,origin,security,clock=()=>new Date(),inviteMs=259200000}) {
    if(!Number.isSafeInteger(inviteMs)||inviteMs<60000)throw new Error('Prazo de convite inválido.');
    Object.assign(this,{pool,keyring,origin,security,clock,inviteMs});
  }
  parse(kind,body) {const r=schemas[kind].safeParse(body);if(!r.success) throw new AccountError('VALIDATION_ERROR',422,'Confira os dados da equipe.');return r.data;}
  id(id) {if(!z.string().uuid().safeParse(id).success) throw missing();return id;}
  async audit(c,auth,empresaId,action) {throw customerProvisioningDenied();}
  async identity(c,auth) {
    throw customerProvisioningDenied();
    const r=(await c.query(`SELECT u.id,u.email,u.email_verified_at FROM usuarios u JOIN auth_sessions s ON s.usuario_id=u.id
      WHERE u.id=$1 AND s.id=$2 AND s.audience='customer' AND s.revoked_at IS NULL AND s.expires_at>$3
      AND s.last_seen_at>$4 AND s.security_version=u.security_version AND u.status='ativo' AND u.deleted_at IS NULL
      AND (NOT u.mfa_habilitado OR s.mfa_verified_at IS NOT NULL)`,[auth.user.id,auth.sessionId,this.clock(),new Date(this.clock().getTime()-3600000)])).rows[0];
    if(!r) throw denied();return r;
  }
  async principal(c,auth,empresaId) {
    throw customerProvisioningDenied();
    await this.identity(c,auth);
    const m=(await c.query(`SELECT m.papel,m.permissoes,(o.usuario_id=m.usuario_id) owner FROM usuarios_empresas m
      LEFT JOIN company_owners o ON o.empresa_id=m.empresa_id WHERE m.empresa_id=$1 AND m.usuario_id=$2 AND m.status='ativo'`,[empresaId,auth.user.id])).rows[0];
    if(!m) throw missing();
    return {audience:'customer',memberships:[{empresaId,role:role(m.papel),permissions:m.permissoes,owner:m.owner===true}]};
  }
  allow(p,op,id,options) {if(!evaluateAccess(p,op,id,options)) throw denied();}
  run(auth,id,fn) {
    throw customerProvisioningDenied();
    this.id(id);
    return withTenantTransaction(this.pool,{empresaId:id,usuarioId:auth.user.id},async({client:c})=>{
      // Empresa serializa convites, alteracoes, revogacoes e transferencias concorrentes.
      const e=(await c.query('SELECT id FROM empresas WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0];
      if(!e) throw missing();
      return fn(c,await this.principal(c,auth,id));
    });
  }
  list(auth,id) {
    throw customerProvisioningDenied();
    return this.run(auth,id,async(c,p)=>{
      this.allow(p,'team.read',id);
      const members=(await c.query(`SELECT m.usuario_id id,u.nome name,u.email,m.papel role,m.status,m.permissoes permissions,(o.usuario_id=m.usuario_id) owner
        FROM usuarios_empresas m JOIN usuarios u ON u.id=m.usuario_id LEFT JOIN company_owners o ON o.empresa_id=m.empresa_id
        WHERE m.empresa_id=$1 ORDER BY m.created_at,m.usuario_id LIMIT 100`,[id])).rows;
      const invitations=(await c.query("SELECT id,email,role,status,expires_at FROM team_invitations WHERE empresa_id=$1 AND status='pending' AND expires_at>$2 ORDER BY created_at DESC LIMIT 100",[id,this.clock()])).rows;
      const transfers=(await c.query("SELECT id,to_user,expires_at FROM ownership_transfers WHERE empresa_id=$1 AND status='pending' AND expires_at>$2 LIMIT 1",[id,this.clock()])).rows;
      return {members,invitations,transfers,owner:p.memberships[0].owner};
    });
  }
  async mail(c,{id,actorId,to,purpose,token,expiresAt}) {
    throw customerProvisioningDenied();
    const envelope=encryptCredentialSecret({secret:JSON.stringify({to,purpose,url:`${this.origin}/portal/#${purpose}=${token}`}),keyring:this.keyring,
      binding:{empresaId:'platform-accounts',credentialId:id,provider:'email',purpose:'account-delivery'}});
    await c.query('INSERT INTO account_email_outbox(id,usuario_id,envelope,expires_at) VALUES($1,$2,$3,$4)',[id,actorId,envelope,expiresAt]);
  }
  invite(auth,id,body) {
    throw customerProvisioningDenied();
    const input=this.parse('invite',body);
    return this.run(auth,id,async(c,p)=>{
      this.allow(p,'team.manage',id,{targetRole:role(input.role)});
      if(!(await this.identity(c,auth)).email_verified_at) throw denied();
      await c.query("UPDATE team_invitations SET status='expired' WHERE empresa_id=$1 AND expires_at<=$2 AND status='pending'",[id,this.clock()]);
      const prior=(await c.query("SELECT id FROM team_invitations WHERE empresa_id=$1 AND email=$2 AND status='pending'",[id,input.email])).rows[0];
      if(prior) return {id:prior.id,message:'Convite pendente. Revogue-o para enviar outro.'};
      const count=(await c.query(`SELECT (SELECT count(*) FROM usuarios_empresas WHERE empresa_id=$1)
        +(SELECT count(*) FROM team_invitations WHERE empresa_id=$1 AND status='pending') AS n`,[id])).rows[0];
      if(Number(count.n)>=100) throw new AccountError('TEAM_LIMIT',409,'Limite de membros e convites atingido.');
      const inviteId=randomUUID(),token=randomBytes(32).toString('base64url'),expiresAt=new Date(this.clock().getTime()+this.inviteMs);
      await c.query('INSERT INTO team_invitations(id,empresa_id,email,role,invited_by,digest,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[inviteId,id,input.email,input.role,auth.user.id,digest(token),expiresAt]);
      // Outbox policy permite apenas a mensagem criada por esta identidade no tenant.
      await this.mail(c,{id:inviteId,actorId:auth.user.id,to:input.email,purpose:'invite',token,expiresAt});
      await this.audit(c,auth,id,'team.invited');return {id:inviteId,message:'Convite registrado para envio.'};
    });
  }
  revokeInvite(auth,id,inviteId) {
    throw customerProvisioningDenied();
    this.id(inviteId);return this.run(auth,id,async(c,p)=>{
      const row=(await c.query('SELECT role FROM team_invitations WHERE id=$1 AND empresa_id=$2',[inviteId,id])).rows[0];if(!row) throw missing();
      this.allow(p,'team.manage',id,{targetRole:role(row.role)});
      await c.query("UPDATE team_invitations SET status='revoked' WHERE id=$1 AND status='pending'",[inviteId]);
      await this.audit(c,auth,id,'team.invitation.revoked');
    });
  }
  member(auth,id,userId,body) {
    throw customerProvisioningDenied();
    this.id(userId);const input=this.parse('member',body);
    return this.run(auth,id,async(c,p)=>{
      const m=(await c.query('SELECT papel FROM usuarios_empresas WHERE empresa_id=$1 AND usuario_id=$2 FOR UPDATE',[id,userId])).rows[0];if(!m) throw missing();
      this.allow(p,'team.manage',id,{targetRole:role(m.papel)});this.allow(p,'team.manage',id,{targetRole:role(input.role)});
      if(input.permissions.length && (!p.memberships[0].owner||input.role!=='administrador')) throw denied();
      if((await c.query('SELECT 1 FROM company_owners WHERE empresa_id=$1 AND usuario_id=$2',[id,userId])).rowCount) throw new AccountError('OWNER_PROTECTED',409,'Transfira a propriedade antes de alterar este vínculo.');
      await c.query('UPDATE usuarios_empresas SET papel=$3,status=$4,permissoes=$5 WHERE empresa_id=$1 AND usuario_id=$2',[id,userId,input.role,input.status,input.permissions]);
      await this.audit(c,auth,id,'team.member.changed');return {};
    });
  }
  accept(auth,body) {
    throw customerProvisioningDenied();
    const {token}=this.parse('token',body);
    return withPlatformTransaction(this.pool,{},async({client:c})=>{
      const inv=(await c.query('SELECT * FROM team_invitations WHERE digest=$1',[digest(token)])).rows[0];if(!inv) throw missing();
      if(!(await c.query('SELECT id FROM empresas WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[inv.empresa_id])).rowCount) throw missing();
      const current=(await c.query('SELECT * FROM team_invitations WHERE id=$1 FOR UPDATE',[inv.id])).rows[0];
      const u=await this.identity(c,auth);
      if(!u.email_verified_at||String(u.email).toLowerCase()!==String(inv.email).toLowerCase()||current.status!=='pending'||new Date(current.expires_at)<=this.clock()) throw denied();
      const author=(await c.query(`SELECT m.papel,(o.usuario_id=m.usuario_id) owner FROM usuarios_empresas m JOIN usuarios u ON u.id=m.usuario_id
        LEFT JOIN company_owners o ON o.empresa_id=m.empresa_id WHERE m.empresa_id=$1 AND m.usuario_id=$2 AND m.status='ativo' AND u.status='ativo' AND u.deleted_at IS NULL`,[inv.empresa_id,inv.invited_by])).rows[0];
      if(!author||!evaluateAccess({audience:'customer',memberships:[{empresaId:inv.empresa_id,role:role(author.papel),owner:author.owner}]},'team.manage',inv.empresa_id,{targetRole:role(inv.role)})) throw denied();
      const old=(await c.query('SELECT status FROM usuarios_empresas WHERE empresa_id=$1 AND usuario_id=$2',[inv.empresa_id,u.id])).rows[0];
      if(old?.status==='ativo') throw conflict();
      await c.query(`INSERT INTO usuarios_empresas(empresa_id,usuario_id,papel) VALUES($1,$2,$3)
        ON CONFLICT(empresa_id,usuario_id) DO UPDATE SET papel=$3,status='ativo',permissoes='{}'`,[inv.empresa_id,u.id,inv.role]);
      await c.query("UPDATE team_invitations SET status='accepted' WHERE id=$1",[inv.id]);await this.audit(c,auth,inv.empresa_id,'team.invitation.accepted');return {companyId:inv.empresa_id};
    });
  }
  transfer(auth,id,body) {
    throw customerProvisioningDenied();
    const {userId}=this.parse('transfer',body);
    return this.run(auth,id,async(c,p)=>{
      this.allow(p,'ownership.transfer',id);await this.security.fresh(c,auth);
      if(userId===auth.user.id) throw conflict();
      const target=(await c.query(`SELECT u.email FROM usuarios u JOIN usuarios_empresas m ON m.usuario_id=u.id
        WHERE m.empresa_id=$1 AND u.id=$2 AND m.status='ativo' AND u.status='ativo' AND u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL`,[id,userId])).rows[0];if(!target) throw missing();
      await c.query("UPDATE ownership_transfers SET status='revoked' WHERE empresa_id=$1 AND status='pending'",[id]);
      const transferId=randomUUID(),token=randomBytes(32).toString('base64url'),expiresAt=new Date(this.clock().getTime()+86400000);
      await c.query('INSERT INTO ownership_transfers(id,empresa_id,from_user,to_user,digest,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[transferId,id,auth.user.id,userId,digest(token),expiresAt]);
      await this.mail(c,{id:transferId,actorId:auth.user.id,to:target.email,purpose:'transfer',token,expiresAt});
      await this.audit(c,auth,id,'ownership.requested');return {id:transferId};
    });
  }
  revokeTransfer(auth,id,transferId) {
    throw customerProvisioningDenied();
    this.id(transferId);return this.run(auth,id,async(c,p)=>{this.allow(p,'ownership.transfer',id);
      await c.query("UPDATE ownership_transfers SET status='revoked' WHERE empresa_id=$1 AND id=$2 AND status='pending'",[id,transferId]);await this.audit(c,auth,id,'ownership.revoked');});
  }
  acceptTransfer(auth,body) {
    throw customerProvisioningDenied();
    const {token}=this.parse('token',body);
    return withPlatformTransaction(this.pool,{},async({client:c})=>{
      const found=(await c.query('SELECT empresa_id FROM ownership_transfers WHERE digest=$1',[digest(token)])).rows[0];if(!found) throw missing();
      const e=(await c.query('SELECT id FROM empresas WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[found.empresa_id])).rows[0];if(!e) throw missing();
      const t=(await c.query('SELECT * FROM ownership_transfers WHERE digest=$1 FOR UPDATE',[digest(token)])).rows[0];
      if(t.status!=='pending'||new Date(t.expires_at)<=this.clock()||t.to_user!==auth.user.id) throw denied();
      const u=await this.security.fresh(c,auth);if(!u.email_verified_at) throw denied();
      const members=await c.query("SELECT usuario_id FROM usuarios_empresas WHERE empresa_id=$1 AND usuario_id=ANY($2::uuid[]) AND status='ativo' FOR UPDATE",[t.empresa_id,[t.from_user,t.to_user]]);
      if(members.rowCount!==2) throw conflict();
      const owner=(await c.query('SELECT usuario_id FROM company_owners WHERE empresa_id=$1 FOR UPDATE',[t.empresa_id])).rows[0];if(owner?.usuario_id!==t.from_user) throw conflict();
      await c.query("UPDATE usuarios_empresas SET papel='administrador' WHERE empresa_id=$1 AND usuario_id=$2",[t.empresa_id,t.to_user]);
      await c.query('UPDATE company_owners SET usuario_id=$2 WHERE empresa_id=$1',[t.empresa_id,t.to_user]);
      await c.query("UPDATE ownership_transfers SET status='accepted' WHERE id=$1",[t.id]);await this.audit(c,auth,t.empresa_id,'ownership.accepted');return {companyId:t.empresa_id};
    });
  }
}
