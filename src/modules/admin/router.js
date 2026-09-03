import express from "express";
import { publicAdminError } from "./errors.js";

const asyncRoute = (handler) => async (request, response, next) => {
  try { await handler(request, response); } catch (error) { next(error); }
};

export function createAdminRouter({ adminService, authenticate, csrf } = {}) {
  const router = express.Router();
  router.use(authenticate);
  router.use((request, _response, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
    return csrf(request, _response, next);
  });
  router.get("/session", (request, response) => response.json(adminService.session(request.auth)));
  router.get("/users/lookup", asyncRoute(async (request, response) => response.json(await adminService.lookupGlobalUser({ auth: request.auth, email: request.query.email }))));
  router.get("/tenants", asyncRoute(async (request, response) => response.json(await adminService.listTenants({ auth: request.auth, query: { ...request.query, limit: request.query.pageSize } }))));
  router.post("/tenants", asyncRoute(async (request, response) => response.status(201).json(await adminService.createTenant({ auth: request.auth, body: request.body }))));
  router.get("/tenants/:empresaId", asyncRoute(async (request, response) => response.json(await adminService.getTenant({ auth: request.auth, empresaId: request.params.empresaId }))));
  router.patch("/tenants/:empresaId", asyncRoute(async (request, response) => response.json(await adminService.updateTenant({ auth: request.auth, empresaId: request.params.empresaId, body: request.body }))));
  router.post("/tenants/:empresaId/suspend", asyncRoute(async (request, response) => response.json(await adminService.suspendTenant({ auth: request.auth, empresaId: request.params.empresaId }))));
  router.get("/tenants/:empresaId/onboarding", asyncRoute(async (request, response) => response.json(await adminService.getOnboarding({ auth: request.auth, empresaId: request.params.empresaId }))));
  router.patch("/tenants/:empresaId/onboarding/:step", asyncRoute(async (request, response) => response.json(await adminService.saveOnboardingStep({
    auth: request.auth,
    empresaId: request.params.empresaId,
    step: request.params.step,
    body: request.body,
    correlationId: request.context?.correlationId,
  }))));
  router.get("/tenants/:empresaId/action-catalog", asyncRoute(async (request, response) => response.json(await adminService.getActionCatalog({ auth: request.auth, empresaId: request.params.empresaId }))));
  router.get("/tenants/:empresaId/configuration/draft", asyncRoute(async (request, response) => response.json(await adminService.readConfigurationDraft({ auth: request.auth, empresaId: request.params.empresaId }))));
  router.put("/tenants/:empresaId/configuration/draft", asyncRoute(async (request, response) => response.json(await adminService.saveConfigurationDraft({
    auth: request.auth,
    empresaId: request.params.empresaId,
    body: request.body,
    correlationId: request.context?.correlationId,
  }))));
  router.post("/tenants/:empresaId/configuration/validate", asyncRoute(async (request, response) => response.json(await adminService.validateConfiguration({ auth: request.auth, empresaId: request.params.empresaId }))));
  router.post("/tenants/:empresaId/configuration/publish", asyncRoute(async (request, response) => response.status(201).json(await adminService.publishConfiguration({
    auth: request.auth,
    empresaId: request.params.empresaId,
    body: request.body,
    correlationId: request.context?.correlationId,
  }))));
  router.get("/tenants/:empresaId/readiness", asyncRoute(async (request, response) => response.json(await adminService.configurationReadiness({ auth: request.auth, empresaId: request.params.empresaId }))));
  router.post("/tenants/:empresaId/activate", asyncRoute(async (request, response) => response.json(await adminService.activateTenant({
    auth: request.auth,
    empresaId: request.params.empresaId,
    body: request.body,
    correlationId: request.context?.correlationId,
  }))));
  router.get("/dashboard", asyncRoute(async (request, response) => response.json(await adminService.globalDashboard({ auth: request.auth, query: request.query }))));
  router.get("/diagnostics", asyncRoute(async (request, response) => response.json(await adminService.diagnostics({ auth: request.auth }))));
  router.get("/tenants/:empresaId/dashboard", asyncRoute(async (request, response) => response.json(await adminService.tenantDashboard({ auth: request.auth, empresaId: request.params.empresaId, query: request.query }))));
  router.get("/tenants/:empresaId/diagnostics", asyncRoute(async (request, response) => response.json(await adminService.diagnostics({ auth: request.auth, empresaId: request.params.empresaId }))));
  router.put("/tenants/:empresaId/modules", asyncRoute(async (request, response) => response.json(await adminService.replaceModules({ auth: request.auth, empresaId: request.params.empresaId, body: request.body }))));
  router.post("/tenants/:empresaId/credentials", asyncRoute(async (request, response) => response.status(201).json(await adminService.createCredential({ auth: request.auth, empresaId: request.params.empresaId, body: request.body, correlationId: request.context?.correlationId }))));
  router.post("/tenants/:empresaId/credentials/:id/rotate", asyncRoute(async (request, response) => response.json(await adminService.rotateCredential({ auth: request.auth, empresaId: request.params.empresaId, credentialId: request.params.id, body: request.body, correlationId: request.context?.correlationId }))));
  router.post("/tenants/:empresaId/credentials/:id/revoke", asyncRoute(async (request, response) => response.json(await adminService.revokeCredential({ auth: request.auth, empresaId: request.params.empresaId, credentialId: request.params.id, correlationId: request.context?.correlationId }))));
  router.get("/tenants/:empresaId/meta-applications", asyncRoute(async (request, response) => response.json(await adminService.listMetaApplications({ auth: request.auth, empresaId: request.params.empresaId }))));
  router.post("/tenants/:empresaId/meta-applications", asyncRoute(async (request, response) => response.status(201).json(await adminService.createMetaApplication({ auth: request.auth, empresaId: request.params.empresaId, body: request.body, correlationId: request.context?.correlationId }))));
  router.patch("/tenants/:empresaId/meta-applications/:appId", asyncRoute(async (request, response) => response.json(await adminService.updateMetaApplication({ auth: request.auth, empresaId: request.params.empresaId, appId: request.params.appId, body: request.body, correlationId: request.context?.correlationId }))));
  router.post("/tenants/:empresaId/meta-applications/:appId/rotate-secret", asyncRoute(async (request, response) => response.json(await adminService.rotateMetaApplicationSecret({ auth: request.auth, empresaId: request.params.empresaId, appId: request.params.appId, body: request.body, correlationId: request.context?.correlationId }))));
  router.post("/tenants/:empresaId/meta-applications/:appId/preflight", asyncRoute(async (request, response) => response.json(await adminService.preflightMetaApplication({ auth: request.auth, empresaId: request.params.empresaId, appId: request.params.appId, body: request.body, correlationId: request.context?.correlationId }))));
  router.put("/tenants/:empresaId/numbers/:numberId/meta-binding", asyncRoute(async (request, response) => response.json(await adminService.bindMetaNumber({ auth: request.auth, empresaId: request.params.empresaId, numberId: request.params.numberId, body: request.body, correlationId: request.context?.correlationId }))));
  router.post("/tenants/:empresaId/integrations/google-sheets/sync", asyncRoute(async (request, response) => response.json(await adminService.syncGoogleSheets({ auth: request.auth, empresaId: request.params.empresaId, correlationId: request.context?.correlationId }))));
  for (const [path, mode] of [["assume", "human"], ["pause", "paused"], ["resume", "bot"]]) {
    router.post(`/tenants/:empresaId/conversations/:id/${path}`, asyncRoute(async (request, response) => response.json(await adminService.setConversationMode({ auth: request.auth, empresaId: request.params.empresaId, conversationId: request.params.id, mode, operatorId: mode === "human" ? request.auth.user.id : null }))));
  }
  router.post("/tenants/:empresaId/conversations/:id/messages", asyncRoute(async (request, response) => response.status(202).json(await adminService.sendHumanMessage({
    auth: request.auth,
    empresaId: request.params.empresaId,
    conversationId: request.params.id,
    body: request.body,
    correlationId: request.context?.correlationId,
  }))));
  router.get("/tenants/:empresaId/failed-jobs", asyncRoute(async (request, response) => response.json(await adminService.listFailedJobs({
    auth: request.auth,
    empresaId: request.params.empresaId,
    query: { ...request.query, limit: request.query.pageSize },
  }))));
  router.get("/tenants/:empresaId/failed-jobs/:id", asyncRoute(async (request, response) => response.json(await adminService.getFailedJob({
    auth: request.auth,
    empresaId: request.params.empresaId,
    failedJobId: request.params.id,
  }))));
  router.post("/tenants/:empresaId/failed-jobs/:id/retry", asyncRoute(async (request, response) => response.status(202).json(await adminService.retryFailedJob({
    auth: request.auth,
    empresaId: request.params.empresaId,
    failedJobId: request.params.id,
    body: request.body,
    correlationId: request.context?.correlationId,
  }))));
  router.post("/tenants/:empresaId/failed-jobs/:id/resolve", asyncRoute(async (request, response) => response.json(await adminService.resolveFailedJob({
    auth: request.auth,
    empresaId: request.params.empresaId,
    failedJobId: request.params.id,
    body: request.body,
    correlationId: request.context?.correlationId,
  }))));
  router.get("/tenants/:empresaId/messages/:id/media", asyncRoute(async (request, response) => {
    const media = await adminService.getMessageMedia({ auth: request.auth, empresaId: request.params.empresaId, messageId: request.params.id });
    const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" })[media.mimeType] || "bin";
    response.set({
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Disposition": `inline; filename="comprovante-${request.params.id}.${extension}"`,
      "Content-Length": String(media.data.length),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": media.mimeType,
      "X-Content-Type-Options": "nosniff",
      "X-Media-SHA256": media.sha256,
    });
    response.send(media.data);
  }));
  router.get("/tenants/:empresaId/:resource", asyncRoute(async (request, response) => response.json(await adminService.list({ auth: request.auth, empresaId: request.params.empresaId, resource: request.params.resource, query: { ...request.query, limit: request.query.pageSize } }))));
  router.post("/tenants/:empresaId/:resource", asyncRoute(async (request, response) => response.status(201).json(await adminService.create({ auth: request.auth, empresaId: request.params.empresaId, resource: request.params.resource, body: request.body }))));
  router.get("/tenants/:empresaId/:resource/:id", asyncRoute(async (request, response) => response.json(await adminService.get({ auth: request.auth, empresaId: request.params.empresaId, resource: request.params.resource, id: request.params.id }))));
  router.patch("/tenants/:empresaId/:resource/:id", asyncRoute(async (request, response) => response.json(await adminService.update({ auth: request.auth, empresaId: request.params.empresaId, resource: request.params.resource, id: request.params.id, body: request.body }))));
  router.delete("/tenants/:empresaId/:resource/:id", asyncRoute(async (request, response) => response.json(await adminService.remove({ auth: request.auth, empresaId: request.params.empresaId, resource: request.params.resource, id: request.params.id }))));
  return router;
}

export function adminErrorMiddleware(error, _request, response, next) {
  if (!error?.status && !/^23/u.test(String(error?.code || ""))) return next(error);
  const { status, body } = publicAdminError(error);
  response.status(status).json(body);
}
