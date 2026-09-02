import test from "node:test";
import assert from "node:assert/strict";
import { compileTenantRuntimeConfigV2 } from "../src/modules/configuration/index.js";
import { OnboardingService } from "../src/modules/onboarding/onboarding-service.js";
import {
  OnboardingRevisionConflictError,
  TenantNotReadyError,
} from "../src/modules/onboarding/onboarding-errors.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000301";
const ACTOR_ID = "00000000-0000-4000-8000-000000000302";

function configuration(name = "Empresa Sintética") {
  return {
    schemaVersion: 2,
    identity: { name },
    modules: ["catalog"],
    menu: {
      text: "Escolha uma opção:",
      options: [{ id: "catalogo", label: "Catálogo", action: "catalog.list", params: {} }],
    },
  };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

class FakeOnboardingRepository {
  constructor() {
    this.progress = null;
    this.draft = {
      empresaId: TENANT_ID,
      draftVersion: 1,
      schemaVersion: 2,
      configuration: configuration(),
    };
    this.tenant = {
      empresaId: TENANT_ID,
      status: "draft",
      runtimeMode: "versionado",
      configurationVersion: 1,
      activeConfigurationVersion: null,
    };
    this.revisions = [];
    this.publicationAudits = [];
    this.activationAudits = [];
    this.events = [];
    this.failActivationAudit = false;
    this.lastActivationInput = null;
    this.lastProgressInput = null;
  }

  async readProgress() {
    return clone(this.progress);
  }

  async saveProgressAtomic(input) {
    this.lastProgressInput = clone(input);
    const { empresaId, expectedRevision, currentStep, completedSteps } = input;
    const current = this.progress?.revision || 0;
    if (current !== expectedRevision) return { saved: false, progress: null, currentRevision: current };
    this.progress = {
      empresaId,
      revision: current + 1,
      currentStep,
      completedSteps: clone(completedSteps),
      updatedAt: new Date("2026-09-01T12:00:00.000Z"),
    };
    return { saved: true, progress: clone(this.progress), currentRevision: this.progress.revision };
  }

  async readReadinessSnapshot() {
    this.events.push("readiness-snapshot");
    if (!this.tenant) return null;
    return {
      tenant: clone(this.tenant),
      draftVersion: this.draft?.draftVersion,
      administratorCount: 1,
      whatsapp: { accessTokenConfigured: true },
    };
  }

  async withActivationTransaction(_context, callback) {
    const snapshot = clone({
      tenant: this.tenant,
      revisions: this.revisions,
      publicationAudits: this.publicationAudits,
      activationAudits: this.activationAudits,
    });
    try {
      return await callback({ fake: true });
    } catch (error) {
      this.tenant = snapshot.tenant;
      this.revisions = snapshot.revisions;
      this.publicationAudits = snapshot.publicationAudits;
      this.activationAudits = snapshot.activationAudits;
      throw error;
    }
  }

  async lockActivationState() {
    this.events.push("lock");
    return { tenant: clone(this.tenant), draft: clone(this.draft) };
  }

  async insertPublishedRevision({ empresaId, compiled, actorId, publishedAt }) {
    this.events.push("revision");
    this.revisions.push({ empresaId, compiled: clone(compiled), actorId, publishedAt });
    return clone(this.revisions.at(-1));
  }

  async setActiveRevision({ configVersion, publishedAt }) {
    this.events.push("active-revision");
    this.tenant = {
      ...this.tenant,
      runtimeMode: "versionado",
      configurationVersion: configVersion,
      activeConfigurationVersion: configVersion,
      publishedAt,
    };
    return clone(this.tenant);
  }

  async setTenantActive(input) {
    this.events.push("tenant-active");
    this.lastActivationInput = clone(input);
    this.tenant = { ...this.tenant, status: "active" };
    return clone(this.tenant);
  }

  async writePublicationAudit(input) {
    this.events.push("publication-audit");
    this.publicationAudits.push(clone(input));
  }

  async writeActivationAudit(input) {
    this.events.push("activation-audit");
    if (this.failActivationAudit) throw new Error("erro interno com detalhe privado");
    this.activationAudits.push(clone(input));
  }
}

class FakeConfigurationService {
  constructor(repository) {
    this.repository = repository;
  }

  async readDraft() {
    return clone(this.repository.draft);
  }

  async saveDraft({ empresaId, configuration: draft, expectedDraftVersion }) {
    const current = this.repository.draft?.draftVersion || 0;
    if (current !== expectedDraftVersion) {
      const error = new Error("conflito");
      error.code = "DRAFT_VERSION_CONFLICT";
      error.status = 409;
      throw error;
    }
    this.repository.draft = {
      empresaId,
      draftVersion: current + 1,
      schemaVersion: 2,
      configuration: clone(draft),
    };
    return clone(this.repository.draft);
  }
}

class FakeReadinessService {
  constructor(repository) {
    this.repository = repository;
    this.result = { ready: true, mode: "enforcement", checks: [] };
    this.inputs = [];
  }

  async evaluate(input) {
    this.repository.events.push("readiness");
    this.inputs.push(clone(input));
    return clone(this.result);
  }
}

function subject({ repository = new FakeOnboardingRepository(), compiler, flowPublisher = null } = {}) {
  const readinessService = new FakeReadinessService(repository);
  const service = new OnboardingService({
    repository,
    configurationService: new FakeConfigurationService(repository),
    readinessService,
    flowPublisher,
    compiler,
    idGenerator: (() => {
      let value = 400;
      return () => `00000000-0000-4000-8000-${String(value += 1).padStart(12, "0")}`;
    })(),
    clock: () => new Date("2026-09-01T15:00:00.000Z"),
  });
  return { service, repository, readinessService };
}

test("publicação materializa versões imutáveis dos fluxos antes de trocar a revisão ativa", async () => {
  const repository = new FakeOnboardingRepository();
  repository.draft.configuration = {
    schemaVersion: 2,
    identity: { name: "Empresa Fluxos" },
    modules: ["flows"],
    menu: {
      text: "Escolha:",
      options: [{ id: "triagem", label: "Triagem", action: "flows.start", params: { flowRef: "flow:triagem" } }],
    },
    flows: {
      definitions: [{
        key: "triagem",
        name: "Triagem",
        version: 1,
        startStepId: "pergunta",
        steps: [
          { id: "pergunta", type: "text", field: "nome", required: true, nextStepId: "fim" },
          { id: "fim", type: "completion", message: "Concluído." },
        ],
      }],
    },
  };
  const calls = [];
  const flowPublisher = {
    async publishDefinitions(input) {
      repository.events.push("flow-versions");
      calls.push(clone(input));
    },
  };
  const { service } = subject({ repository, flowPublisher });

  await service.publish({ empresaId: TENANT_ID, actorId: ACTOR_ID, expectedDraftVersion: 1 });

  assert.deepEqual(repository.events, [
    "lock", "readiness-snapshot", "readiness", "revision", "flow-versions",
    "active-revision", "publication-audit",
  ]);
  assert.equal(calls[0].configVersion, 2);
  assert.equal(calls[0].definitions[0].key, "triagem");
  assert.deepEqual(calls[0].transaction, { fake: true });
});

test("progresso começa em zero, salva etapa auditada com revisão otimista e recusa stale", async () => {
  const { service, repository } = subject();
  assert.deepEqual(await service.getProgress({ empresaId: TENANT_ID }), {
    empresaId: TENANT_ID,
    revision: 0,
    currentStep: 1,
    completedSteps: [],
    updatedAt: null,
  });

  const saved = await service.saveProgressStep({
    empresaId: TENANT_ID,
    actorId: ACTOR_ID,
    expectedRevision: 0,
    currentStep: 2,
    completedSteps: [{ step: 1, completedAt: "2026-09-01T14:00:00-03:00" }],
  });
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.completedSteps, [{ step: 1, completedAt: "2026-09-01T17:00:00.000Z" }]);
  assert.equal(Object.isFrozen(saved.completedSteps), true);
  assert.equal(repository.lastProgressInput.auditId, "00000000-0000-4000-8000-000000000401");
  assert.equal(repository.lastProgressInput.occurredAt.toISOString(), "2026-09-01T15:00:00.000Z");

  await assert.rejects(
    service.saveProgressStep({
      empresaId: TENANT_ID,
      actorId: ACTOR_ID,
      expectedRevision: 0,
      currentStep: 3,
      completedSteps: [],
    }),
    (error) => error instanceof OnboardingRevisionConflictError
      && error.code === "ONBOARDING_REVISION_CONFLICT"
      && error.status === 409
      && error.details.currentRevision === 1,
  );
});

