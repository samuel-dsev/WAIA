import test from "node:test";
import assert from "node:assert/strict";
import { VersionedConfigurationService } from "../src/modules/configuration/versioned-configuration-service.js";
import {
  DraftVersionConflictError,
  VersionedConfigurationError,
} from "../src/modules/configuration/versioned-configuration-errors.js";

const TENANT_ID = "00000000-0000-4000-8000-0000000000a1";
const ACTOR_ID = "00000000-0000-4000-8000-0000000000b1";

function validConfiguration(name = "Empresa Sintética") {
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

class FakeVersionedConfigurationRepository {
  constructor() {
    this.tenant = {
      empresaId: TENANT_ID,
      configurationVersion: 1,
      runtimeMode: "legado",
      activeConfigurationVersion: null,
      publishedAt: null,
    };
    this.draft = null;
    this.revisions = [];
    this.audits = [];
    this.draftAudits = [];
    this.failAudit = false;
    this.failDraftAudit = false;
    this.events = [];
  }

  async readDraft() {
    return clone(this.draft);
  }

  async saveDraftAtomic({ empresaId, expectedDraftVersion, schemaVersion, configuration, actorId, auditId, correlationId, occurredAt }) {
    const snapshot = clone({ draft: this.draft, draftAudits: this.draftAudits });
    const current = this.draft?.draftVersion || 0;
    if (current !== expectedDraftVersion) return { saved: false, draft: null, currentDraftVersion: current };
    const now = new Date("2026-09-01T12:00:00.000Z");
    this.draft = {
      empresaId,
      draftVersion: current + 1,
      schemaVersion,
      configuration: clone(configuration),
      createdBy: this.draft?.createdBy || actorId,
      updatedBy: actorId,
      createdAt: this.draft?.createdAt || now,
      updatedAt: now,
    };
    if (this.failDraftAudit) {
      this.draft = snapshot.draft;
      this.draftAudits = snapshot.draftAudits;
      throw new Error("detalhe interno do audit de draft");
    }
    this.draftAudits.push({ auditId, empresaId, actorId, draftVersion: this.draft.draftVersion, correlationId, occurredAt });
    return { saved: true, draft: clone(this.draft), currentDraftVersion: this.draft.draftVersion };
  }

  async withPublicationTransaction(_context, callback) {
    const snapshot = clone({
      tenant: this.tenant,
      draft: this.draft,
      revisions: this.revisions,
      audits: this.audits,
      events: this.events,
    });
    try {
      return await callback({ fake: true });
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    }
  }

  async lockPublicationState() {
    this.events.push("lock");
    return { tenant: clone(this.tenant), draft: clone(this.draft) };
  }

  async insertPublishedRevision({ empresaId, compiled, actorId, publishedAt }) {
    this.events.push("revision");
    if (this.revisions.some((revision) => revision.configVersion === compiled.configVersion)) {
      throw new Error("revisão duplicada");
    }
    const revision = {
      empresaId,
      configVersion: compiled.configVersion,
      sourceDraftVersion: compiled.draftVersion,
      checksum: compiled.checksum,
      compiled: clone(compiled),
      actorId,
      publishedAt,
    };
    this.revisions.push(revision);
    return clone(revision);
  }

  async activatePublishedRevision({ configVersion, publishedAt }) {
    this.events.push("activate");
    this.tenant = {
      ...this.tenant,
      configurationVersion: configVersion,
      runtimeMode: "versionado",
      activeConfigurationVersion: configVersion,
      publishedAt,
    };
    return clone(this.tenant);
  }

  async writePublicationAudit({ auditId, empresaId, actorId, configVersion, correlationId, occurredAt }) {
    this.events.push("audit");
    if (this.failAudit) throw new Error("detalhe interno da auditoria");
    this.audits.push({ auditId, empresaId, actorId, configVersion, correlationId, occurredAt });
  }

  activeRuntimeConfiguration() {
    const version = this.tenant.activeConfigurationVersion;
    return clone(this.revisions.find((revision) => revision.configVersion === version)?.compiled || null);
  }

  snapshot() {
    return clone({ tenant: this.tenant, draft: this.draft, revisions: this.revisions, audits: this.audits });
  }
}

function service(repository) {
  return new VersionedConfigurationService(repository, {
    idGenerator: () => "00000000-0000-4000-8000-0000000000c1",
    clock: () => new Date("2026-09-01T15:00:00.000Z"),
  });
}

test("expectedDraftVersion é obrigatório e criação começa em 1", async () => {
  const repository = new FakeVersionedConfigurationRepository();
  const subject = service(repository);
  await assert.rejects(
    subject.saveDraft({ empresaId: TENANT_ID, actorId: ACTOR_ID, configuration: validConfiguration() }),
    (error) => error instanceof VersionedConfigurationError
      && error.code === "EXPECTED_DRAFT_VERSION_REQUIRED"
      && error.issues[0].path === "/expectedDraftVersion",
  );
  const created = await subject.saveDraft({
    empresaId: TENANT_ID,
    actorId: ACTOR_ID,
    expectedDraftVersion: 0,
    configuration: validConfiguration(),
  });
  assert.equal(created.draftVersion, 1);
  assert.equal(Object.isFrozen(created.configuration), true);
  assert.equal(repository.activeRuntimeConfiguration(), null);
  assert.equal(repository.draftAudits.length, 1);
  assert.equal(repository.tenant.runtimeMode, "legado");
  assert.equal(repository.tenant.activeConfigurationVersion, null);
});

test("concorrência otimista recusa criação repetida e atualização stale", async () => {
  const repository = new FakeVersionedConfigurationRepository();
  const subject = service(repository);
  await subject.saveDraft({ empresaId: TENANT_ID, actorId: ACTOR_ID, expectedDraftVersion: 0, configuration: validConfiguration() });
  await assert.rejects(
    subject.saveDraft({ empresaId: TENANT_ID, actorId: ACTOR_ID, expectedDraftVersion: 0, configuration: validConfiguration("Outra") }),
    (error) => error instanceof DraftVersionConflictError
      && error.status === 409
      && error.details.expectedDraftVersion === 0
      && error.details.currentDraftVersion === 1
      && !JSON.stringify(error).includes("Outra"),
  );
  const updated = await subject.saveDraft({
    empresaId: TENANT_ID,
    actorId: ACTOR_ID,
    expectedDraftVersion: 1,
    configuration: validConfiguration("Versão dois"),
  });
  assert.equal(updated.draftVersion, 2);
  await assert.rejects(
    subject.saveDraft({ empresaId: TENANT_ID, actorId: ACTOR_ID, expectedDraftVersion: 1, configuration: validConfiguration("Stale") }),
    (error) => error.code === "DRAFT_VERSION_CONFLICT" && error.details.currentDraftVersion === 2,
  );
});

test("rascunho recusa plaintext sensível antes da persistência", async () => {
  const repository = new FakeVersionedConfigurationRepository();
  const subject = service(repository);
  await assert.rejects(
    subject.saveDraft({
      empresaId: TENANT_ID,
      actorId: ACTOR_ID,
      expectedDraftVersion: 0,
      configuration: { schemaVersion: 2, integrations: [{ accessToken: "não-persistir" }] },
    }),
    (error) => error.code === "SECRET_FIELD_FORBIDDEN"
      && error.issues[0].path === "/configuration/integrations/0/accessToken",
  );
  assert.equal(repository.draft, null);
  await assert.rejects(
    subject.saveDraft({
      empresaId: TENANT_ID,
      actorId: ACTOR_ID,
      expectedDraftVersion: 0,
      configuration: { schemaVersion: 2, note: "Bearer abcdefghijklmnop1234" },
    }),
    (error) => error.code === "SECRET_VALUE_FORBIDDEN" && !error.message.includes("abcdefghijkl"),
  );
});

test("rascunho parcial aceita ausência de campos obrigatórios, mas rejeita campos fora do V2", async () => {
  const repository = new FakeVersionedConfigurationRepository();
  const subject = service(repository);
  const saved = await subject.saveDraft({
    empresaId: TENANT_ID,
    actorId: ACTOR_ID,
    expectedDraftVersion: 0,
    configuration: { identity: { name: "Empresa ainda incompleta" } },
  });
  assert.deepEqual(saved.configuration, {
    identity: { name: "Empresa ainda incompleta" },
    schemaVersion: 2,
  });
  await assert.rejects(
    subject.saveDraft({
      empresaId: TENANT_ID,
      actorId: ACTOR_ID,
      expectedDraftVersion: 1,
      configuration: { identity: { name: "Empresa", campoArbitrario: "valor privado" } },
    }),
    (error) => error.code === "UNKNOWN_FIELD"
      && error.issues[0].path === "/configuration/identity/campoArbitrario",
  );
  await assert.rejects(
    subject.saveDraft({
      empresaId: TENANT_ID,
      actorId: ACTOR_ID,
      expectedDraftVersion: 1,
      configuration: {
        ...validConfiguration(),
        menu: {
          text: "Menu",
          options: [{ id: "x", action: "catalog.list", transportId: "cfg:nao-administravel" }],
        },
      },
    }),
    (error) => error.code === "UNKNOWN_FIELD"
      && error.issues[0].path === "/configuration/menu/options/0/transportId",
  );
  assert.equal(repository.draft.draftVersion, 1);
});

test("schema ausente assume V2, versão diferente é recusada e leitura revalida o banco", async () => {
  const repository = new FakeVersionedConfigurationRepository();
  const subject = service(repository);
  const withoutVersion = validConfiguration();
  delete withoutVersion.schemaVersion;
  const saved = await subject.saveDraft({
    empresaId: TENANT_ID,
    actorId: ACTOR_ID,
    expectedDraftVersion: 0,
    configuration: withoutVersion,
  });
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.configuration.schemaVersion, 2);
  await assert.rejects(
    subject.saveDraft({
      empresaId: TENANT_ID,
      actorId: ACTOR_ID,
      expectedDraftVersion: 1,
      configuration: { ...validConfiguration(), schemaVersion: "2" },
    }),
    (error) => error.code === "UNSUPPORTED_SCHEMA_VERSION"
      && error.issues[0].path === "/configuration/schemaVersion",
  );
  repository.draft.configuration = { accessToken: "valor-injetado-no-banco" };
  await assert.rejects(
    subject.readDraft({ empresaId: TENANT_ID }),
    (error) => error.code === "SECRET_FIELD_FORBIDDEN"
      && !error.message.includes("valor-injetado"),
  );
});

