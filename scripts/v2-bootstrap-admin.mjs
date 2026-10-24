import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { hashPassword,verifyPassword } from '../src/modules/auth/password.js';
import { withPlatformTransaction } from '../src/infra/postgres/transaction.js';

assert.equal(process.env.NODE_ENV,'development');
assert.ok(process.env.V2_PREVIEW_ADMIN_PASSWORD?.length>=32);
const pool=new pg.Pool({connectionString:`postgres://waia_v2_owner:${encodeURIComponent(process.env.V2_OWNER_PASSWORD)}@v2-postgres:5432/waia_v2_app`});
try {
  await withPlatformTransaction(pool,{},async({client})=>{
    assert.equal((await client.query('SELECT current_database() name')).rows[0].name,'waia_v2_app');
    await client.query('SELECT pg_advisory_xact_lock(810420267)');
    const email='admin.local@waia.example';
    const current=(await client.query('SELECT * FROM usuarios WHERE email=$1 FOR UPDATE',[email])).rows[0];
    if(current) {
      assert.equal(current.papel_plataforma,'administrador');
      assert.ok(await verifyPassword(process.env.V2_PREVIEW_ADMIN_PASSWORD,current.password_hash),'A senha de bootstrap mudou; não redefinir identidade existente.');
    } else {
      assert.equal((await client.query("SELECT count(*)::int n FROM usuarios WHERE papel_plataforma='administrador' AND deleted_at IS NULL")).rows[0].n,0);
      await client.query(`INSERT INTO usuarios(id,email,nome,password_hash,papel_plataforma,email_verified_at)
        VALUES($1,$2,'Administrador local M2',$3,'administrador',now())`,[randomUUID(),email,await hashPassword(process.env.V2_PREVIEW_ADMIN_PASSWORD)]);
    }
  });
  console.log('Bootstrap administrativo sintético pronto; credenciais preservadas no arquivo protegido.');
} finally {await pool.end();}