test("progresso ausente só usa defaults quando a empresa existe", async () => {
  const repository = new FakeOnboardingRepository();
  repository.tenant = null;
  const { service } = subject({ repository });
  await assert.rejects(
    service.getProgress({ empresaId: TENANT_ID }),
    (error) => error.code === "TENANT_NOT_FOUND" && error.status === 404,
  );
});

test("draft usa a fronteira segura existente e valida sem devolver configuração", async () => {
  const { service, repository } = subject();
  const read = await service.readDraft({ empresaId: TENANT_ID });
  assert.equal(read.draftVersion, 1);
  assert.equal(Object.isFrozen(read.configuration), true);

  const saved = await service.saveDraft({
    empresaId: TENANT_ID,
    actorId: ACTOR_ID,
    expectedDraftVersion: 1,
    configuration: configuration("Versão dois"),
  });
  assert.equal(saved.draftVersion, 2);
  assert.equal(repository.draft.configuration.identity.name, "Versão dois");

  const valid = await service.validate({ empresaId: TENANT_ID });
  assert.deepEqual(valid, { empresaId: TENANT_ID, valid: true, draftVersion: 2, issues: [] });
  assert.equal(Object.hasOwn(valid, "configuration"), false);

  repository.draft.configuration = { schemaVersion: 2, identity: {}, modules: [], menu: { options: [] } };
  const invalid = await service.validate({ empresaId: TENANT_ID });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.issues.length > 0);
  assert.equal(JSON.stringify(invalid).includes("configuration"), false);
});

