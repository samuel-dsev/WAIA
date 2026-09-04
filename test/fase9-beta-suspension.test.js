import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  compileTenantRuntimeConfigV2,
  VersionedConfigurationService,
} from "../src/modules/configuration/index.js";
import {
  AdminService,
  MemoryAdminRepository,
  adminErrorMiddleware,
  createAdminRouter,
} from "../src/modules/admin/index.js";
import {
  OnboardingService,
  PreviewService,
} from "../src/modules/onboarding/index.js";
import { createWebhookIngestionService } from "../src/modules/webhook/ingestion-service.js";

const CAPITAO_ID = "00000000-0000-4000-8000-000000000801";
const CAPITAO_PHONE_ID = "phone-capitao-fase9";
const BETA_PHONE_ID = "phone-beta-fase9";
const FIXED_NOW = new Date("2026-09-03T18:00:00.000Z");

const clone = (value) => value == null ? value : structuredClone(value);

function idSequence(start = 900) {
  let current = start;
  return () => `00000000-0000-4000-8000-${String(current += 1).padStart(12, "0")}`;
}

function betaConfiguration() {
  return {
    schemaVersion: 2,
    identity: {
      name: "Empresa Beta Sintética",
      displayName: "Beta Sintética",
      publicIdentity: "Atendimento sintético para validação isolada.",
      segment: "serviços",
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
      welcomeMessage: "Olá! Este é o atendimento da Beta Sintética.",
      fallbackMessage: "Escolha uma opção do menu.",
      publicRules: ["Ambiente exclusivamente sintético."],
    },
    retention: { messagesDays: 30, logsDays: 30 },
    modules: ["appointments", "ai_freeform", "flows"],
    menu: {
      text: "Como podemos ajudar?",
      options: [
        { id: "agendar", label: "Agendar", action: "appointments.start", params: {} },
        { id: "triagem", label: "Iniciar triagem", action: "flows.start", params: { flowRef: "flow:triagem_beta" } },
      ],
    },
    routing: {
      greetings: ["oi", "olá"],
      aliases: [{ terms: ["triagem"], action: "flows.start", params: { flowRef: "flow:triagem_beta" } }],
      fallbackAction: "ai_freeform.reply",
    },
    publicReplies: [{ action: "appointments.start", text: "Selecione um serviço e horário." }],
    appointments: {
      services: [{
        id: "consulta_beta",
        name: "Consulta sintética",
        active: true,
        slots: [{
          id: "slot_beta_09",
          label: "Segunda às 09h",
          startsAt: "2026-09-07T09:00:00-03:00",
          available: true,
        }],
      }],
    },
    ai: {
      enabled: true,
      provider: "simulated",
      model: "waia-synthetic-model",
      personality: "Objetiva e cordial.",
      prompt: "Use somente as informações públicas desta configuração sintética.",
      keyMode: "simulated",
      fallbackMessage: "A IA simulada não encontrou uma resposta.",
    },
    flows: {
      definitions: [{
        key: "triagem_beta",
        name: "Triagem Beta",
        version: 1,
        startStepId: "nome",
        steps: [
          { id: "nome", type: "name", field: "nome", required: true, message: "Qual é o seu nome?", nextStepId: "fim" },
          { id: "fim", type: "completion", message: "Triagem sintética concluída." },
        ],
      }],
    },
    integrations: [],
  };
}

class Phase9Repository extends MemoryAdminRepository {
  constructor() {
    super({
      environment: "test",
      tenants: [{
        id: CAPITAO_ID,
        empresaId: CAPITAO_ID,
        slug: "capitao-mor-demo",
        name: "Capitão Mor",
        displayName: "Capitão Mor",
        status: "active",
        runtimeMode: "legado",
        configurationVersion: 1,
        activeConfigurationVersion: 1,
      }],
    });
    this.drafts = new Map();
    this.draftAudits = [];
    this.publishedRevisions = [];
    this.publicationAudits = [];
    this.activationAudits = [];
    this.flowPublications = [];
  }

