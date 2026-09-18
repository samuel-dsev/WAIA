import express from 'express';
import { AccountError } from './errors.js';

export const CUSTOMER_COOKIE = 'waia_customer_session';
function token(request) {
  const part = String(request.headers.cookie || '').split(';').map((p) => p.trim()).find((p) => p.startsWith(`${CUSTOMER_COOKIE}=`));
  return part?.slice(CUSTOMER_COOKIE.length + 1) || null;
}
const route = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

export function createAccountRouter({ service, secure = true }) {
  const router = express.Router();
  const options = { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: service.sessionMs };
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.get('origin') !== service.origin) {
      return next(new AccountError('ORIGIN_DENIED', 403, 'Origem da solicitação inválida.'));
    }
    next();
  });
  router.post('/register', route(async (req, res) => res.status(202).json(await service.register(req.body, req.ip))));
  router.post('/email/resend', route(async (req, res) => res.status(202).json(await service.requestToken(req.body, 'verify', req.ip))));
  router.post('/password/forgot', route(async (req, res) => res.status(202).json(await service.requestToken(req.body, 'reset', req.ip))));
  router.post('/email/verify', route(async (req, res) => { await service.verify(req.body, req.ip); res.sendStatus(204); }));
  router.post('/password/reset', route(async (req, res) => { await service.reset(req.body, req.ip); res.clearCookie(CUSTOMER_COOKIE, options); res.sendStatus(204); }));
  router.post('/login', route(async (req, res) => {
    const result = await service.login(req.body, req.ip, token(req));
    res.cookie(CUSTOMER_COOKIE, result.token, options).json({ user: result.user, csrfToken: result.csrfToken });
  }));
  router.use(async (req, _res, next) => {
    try {
      req.customer = await service.authenticate(token(req));
      if (!['GET','HEAD','OPTIONS'].includes(req.method) && !service.codec.verifyCsrf(token(req), req.get('x-csrf-token'))) {
        throw new AccountError('CSRF_DENIED', 403, 'Atualize a página e tente novamente.');
      }
      next();
    } catch (e) { next(e); }
  });
  router.get('/session', route(async (req, res) => res.json({ user: req.customer.user, csrfToken: service.codec.csrf(token(req)) })));
  router.post('/logout', route(async (req, res) => { await service.logout(req.customer); res.clearCookie(CUSTOMER_COOKIE, options); res.sendStatus(204); }));
  router.patch('/profile', route(async (req, res) => res.json({ user: await service.profile(req.customer, req.body) })));
  router.post('/password/change', route(async (req, res) => {
    await service.rate('password-change', req.customer.user.id, req.ip, 5);
    await service.changePassword(req.customer, req.body); res.clearCookie(CUSTOMER_COOKIE, options); res.sendStatus(204);
  }));
  router.use(accountErrors);
  return router;
}

export function createCustomerRouter({ service }) {
  const router = express.Router();
  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      req.customer = await service.authenticate(token(req));
      if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
        if (req.get('origin') !== service.origin || !service.codec.verifyCsrf(token(req), req.get('x-csrf-token'))) {
          throw new AccountError('CSRF_DENIED', 403, 'Atualize a página e tente novamente.');
        }
      }
      next();
    } catch (e) { next(e); }
  });
  router.get('/companies', route(async (req, res) => res.json({ companies: await service.companies(req.customer) })));
  router.get('/companies/:empresaId', route(async (req, res) => res.json(await service.company(req.customer, req.params.empresaId))));
  router.post('/companies', route(async (req, res) => {
    await service.rate('company-create', req.customer.user.id, req.ip, 20);
    res.status(201).json(await service.createCompany(req.customer, req.body, req.get('idempotency-key')));
  }));
  router.use(accountErrors);
  return router;
}
function accountErrors(error, req, res, _next) {
  const known = error instanceof AccountError;
  if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
  res.status(known ? error.status : 503).json({ code: known ? error.code : 'ACCOUNT_UNAVAILABLE',
    message: known ? error.message : 'Serviço temporariamente indisponível. Tente novamente.', correlationId: req.context?.correlationId });
}