test("catálogo retornado é destacado e imutável", () => {
  const { service } = subject();
  const first = service.getActionCatalog();
  const second = service.getActionCatalog();
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.notEqual(first.find(({ key }) => key === "flows").reserved, true);
});

test("readiness devolve somente checks públicos e preserva modo diagnóstico", async () => {
  const { service, readinessService } = subject();
  readinessService.result = {
    ready: true,
    mode: "diagnostic",
    checks: [{
      code: "LEGACY_WARNING",
      state: "warning",
      severity: "warning",
      step: 10,
      message: "Tenant legado permanece ativo.",
      correctiveAction: "Planeje a migração.",
      internalSecret: "não-retornar",
    }],
    snapshot: { token: "não-retornar" },
  };
  const result = await service.readiness({ empresaId: TENANT_ID });
  assert.equal(result.mode, "diagnostic");
  assert.equal(result.ready, true);
  assert.equal(result.checks[0].code, "LEGACY_WARNING");
  assert.equal(JSON.stringify(result).includes("não-retornar"), false);
});

test("tenant ativo legado sem draft recebe diagnóstico em vez de ativação ou erro", async () => {
  const repository = new FakeOnboardingRepository();
  repository.draft = null;
  repository.tenant = {
    ...repository.tenant,
    status: "active",
    runtimeMode: "legado",
  };
  const { service, readinessService } = subject({ repository });
  readinessService.result = {
    ready: true,
    mode: "diagnostic",
    checks: [{
      code: "CONFIGURATION_DRAFT_REQUIRED",
      state: "warning",
      severity: "warning",
      step: 10,
      message: "A empresa ativa ainda usa a configuração legada.",
      correctiveAction: "Crie e valide um draft V2 antes da próxima publicação.",
    }],
  };
  const result = await service.readiness({ empresaId: TENANT_ID });
  assert.equal(result.draftVersion, 0);
  assert.equal(result.mode, "diagnostic");
  assert.equal(result.ready, true);
  assert.deepEqual(readinessService.inputs[0].configuration, {});
  assert.equal(repository.tenant.status, "active");
});

test("publicação é recusada com TENANT_NOT_READY antes de compilar ou persistir", async () => {
  let compiled = false;
  const { service, repository, readinessService } = subject({
    compiler() { compiled = true; throw new Error("não deve compilar"); },
  });
  readinessService.result = {
    ready: false,
    mode: "enforcement",
    checks: [{
      code: "PRIMARY_NUMBER_REQUIRED",
      state: "failed",
      severity: "blocker",
      step: 8,
      message: "Configure o número principal.",
      correctiveAction: "Selecione um número ativo.",
      token: "não-retornar",
    }],
  };

  await assert.rejects(
    service.publish({ empresaId: TENANT_ID, actorId: ACTOR_ID, expectedDraftVersion: 1 }),
    (error) => error instanceof TenantNotReadyError
      && error.code === "TENANT_NOT_READY"
      && error.status === 409
      && error.checks[0].code === "PRIMARY_NUMBER_REQUIRED"
      && !JSON.stringify(error.checks).includes("token"),
  );
  assert.equal(compiled, false);
  assert.deepEqual(repository.revisions, []);
  assert.deepEqual(repository.publicationAudits, []);
});

