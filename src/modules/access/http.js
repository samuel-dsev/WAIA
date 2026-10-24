import express from 'express';

export function createAccessRouter({ service }) {
  const router=express.Router();
  router.use((_req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
  const action=(fn,status=200)=>async(req,res,next)=>{try{res.status(status).json(await fn(req));}catch(error){next(error);}};
  const key=req=>req.get('idempotency-key');
  const meta=req=>({correlationId:req.context?.correlationId});
  router.get('/',action(req=>service.list(req.auth,req.query)));
  router.post('/',action(req=>service.create(req.auth,req.body,key(req),meta(req)),201));
  router.get('/:id',action(req=>service.get(req.auth,req.params.id)));
  router.patch('/:id',action(req=>service.setStatus(req.auth,req.params.id,req.body,key(req),meta(req))));
  router.put('/:id/companies/:empresaId',action(req=>service.putCompany(req.auth,req.params.id,req.params.empresaId,req.body,key(req),meta(req))));
  router.delete('/:id/companies/:empresaId',action(req=>service.removeCompany(req.auth,req.params.id,req.params.empresaId,req.body,key(req),meta(req))));
  for(const [path,method] of [['activation','activation'],['reset','reset'],['revoke-sessions','revokeSessions']]) {
    router.post(`/:id/${path}`,action(req=>service[method](req.auth,req.params.id,req.body,key(req),meta(req))));
  }
  router.use((error,_req,res,_next)=>{
    if(Number.isInteger(error.status)&&error.status>=400&&error.status<500&&/^[A-Z][A-Z_]+$/.test(error.code||'')) {
      return res.status(error.status).json({error:{code:error.code,message:error.message}});
    }
    res.status(503).json({error:{code:'ACCESS_UNAVAILABLE',message:'Não foi possível concluir a operação. Tente novamente.'}});
  });
  return router;
}
