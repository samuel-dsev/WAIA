import { createHash } from "node:crypto";
import {
  compileTenantRuntimeConfigV2,
  materializeLegacyTenantDefinition,
} from "../configuration/index.js";
import { createConfiguredTenantRuntime } from "../../tenants/configured-runtime.js";
import { OnboardingError } from "./onboarding-errors.js";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u;
const MESSAGE_TYPES = new Set(["text", "interactive", "button", "list", "image", "document", "reset"]);
const MESSAGE_KEYS = new Set(["type", "text", "selectionId", "document"]);
const DOCUMENT_KEYS = new Set(["name", "mimeType", "sizeBytes"]);
const SIMULATE_KEYS = new Set([
  "actorId", "empresaId", "configuration", "draftVersion", "sessionId", "expectedSessionRevision", "message",
]);
const RESET_KEYS = new Set(["actorId", "empresaId", "sessionId", "expectedSessionRevision"]);
const DEFAULT_AI_REPLY = "Resposta simulada da IA. Nenhuma chamada externa foi realizada.";
const DEFAULT_INTEGRATION_REPLY = "Integração simulada com sucesso. Nenhuma chamada externa foi realizada.";

export class PreviewSessionError extends OnboardingError {
  constructor(code, message, { status = 422, path, details } = {}) {
    super(code, message, { status, path, details });
    if (path) this.path = path;
  }
}

function fail(code, message, options) {
  throw new PreviewSessionError(code, message, options);
}

function requiredId(value, path) {
  const id = String(value || "").trim();
  if (!ID_PATTERN.test(id)) fail("PREVIEW_ID_INVALID", `${path} é inválido.`, { path });
  return id;
}

function positiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("PREVIEW_VERSION_INVALID", `${path} deve ser um inteiro positivo.`, { path });
  }
  return value;
}

function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("PREVIEW_REVISION_INVALID", `${path} deve ser um inteiro não negativo.`, { path });
  }
  return value;
}

function plainObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("PREVIEW_INPUT_INVALID", `${path} deve ser um objeto.`, { path });
  }
  return value;
}

function rejectUnknownKeys(value, allowed, path) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) fail("PREVIEW_INPUT_UNKNOWN_FIELD", `${path}/${unknown} não é aceito.`, { path: `${path}/${unknown}` });
}

function optionalText(value, path, max) {
  if (value == null) return "";
  if (typeof value !== "string") fail("PREVIEW_INPUT_INVALID", `${path} deve ser texto.`, { path });
  const text = value.trim().normalize("NFC");
  if (text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    fail("PREVIEW_INPUT_INVALID", `${path} é inválido.`, { path });
  }
  return text;
}

function boundedSize(value, path) {
  if (value == null) return 1_024;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10 * 1024 * 1024) {
    fail("PREVIEW_DOCUMENT_INVALID", `${path} deve estar entre 1 byte e 10 MB.`, { path });
  }
  return value;
}

