import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync,writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const branch=spawnSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'});
if(branch.status!==0||branch.stdout.trim()!=='new')throw Error('Preview autorizado somente no checkout da branch new.');
// An acceptance run must use the immutable image that was actually validated.
// The historical default remains available for earlier phase runners.
const image=process.argv[2]||'waia:v2-test-local';
if(process.argv[2]&&!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('Informe o Image ID imutável, não uma tag mutável.');
const secretDir=path.join(root,'.secrets');mkdirSync(secretDir,{recursive:true});
const values=Object.fromEntries(readFileSync(path.join(secretDir,'v2-test.env'),'utf8').trim().split(/\r?\n/).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
function run(args,capture=false){const r=spawnSync('docker',args,{cwd:root,encoding:'utf8',timeout:120000,stdio:capture?'pipe':'inherit'});if(r.status!==0)throw Error('Operação de preview falhou sem limpar dados.');return r.stdout?.trim();}
const imageMetadata=JSON.parse(run(['image','inspect',image],true))[0];
const version=run(['run','--rm','--network','none',imageMetadata.Id,'node','-p',"require('./package.json').version"],true);
if(process.argv[2]&&!/^2\.0\.0(?:-rc\.[1-9][0-9]*)?$/.test(version))throw Error('O artefato informado não é da entrega 2.0.0.');
const bootstrapFile=path.join(secretDir,'v2-preview-bootstrap.env');
if(!existsSync(bootstrapFile))writeFileSync(bootstrapFile,`NODE_ENV=development\nV2_PREVIEW_ADMIN_PASSWORD=${randomBytes(32).toString('hex')}\n`,{mode:0o600,flag:'wx'});
const network=JSON.parse(run(['network','inspect','waia-test_v2_internal'],true))[0];
if(!network.Internal)throw Error('Rede v2 não está isolada.');
const media=JSON.parse(run(['volume','inspect','waia-test_v2_media_data'],true))[0];
if(media.Name!=='waia-test_v2_media_data'||media.Labels?.['com.docker.compose.project']!=='waia-test'
  ||media.Labels?.['com.docker.compose.volume']!=='v2_media_data')throw Error('Volume de mídia v2 existente não confirmado.');
const proxyName='waia-test-v2-preview-proxy';
// Validate both owned surfaces before interrupting either one. An unexpected
// name/target must leave the current preview completely intact.
for(const name of [proxyName,'waia-test-v2-preview']){
  const found=spawnSync('docker',['inspect',name],{cwd:root,encoding:'utf8',timeout:30000});
  if(found.status!==0)continue;
  const item=JSON.parse(found.stdout)[0];
  if(item.Name!==`/${name}`||item.Config.Labels?.['waia.preview']!=='v2-local'
    ||item.Config.Labels?.['com.docker.compose.project']!=='waia-test')throw Error('Nome existente não pertence ao preview v2.');
  if(name==='waia-test-v2-preview'){
    const settings=Object.fromEntries(item.Config.Env.map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
    if(Object.keys(item.NetworkSettings.Networks).join(',')!=='waia-test_v2_internal'
      ||settings.NODE_ENV!=='development'||settings.ACCOUNT_EMAIL_MODE!=='fake'
      ||new URL(settings.DATABASE_URL).hostname!=='v2-postgres'||new URL(settings.DATABASE_URL).pathname!=='/waia_v2_app')throw Error('API existente fora do alvo sintético.');
    const mounted=item.Mounts.find(mount=>mount.Destination==='/app/.data/media');
    if(mounted?.Type!=='volume'||mounted.Name!=='waia-test_v2_media_data')throw Error('Mídia existente fora do volume v2 esperado.');
  }else if(item.HostConfig.PortBindings?.['3001/tcp']?.some(binding=>binding.HostIp!=='127.0.0.1'||binding.HostPort!=='5035'))throw Error('Proxy existente fora do loopback previsto.');
}
const proxyExisting=spawnSync('docker',['inspect',proxyName],{cwd:root,encoding:'utf8'});
if(proxyExisting.status===0){
  if(JSON.parse(proxyExisting.stdout)[0].Config.Labels?.['waia.preview']!=='v2-local')throw Error('Proxy existente não pertence a este preview.');
  run(['stop','--timeout','10',proxyName]);run(['rm',proxyName]);
}
run(['run','-d','--name',proxyName,'--label','com.docker.compose.project=waia-test','--label','waia.preview=v2-local',
  '--network','bridge','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges',
  '-p','127.0.0.1:5035:3001',imageMetadata.Id,'node','scripts/v2-preview-proxy.mjs']);
run(['network','connect','waia-test_v2_internal',proxyName]);
const proxyNetworks=JSON.parse(run(['inspect',proxyName],true))[0].NetworkSettings.Networks;
const proxyAddress=proxyNetworks['waia-test_v2_internal'].IPAddress;
const loopbackGateway=proxyNetworks.bridge.Gateway;
if(!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(loopbackGateway))throw Error('Gateway local IPv4 não identificado.');
const keyring=JSON.stringify({activeVersion:'1',keys:{'1':Buffer.from(values.V2_MASTER_KEY,'hex').toString('base64')}});
const previewFile=path.join(secretDir,'v2-preview.env');
writeFileSync(previewFile,[`NODE_ENV=development`,'INFRASTRUCTURE_MODE=postgres',
  `DATABASE_URL=postgres://waia_v2_app:${encodeURIComponent(values.V2_APP_PASSWORD)}@v2-postgres:5432/waia_v2_app`,
  'REDIS_URL=redis://v2-redis:6379/0','REDIS_QUEUE_NAME=waia-v2-synthetic',
  `MASTER_KEYRING=${keyring}`,`SESSION_PEPPER=${values.V2_SESSION_PEPPER}`,
  'MEDIA_STORAGE_ROOT=/app/.data/media','CUSTOMER_ACCOUNTS_ENABLED=true','ACCOUNT_EMAIL_MODE=fake',
  'CUSTOMER_PORTAL_ORIGIN=http://127.0.0.1:5035','PANEL_ORIGIN=http://127.0.0.1:5035',
  'COOKIE_SECURE=false',`TRUST_PROXY=${proxyAddress}/32`,
  `ADMIN_NETWORK_ALLOWLIST=127.0.0.1/32,::1,${loopbackGateway}/32`,'LOG_LEVEL=error',
].join('\n')+'\n',{mode:0o600});
run(['run','--rm','--network','waia-test_v2_internal','--env-file',path.join(secretDir,'v2-test.env'),'--env-file',bootstrapFile,
  imageMetadata.Id,'node','scripts/v2-bootstrap-admin.mjs']);
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
  imageMetadata.Id,'node','scripts/v2-preview-api.mjs']);
let ready=false;
for(let n=0;n<30;n++){
  try{const result=await fetch('http://127.0.0.1:5035/health/ready',{signal:AbortSignal.timeout(3000)});if(result.ok){ready=true;break;}}catch{}
  await new Promise(resolve=>setTimeout(resolve,1000));
}
if(!ready)throw Error('Preview iniciado, mas health ainda não confirmou prontidão.');
console.log(JSON.stringify({status:'ready',version,imageId:imageMetadata.Id,portal:'http://127.0.0.1:5035/',panel:'http://127.0.0.1:5035/panel/',externalConnections:false}));
