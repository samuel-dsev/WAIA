import {createServer,request} from 'node:http';
// Fixed upstream only. No credentials, database access, target URL or redirects.
const server=createServer((req,res)=>{
  if(req.headers.host!=='127.0.0.1:5035'||!req.url?.startsWith('/')||req.url.startsWith('//')){res.writeHead(400);res.end();return;}
  const headers={...req.headers,connection:'close'};
  for(const key of Object.keys(headers))if(/^(?:forwarded|x-forwarded-.*|x-real-ip|x-original-url|x-rewrite-url)$/i.test(key))delete headers[key];
  headers['x-forwarded-for']=req.socket.remoteAddress;
  headers['x-forwarded-proto']='http';
  const upstream=request({hostname:'waia-test-v2-preview',port:3001,path:req.url,method:req.method,
    headers,timeout:30000},response=>{
    res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });
  upstream.on('timeout',()=>upstream.destroy());
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Preview temporariamente indisponível.');});
  req.pipe(upstream);
});
server.listen(3001,'0.0.0.0');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