test("falha da auditoria do draft reverte a gravação e retorna erro sanitizado", async () => {
  const repository = new FakeVersionedConfigurationRepository();
  repository.failDraftAudit = true;
  const subject = service(repository);
  await assert.rejects(
    subject.saveDraft({
      empresaId: TENANT_ID,
      actorId: ACTOR_ID,
      expectedDraftVersion: 0,
      configuration: validConfiguration(),
    }),
    (error) => error.code === "CONFIGURATION_DRAFT_SAVE_FAILED"
      && !error.message.includes("detalhe interno"),
  );
  assert.equal(repository.draft, null);
  assert.deepEqual(repository.draftAudits, []);
});

test("publicação bloqueada é atômica e draft posterior não altera runtime ativo", async () => {
  const repository = new FakeVersionedConfigurationRepository();
  const subject = service(repository);
  await subject.saveDraft({ empresaId: TENANT_ID, actorId: ACTOR_ID, expectedDraftVersion: 0, configuration: validConfiguration("Publicada") });
  const published = await subject.publish({
    empresaId: TENANT_ID,
    actorId: ACTOR_ID,
    expectedDraftVersion: 1,
    correlationId: "00000000-0000-4000-8000-0000000000d1",
  });
  assert.deepEqual(repository.events, ["lock", "revision", "activate", "audit"]);
  assert.equal(published.configVersion, 2);
  assert.equal(published.runtimeMode, "versionado");
  assert.equal(repository.tenant.activeConfigurationVersion, 2);
  assert.equal(repository.revisions[0].sourceDraftVersion, 1);
  assert.equal(repository.audits.length, 1);
  assert.deepEqual(Object.keys(repository.audits[0]).sort(), [
    "actorId", "auditId", "configVersion", "correlationId", "empresaId", "occurredAt",
  ]);
  const activeBeforeNewDraft = repository.activeRuntimeConfiguration();

  await subject.saveDraft({
    empresaId: TENANT_ID,
    actorId: ACTOR_ID,
    expectedDraftVersion: 1,
    configuration: validConfiguration("Ainda em rascunho"),
  });
  assert.equal(repository.draft.draftVersion, 2);
  assert.deepEqual(repository.activeRuntimeConfiguration(), activeBeforeNewDraft);
  assert.equal(repository.activeRuntimeConfiguration().configuration.identity.name, "Publicada");
});