  async createTenant(input) {
    return super.createTenant({
      ...input,
      empresaId: input.id,
      runtimeMode: "versionado",
      configurationVersion: 1,
      activeConfigurationVersion: null,
    });
  }

  async readDraft({ empresaId }) {
    return clone(this.drafts.get(empresaId) || null);
  }

  async saveDraftAtomic(input) {
    const current = this.drafts.get(input.empresaId);
    const currentDraftVersion = current?.draftVersion || 0;
    if (currentDraftVersion !== input.expectedDraftVersion) {
      return { saved: false, draft: null, currentDraftVersion };
    }
    const draft = {
      empresaId: input.empresaId,
      draftVersion: currentDraftVersion + 1,
      schemaVersion: input.schemaVersion,
      configuration: clone(input.configuration),
      updatedBy: input.actorId,
      updatedAt: input.occurredAt,
    };
    this.drafts.set(input.empresaId, draft);
    this.draftAudits.push({
      auditId: input.auditId,
      empresaId: input.empresaId,
      actorId: input.actorId,
      correlationId: input.correlationId,
      draftVersion: draft.draftVersion,
    });
    return { saved: true, draft: clone(draft), currentDraftVersion: draft.draftVersion };
  }

  async readProgress({ empresaId }) {
    return this.tenants.has(empresaId) ? null : null;
  }

  async saveProgressAtomic() {
    throw new Error("O progresso não faz parte desta suíte focada.");
  }

  async readReadinessSnapshot({ empresaId }) {
    const tenant = await this.getTenant({ empresaId });
    if (!tenant) return null;
    const users = await this.list({ resource: "users", empresaId, limit: Number.MAX_SAFE_INTEGER });
    return {
      tenant,
      draftVersion: this.drafts.get(empresaId)?.draftVersion || 0,
      nextConfigurationVersion: Math.max(
        Number(tenant.configurationVersion || 1),
        Number(tenant.activeConfigurationVersion || 0),
      ) + 1,
      administratorCount: users.items.filter((user) => user.role === "tenant_admin" && user.status === "active").length,
      whatsapp: {
        primaryNumber: {
          primary: true,
          status: "ativo",
          phoneNumberId: BETA_PHONE_ID,
          wabaId: "waba-beta-synthetic",
          numeroE164: "+5511999999909",
        },
        accessTokenConfigured: true,
        applicationValid: true,
      },
      credentialReferences: [],
      credentials: [],
      integrations: [],
      environment: "test",
    };
  }

  async readPreflightTargets({ empresaId }) {
    return {
      meta: {
        empresaId,
        applicationId: "meta-app-beta-synthetic",
        numberId: "number-beta-synthetic",
      },
    };
  }

  async withActivationTransaction(_context, callback) {
    return callback(Object.freeze({ kind: "phase9-activation-transaction" }));
  }

  async withPublicationTransaction(context, callback) {
    return this.withActivationTransaction(context, callback);
  }

  async lockActivationState({ empresaId }) {
    return {
      tenant: await this.getTenant({ empresaId }),
      draft: await this.readDraft({ empresaId }),
    };
  }

  async lockPublicationState(input) {
    return this.lockActivationState(input);
  }

  async insertPublishedRevision({ empresaId, compiled, actorId, publishedAt }) {
    const revision = { empresaId, compiled: clone(compiled), actorId, publishedAt };
    this.publishedRevisions.push(revision);
    return clone(revision);
  }

  async setActiveRevision({ empresaId, configVersion, publishedAt }) {
    return this.updateTenant({
      empresaId,
      changes: {
        runtimeMode: "versionado",
        configurationVersion: configVersion,
        activeConfigurationVersion: configVersion,
        publishedAt: publishedAt.toISOString(),
      },
    });
  }

  async activatePublishedRevision(input) {
    return this.setActiveRevision(input);
  }