function hashId(...parts) {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function immutable(value) {
  const clone = structuredClone(value);
  const freeze = (item) => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return item;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(clone);
  return clone;
}

function normalizeMessage(rawMessage, session, nextSequence) {
  const message = plainObject(rawMessage, "/message");
  rejectUnknownKeys(message, MESSAGE_KEYS, "/message");
  const inferredType = message.type || (message.selectionId ? "interactive" : "text");
  const type = String(inferredType).trim();
  if (!MESSAGE_TYPES.has(type)) {
    fail("PREVIEW_MESSAGE_TYPE_UNSUPPORTED", "/message/type não é suportado pelo simulador.", { path: "/message/type" });
  }
  if (type === "reset") {
    if (message.text != null || message.selectionId != null || message.document != null) {
      fail("PREVIEW_RESET_INVALID", "A mensagem de reset não aceita conteúdo adicional.", { path: "/message" });
    }
    return { resetToMenu: true };
  }
  if (["interactive", "button", "list"].includes(type)) {
    const selectionId = optionalText(message.selectionId, "/message/selectionId", 256);
    if (!selectionId) {
      fail("PREVIEW_SELECTION_REQUIRED", "A seleção do botão ou da lista é obrigatória.", { path: "/message/selectionId" });
    }
    if (message.document != null) fail("PREVIEW_INPUT_INVALID", "Uma seleção não aceita documento.", { path: "/message/document" });
    return { type: "interactive", text: selectionId, selectionId };
  }
  if (["image", "document"].includes(type)) {
    const document = message.document == null ? {} : plainObject(message.document, "/message/document");
    rejectUnknownKeys(document, DOCUMENT_KEYS, "/message/document");
    if (message.selectionId != null) fail("PREVIEW_INPUT_INVALID", "Um documento não aceita seleção.", { path: "/message/selectionId" });
    const name = optionalText(document.name, "/message/document/name", 180) || `arquivo-sintetico.${type === "image" ? "png" : "pdf"}`;
    const mimeType = optionalText(document.mimeType, "/message/document/mimeType", 120)
      || (type === "image" ? "image/png" : "application/pdf");
    const expectedMime = type === "image" ? /^image\/(?:jpeg|png|webp)$/u : /^application\/pdf$/u;
    if (!expectedMime.test(mimeType)) {
      fail("PREVIEW_DOCUMENT_INVALID", "O tipo MIME sintético não corresponde à mensagem.", { path: "/message/document/mimeType" });
    }
    const sizeBytes = boundedSize(document.sizeBytes, "/message/document/sizeBytes");
    const digest = hashId(session.empresaId, session.sessionId, String(nextSequence), name, mimeType, String(sizeBytes));
    return {
      type,
      text: optionalText(message.text, "/message/text", 1_000),
      messageId: `preview-message:${digest.slice(0, 32)}`,
      mediaId: `preview-media:${digest.slice(0, 32)}`,
      mediaStorageKey: `preview/${session.tenantHash}/${digest}`,
      mediaMimeType: mimeType,
      mediaSizeBytes: sizeBytes,
      mediaSha256: digest,
    };
  }
  if (message.selectionId != null || message.document != null) {
    fail("PREVIEW_INPUT_INVALID", "Uma mensagem de texto não aceita seleção ou documento.", { path: "/message" });
  }
  const text = optionalText(message.text, "/message/text", 5_000);
  if (!text) fail("PREVIEW_TEXT_REQUIRED", "O texto da mensagem é obrigatório.", { path: "/message/text" });
  return { type: "text", text };
}

class PreviewStateRepository {
  constructor(empresaId) {
    this.empresaId = empresaId;
    this.values = new Map();
  }

  assertTenant(empresaId) {
    if (empresaId !== this.empresaId) fail("PREVIEW_TENANT_MISMATCH", "A sessão pertence a outra empresa.", { status: 409 });
  }

  async load({ empresaId, conversationId }) {
    this.assertTenant(empresaId);
    return structuredClone(this.values.get(conversationId) || null);
  }

  async save({ empresaId, conversationId }, value) {
    this.assertTenant(empresaId);
    if (value == null) this.values.delete(conversationId);
    else this.values.set(conversationId, structuredClone(value));
  }
}

class PreviewBusinessRepository {
  constructor(empresaId) {
    this.empresaId = empresaId;
    this.orders = new Map();
    this.appointments = new Map();
    this.handoffs = new Map();
  }

  assertTenant(empresaId) {
    if (empresaId !== this.empresaId) fail("PREVIEW_TENANT_MISMATCH", "A operação pertence a outra empresa.", { status: 409 });
  }

  async createPending(input) {
    this.assertTenant(input.empresaId);
    const target = input.eventId ? this.orders : this.appointments;
    if (!target.has(input.idempotencyKey)) target.set(input.idempotencyKey, structuredClone(input));
    return { id: `preview:${hashId(input.empresaId, input.idempotencyKey).slice(0, 24)}`, status: input.status };
  }

  async request(input) {
    this.assertTenant(input.empresaId);
    if (!this.handoffs.has(input.idempotencyKey)) this.handoffs.set(input.idempotencyKey, structuredClone(input));
    return { requested: true };
  }

  snapshot() {
    const publicOperation = (input) => ({
      status: String(input.status || "Pendente"),
      ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(input.serviceId ? { serviceId: input.serviceId, slotId: input.slotId } : {}),
    });
    return {
      orders: [...this.orders.values()].map(publicOperation),
      appointments: [...this.appointments.values()].map(publicOperation),
      handoffs: [...this.handoffs.values()].map(() => ({ status: "waiting_operator" })),
    };
  }
}

class PreviewFlowRepository {
  constructor({ empresaId, configVersion, definitions }) {
    this.empresaId = empresaId;
    this.configVersion = configVersion;
    this.versions = new Map(definitions.map((definition) => {
      const flowVersionId = `preview-flow:${hashId(empresaId, String(configVersion), definition.key, String(definition.version)).slice(0, 32)}`;
      return [definition.key, {
        flowId: `preview-flow-id:${hashId(empresaId, definition.key).slice(0, 24)}`,
        flowKey: definition.key,
        flowVersionId,
        flowVersion: definition.version,
        configurationVersion: configVersion,
        definition: structuredClone(definition),
      }];
    }));
    this.submissions = new Map();
    this.documents = [];
    this.counter = 0;
  }

  assertTenant(empresaId) {
    if (empresaId !== this.empresaId) fail("PREVIEW_TENANT_MISMATCH", "O fluxo pertence a outra empresa.", { status: 409 });
  }

  async findPublishedDefinition({ empresaId, flowKey, configurationVersion }) {
    this.assertTenant(empresaId);
    if (configurationVersion !== this.configVersion) return null;
    return structuredClone(this.versions.get(flowKey) || null);
  }

  async findVersionById({ empresaId, flowVersionId }) {
    this.assertTenant(empresaId);
    const version = [...this.versions.values()].find((item) => item.flowVersionId === flowVersionId);
    return structuredClone(version || null);
  }

  async startSubmission(input) {
    this.assertTenant(input.empresaId);
    const version = this.versions.get(input.flowKey);
    if (!version || version.flowVersionId !== input.expectedFlowVersionId || input.configurationVersion !== this.configVersion) {
      fail("PREVIEW_FLOW_VERSION_MISMATCH", "A versão sintética do fluxo não corresponde à revisão simulada.", { status: 409 });
    }
    const active = await this.findActiveSubmission(input);
    if (active) fail("FLOW_SUBMISSION_ALREADY_ACTIVE", "A conversa já possui um fluxo em andamento.", { status: 409 });
    this.counter += 1;
    const submission = {
      id: `preview-submission:${this.counter}`,
      empresaId: input.empresaId,
      flowId: version.flowId,
      flowVersionId: version.flowVersionId,
      flowVersion: version.flowVersion,
      configurationVersion: this.configVersion,
      conversationId: input.conversationId,
      contactId: input.contactId,
      status: input.initialState.status === "waiting_input" ? "waiting" : input.initialState.status,
      currentStepId: input.initialState.currentStepId,
      data: structuredClone(input.initialState),
      revision: 1,
    };
    this.submissions.set(submission.id, submission);
    return structuredClone({ version, submission });
  }

  async findActiveSubmission({ empresaId, conversationId }) {
    this.assertTenant(empresaId);
    const submission = [...this.submissions.values()].find((item) => (
      item.conversationId === conversationId && ["active", "waiting"].includes(item.status)
    ));
    if (!submission) return null;
    const version = [...this.versions.values()].find((item) => item.flowVersionId === submission.flowVersionId);
    return structuredClone({ version, submission });
  }

  async saveSubmission(input) {
    this.assertTenant(input.empresaId);
    const current = this.submissions.get(input.submissionId);
    if (!current || current.flowVersionId !== input.flowVersionId) {
      fail("PREVIEW_FLOW_SUBMISSION_NOT_FOUND", "A submissão sintética não foi encontrada.", { status: 404 });
    }
    if (current.revision !== input.expectedRevision) {
      fail("PREVIEW_FLOW_REVISION_CONFLICT", "A submissão sintética foi alterada por outra execução.", { status: 409 });
    }
    const next = {
      ...current,
      status: input.status,
      currentStepId: input.currentStepId,
      data: structuredClone(input.data),
      revision: current.revision + 1,
    };
    this.submissions.set(next.id, next);
    return structuredClone(next);
  }

  completeSubmission(input) {
    return this.saveSubmission({ ...input, status: "completed" });
  }

  cancelSubmission(input) {
    return this.saveSubmission({ ...input, status: "cancelled" });
  }

  async attachDocument(input) {
    this.assertTenant(input.empresaId);
    if (!this.submissions.has(input.submissionId)) {
      fail("PREVIEW_FLOW_SUBMISSION_NOT_FOUND", "A submissão sintética não foi encontrada.", { status: 404 });
    }
    this.documents.push({
      submissionId: input.submissionId,
      field: input.field,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    });
    return { attached: true };
  }

  snapshot() {
    return [...this.submissions.values()].map((submission) => ({
      flowKey: submission.data.flowKey,
      flowVersion: submission.flowVersion,
      status: submission.status,
      currentStepId: submission.currentStepId,
      documentCount: this.documents.filter((document) => document.submissionId === submission.id).length,
    }));
  }
}

function normalizeReply(outcome) {
  const text = typeof outcome?.text === "string" ? outcome.text : "";
  const buttons = Array.isArray(outcome?.buttons) ? outcome.buttons.map((button) => ({
    id: String(button.id || ""),
    label: String(button.label || ""),
    ...(button.description ? { description: String(button.description) } : {}),
  })) : [];
  return {
    source: outcome?.source === "deterministic" ? "deterministic" : "simulated",
    module: outcome?.module || null,
    text,
    buttons,
  };
}

function createSession({ actorId, empresaId, sessionId, compiled, runtimeFactory, aiSimulator, integrationSimulator, now, sessionTtlMs }) {
  const tenantHash = hashId(empresaId).slice(0, 16);
  const conversationId = `preview-conversation:${hashId(empresaId, sessionId, "conversation").slice(0, 24)}`;
  const contactId = `preview-contact:${hashId(empresaId, sessionId, "contact").slice(0, 24)}`;
  const stateRepository = new PreviewStateRepository(empresaId);
  const businessRepository = new PreviewBusinessRepository(empresaId);
  const flowRepository = new PreviewFlowRepository({
    empresaId,
    configVersion: compiled.configVersion,
    definitions: compiled.configuration.flows?.definitions || [],
  });
  const definition = materializeLegacyTenantDefinition(compiled, {
    payment: compiled.configuration.modules.includes("payments") ? {
      key: "PIX-SIMULADO-SEM-VALOR",
      recipient: "Ambiente isolado do simulador",
      instructions: "Este pagamento é apenas uma simulação e não deve ser realizado.",
    } : undefined,
  });
  const session = {
    actorId,
    empresaId,
    sessionId,
    tenantHash,
    checksum: compiled.checksum,
    compiled,
    conversationId,
    contactId,
    stateRepository,
    businessRepository,
    flowRepository,
    sequence: 0,
    revision: 0,
    processing: false,
    expiresAt: now + sessionTtlMs,
  };
  session.runtime = runtimeFactory({
    definition,
    stateRepository,
    orderRepository: businessRepository,
    appointmentRepository: businessRepository,
    handoffRepository: businessRepository,
    flowRepository,
    aiHandler: aiSimulator,
    integrationsHandler: integrationSimulator,
    logger: Object.freeze({ error() {}, warn() {}, info() {} }),
  });
  return session;
}

/**
 * Executa o mesmo compilador e runtime configurável usados pelo worker em uma
 * sessão exclusivamente em memória. Não recebe gateways nem credenciais e não
 * possui qualquer caminho de saída para Meta, OpenAI, Google ou persistência.
 */
export class PreviewService {
  #sessions;

  constructor({
    compiler = compileTenantRuntimeConfigV2,
    runtimeFactory = createConfiguredTenantRuntime,
    aiSimulator = async () => ({ reply: { text: DEFAULT_AI_REPLY, buttons: [] } }),
    integrationSimulator = async () => ({ reply: { text: DEFAULT_INTEGRATION_REPLY, buttons: [] } }),
    configurationVersionResolver = ({ draftVersion }) => draftVersion,
    clock = () => Date.now(),
    sessionTtlMs = 30 * 60 * 1_000,
    maxSessions = 100,
    maxTotalSessions = Math.max(1_000, maxSessions),
  } = {}) {
    if (![compiler, runtimeFactory, aiSimulator, integrationSimulator, configurationVersionResolver, clock]
      .every((item) => typeof item === "function")) {
      throw new TypeError("Dependências do simulador são inválidas.");
    }
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1_000 || sessionTtlMs > 24 * 60 * 60 * 1_000) {
      throw new TypeError("sessionTtlMs deve estar entre um segundo e 24 horas.");
    }
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 10_000) {
      throw new TypeError("maxSessions deve estar entre 1 e 10000.");
    }
    if (!Number.isSafeInteger(maxTotalSessions) || maxTotalSessions < maxSessions || maxTotalSessions > 100_000) {
      throw new TypeError("maxTotalSessions deve ser maior ou igual a maxSessions e no máximo 100000.");
    }
    this.compiler = compiler;
    this.runtimeFactory = runtimeFactory;
    this.aiSimulator = aiSimulator;
    this.integrationSimulator = integrationSimulator;
    this.configurationVersionResolver = configurationVersionResolver;
    this.clock = clock;
    this.sessionTtlMs = sessionTtlMs;
    this.maxSessions = maxSessions;
    this.maxTotalSessions = maxTotalSessions;
    this.#sessions = new Map();
  }

  #key(actorId, empresaId, sessionId) {
    return JSON.stringify([actorId, empresaId, sessionId]);
  }

  #now() {
    const value = this.clock();
    const timestamp = value instanceof Date ? value.getTime() : value;
    if (!Number.isFinite(timestamp) || timestamp < 0) fail("PREVIEW_CLOCK_INVALID", "O relógio do simulador é inválido.", { status: 500 });
    return timestamp;
  }

  #pruneExpired(now) {
    for (const [key, session] of this.#sessions) {
      if (!session.processing && session.expiresAt <= now) this.#sessions.delete(key);
    }
  }

  async simulate(input = {}) {
    plainObject(input, "/");
    rejectUnknownKeys(input, SIMULATE_KEYS, "");
    const { actorId, empresaId, configuration, draftVersion, sessionId, expectedSessionRevision, message } = input;
    const adminId = requiredId(actorId, "/actorId");
    const tenantId = requiredId(empresaId, "/empresaId");
    const previewSessionId = requiredId(sessionId, "/sessionId");
    const optimisticVersion = positiveInteger(draftVersion, "/draftVersion");
    const expectedRevision = nonNegativeInteger(expectedSessionRevision, "/expectedSessionRevision");
    plainObject(configuration, "/configuration");
    const revision = positiveInteger(await this.configurationVersionResolver({
      actorId: adminId,
      empresaId: tenantId,
      draftVersion: optimisticVersion,
    }), "/resolvedConfigVersion");
    const compiled = this.compiler(configuration, {
      empresaId: tenantId,
      configVersion: revision,
      draftVersion: optimisticVersion,
    });
    const now = this.#now();
    this.#pruneExpired(now);
    const key = this.#key(adminId, tenantId, previewSessionId);
    let session = this.#sessions.get(key);
    let created = false;
    if (session && session.checksum !== compiled.checksum) {
      fail(
        "PREVIEW_CONFIGURATION_CHANGED",
        "A configuração mudou durante a simulação. Reinicie a sessão antes de continuar.",
        { status: 409, details: { expectedChecksum: session.checksum, currentChecksum: compiled.checksum } },
      );
    }
    if (!session) {
      if (expectedRevision !== 0) {
        fail("PREVIEW_SESSION_REVISION_CONFLICT", "A sessão de simulação ainda não existe.", {
          status: 409,
          details: { expectedSessionRevision: expectedRevision, currentSessionRevision: 0 },
        });
      }
      const scopedSessionCount = [...this.#sessions.values()].filter(
        (candidate) => candidate.actorId === adminId && candidate.empresaId === tenantId,
      ).length;
      if (scopedSessionCount >= this.maxSessions || this.#sessions.size >= this.maxTotalSessions) {
        fail("PREVIEW_SESSION_LIMIT_REACHED", "O limite de sessões simultâneas do simulador foi atingido.", { status: 429 });
      }
      session = createSession({
        actorId: adminId,
        empresaId: tenantId,
        sessionId: previewSessionId,
        compiled,
        runtimeFactory: this.runtimeFactory,
        aiSimulator: this.aiSimulator,
        integrationSimulator: this.integrationSimulator,
        now,
        sessionTtlMs: this.sessionTtlMs,
      });
      this.#sessions.set(key, session);
      created = true;
    }
    if (session.revision !== expectedRevision) {
      fail("PREVIEW_SESSION_REVISION_CONFLICT", "A sessão foi alterada por outra requisição.", {
        status: 409,
        details: { expectedSessionRevision: expectedRevision, currentSessionRevision: session.revision },
      });
    }
    if (session.processing) fail("PREVIEW_SESSION_BUSY", "A sessão já está processando outra mensagem.", { status: 409 });
    session.processing = true;
    try {
      const runtimeInput = normalizeMessage(message, session, session.sequence + 1);
      const nextSequence = session.sequence + 1;
      const outcome = await session.runtime.handle({
        conversationId: session.conversationId,
        contactId: session.contactId,
        correlationId: `preview:${hashId(tenantId, previewSessionId, String(nextSequence)).slice(0, 24)}`,
        ...runtimeInput,
      });
      session.sequence = nextSequence;
      session.revision += 1;
      session.expiresAt = this.#now() + this.sessionTtlMs;
      const business = session.businessRepository.snapshot();
      return immutable({
        empresaId: tenantId,
        sessionId: previewSessionId,
        configVersion: compiled.configVersion,
        draftVersion: compiled.draftVersion,
        sequence: session.sequence,
        sessionRevision: session.revision,
        synthetic: true,
        simulation: {
          runtime: "configured-runtime",
          persistence: "isolated-memory",
          ai: "simulated",
          documents: "synthetic-metadata-only",
          externalCallsAllowed: false,
        },
        externalCalls: [],
        reply: normalizeReply(outcome),
        activity: {
          ...business,
          flows: session.flowRepository.snapshot(),
        },
      });
    } catch (error) {
      if (created && session.revision === 0) this.#sessions.delete(key);
      throw error;
    } finally {
      session.processing = false;
    }
  }

  resetSession(input = {}) {
    plainObject(input, "/");
    rejectUnknownKeys(input, RESET_KEYS, "");
    const { actorId, empresaId, sessionId, expectedSessionRevision } = input;
    const adminId = requiredId(actorId, "/actorId");
    const tenantId = requiredId(empresaId, "/empresaId");
    const previewSessionId = requiredId(sessionId, "/sessionId");
    const expectedRevision = nonNegativeInteger(expectedSessionRevision, "/expectedSessionRevision");
    const key = this.#key(adminId, tenantId, previewSessionId);
    const session = this.#sessions.get(key);
    if (!session) return expectedRevision === 0;
    if (session.revision !== expectedRevision) {
      fail("PREVIEW_SESSION_REVISION_CONFLICT", "A sessão foi alterada por outra requisição.", {
        status: 409,
        details: { expectedSessionRevision: expectedRevision, currentSessionRevision: session.revision },
      });
    }
    if (session.processing) fail("PREVIEW_SESSION_BUSY", "A sessão já está processando outra mensagem.", { status: 409 });
    return this.#sessions.delete(key);
  }
}

export function createPreviewService(options) {
  return new PreviewService(options);
}
