import express from 'express';
import { AccountError } from '../accounts/errors.js';

export function createFollowUpRouter({ repository, customer = false }) {
  if (customer) throw new TypeError('Follow-up estável exige painel administrativo.');
  const router = express.Router();
  const base = customer ? '/companies/:empresaId' : '/tenants/:empresaId';
  const route = fn => async (req, res, next) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      res.json(await fn(req));
    } catch (e) { next(e); }
  };
  const auth = req => customer ? req.customer : req.auth;
  router.get(`${base}/follow-up`, route(req => repository.read(auth(req), req.params.empresaId)));
  router.put(`${base}/follow-up`, route(req => repository.saveSettings(auth(req), req.params.empresaId, req.body)));
  router.get(`${base}/conversations/:id/follow-up`, route(req => repository.read(auth(req), req.params.empresaId, req.params.id)));
  router.put(`${base}/conversations/:id/follow-up`, route(req => repository.toggle(auth(req), req.params.empresaId, req.params.id, req.body)));
  router.use((error, _req, res, next) => {
    if (!(error instanceof AccountError)) return next(error);
    res.status(error.status).json({ code: error.code, message: error.message });
  });
  return router;
}