  async setTenantActive({ empresaId, configVersion, activatedAt }) {
    return this.updateTenant({
      empresaId,
      changes: {
        status: "active",
        configurationVersion: configVersion,
        activeConfigurationVersion: configVersion,
        publishedAt: activatedAt.toISOString(),
      },
    });
  }

  async writePublicationAudit(input) {
    this.publicationAudits.push(clone(input));
  }

  async writeActivationAudit(input) {
    this.activationAudits.push(clone(input));
  }
}

function createMetaSimulation() {
  const applications = new Map();
  return {
    applications,
    repository: {
      async listApps({ empresaId }) {
        return [...applications.values()].filter((app) => app.empresaId === empresaId).map(clone);
      },
      async createApp(input) {
        const record = {
          id: "meta-app-beta-synthetic",
          empresaId: input.empresaId,
          name: input.name,
          appId: input.metaAppId,
          mode: input.mode,
          webhookPublicId: "beta-webhook-public-synthetic",
          state: "pending",
          revision: 1,
        };
        applications.set(record.id, record);
        return clone(record);
      },
      async bindNumber(input) {
        const application = applications.get(input.metaAppId);
        assert.equal(application?.empresaId, input.empresaId);
        return {
          empresaId: input.empresaId,
          numberId: input.numberId,
          applicationId: input.metaAppId,
          accessTokenCredentialId: input.accessTokenCredentialId,
          bindingRevision: 1,
          status: "active",
        };
      },
    },
    health: {
      async run(input) {
        const application = applications.get(input.appId);
        assert.equal(application?.empresaId, input.empresaId);
        application.state = "active";
        application.revision += 1;
        return {
          empresaId: input.empresaId,
          applicationId: input.appId,
          numberId: input.numberId,
          success: true,
          state: "active",
          code: "META_SIMULATED_OK",
          message: "Meta validada em modo sintético.",
          testedAt: FIXED_NOW.toISOString(),
        };
      },
    },
  };
}

function createApiFixture() {
  const repository = new Phase9Repository();
  const nextId = idSequence();
  const clock = () => new Date(FIXED_NOW);
  const configurationService = new VersionedConfigurationService(repository, {
    compiler: compileTenantRuntimeConfigV2,
    idGenerator: nextId,
    clock,
  });
  const readinessService = {
    evaluations: [],
    async evaluate(input) {
      this.evaluations.push(clone(input));
      return { ready: true, mode: "enforcement", blockingCount: 0, checks: [] };
    },
  };
  const preflightService = {
    calls: [],
    async run(input) {
      this.calls.push(clone(input));
      return {
        authoritativeGate: "readiness",
        testedAt: FIXED_NOW.toISOString(),
        completedAt: FIXED_NOW.toISOString(),
        summary: { total: 1, passedCount: 1, failedCount: 0 },
        checks: [{
          code: "META_SIMULATED",
          state: "passed",
          message: "A conexão Meta sintética está pronta.",
        }],
      };
    },
  };
  const onboardingService = new OnboardingService({
    repository,
    configurationService,
    readinessService,
    previewService: new PreviewService(),
    preflightService,
    flowPublisher: {
      async publishDefinitions(input) {
        repository.flowPublications.push(clone(input));
      },
    },
    compiler: compileTenantRuntimeConfigV2,
    idGenerator: nextId,
    clock,
  });
  const meta = createMetaSimulation();
  const adminService = new AdminService({
    repository,
    onboardingService,
    metaAppRepository: meta.repository,
    metaHealthService: meta.health,
    idGenerator: nextId,
    clock,
  });
  let betaId = null;
  const authFor = (role) => {
    if (role === "platform") return { user: { id: "platform-phase9" }, platformRole: "platform_admin", memberships: [] };
    if (!betaId) throw new Error("A Beta precisa existir antes da autenticação tenant-scoped.");
    if (role === "beta-admin") {
      return { user: { id: "beta-admin-phase9" }, memberships: [{ empresaId: betaId, role: "tenant_admin", permissions: [] }] };
    }
    return {
      user: { id: "beta-operator-phase9" },
      memberships: [{
        empresaId: betaId,
        role: "tenant_operator",
        permissions: ["appointments.read", "appointments.update"],
      }],
    };
  };
  const csrfCalls = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.context = { correlationId: "00000000-0000-4000-8000-000000000899" };
    next();
  });
  app.use("/api/admin", createAdminRouter({
    adminService,
    authenticate(request, _response, next) {
      request.auth = authFor(request.headers["x-test-auth"] || "platform");
      next();
    },
    csrf(request, _response, next) {
      csrfCalls.push(`${request.method} ${request.path}`);
      next();
    },
  }));
  app.use(adminErrorMiddleware);
  return {
    app,
    repository,
    meta,
    preflightService,
    readinessService,
    csrfCalls,
    setBetaId(value) { betaId = value; },
  };
}

