import express from "express";
import { AuthError, AuthenticationRequiredError, AuthorizationDeniedError } from "./errors.js";
import { authErrorResponse, publicPrincipal } from "./auth-service.js";
import { requirePermission } from "./permissions.js";

export const SESSION_COOKIE = "waia_session";
export const CSRF_COOKIE = "waia_csrf";

function cookies(header = "") {
  return Object.fromEntries(String(header).split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    if (index <= 0) return null;
    try {
      return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
    } catch {
      return null;
    }
  }).filter(Boolean));
}

function sessionToken(request) { return cookies(request.headers.cookie)[SESSION_COOKIE] || null; }

export function sessionCookieOptions({ secure = false, maxAgeMs = 12 * 60 * 60_000 } = {}) {
  return { httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: maxAgeMs };
}

export function createAuthMiddleware({ authService }) {
  return async function authenticate(request, _response, next) {
    try {
      request.auth = await authService.authenticate(sessionToken(request));
      next();
    } catch (error) { next(error); }
  };
}

export function requireCsrf({ authService }) {
  return function csrf(request, _response, next) {
    const token = sessionToken(request);
    const csrfToken = request.get("x-csrf-token");
    if (!token || !authService.verifyCsrf({ sessionToken: token, csrfToken })) return next(new AuthorizationDeniedError());
    next();
  };
}

export function authorize(permission, { empresaParam = "empresaId" } = {}) {
  return function authorization(request, _response, next) {
    try {
      requirePermission(request.auth, permission, request.params[empresaParam]);
      next();
    } catch (error) { next(error); }
  };
}

export function createAuthRouter({ authService, secureCookies = false, sessionTtlMs = 12 * 60 * 60_000 } = {}) {
  const router = express.Router();
  const cookieOptions = sessionCookieOptions({ secure: secureCookies, maxAgeMs: sessionTtlMs });
  const authenticate = createAuthMiddleware({ authService });
  const csrf = requireCsrf({ authService });
  router.post("/login", async (request, response, next) => {
    try {
      const result = await authService.login({
        email: request.body?.email,
        password: request.body?.password,
        ip: request.ip,
        userAgent: request.get("user-agent"),
        existingSessionToken: sessionToken(request),
      });
      response.cookie(SESSION_COOKIE, result.credentials.sessionToken, cookieOptions);
      response.cookie(CSRF_COOKIE, result.credentials.csrfToken, { ...cookieOptions, httpOnly: false });
      response.status(200).json({ ...publicPrincipal(result.principal), csrfToken: result.credentials.csrfToken });
    } catch (error) { next(error); }
  });
  router.get("/session", authenticate, (request, response) => response.json(publicPrincipal(request.auth)));
  router.post("/logout", authenticate, csrf, async (request, response, next) => {
    try {
      await authService.logout({ sessionId: request.auth.sessionId, userId: request.auth.user.id, ip: request.ip });
      response.clearCookie(SESSION_COOKIE, cookieOptions);
      response.clearCookie(CSRF_COOKIE, { ...cookieOptions, httpOnly: false });
      response.sendStatus(204);
    } catch (error) { next(error); }
  });
  return router;
}

export function authErrorMiddleware(error, _request, response, next) {
  if (!(error instanceof AuthError)) return next(error);
  response.status(error.status).json(authErrorResponse(error));
}

export function requireAuthentication(request, _response, next) {
  if (!request.auth) return next(new AuthenticationRequiredError());
  next();
}
