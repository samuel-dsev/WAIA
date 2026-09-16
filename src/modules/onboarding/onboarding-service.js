import { randomUUID } from "node:crypto";
import {
  CAPABILITY_CATALOG_V2,
  compileTenantRuntimeConfigV2,
  parseTenantRuntimeConfigV2Draft,
  validateTenantRuntimeConfigV2,
} from "../configuration/index.js";
import {
  OnboardingError,
  OnboardingNotFoundError,
  OnboardingPersistenceError,
  OnboardingRevisionConflictError,
  TenantNotReadyError,
  sanitizeReadinessChecks,
} from "./onboarding-errors.js";

const MAX_STEPS = 10;

function immutableClone(value) {
  const clone = structuredClone(value);
  const freeze = (item) => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return item;
    for (const child of Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(clone);
}

function requiredText(value, path, max = 200) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new OnboardingError("INVALID_FIELD", `${path} é inválido.`, { path });
  }
  return text;
}

function nonNegativeInteger(value, path, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new OnboardingError("INVALID_INTEGER", `${path} deve ser um inteiro válido.`, { path });
  }
  return value;
}

function positiveStep(value, path = "/currentStep") {
  const step = nonNegativeInteger(value, path, { max: MAX_STEPS });
  if (step < 1) throw new OnboardingError("INVALID_STEP", `${path} deve estar entre 1 e ${MAX_STEPS}.`, { path });
  return step;
}

function isoInstant(value, path) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new OnboardingError("INVALID_DATE", `${path} deve ser uma data válida.`, { path });
  return date.toISOString();
}