test("publish cria revisão e ponte auditadas sem ativar o status da empresa", async () => {
  const { service, repository } = subject();
  const result = await service.publish({
    empresaId: TENANT_ID,
    actorId: ACTOR_ID,
    expectedDraftVersion: 1,
    correlationId: "00000000-0000-4000-8000-000000000399",
  });
  assert.deepEqual(repository.events, [
    "lock", "readiness-snapshot", "readiness", "revision", "active-revision", "publication-audit",
  ]);
  assert.equal(result.configVersion, 2);
  assert.equal(result.status, undefined);
  assert.equal(repository.tenant.status, "draft");
  assert.equal(repository.tenant.activeConfigurationVersion, 2);
  assert.equal(repository.publicationAudits.length, 1);
  assert.equal(repository.activationAudits.length, 0);
});

test("activate recalcula, compila, publica, audita e ativa na mesma transação", async () => {
  const repository = new FakeOnboardingRepository();
  const compiler = (draft, options) => {
    repository.events.push("compile");
    return compileTenantRuntimeConfigV2(draft, options);
  };
  const { service, readinessService } = subject({ repository, compiler });
  const result = await service.activate({
    empresaId: TENANT_ID,
    actorId: ACTOR_ID,
    expectedDraftVersion: 1,
  });

  assert.deepEqual(repository.events, [
    "lock", "readiness-snapshot", "readiness", "compile", "revision", "active-revision",
    "publication-audit", "tenant-active", "activation-audit",
  ]);
  assert.equal(readinessService.inputs[0].mode, "enforcement");
  assert.equal(result.status, "active");
  assert.equal(repository.tenant.status, "active");
  assert.equal(repository.revisions.length, 1);
  assert.equal(repository.activationAudits.length, 1);
  assert.equal(Object.hasOwn(repository.lastActivationInput, "status"), false);
  assert.equal(repository.lastActivationInput.configVersion, 2);
});

test("falha final de auditoria reverte revisão, ponte e ativação", async () => {
  const { service, repository } = subject();
  repository.failActivationAudit = true;
  const before = clone({ tenant: repository.tenant, revisions: repository.revisions });
  await assert.rejects(
    service.activate({ empresaId: TENANT_ID, actorId: ACTOR_ID, expectedDraftVersion: 1 }),
    (error) => error.code === "ONBOARDING_ACTIVATION_FAILED"
      && error.status === 500
      && error.message === "Não foi possível concluir a ativação da empresa."
      && !error.message.includes("detalhe privado"),
  );
  assert.deepEqual({ tenant: repository.tenant, revisions: repository.revisions }, before);
  assert.deepEqual(repository.publicationAudits, []);
  assert.deepEqual(repository.activationAudits, []);
});

test("draft stale falha antes de readiness e não aceita ativação genérica por status", async () => {
  const { service, repository, readinessService } = subject();
  await assert.rejects(
    service.activate({
      empresaId: TENANT_ID,
      actorId: ACTOR_ID,
      expectedDraftVersion: 0,
      status: "suspended",
    }),
    (error) => error.code === "DRAFT_VERSION_CONFLICT"
      && error.status === 409
      && error.details.currentDraftVersion === 1,
  );
  assert.equal(readinessService.inputs.length, 0);
  assert.equal(repository.tenant.status, "draft");
});

test("modo de readiness diferente de enforcement fecha publicação", async () => {
  const { service, repository, readinessService } = subject();
  readinessService.result = { ready: true, mode: "diagnostic", checks: [] };
  await assert.rejects(
    service.publish({ empresaId: TENANT_ID, actorId: ACTOR_ID, expectedDraftVersion: 1 }),
    (error) => error.code === "TENANT_NOT_READY"
      && error.checks[0].code === "READINESS_ENFORCEMENT_REQUIRED",
  );
  assert.deepEqual(repository.revisions, []);
});
