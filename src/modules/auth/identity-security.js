import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withPlatformTransaction } from '../../infra/postgres/transaction.js';
import { encryptCredentialSecret, decryptCredentialSecret } from '../../security/credential-crypto.js';
import { verifyPassword } from './password.js';
import { base32, newTotpSecret, verifyTotp } from './totp.js';
import { AccountError } from '../accounts/errors.js';
import { invalidateIdentitySecurity } from './identity-lifecycle.js';

const digest = (v) => createHash('sha256').update(String(v)).digest();
const fail = () => new AccountError('MFA_INVALID',401,'Código inválido ou expirado. Inicie novamente se necessário.');
const binding = (id) => ({empresaId:'platform-identity',credentialId:id,provider:'totp',purpose:'mfa'});
export class IdentitySecurity {
  constructor({pool,keyring,codecs,limiter,clock=()=>new Date(),sessionMs=43200000,sessionMsByAudience={}}) {
    if(!sessionMsByAudience || typeof sessionMsByAudience!=='object' || Array.isArray(sessionMsByAudience)
      || Object.keys(sessionMsByAudience).some(audience=>!['admin','customer'].includes(audience))) throw new TypeError('Prazos de sessão inválidos.');
    const durations={admin:sessionMsByAudience.admin??sessionMs,customer:sessionMsByAudience.customer??sessionMs};
    for(const duration of [sessionMs,...Object.values(durations)]) {
      if(!Number.isSafeInteger(duration)||duration<60000||!Number.isFinite(new Date(clock().getTime()+duration).getTime())) {
        throw new TypeError('Prazo de sessão inválido.');
      }
    }
    Object.assign(this,{pool,keyring,codecs,limiter,clock,sessionMs});
    this.sessionMsByAudience=Object.freeze(durations);
  }
  seal(id,value) { return encryptCredentialSecret({secret:value,keyring:this.keyring,binding:binding(id)}); }
  open(id,envelope) { return decryptCredentialSecret({envelope,keyring:this.keyring,binding:binding(id)}); }
  async rate(key,ip) {
    for(const value of [`identity:${key}`,`ip:${ip}`]) {
      const r=await this.limiter.consume({key:`mfa:${digest(value).toString('hex')}`,max:10});
      if(!r.allowed) throw new AccountError('RATE_LIMITED',429,'Muitas tentativas. Aguarde alguns minutos.');
    }
  }
  async audit(c,userId,action) {
    await c.query('INSERT INTO account_audit(usuario_id,action) VALUES($1,$2)',[userId,action]);
  }
  async notify(c,u) {
    const id=randomUUID(), envelope=encryptCredentialSecret({secret:JSON.stringify({to:u.email,purpose:'mfa_changed'}),keyring:this.keyring,
      binding:{empresaId:'platform-accounts',credentialId:id,provider:'email',purpose:'account-delivery'}});
    await c.query('INSERT INTO account_email_outbox(id,usuario_id,envelope,expires_at) VALUES($1,$2,$3,$4)',[id,u.id,envelope,new Date(this.clock().getTime()+86400000)]);
  }
  async #user(c,id) { return (await c.query("SELECT * FROM usuarios WHERE id=$1 AND status='ativo' AND deleted_at IS NULL AND NOT activation_required FOR UPDATE",[id])).rows[0]; }
  #allowedAudience(u,audience) {
    return ['admin','customer'].includes(audience) && typeof this.codecs?.[audience]?.issue==='function'
      && (audience!=='admin' || u.papel_plataforma==='administrador');
  }
  async #session(c,auth,u) {
    if(!this.#allowedAudience(u,auth?.audience)) throw fail();
    const s=(await c.query(`SELECT * FROM auth_sessions WHERE id=$1 AND usuario_id=$2 AND revoked_at IS NULL
      AND expires_at>$3 AND last_seen_at>$4 AND security_version=$5 AND audience=$6 FOR UPDATE`,[auth.sessionId,u.id,this.clock(),new Date(this.clock().getTime()-3600000),u.security_version,auth.audience])).rows[0];
    if(s && (s.audience!==auth.audience || (s.audience==='admin' && (!u.mfa_habilitado || !s.mfa_verified_at)))) throw fail();
    if(!s) throw fail(); return s;
  }
  async #challenge(c,u,audience,purpose,sessionId=null) {
    const id=randomUUID(), token=randomBytes(32).toString('base64url');
    const enroll=!u.mfa_habilitado;
    const secret=enroll?newTotpSecret():null;
    await c.query('UPDATE identity_challenges SET consumed_at=$2,envelope=NULL WHERE usuario_id=$1 AND consumed_at IS NULL',[u.id,this.clock()]);
    await c.query(`INSERT INTO identity_challenges(id,usuario_id,digest,audience,purpose,session_id,security_version,envelope,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,u.id,digest(token),audience,purpose,sessionId,u.security_version,
      secret?this.seal(id,secret.toString('base64')):null,new Date(this.clock().getTime()+300000)]);
    return {mfaRequired:true,challenge:token,...(secret?{enrollment:{secret:base32(secret),uri:`otpauth://totp/WAIA:${encodeURIComponent(u.email)}?secret=${base32(secret)}&issuer=WAIA&algorithm=SHA1&digits=6&period=30`}}:{})};
  }
  // Called only after a password check; recheck the hash under the user lock.
  login({userId,passwordHash,audience}) {
    return withPlatformTransaction(this.pool,{},async({client:c})=>{
      const u=await this.#user(c,userId);
      if(!u || !this.#allowedAudience(u,audience) || u.password_hash!==passwordHash) throw fail();
      if(!u.mfa_habilitado && u.papel_plataforma!=='administrador') return null;
      return this.#challenge(c,u,audience,'login');
    });
  }
  async setup(auth,password,ip) {
    await this.rate(auth.user.id,ip);
    return withPlatformTransaction(this.pool,{},async({client:c})=>{
      const u=await this.#user(c,auth.user.id); if(!u) throw fail();
      const s=await this.#session(c,auth,u);
      if(!u.email_verified_at || u.mfa_habilitado || !await verifyPassword(password,u.password_hash)) throw fail();
      return this.#challenge(c,u,s.audience,'enroll',s.id);
    });
  }
  async #factor(c,u,code,now) {
    if(!u.mfa_habilitado || !u.mfa_envelope) return false;
    const step=verifyTotp(Buffer.from(this.open(u.id,u.mfa_envelope),'base64'),code,now,u.mfa_last_counter);
    if(step!==null) { await c.query('UPDATE usuarios SET mfa_last_counter=$2 WHERE id=$1',[u.id,step]); return true; }
    if(typeof code!=='string'||!/^([a-f0-9]{32})$/.test(code)) return false;
    return (await c.query('UPDATE mfa_recovery_codes SET consumed_at=$3 WHERE usuario_id=$1 AND digest=$2 AND consumed_at IS NULL RETURNING digest',[u.id,digest(code),now])).rowCount===1;
  }
  async #codes(c,userId) {
    const codes=Array.from({length:10},()=>randomBytes(16).toString('hex'));
    await c.query('DELETE FROM mfa_recovery_codes WHERE usuario_id=$1',[userId]);
    for(const code of codes) await c.query('INSERT INTO mfa_recovery_codes(usuario_id,digest) VALUES($1,$2)',[userId,digest(code)]);
    return codes;
  }
  async complete({challenge,code,audience,purpose='login',auth,ip}) {
    if(!['admin','customer'].includes(audience)||!['login','enroll'].includes(purpose)
      ||typeof challenge!=='string'||!/^[\w-]{43}$/.test(challenge)||typeof code!=='string'||code.length>32) throw fail();
    await this.rate(challenge,ip);
    const result=await withPlatformTransaction(this.pool,{},async({client:c})=>{
      const found=(await c.query('SELECT usuario_id FROM identity_challenges WHERE digest=$1',[digest(challenge)])).rows[0];
      if(!found) return null;
      const u=await this.#user(c,found.usuario_id); if(!u || !this.#allowedAudience(u,audience)) return null;
      const ch=(await c.query('SELECT * FROM identity_challenges WHERE digest=$1 FOR UPDATE',[digest(challenge)])).rows[0];
      const now=this.clock();
      if(!ch||ch.consumed_at||new Date(ch.expires_at)<=now||ch.attempts>=5||ch.audience!==audience||ch.purpose!==purpose||ch.security_version!==u.security_version) return null;
      if(purpose==='enroll') {if(!auth||auth.audience!==audience||auth.user.id!==u.id||auth.sessionId!==ch.session_id) return null; await this.#session(c,auth,u);}
      await c.query('UPDATE identity_challenges SET attempts=attempts+1 WHERE id=$1',[ch.id]);
      let recoveryCodes;
      if(ch.envelope) {
        if(u.mfa_habilitado) return null;
        const raw=this.open(ch.id,ch.envelope), step=verifyTotp(Buffer.from(raw,'base64'),code,now);
        if(step===null) return null;
        await c.query('UPDATE usuarios SET mfa_habilitado=true,mfa_envelope=$2,mfa_last_counter=$3 WHERE id=$1',[u.id,this.seal(u.id,raw),step]);
        const invalidation=await invalidateIdentitySecurity(c,{userId:u.id,now,keepSessionId:purpose==='enroll'?auth.sessionId:null});
        u.security_version=invalidation.securityVersion; u.mfa_habilitado=true;
        recoveryCodes=await this.#codes(c,u.id); await this.notify(c,u); await this.audit(c,u.id,'account.mfa.enabled');
      } else if(!await this.#factor(c,u,code,now)) return null;
      await c.query('UPDATE identity_challenges SET consumed_at=$2,envelope=NULL WHERE id=$1',[ch.id,now]);
      if(purpose==='enroll') {
        await c.query('UPDATE auth_sessions SET security_version=$2,mfa_verified_at=$3,reauthenticated_at=$3 WHERE id=$1 AND revoked_at IS NULL',[auth.sessionId,u.security_version,now]);
        return {recoveryCodes};
      }
      const issued=this.codecs[audience].issue();
      const expiresAt=new Date(now.getTime()+this.sessionMsByAudience[audience]);
      if(!Number.isFinite(expiresAt.getTime())) throw fail();
      const session=(await c.query(`INSERT INTO auth_sessions(usuario_id,token_hash,audience,security_version,created_at,last_seen_at,expires_at,mfa_verified_at,reauthenticated_at)
        VALUES($1,$2,$3,$4,$5,$5,$6,$5,$5) RETURNING id,created_at,expires_at`,[u.id,issued.tokenHash,audience,u.security_version,now,expiresAt])).rows[0];
      await this.audit(c,u.id,'account.mfa.login');
      return {userId:u.id,issued,session,recoveryCodes};
    });
    if(!result) throw fail(); return result;
  }
  async reauthenticate(auth,{password,code},ip) {
    await this.rate(auth.user.id,ip);
    const ok=await withPlatformTransaction(this.pool,{},async({client:c})=>{
      const u=await this.#user(c,auth.user.id); if(!u) return false;
      await this.#session(c,auth,u);
      if(!await verifyPassword(password,u.password_hash)||!await this.#factor(c,u,code,this.clock())) return false;
      await c.query('UPDATE auth_sessions SET reauthenticated_at=$2,mfa_verified_at=$2 WHERE id=$1',[auth.sessionId,this.clock()]);
      await this.audit(c,u.id,'account.reauthenticated'); return true;
    });
    if(!ok) throw fail();
  }
  async fresh(c,auth) {
    const u=await this.#user(c,auth.user.id); if(!u) throw fail();
    const s=await this.#session(c,auth,u);
    if(!u.mfa_habilitado||!s.reauthenticated_at||new Date(s.reauthenticated_at)<=new Date(this.clock().getTime()-600000))
      throw new AccountError('REAUTH_REQUIRED',403,'Confirme sua senha e seu segundo fator para continuar.');
    return u;
  }
  manage(auth,action) {
    return withPlatformTransaction(this.pool,{},async({client:c})=>{
      const u=await this.fresh(c,auth);
      if(action==='codes') {const recoveryCodes=await this.#codes(c,u.id);await this.audit(c,u.id,'account.mfa.recovery_rotated');await this.notify(c,u);return {recoveryCodes};}
      if(u.papel_plataforma==='administrador') throw new AccountError('MFA_REQUIRED',403,'A plataforma exige autenticação em duas etapas.');
      await c.query('UPDATE usuarios SET mfa_habilitado=false,mfa_envelope=NULL,mfa_last_counter=NULL WHERE id=$1',[u.id]);
      await c.query('DELETE FROM mfa_recovery_codes WHERE usuario_id=$1',[u.id]);
      await invalidateIdentitySecurity(c,{userId:u.id,now:this.clock()});
      await this.audit(c,u.id,'account.mfa.disabled'); await this.notify(c,u); return {};
    });
  }
  sessions(auth) {
    return withPlatformTransaction(this.pool,{},async({client:c})=>{
      const u=await this.#user(c,auth.user.id); if(!u) throw fail();await this.#session(c,auth,u);
      return (await c.query(`SELECT id,audience,created_at,last_seen_at,expires_at FROM auth_sessions WHERE usuario_id=$1 AND revoked_at IS NULL AND expires_at>$2 ORDER BY created_at DESC LIMIT 100`,[u.id,this.clock()])).rows.map(s=>({id:s.id,audience:s.audience,createdAt:s.created_at,lastSeenAt:s.last_seen_at,expiresAt:s.expires_at,current:s.id===auth.sessionId}));
    });
  }
  revoke(auth,id) {
    return withPlatformTransaction(this.pool,{},async({client:c})=>{
      const u=await this.#user(c,auth.user.id); if(!u) throw fail();await this.#session(c,auth,u);
      await c.query('UPDATE auth_sessions SET revoked_at=$3 WHERE usuario_id=$1 AND id=$2',[u.id,id,this.clock()]);await this.audit(c,u.id,'account.session.revoked');
    });
  }
}
