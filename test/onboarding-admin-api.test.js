import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import { createAdminRouter } from "../src/modules/admin/router.js";

const auth = { user: { id: "admin-a" }, platformRole: "platform_admin", memberships: [] };
const correlationId = "00000000-0000-4000-8000-000000000301";

async function request(app, path, options = {}) {
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    return await fetch(`http://127.0.0.1:${port}${path}`, options);
  } finally {
    server.close();
  }
}

function api(service, calls) {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.context = { correlationId };
    next();
  });
  app.use("/api/admin", createAdminRouter({
    adminService: service,
    authenticate(request, _response, next) {
      request.auth = auth;
      next();
    },
    csrf(request, _response, next) {
      calls.push(["csrf", request.method, request.path]);
      next();
    },
  }));
  return app;
}

test("rotas da Fase 3 mantêm contratos específicos antes do CRUD genérico", async () => {
  const calls = [];
  const service = Object.fromEntries([
    ["getOnboarding", { revision: 1 }],
    ["saveOnboardingStep", { revision: 2 }],
    ["getActionCatalog", { schemaVersion: 2 }],
    ["readConfigurationDraft", { draftVersion: 1 }],
    ["saveConfigurationDraft", { draftVersion: 2 }],
    ["validateConfiguration", { ready: true, checks: [] }],
    ["publishConfiguration", { configVersion: 2 }],
    ["configurationReadiness", { ready: true, checks: [] }],
    ["activateTenant", { status: "active", configVersion: 2 }],
  ].map(([name, result]) => [name, async (input) => {
    calls.push([name, input]);
    return result;
  }]));
  const app = api(service, calls);
  const json = { "content-type": "application/json" };
  const requests = [
    ["GET", "/api/admin/tenants/tenant-a/onboarding", undefined, 200],
    ["PATCH", "/api/admin/tenants/tenant-a/onboarding/4", {
      revision: 1,
      completedSteps: [{ step: 3, completedAt: "2026-09-01T12:00:00.000Z" }],
    }, 200],
    ["GET", "/api/admin/tenants/tenant-a/action-catalog", undefined, 200],
    ["GET", "/api/admin/tenants/tenant-a/configuration/draft", undefined, 200],
    ["PUT", "/api/admin/tenants/tenant-a/configuration/draft", { draftVersion: 1, configuration: { schemaVersion: 2 } }, 200],
    ["POST", "/api/admin/tenants/tenant-a/configuration/validate", {}, 200],
    ["POST", "/api/admin/tenants/tenant-a/configuration/publish", { draftVersion: 2 }, 201],
    ["GET", "/api/admin/tenants/tenant-a/readiness", undefined, 200],
    ["POST", "/api/admin/tenants/tenant-a/activate", { draftVersion: 2 }, 200],
  ];
  for (const [method, path, body, status] of requests) {
    const response = await request(app, path, {
      method,
      headers: body === undefined ? undefined : json,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, status, `${method} ${path}`);
  }
  const savedStep = calls.find(([name]) => name === "saveOnboardingStep")[1];
  assert.equal(savedStep.step, "4");
  assert.equal(savedStep.correlationId, correlationId);
  const activation = calls.find(([name]) => name === "activateTenant")[1];
  assert.deepEqual(activation.body, { draftVersion: 2 });
  assert.equal(calls.filter(([name]) => name === "csrf").length, 5);
});
