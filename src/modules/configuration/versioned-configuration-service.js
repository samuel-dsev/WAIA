import { randomUUID } from "node:crypto";
import { compileTenantRuntimeConfigV2 } from "./compiler.js";
import { parseTenantRuntimeConfigV2Draft } from "./tenant-runtime-config-v2.js";
import {
  DraftVersionConflictError,
  VersionedConfigurationError,
  VersionedConfigurationNotFoundError,
  VersionedConfigurationPersistenceError,
} from "./versioned-configuration-errors.js";

function requiredText(value, path) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new VersionedConfigurationError("REQUIRED", `${path} é obrigatório.`, { path });
  return normalized;
}

function requiredDraftVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VersionedConfigurationError(
      "EXPECTED_DRAFT_VERSION_REQUIRED",
      "expectedDraftVersion deve ser um inteiro maior ou igual a zero.",
      { path: "/expectedDraftVersion" },
    );
  }
  return value;
}

function safeDraft(value) {
  try {
    return structuredClone(parseTenantRuntimeConfigV2Draft(value));
  } catch (error) {
    if (error?.code === "CONFIGURATION_INVALID" && error.issues?.[0]) {
      const first = error.issues[0];
      const path = first.path === "/" ? "/configuration" : `/configuration${first.path}`;
      throw new VersionedConfigurationError(first.code, first.message, { path });
    }
    throw error;
  }
}

function schemaVersionForDraft(draft) {
  if (draft.schemaVersion === undefined) return 2;
  if (draft.schemaVersion !== 2) {
    throw new VersionedConfigurationError(
      "UNSUPPORTED_SCHEMA_VERSION",
      "O rascunho deve usar schemaVersion 2.",
      { path: "/configuration/schemaVersion" },
    );
  }
  return 2;
}

function immutableClone(value) {
  const clone = structuredClone(value);
  const freeze = (item) => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return item;
    for (const child of Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(clone);
}

function nextConfigurationVersion(tenant) {
  const current = Number(tenant.configurationVersion);
  const active = tenant.activeConfigurationVersion == null ? 0 : Number(tenant.activeConfigurationVersion);
  if (!Number.isSafeInteger(current) || current < 1 || !Number.isSafeInteger(active) || active < 0) {
    throw new TypeError("Estado de versão da empresa inválido.");
  }
  return Math.max(current, active) + 1;
}

function unexpectedPersistenceError(code, message, error) {
  if (error instanceof VersionedConfigurationError || error?.code === "CONFIGURATION_INVALID") return error;
  return new VersionedConfigurationPersistenceError(code, message, error);
}

export class VersionedConfigurationService {
  constructor(repository, {
    compiler = compileTenantRuntimeConfigV2,
    idGenerator = randomUUID,
    clock = () => new Date(),
  } = {}) {
    if (!repository) throw new TypeError("configurationRepository é obrigatório.");
    for (const method of [
      "readDraft", "saveDraftAtomic", "withPublicationTransaction", "lockPublicationState",
      "insertPublishedRevision", "activatePublishedRevision", "writePublicationAudit",
    ]) {
      if (typeof repository[method] !== "function") throw new TypeError(`configurationRepository.${method} é obrigatório.`);
    }
    if (typeof compiler !== "function") throw new TypeError("compiler deve ser uma função.");
    this.repository = repository;
    this.compiler = compiler;
    this.idGenerator = idGenerator;
    this.clock = clock;
  }

  async readDraft({ empresaId }) {
    const tenantId = requiredText(empresaId, "/empresaId");
    try {
      const draft = await this.repository.readDraft({ empresaId: tenantId });
      return draft ? immutableClone({ ...draft, configuration: safeDraft(draft.configuration) }) : null;
    } catch (error) {
      throw unexpectedPersistenceError("CONFIGURATION_DRAFT_READ_FAILED", "Não foi possível carregar o rascunho.", error);
    }
  }

  async saveDraft({ empresaId, configuration, expectedDraftVersion, actorId, correlationId = null }) {
    const tenantId = requiredText(empresaId, "/empresaId");
    const userId = requiredText(actorId, "/actorId");
    const expected = requiredDraftVersion(expectedDraftVersion);
    const draft = safeDraft(configuration);
    const schemaVersion = schemaVersionForDraft(draft);
    const occurredAt = this.clock();
    if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
      throw new VersionedConfigurationError("INVALID_CLOCK", "Não foi possível registrar a alteração do rascunho.", { status: 500 });
    }
    try {
      const result = await this.repository.saveDraftAtomic({
        empresaId: tenantId,
        expectedDraftVersion: expected,
        schemaVersion,
        configuration: draft,
        actorId: userId,
        auditId: this.idGenerator(),
        correlationId,
        occurredAt,
      });
      if (!result.saved) {
        throw new DraftVersionConflictError({
          expectedDraftVersion: expected,
          currentDraftVersion: result.currentDraftVersion,
        });
      }
      return immutableClone(result.draft);
    } catch (error) {
      throw unexpectedPersistenceError("CONFIGURATION_DRAFT_SAVE_FAILED", "Não foi possível salvar o rascunho.", error);
    }
  }

  async publish({ empresaId, expectedDraftVersion, actorId, correlationId = null }) {
    const tenantId = requiredText(empresaId, "/empresaId");
    const userId = requiredText(actorId, "/actorId");
    const expected = requiredDraftVersion(expectedDraftVersion);
    try {
      return await this.repository.withPublicationTransaction({ empresaId: tenantId, actorId: userId }, async (transaction) => {
        const { tenant, draft } = await this.repository.lockPublicationState({ empresaId: tenantId, transaction });
        if (!tenant) {
          throw new VersionedConfigurationNotFoundError("TENANT_NOT_FOUND", "A empresa não foi encontrada.");
        }
        if (!draft) {
          throw new VersionedConfigurationNotFoundError("CONFIGURATION_DRAFT_NOT_FOUND", "O rascunho da configuração não foi encontrado.");
        }
        if (draft.draftVersion !== expected) {
          throw new DraftVersionConflictError({
            expectedDraftVersion: expected,
            currentDraftVersion: draft.draftVersion,
          });
        }
        const configVersion = nextConfigurationVersion(tenant);
        const compiled = this.compiler(draft.configuration, {
          empresaId: tenantId,
          configVersion,
          draftVersion: draft.draftVersion,
        });
        const publishedAt = this.clock();
        if (!(publishedAt instanceof Date) || Number.isNaN(publishedAt.getTime())) throw new TypeError("Relógio inválido.");
        await this.repository.insertPublishedRevision({
          empresaId: tenantId,
          compiled,
          actorId: userId,
          publishedAt,
          transaction,
        });
        const activatedTenant = await this.repository.activatePublishedRevision({
          empresaId: tenantId,
          configVersion,
          publishedAt,
          transaction,
        });
        if (!activatedTenant) throw new TypeError("A empresa deixou de existir durante a publicação.");
        await this.repository.writePublicationAudit({
          auditId: this.idGenerator(),
          empresaId: tenantId,
          actorId: userId,
          configVersion,
          correlationId,
          occurredAt: publishedAt,
          transaction,
        });
        return immutableClone({
          empresaId: tenantId,
          configVersion,
          draftVersion: draft.draftVersion,
          checksum: compiled.checksum,
          publishedAt,
          runtimeMode: activatedTenant.runtimeMode,
        });
      });
    } catch (error) {
      throw unexpectedPersistenceError("CONFIGURATION_PUBLICATION_FAILED", "Não foi possível publicar a configuração.", error);
    }
  }
}