function completedSteps(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_STEPS) {
    throw new OnboardingError("INVALID_COMPLETED_STEPS", "completedSteps deve ser uma lista de etapas.", { path: "/completedSteps" });
  }
  const seen = new Set();
  return value.map((entry, index) => {
    const path = `/completedSteps/${index}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new OnboardingError("INVALID_COMPLETED_STEP", "A etapa concluída é inválida.", { path });
    }
    const step = positiveStep(entry.step, `${path}/step`);
    if (seen.has(step)) throw new OnboardingError("DUPLICATE_COMPLETED_STEP", "Uma etapa concluída está duplicada.", { path: `${path}/step` });
    seen.add(step);
    return Object.freeze({ step, completedAt: isoInstant(entry.completedAt, `${path}/completedAt`) });
  }).sort((left, right) => left.step - right.step);
}

function progressView(record, empresaId) {
  if (!record) {
    return immutableClone({ empresaId, revision: 0, currentStep: 1, completedSteps: [], updatedAt: null });
  }
  return immutableClone({
    empresaId,
    revision: nonNegativeInteger(Number(record.revision), "/revision"),
    currentStep: positiveStep(Number(record.currentStep)),
    completedSteps: completedSteps(record.completedSteps),
    updatedAt: record.updatedAt == null ? null : isoInstant(record.updatedAt, "/updatedAt"),
  });
}

function safeIssue(issue, index) {
  const source = issue && typeof issue === "object" && !Array.isArray(issue) ? issue : {};
  const code = /^[A-Z][A-Z0-9_]{1,99}$/u.test(String(source.code || ""))
    ? String(source.code)
    : "CONFIGURATION_INVALID";
  const path = typeof source.path === "string" && source.path.startsWith("/")
    ? source.path.slice(0, 500)
    : `/issues/${index}`;
  const message = typeof source.message === "string" && source.message.trim()
    ? source.message.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 1_000)
    : "A configuração possui um campo inválido.";
  return Object.freeze({ code, path, severity: "error", message });
}

function validationView(result, draftVersion) {
  const issues = Array.isArray(result?.issues)
    ? Object.freeze(result.issues.slice(0, 200).map(safeIssue))
    : Object.freeze([]);
  return Object.freeze({ valid: result?.valid === true && issues.length === 0, draftVersion, issues });
}

function readinessView(result) {
  const checks = sanitizeReadinessChecks(result?.checks);
  const blockers = checks.filter((check) => check.severity === "blocker" && check.state === "failed");
  const mode = result?.mode === "diagnostic" || result?.mode === "enforcement" ? result.mode : "unknown";
  return Object.freeze({
    ready: result?.ready === true && blockers.length === 0,
    mode,
    checks,
  });
}

function blockerChecks(result, { requireEnforcement = false } = {}) {
  const view = readinessView(result);
  const blockers = view.checks.filter((check) => check.severity === "blocker" && check.state === "failed");
  if (requireEnforcement && view.mode !== "enforcement") {
    blockers.push(Object.freeze({
      code: "READINESS_ENFORCEMENT_REQUIRED",
      state: "failed",
      severity: "blocker",
      step: 10,
      message: "A prontidão precisa ser recalculada em modo de bloqueio.",
      correctiveAction: "Recalcule a prontidão antes de publicar ou ativar.",
    }));
  } else if (!view.ready && blockers.length === 0) {
    blockers.push(Object.freeze({
      code: "READINESS_INCONSISTENT",
      state: "failed",
      severity: "blocker",
      step: 10,
      message: "A prontidão não confirmou que a empresa pode continuar.",
      correctiveAction: "Recalcule a prontidão e revise as pendências.",
    }));
  }
  return { view, blockers };
}

function nextConfigurationVersion(tenant) {
  const current = Number(tenant?.configurationVersion);
  const active = tenant?.activeConfigurationVersion == null ? 0 : Number(tenant.activeConfigurationVersion);
  if (!Number.isSafeInteger(current) || current < 1 || !Number.isSafeInteger(active) || active < 0) {
    throw new OnboardingError("INVALID_TENANT_VERSION", "O estado de versão da empresa é inválido.", { status: 500 });
  }
  return Math.max(current, active) + 1;
}

function requireRepository(repository) {
  const methods = [
    "readProgress", "saveProgressAtomic", "readReadinessSnapshot",
    "withActivationTransaction", "lockActivationState", "insertPublishedRevision",
    "setActiveRevision", "setTenantActive", "writePublicationAudit", "writeActivationAudit",
  ];
  for (const method of methods) {
    if (typeof repository?.[method] !== "function") throw new TypeError(`onboardingRepository.${method} é obrigatório.`);
  }
}

function requireService(service, name, methods) {
  for (const method of methods) {
    if (typeof service?.[method] !== "function") throw new TypeError(`${name}.${method} é obrigatório.`);
  }
}

function unexpectedReleaseError(error, activate) {
  if (error instanceof OnboardingError || error?.code === "CONFIGURATION_INVALID") return error;
  return new OnboardingPersistenceError(
    activate ? "ONBOARDING_ACTIVATION_FAILED" : "ONBOARDING_PUBLICATION_FAILED",
    activate
      ? "Não foi possível concluir a ativação da empresa."
      : "Não foi possível concluir a publicação da configuração.",
    error,
  );
}

/**
 * Contrato de integração:
 * - o repository mantém progresso e oferece uma única transação para publicação/ativação;
 * - configurationService é a fronteira segura do draft V2;
 * - readinessService.evaluate recebe somente configuração validada e snapshot sanitizado;
 * - setTenantActive é uma operação específica, sem aceitar status arbitrário.
 */
export class OnboardingService {
  constructor({
    repository,
    configurationService,
    readinessService,
    flowPublisher = null,
    previewService = null,
    preflightService = null,
    compiler = compileTenantRuntimeConfigV2,
    draftParser = parseTenantRuntimeConfigV2Draft,
    validator = validateTenantRuntimeConfigV2,
    actionCatalog = CAPABILITY_CATALOG_V2,
    idGenerator = randomUUID,
    clock = () => new Date(),
  } = {}) {
    requireRepository(repository);
    requireService(configurationService, "configurationService", ["readDraft", "saveDraft"]);
    requireService(readinessService, "readinessService", ["evaluate"]);
    if (flowPublisher != null) requireService(flowPublisher, "flowPublisher", ["publishDefinitions"]);
    if (previewService != null) requireService(previewService, "previewService", ["simulate"]);
    if (preflightService != null) requireService(preflightService, "preflightService", ["run"]);
    if (![compiler, draftParser, validator, idGenerator, clock].every((item) => typeof item === "function")) {
      throw new TypeError("Helpers do onboarding são inválidos.");
    }
    this.repository = repository;
    this.configurationService = configurationService;
    this.readinessService = readinessService;
    this.flowPublisher = flowPublisher;
    this.previewService = previewService;
    this.preflightService = preflightService;
    this.compiler = compiler;
    this.draftParser = draftParser;
    this.validator = validator;
    this.actionCatalog = immutableClone(actionCatalog);
    this.idGenerator = idGenerator;
    this.clock = clock;
  }

  getActionCatalog() {
    return immutableClone(this.actionCatalog);
  }

  async getProgress({ empresaId }) {
    const tenantId = requiredText(empresaId, "/empresaId");
    const progress = await this.repository.readProgress({ empresaId: tenantId });
    if (!progress && !await this.repository.readReadinessSnapshot({ empresaId: tenantId })) {
      throw new OnboardingNotFoundError("TENANT_NOT_FOUND", "A empresa não foi encontrada.");
    }
    return progressView(progress, tenantId);
  }

  async saveProgressStep({
    empresaId,
    expectedRevision,
    currentStep,
    completedSteps: completed = [],
    actorId,
    correlationId = null,
  }) {
    const tenantId = requiredText(empresaId, "/empresaId");
    const userId = requiredText(actorId, "/actorId");
    const expected = nonNegativeInteger(expectedRevision, "/expectedRevision");
    const step = positiveStep(currentStep);
    const normalizedCompleted = completedSteps(completed);
    const occurredAt = this.clock();
    if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
      throw new OnboardingError("INVALID_CLOCK", "Não foi possível registrar o progresso.", { status: 500 });
    }
    const result = await this.repository.saveProgressAtomic({
      empresaId: tenantId,
      expectedRevision: expected,
      currentStep: step,
      completedSteps: normalizedCompleted,
      actorId: userId,
      correlationId,
      auditId: this.idGenerator(),
      occurredAt,
    });
    if (!result?.saved) {
      throw new OnboardingRevisionConflictError(
        "ONBOARDING_REVISION_CONFLICT",
        "O progresso foi alterado por outra sessão. Recarregue antes de salvar novamente.",
        { expectedRevision: expected, currentRevision: Number(result?.currentRevision || 0) },
        "/expectedRevision",
      );
    }
    return progressView(result.progress, tenantId);
  }

  async readDraft({ empresaId }) {
    const tenantId = requiredText(empresaId, "/empresaId");
    const draft = await this.configurationService.readDraft({ empresaId: tenantId });
    return draft == null ? null : immutableClone(draft);
  }

  async saveDraft({ empresaId, configuration, expectedDraftVersion, actorId, correlationId = null }) {
    const tenantId = requiredText(empresaId, "/empresaId");
    const result = await this.configurationService.saveDraft({
      empresaId: tenantId,
      configuration,
      expectedDraftVersion,
      actorId,
      correlationId,
    });
    return immutableClone(result);
  }

  async validate({ empresaId }) {
    const { tenantId, draft } = await this.#requiredDraft(empresaId);
    const result = this.validator(draft.configuration);
    return Object.freeze({ empresaId: tenantId, ...validationView(result, draft.draftVersion) });
  }

  async readiness({ empresaId }) {
    const tenantId = requiredText(empresaId, "/empresaId");
    const draft = await this.configurationService.readDraft({ empresaId: tenantId });
    const configuration = draft ? this.draftParser(draft.configuration) : {};
    const snapshot = await this.repository.readReadinessSnapshot({ empresaId: tenantId });
    if (!snapshot) throw new OnboardingNotFoundError("TENANT_NOT_FOUND", "A empresa não foi encontrada.");
    const evaluated = await this.readinessService.evaluate({
      empresaId: tenantId,
      configuration,
      snapshot,
    });
    return Object.freeze({ empresaId: tenantId, draftVersion: draft?.draftVersion || 0, ...readinessView(evaluated) });
  }

  async simulateMessage({
    empresaId,
    expectedDraftVersion,
    sessionId = null,
    expectedSessionRevision = 0,
    message,
    actorId,
  }) {
    if (!this.previewService) throw new OnboardingError("PREVIEW_UNAVAILABLE", "O simulador não está disponível.", { status: 503 });
    const userId = requiredText(actorId, "/actorId");
    const { tenantId, draft } = await this.#requiredDraftVersion(empresaId, expectedDraftVersion);
    return this.previewService.simulate({
      actorId: userId,
      empresaId: tenantId,
      configuration: draft.configuration,
      draftVersion: Number(draft.draftVersion),
      sessionId: sessionId == null || sessionId === "" ? this.idGenerator() : sessionId,
      expectedSessionRevision,
      message,
    });
  }

  async preflight({ empresaId, expectedDraftVersion, actorId, correlationId = null }) {
    if (!this.preflightService) throw new OnboardingError("PREFLIGHT_UNAVAILABLE", "O preflight não está disponível.", { status: 503 });
    if (typeof this.repository.readPreflightTargets !== "function") {
      throw new OnboardingError("PREFLIGHT_UNAVAILABLE", "Os alvos do preflight não estão disponíveis.", { status: 503 });
    }
    const userId = requiredText(actorId, "/actorId");
    const { tenantId, draft } = await this.#requiredDraftVersion(empresaId, expectedDraftVersion);
    const snapshot = await this.repository.readReadinessSnapshot({ empresaId: tenantId });
    if (!snapshot) throw new OnboardingNotFoundError("TENANT_NOT_FOUND", "A empresa não foi encontrada.");
    const configuration = this.draftParser(draft.configuration);
    const compiled = this.compiler(configuration, {
      empresaId: tenantId,
      configVersion: Number(snapshot.nextConfigurationVersion),
      draftVersion: Number(draft.draftVersion),
    });
    const targets = await this.repository.readPreflightTargets({ empresaId: tenantId });
    const result = await this.preflightService.run({
      empresaId: tenantId,
      configuration: compiled.configuration,
      targets,
      actorId: userId,
      correlationId,
    });
    const currentDraft = await this.configurationService.readDraft({ empresaId: tenantId });
    if (!currentDraft || Number(currentDraft.draftVersion) !== Number(draft.draftVersion)) {
      throw new OnboardingRevisionConflictError(
        "DRAFT_VERSION_CONFLICT",
        "O rascunho mudou durante o preflight. Execute os testes novamente.",
        {
          expectedDraftVersion: Number(draft.draftVersion),
          currentDraftVersion: Number(currentDraft?.draftVersion || 0),
        },
        "/expectedDraftVersion",
      );
    }
    const readiness = await this.readiness({ empresaId: tenantId });
    return immutableClone({
      ...result,
      draftVersion: Number(draft.draftVersion),
      state: result.summary.failedCount === 0 ? "passed" : "failed",
      readiness,
    });
  }

  publish(input) {
    return this.#release(input, { activate: false });
  }

  activate(input) {
    return this.#release(input, { activate: true });
  }

  async #requiredDraft(empresaId) {
    const tenantId = requiredText(empresaId, "/empresaId");
    const draft = await this.configurationService.readDraft({ empresaId: tenantId });
    if (!draft) {
      throw new OnboardingNotFoundError("CONFIGURATION_DRAFT_NOT_FOUND", "O rascunho da configuração não foi encontrado.");
    }
    return { tenantId, draft };
  }

  async #requiredDraftVersion(empresaId, expectedDraftVersion) {
    const expected = nonNegativeInteger(expectedDraftVersion, "/expectedDraftVersion");
    const { tenantId, draft } = await this.#requiredDraft(empresaId);
    if (Number(draft.draftVersion) !== expected) {
      throw new OnboardingRevisionConflictError(
        "DRAFT_VERSION_CONFLICT",
        "O rascunho foi alterado por outra sessão. Recarregue antes de continuar.",
        { expectedDraftVersion: expected, currentDraftVersion: Number(draft.draftVersion) },
        "/expectedDraftVersion",
      );
    }
    return { tenantId, draft };
  }

  async #release({ empresaId, expectedDraftVersion, actorId, correlationId = null }, { activate }) {
    const tenantId = requiredText(empresaId, "/empresaId");
    const userId = requiredText(actorId, "/actorId");
    const expected = nonNegativeInteger(expectedDraftVersion, "/expectedDraftVersion");
    try {
      return await this.repository.withActivationTransaction({ empresaId: tenantId, actorId: userId }, async (transaction) => {
      const { tenant, draft } = await this.repository.lockActivationState({ empresaId: tenantId, transaction });
      if (!tenant) throw new OnboardingNotFoundError("TENANT_NOT_FOUND", "A empresa não foi encontrada.");
      if (!draft) throw new OnboardingNotFoundError("CONFIGURATION_DRAFT_NOT_FOUND", "O rascunho da configuração não foi encontrado.");
      if (Number(draft.draftVersion) !== expected) {
        throw new OnboardingRevisionConflictError(
          "DRAFT_VERSION_CONFLICT",
          "O rascunho foi alterado por outra sessão. Recarregue antes de continuar.",
          { expectedDraftVersion: expected, currentDraftVersion: Number(draft.draftVersion) },
          "/expectedDraftVersion",
        );
      }

      const configuration = this.draftParser(draft.configuration);
      const snapshot = await this.repository.readReadinessSnapshot({ empresaId: tenantId, transaction });
      const evaluated = await this.readinessService.evaluate({
        empresaId: tenantId,
        configuration,
        snapshot,
        mode: "enforcement",
      });
      const { blockers } = blockerChecks(evaluated, { requireEnforcement: true });
      if (blockers.length > 0) throw new TenantNotReadyError(blockers);

      const configVersion = nextConfigurationVersion(tenant);
      const compiled = this.compiler(configuration, {
        empresaId: tenantId,
        configVersion,
        draftVersion: Number(draft.draftVersion),
      });
      const publishedAt = this.clock();
      if (!(publishedAt instanceof Date) || Number.isNaN(publishedAt.getTime())) {
        throw new OnboardingError("INVALID_CLOCK", "Não foi possível registrar a publicação.", { status: 500 });
      }

      await this.repository.insertPublishedRevision({
        empresaId: tenantId,
        compiled,
        actorId: userId,
        publishedAt,
        transaction,
      });
      const flowDefinitions = compiled.configuration.flows?.definitions || [];
      if (flowDefinitions.length > 0) {
        if (!this.flowPublisher) {
          throw new OnboardingError(
            "FLOW_PUBLISHER_UNAVAILABLE",
            "Não foi possível materializar as versões imutáveis dos fluxos.",
            { status: 500 },
          );
        }
        await this.flowPublisher.publishDefinitions({
          empresaId: tenantId,
          configVersion,
          definitions: flowDefinitions,
          actorId: userId,
          correlationId,
          publishedAt,
          transaction,
        });
      }
      const activeRevision = await this.repository.setActiveRevision({
        empresaId: tenantId,
        configVersion,
        publishedAt,
        transaction,
      });
      if (!activeRevision) throw new OnboardingError("ACTIVE_REVISION_UPDATE_FAILED", "Não foi possível ativar a revisão publicada.", { status: 500 });
      await this.repository.writePublicationAudit({
        auditId: this.idGenerator(),
        empresaId: tenantId,
        actorId: userId,
        configVersion,
        correlationId,
        occurredAt: publishedAt,
        transaction,
      });

      let tenantResult = activeRevision;
      if (activate) {
        tenantResult = await this.repository.setTenantActive({
          empresaId: tenantId,
          configVersion,
          activatedAt: publishedAt,
          transaction,
        });
        if (!tenantResult) throw new OnboardingError("TENANT_ACTIVATION_FAILED", "Não foi possível ativar a empresa.", { status: 500 });
        await this.repository.writeActivationAudit({
          auditId: this.idGenerator(),
          empresaId: tenantId,
          actorId: userId,
          configVersion,
          correlationId,
          occurredAt: publishedAt,
          transaction,
        });
      }

        return immutableClone({
          empresaId: tenantId,
          configVersion,
          draftVersion: Number(draft.draftVersion),
          checksum: compiled.checksum,
          publishedAt: publishedAt.toISOString(),
          runtimeMode: tenantResult.runtimeMode || activeRevision.runtimeMode || "versionado",
          ...(activate ? { status: "active" } : {}),
        });
      });
    } catch (error) {
      throw unexpectedReleaseError(error, activate);
    }
  }
}
