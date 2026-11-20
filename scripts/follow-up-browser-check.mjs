import express from 'express';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MemoryAdminRepository, AdminService, createAdminRouter, adminErrorMiddleware } from '../src/modules/admin/index.js';
import { createFollowUpRouter } from '../src/modules/follow-up/http.js';

// Visual/UI evidence only. All state is synthetic and held in this process.
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || 'playwright');
const output = fileURLToPath(new URL('../.tmp/follow-up/browser/', import.meta.url)); await mkdir(output,{recursive:true});
const companyId=randomUUID(), conversationId=randomUUID(), userId=randomUUID();
const auth={audience:'admin',platformRole:'platform_admin',user:{id:userId,name:'Revisão fictícia'},memberships:[],csrfToken:'synthetic-csrf'};
let settings={enabled:false,profile:'test',version:0,periodsHours:[2/60,5/60,10/60,15/60],closeAfterHours:20/60,templates:[null,null,null,null]};
let contact={enabled:false,version:0,state:'disabled',actions:[]},mutations=[];
const snapshot=()=>structuredClone({settings,contact});
const followUp={read:async()=>snapshot(),saveSettings:async(_auth,_company,body)=>{
  assert.equal(body.expectedVersion,settings.version);mutations.push({type:'settings',body});settings={...body,version:settings.version+1};contact={...contact,enabled:false};return snapshot();
},toggle:async(_auth,_company,_id,body)=>{
  assert.equal(body.expectedVersion,contact.version);assert.equal(settings.enabled,true);mutations.push({type:'contact',body});
  contact={...contact,enabled:body.enabled,version:contact.version+1};return snapshot();
}};
const repository=new MemoryAdminRepository({environment:'test',tenants:[{id:companyId,name:'Empresa fictícia',status:'active'}],records:{
  contacts:[{id:'contact',empresaId:companyId,name:'Contato de teste',phone:'5511000000001'}],
  conversations:[{id:conversationId,empresaId:companyId,contactId:'contact',status:'aberta',mode:'bot'}],messages:[]}});
const app=express();app.use(express.json());
app.get('/api/admin/auth/session',(_req,res)=>res.json(auth));
app.use('/api/admin',createAdminRouter({adminService:new AdminService({repository}),followUpRepository:followUp,authenticate:(req,_res,next)=>{req.auth=auth;next();},csrf:(_req,_res,next)=>next()}));
app.use(adminErrorMiddleware);
for(const surface of ['panel','portal'])app.use(`/${surface}`,express.static(fileURLToPath(new URL(`../${surface}/`,import.meta.url))));
app.get('/preview',(_req,res)=>res.type('html').send(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Follow-up fictício</title><link rel="stylesheet" href="/portal/styles.css"><link rel="stylesheet" href="/portal/conversations.css"><main style="padding:20px;max-width:900px;margin:auto"><h1>Follow-up · revisão fictícia</h1><div id="qa"></div></main><script type="module">import{createFollowUpControl}from'/portal/inbox.js';document.querySelector('#qa').append(createFollowUpControl({company:{id:'${companyId}',effectiveCapabilities:['attendance.edit','conversations.update']},conversationId:'${conversationId}',api:async(path,body,method)=>{const r=await fetch(path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const p=await r.json();if(!r.ok)throw Object.assign(Error(p.message),{status:r.status});return p;}}));</script></html>`));
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true,channel:'chrome'}),errors=[],screenshots=[];
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/panel/index.html#conversations`);
  await page.locator('#tenantSelect').selectOption(companyId);
  await page.getByRole('button',{name:'Follow-up da empresa',exact:true}).click();
  const dialog=page.locator('#detailDialog');await dialog.getByLabel('Prazo do follow-up em horas').first().waitFor();
  assert.equal(await dialog.getByLabel('Habilitar follow-up da empresa').isChecked(),false);
  assert.equal(await dialog.getByLabel('Prazo do follow-up em horas').count(),4);
  await dialog.getByLabel('Prazo do follow-up em horas').nth(0).fill('0.5');
  await dialog.getByRole('button',{name:'Remover período'}).nth(3).click();
  await dialog.getByRole('button',{name:'Adicionar período'}).click();
  const inputs=dialog.getByLabel('Prazo do follow-up em horas');for(const [i,h]of [0.5,2,6,24].entries())await inputs.nth(i).fill(String(h));
  await dialog.getByLabel('Fechar ciclo e avaliar resumo após (horas)').fill('96');
  await dialog.getByLabel('Habilitar follow-up da empresa').check();
  await dialog.getByRole('button',{name:'Salvar follow-up da empresa'}).click();
  await page.waitForFunction(()=>document.querySelector('#detailDialog select')?.value==='custom');
  assert.deepEqual(settings.periodsHours,[0.5,2,6,24]);assert.equal(contact.enabled,false);
  const capture=async(name,width)=>{await page.setViewportSize({width,height:1000});await page.screenshot({path:output+`${name}.png`,fullPage:true});screenshots.push(name);};
  await capture('panel-desktop',1440);await capture('panel-mobile',390);
  const overflow=await dialog.evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,items:[...el.querySelectorAll('*')].filter(x=>x.getBoundingClientRect().right>el.getBoundingClientRect().right).map(x=>({tag:x.tagName,cls:x.className,width:x.getBoundingClientRect().width})).slice(0,10)}));
  assert.equal(overflow.scroll<=overflow.width+1,true,JSON.stringify(overflow));
  await page.locator('#detailClose').click();await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Abrir',exact:true}).click();await dialog.getByLabel('Ativar follow-up para este contato').waitFor();
  assert.equal(await dialog.getByLabel('Ativar follow-up para este contato').isChecked(),false);
  await dialog.getByLabel('Ativar follow-up para este contato').check();await page.waitForFunction(()=>document.querySelector('#detailDialog input[type=checkbox]')?.checked);
  assert.equal(contact.enabled,true);await page.locator('#detailClose').click();
  assert.deepEqual(errors,[]);
  await writeFile(output+'result.json',JSON.stringify({status:'passed',evidence:'synthetic_ui_only',screenshots,mutations:mutations.length,checks:['default-disabled','edit-hours','add-remove','fractional-hours','persist-preview','contact-opt-in','mobile-layout'],pageErrors:errors},null,2));
  console.log(JSON.stringify({status:'passed',screenshots,mutations:mutations.length}));
}catch(error){console.log(JSON.stringify({pageErrors:errors}));throw error;}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
