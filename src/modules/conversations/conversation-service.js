import {
  CONVERSATION_MODES,
  ConversationMessageNotFoundError,
  ConversationNotFoundError,
  MESSAGE_DIRECTIONS,
  MESSAGE_ORIGINS,
  MESSAGE_STATUSES,
  MESSAGE_TYPES,
  assertConversationRepository,
  normalizePhone,
  oneOf,
  positiveInteger,
  requiredText,
  requireTenantId,
  validDate,
} from "./contracts.js";

const DEFAULT_HISTORY_LIMIT = 8;
const MAX_HISTORY_LIMIT = 100;
const MAX_RETENTION_BATCH = 1_000;

function optionalDate(value, fallback, fieldName) {
  return validDate(value ?? fallback, fieldName);
}

function ensurePlainObject(value, fieldName) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${fieldName} deve ser um objeto.`);
  }
  return structuredClone(value);
}

export class ConversationService {
  constructor({ repository, clock = () => new Date() } = {}) {
    this.repository = assertConversationRepository(repository);
    if (typeof clock !== "function") throw new TypeError("clock deve ser uma função.");
    this.clock = clock;
  }

  async openOrResume(input) {
    const empresaId = requireTenantId(input);
    return this.repository.openOrResume({
      empresaId,
      phone: normalizePhone(input.phone),
      numeroWhatsappId: requiredText(input.numeroWhatsappId, "numeroWhatsappId"),
      correlationId: input.correlationId == null ? null : requiredText(input.correlationId, "correlationId"),
      occurredAt: optionalDate(input.occurredAt, this.clock(), "occurredAt"),
    });
  }

  async getConversation(input) {
    const empresaId = requireTenantId(input);
    const conversation = await this.repository.findConversation({
      empresaId,
      conversationId: requiredText(input.conversationId, "conversationId"),
    });
    if (!conversation) throw new ConversationNotFoundError();
    return conversation;
  }

  async recordMessage(input) {
    const empresaId = requireTenantId(input);
    const direction = oneOf(input.direction, MESSAGE_DIRECTIONS, "direction");
    const defaultStatus = direction === "inbound" ? "received" : "responded";
    return this.repository.appendMessage({
      empresaId,
      conversationId: requiredText(input.conversationId, "conversationId"),
      direction,
      type: oneOf(input.type ?? "text", MESSAGE_TYPES, "type"),
      body: input.body == null ? null : String(input.body),
      mediaExternalId: input.mediaExternalId == null ? null : String(input.mediaExternalId),
      mediaStorageKey: input.mediaStorageKey == null ? null : String(input.mediaStorageKey),
      externalMessageId: input.externalMessageId == null ? null : String(input.externalMessageId),
      status: oneOf(input.status ?? defaultStatus, MESSAGE_STATUSES, "status"),
      origin: input.origin == null ? null : oneOf(input.origin, MESSAGE_ORIGINS, "origin"),
      operatorId: input.operatorId == null ? null : String(input.operatorId),
      correlationId: requiredText(input.correlationId, "correlationId"),
      providerTimestamp: input.providerTimestamp == null
        ? null
        : validDate(input.providerTimestamp, "providerTimestamp"),
      createdAt: optionalDate(input.createdAt, this.clock(), "createdAt"),
      expiresAt: input.expiresAt == null ? null : validDate(input.expiresAt, "expiresAt"),
    });
  }

  async getHistory(input) {
    const empresaId = requireTenantId(input);
    const limit = positiveInteger(input.limit ?? DEFAULT_HISTORY_LIMIT, "limit", { max: MAX_HISTORY_LIMIT });
    const conversationId = requiredText(input.conversationId, "conversationId");
    const conversation = await this.repository.findConversation({ empresaId, conversationId });
    if (!conversation) throw new ConversationNotFoundError();
    return this.repository.listMessages({
      empresaId,
      conversationId,
      limit,
      beforeSequence: input.beforeSequence == null
        ? null
        : positiveInteger(input.beforeSequence, "beforeSequence"),
    });
  }

  async getState(input) {
    const empresaId = requireTenantId(input);
    const conversationId = requiredText(input.conversationId, "conversationId");
    const state = await this.repository.findState({ empresaId, conversationId });
    if (!state) throw new ConversationNotFoundError();
    return state;
  }

  async saveState(input) {
    const empresaId = requireTenantId(input);
    return this.repository.saveState({
      empresaId,
      conversationId: requiredText(input.conversationId, "conversationId"),
      expectedVersion: positiveInteger(input.expectedVersion, "expectedVersion"),
      flowKey: requiredText(input.flowKey, "flowKey"),
      stage: requiredText(input.stage, "stage"),
      eventId: input.eventId == null ? null : String(input.eventId),
      orderId: input.orderId == null ? null : String(input.orderId),
      receiptMessageId: input.receiptMessageId == null ? null : String(input.receiptMessageId),
      data: ensurePlainObject(input.data, "data"),
      expiresAt: input.expiresAt == null ? null : validDate(input.expiresAt, "expiresAt"),
      updatedAt: this.clock(),
    });
  }

  async handoffToHuman(input) {
    return this.#setMode(input, "human", requiredText(input.operatorId, "operatorId"));
  }

  async pauseBot(input) {
    return this.#setMode(input, "paused", input.operatorId == null ? null : String(input.operatorId));
  }

  async resumeBot(input) {
    return this.#setMode(input, "bot", null);
  }

  async #setMode(input, mode, operatorId) {
    const empresaId = requireTenantId(input);
    oneOf(mode, CONVERSATION_MODES, "mode");
    const conversation = await this.repository.setMode({
      empresaId,
      conversationId: requiredText(input.conversationId, "conversationId"),
      mode,
      operatorId,
      updatedAt: this.clock(),
      transaction: input.transaction,
    });
    if (!conversation) throw new ConversationNotFoundError();
    return conversation;
  }

  async applyMetaStatus(input) {
    const empresaId = requireTenantId(input);
    const result = await this.repository.updateMessageStatus({
      empresaId,
      externalMessageId: requiredText(input.externalMessageId, "externalMessageId"),
      status: oneOf(input.status, ["sent", "delivered", "read", "failed"], "status"),
      occurredAt: optionalDate(input.occurredAt, this.clock(), "occurredAt"),
      errorCode: input.errorCode == null ? null : String(input.errorCode).slice(0, 100),
      errorSanitized: input.errorSanitized == null ? null : String(input.errorSanitized).slice(0, 1_000),
    });
    if (!result) throw new ConversationMessageNotFoundError();
    return result;
  }

  async anonymizeExpired(input) {
    const empresaId = requireTenantId(input);
    const retentionDays = positiveInteger(input.retentionDays, "retentionDays", { max: 3_650 });
    const batchSize = positiveInteger(input.batchSize ?? 100, "batchSize", { max: MAX_RETENTION_BATCH });
    const before = new Date(this.clock().getTime() - retentionDays * 86_400_000);
    return this.repository.anonymizeMessagesBefore({
      empresaId,
      before,
      limit: batchSize,
      redactedAt: this.clock(),
    });
  }
}
