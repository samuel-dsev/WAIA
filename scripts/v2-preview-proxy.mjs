import {createServer,request} from 'node:http';
// Fixed upstream only. No credentials, database access, target URL or redirects.
const server=createServer((req,res)=>{
  if(!req.url?.startsWith('/')||req.url.startsWith('//')){res.writeHead(400);res.end();return;}
  const upstream=request({hostname:'waia-test-v2-preview',port:3001,path:req.url,method:req.method,
    headers:{...req.headers,connection:'close'},timeout:30000},response=>{
    res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });
  upstream.on('timeout',()=>upstream.destroy());
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Preview temporariamente indisponível.');});
  req.pipe(upstream);
});
server.listen(3001,'0.0.0.0');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