test("falha de compilação não cria revisão, ponte ou auditoria", async () => {
  const repository = new FakeVersionedConfigurationRepository();
  const subject = service(repository);
  await subject.saveDraft({
    empresaId: TENANT_ID,
    actorId: ACTOR_ID,
    expectedDraftVersion: 0,
    configuration: { schemaVersion: 2, identity: {}, modules: [], menu: { options: [] } },
  });
  const before = repository.snapshot();
  await assert.rejects(
    subject.publish({ empresaId: TENANT_ID, actorId: ACTOR_ID, expectedDraftVersion: 1 }),
    (error) => error.code === "CONFIGURATION_INVALID",
  );
  assert.deepEqual(repository.snapshot(), before);
});

test("falha de auditoria reverte revisão e ativação e não expõe erro interno", async () => {
  const repository = new FakeVersionedConfigurationRepository();
  const subject = service(repository);
  await subject.saveDraft({ empresaId: TENANT_ID, actorId: ACTOR_ID, expectedDraftVersion: 0, configuration: validConfiguration() });
  repository.failAudit = true;
  const before = repository.snapshot();
  await assert.rejects(
    subject.publish({ empresaId: TENANT_ID, actorId: ACTOR_ID, expectedDraftVersion: 1 }),
    (error) => error.code === "CONFIGURATION_PUBLICATION_FAILED"
      && error.status === 500
      && !error.message.includes("detalhe interno"),
  );
  assert.deepEqual(repository.snapshot(), before);
  assert.equal(repository.activeRuntimeConfiguration(), null);
});