async function startApi(app) {
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    async call(path, { method = "GET", auth = "platform", body } = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          "x-test-auth": auth,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json();
      return { status: response.status, payload };
    },
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

function createIsolatedWebhook(repository, betaId) {
  const inserted = [];
  const jobs = [];
  const seen = new Set();
  const service = createWebhookIngestionService({
    tenantResolver: {
      async resolveByPhoneNumberId(phoneNumberId) {
        const empresaId = phoneNumberId === CAPITAO_PHONE_ID ? CAPITAO_ID : betaId;
        const tenant = await repository.getTenant({ empresaId });
        return tenant && {
          empresaId,
          numeroWhatsappId: `number:${phoneNumberId}`,
          status: tenant.status,
          numberStatus: "active",
        };
      },
    },
    repository: {
      async withTenantTransaction(tenant, callback) {
        return callback({ empresaId: tenant.empresaId });
      },
      async insertInboundMessage(_transaction, input) {
        const key = `${input.empresaId}:${input.event.externalMessageId}`;
        if (seen.has(key)) return { inserted: false, messageId: `existing:${key}` };
        seen.add(key);
        inserted.push(clone(input));
        return { inserted: true, messageId: `message:${key}`, conversationId: `conversation:${input.empresaId}` };
      },
      async insertStatusEvent() {
        throw new Error("Status não é exercitado nesta suíte.");
      },
    },
    outbox: {
      async add(_transaction, job) {
        jobs.push(clone(job));
      },
    },
    logger: { info() {}, warn() {} },
  });
  return { service, inserted, jobs };
}

function inbound(phoneNumberId, externalMessageId) {
  return {
    kind: "message",
    phoneNumberId,
    externalMessageId,
    idempotencyKey: externalMessageId,
  };
}

test("Beta é publicada, ativada e suspensa pelas rotas do painel sem afetar o Capitão Mor", async () => {
  const fixture = createApiFixture();
  const api = await startApi(fixture.app);
  try {
    const created = await api.call("/api/admin/tenants", {
      method: "POST",
      body: {
        slug: "empresa-beta-sintetica",
        name: "Empresa Beta Sintética",
        displayName: "Beta Sintética",
        identity: "Atendimento sintético",
        timezone: "America/Sao_Paulo",
        locale: "pt-BR",
        messageRetentionDays: 30,
        logRetentionDays: 30,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.payload.status, "draft");
    const betaId = created.payload.id;
    fixture.setBetaId(betaId);

    const admin = await api.call(`/api/admin/tenants/${betaId}/users`, {
      method: "POST",
      body: {
        email: "admin.beta@example.test",
        name: "Admin Beta",
        role: "tenant_admin",
        status: "active",
        initialPassword: "senha-sintetica-admin",
        permissions: ["appointments.read", "appointments.update"],
      },
    });
    assert.equal(admin.status, 201);
    assert.equal(admin.payload.role, "tenant_admin");
    assert.equal(admin.payload.initialPassword, "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(admin.payload), /senha-sintetica-admin/u);

    const operator = await api.call(`/api/admin/tenants/${betaId}/users`, {
      method: "POST",
      auth: "beta-admin",
      body: {
        email: "operador.beta@example.test",
        name: "Operador Beta",
        role: "tenant_operator",
        status: "active",
        initialPassword: "senha-sintetica-operador",
        permissions: ["appointments.read", "appointments.update"],
      },
    });
    assert.equal(operator.status, 201);
    assert.equal(operator.payload.role, "tenant_operator");

    const draft = await api.call(`/api/admin/tenants/${betaId}/configuration/draft`, {
      method: "PUT",
      auth: "beta-admin",
      body: { draftVersion: 0, configuration: betaConfiguration() },
    });
    assert.equal(draft.status, 200);
    assert.equal(draft.payload.draftVersion, 1);
    assert.deepEqual(draft.payload.configuration.modules, ["appointments", "ai_freeform", "flows"]);

    const forbiddenDraft = await api.call(`/api/admin/tenants/${betaId}/configuration/draft`, {
      method: "PUT",
      auth: "beta-operator",
      body: { draftVersion: 1, configuration: betaConfiguration() },
    });
    assert.equal(forbiddenDraft.status, 403);
    assert.equal(forbiddenDraft.payload.error.code, "FORBIDDEN");

    const simulator = await api.call(`/api/admin/tenants/${betaId}/simulator/messages`, {
      method: "POST",
      auth: "beta-admin",
      body: { draftVersion: 1, message: { type: "text", text: "pergunta sem alias" } },
    });
    assert.equal(simulator.status, 200, JSON.stringify(simulator.payload));
    assert.equal(simulator.payload.synthetic, true);
    assert.equal(simulator.payload.simulation.ai, "simulated");
    assert.match(simulator.payload.reply.text, /Resposta simulada da IA/u);

    const number = await api.call(`/api/admin/tenants/${betaId}/numbers`, {
      method: "POST",
      auth: "beta-admin",
      body: {
        phoneNumberId: BETA_PHONE_ID,
        wabaId: "waba-beta-synthetic",
        numeroE164: "+5511999999909",
        nomeVerificado: "Beta Sintética",
        status: "ativo",
        principal: true,
      },
    });
    assert.equal(number.status, 201);

    const metaApp = await api.call(`/api/admin/tenants/${betaId}/meta-applications`, {
      method: "POST",
      auth: "beta-admin",
      body: {
        name: "Meta Beta Simulada",
        metaAppId: "external-meta-beta-synthetic",
        mode: "shared",
      },
    });
    assert.equal(metaApp.status, 201);
    assert.equal(metaApp.payload.state, "pending");
    assert.equal(metaApp.payload.webhookPublicId, "beta-webhook-public-synthetic");

    const binding = await api.call(`/api/admin/tenants/${betaId}/numbers/${number.payload.id}/meta-binding`, {
      method: "PUT",
      auth: "beta-admin",
      body: {
        metaAppId: metaApp.payload.id,
        accessTokenCredentialId: "credential:meta-beta-simulated",
        expectedRevision: 0,
      },
    });
    assert.equal(binding.status, 200);
    assert.equal(binding.payload.status, "active");

    const metaPreflight = await api.call(`/api/admin/tenants/${betaId}/meta-applications/${metaApp.payload.id}/preflight`, {
      method: "POST",
      auth: "beta-admin",
      body: { numberId: number.payload.id },
    });
    assert.equal(metaPreflight.status, 200);
    assert.equal(metaPreflight.payload.success, true);
    assert.equal(metaPreflight.payload.code, "META_SIMULATED_OK");

    const preflight = await api.call(`/api/admin/tenants/${betaId}/preflight`, {
      method: "POST",
      auth: "beta-admin",
      body: { draftVersion: 1 },
    });
    assert.equal(preflight.status, 200);
    assert.equal(preflight.payload.state, "passed");
    assert.equal(fixture.preflightService.calls[0].targets.meta.applicationId, "meta-app-beta-synthetic");

    const published = await api.call(`/api/admin/tenants/${betaId}/configuration/publish`, {
      method: "POST",
      auth: "beta-admin",
      body: { draftVersion: 1 },
    });
    assert.equal(published.status, 201);
    assert.equal(published.payload.configVersion, 2);
    assert.equal((await fixture.repository.getTenant({ empresaId: betaId })).status, "draft");

    const activated = await api.call(`/api/admin/tenants/${betaId}/activate`, {
      method: "POST",
      body: { draftVersion: 1 },
    });
    assert.equal(activated.status, 200);
    assert.equal(activated.payload.status, "active");
    assert.equal(activated.payload.configVersion, 3);
    assert.equal(fixture.repository.publishedRevisions.length, 2);
    assert.equal(fixture.repository.flowPublications.length, 2);
    assert.equal(fixture.repository.flowPublications[1].definitions[0].key, "triagem_beta");
    assert.equal(fixture.repository.publicationAudits.length, 2);
    assert.equal(fixture.repository.activationAudits.length, 1);

    const operatorAppointments = await api.call(`/api/admin/tenants/${betaId}/appointments`, {
      auth: "beta-operator",
    });
    assert.equal(operatorAppointments.status, 200);
    assert.deepEqual(operatorAppointments.payload.items, []);

    const webhook = createIsolatedWebhook(fixture.repository, betaId);
    const simultaneous = await webhook.service.ingestEvents([
      inbound(CAPITAO_PHONE_ID, "wamid.phase9.repeated"),
      inbound(BETA_PHONE_ID, "wamid.phase9.repeated"),
    ]);
    assert.deepEqual(simultaneous.map(({ outcome, empresaId }) => [outcome, empresaId]), [
      ["accepted", CAPITAO_ID],
      ["accepted", betaId],
    ]);

    const suspended = await api.call(`/api/admin/tenants/${betaId}/suspend`, { method: "POST" });
    assert.equal(suspended.status, 200);
    assert.equal(suspended.payload.status, "suspended");

    const afterSuspension = await webhook.service.ingestEvents([
      inbound(CAPITAO_PHONE_ID, "wamid.phase9.after-suspension"),
      inbound(BETA_PHONE_ID, "wamid.phase9.after-suspension"),
    ]);
    assert.deepEqual(afterSuspension.map(({ outcome, empresaId }) => [outcome, empresaId]), [
      ["accepted", CAPITAO_ID],
      ["inactive_tenant", betaId],
    ]);
    assert.equal((await fixture.repository.getTenant({ empresaId: CAPITAO_ID })).status, "active");
    assert.equal((await fixture.repository.getTenant({ empresaId: betaId })).status, "suspended");
    assert.deepEqual(webhook.jobs.map(({ empresaId }) => empresaId), [CAPITAO_ID, betaId, CAPITAO_ID]);

    const auditActions = fixture.repository.audit.map(({ action }) => action);
    for (const action of [
      "tenant.create", "users.create", "numbers.create",
      "onboarding.simulator.message", "tenant.suspend",
    ]) {
      assert.ok(auditActions.includes(action), `auditoria ausente: ${action}`);
    }
    assert.equal(fixture.repository.activationAudits[0].empresaId, betaId);
    assert.equal(fixture.repository.activationAudits[0].actorId, "platform-phase9");
    assert.ok(fixture.csrfCalls.some((entry) => entry.endsWith(`/tenants/${betaId}/suspend`)));
    assert.doesNotMatch(JSON.stringify({
      drafts: [...fixture.repository.drafts.values()],
      revisions: fixture.repository.publishedRevisions,
      audit: fixture.repository.audit,
    }), /senha-sintetica|Filaretti/u);
  } finally {
    await api.close();
  }
});
