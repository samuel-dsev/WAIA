import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync,writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const branch=spawnSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'});
if(branch.status!==0||branch.stdout.trim()!=='new')throw Error('Preview autorizado somente no checkout da branch new.');
const secretDir=path.join(root,'.secrets');mkdirSync(secretDir,{recursive:true});
const values=Object.fromEntries(readFileSync(path.join(secretDir,'v2-test.env'),'utf8').trim().split(/\r?\n/).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
function run(args,capture=false){const r=spawnSync('docker',args,{cwd:root,encoding:'utf8',stdio:capture?'pipe':'inherit'});if(r.status!==0)throw Error('Operação de preview falhou sem limpar dados.');return r.stdout?.trim();}
const bootstrapFile=path.join(secretDir,'v2-preview-bootstrap.env');
if(!existsSync(bootstrapFile))writeFileSync(bootstrapFile,`NODE_ENV=development\nV2_PREVIEW_ADMIN_PASSWORD=${randomBytes(32).toString('hex')}\n`,{mode:0o600,flag:'wx'});
const network=JSON.parse(run(['network','inspect','waia-test_v2_internal'],true))[0];
if(!network.Internal)throw Error('Rede v2 não está isolada.');
const proxyName='waia-test-v2-preview-proxy';
const proxyExisting=spawnSync('docker',['inspect',proxyName],{cwd:root,encoding:'utf8'});
if(proxyExisting.status===0){
  if(JSON.parse(proxyExisting.stdout)[0].Config.Labels?.['waia.preview']!=='v2-local')throw Error('Proxy existente não pertence a este preview.');
  run(['stop','--timeout','10',proxyName]);run(['rm',proxyName]);
}
run(['run','-d','--name',proxyName,'--label','com.docker.compose.project=waia-test','--label','waia.preview=v2-local',
  '--network','bridge','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges',
  '-p','127.0.0.1:5035:3001','-v',`${path.join(root,'scripts/v2-preview-proxy.mjs')}:/preview-proxy.mjs:ro`,
  'node:22-alpine','node','/preview-proxy.mjs']);
run(['network','connect','waia-test_v2_internal',proxyName]);
const proxyAddress=JSON.parse(run(['inspect',proxyName],true))[0].NetworkSettings.Networks['waia-test_v2_internal'].IPAddress;
const keyring=JSON.stringify({activeVersion:'1',keys:{'1':Buffer.from(values.V2_MASTER_KEY,'hex').toString('base64')}});
const previewFile=path.join(secretDir,'v2-preview.env');
writeFileSync(previewFile,[`NODE_ENV=development`,'INFRASTRUCTURE_MODE=postgres',
  `DATABASE_URL=postgres://waia_v2_app:${encodeURIComponent(values.V2_APP_PASSWORD)}@v2-postgres:5432/waia_v2_app`,
  'REDIS_URL=redis://v2-redis:6379/0','REDIS_QUEUE_NAME=waia-v2-synthetic',
  `MASTER_KEYRING=${keyring}`,`SESSION_PEPPER=${values.V2_SESSION_PEPPER}`,
  'MEDIA_STORAGE_ROOT=/app/.data/media','CUSTOMER_ACCOUNTS_ENABLED=true','ACCOUNT_EMAIL_MODE=fake',
  'CUSTOMER_PORTAL_ORIGIN=http://127.0.0.1:5035','PANEL_ORIGIN=http://127.0.0.1:5035',
  'COOKIE_SECURE=false',`ADMIN_NETWORK_ALLOWLIST=127.0.0.1/32,::1,${proxyAddress}/32`,'LOG_LEVEL=error',
].join('\n')+'\n',{mode:0o600});
run(['run','--rm','--network','waia-test_v2_internal','--env-file',path.join(secretDir,'v2-test.env'),'--env-file',bootstrapFile,
  'waia:v2-test-local','node','scripts/v2-bootstrap-admin.mjs']);
const existing=spawnSync('docker',['inspect','waia-test-v2-preview'],{cwd:root,encoding:'utf8'});
if(existing.status===0){
  const metadata=JSON.parse(existing.stdout)[0];
  if(metadata.Config.Labels?.['waia.preview']!=='v2-local')throw Error('Nome ocupado por container não gerenciado por este preview.');
  run(['stop','--timeout','10','waia-test-v2-preview']);
  run(['rm','waia-test-v2-preview']);
}
run(['run','-d','--name','waia-test-v2-preview','--label','com.docker.compose.project=waia-test','--label','waia.preview=v2-local',
  '--network','waia-test_v2_internal','--read-only','--tmpfs','/tmp:mode=1777','--cap-drop','ALL','--security-opt','no-new-privileges',
  '--env-file',previewFile,'-v','waia-test_v2_media_data:/app/.data/media',
  'waia:v2-test-local','node','scripts/v2-preview-api.mjs']);
console.log('Painel local: http://127.0.0.1:5035/panel/ — ambiente v2 dedicado, sem egress ou worker de atendimento.');
