import { randomUUID } from "node:crypto";
import {
  ConversationNotFoundError,
  ConversationStateConflictError,
  canAdvanceMessageStatus,
  requireTenantId,
} from "./contracts.js";

const ALLOWED_ENVIRONMENTS = new Set(["development", "test"]);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function scoped(empresaId, id) {
  return `${empresaId}:${id}`;
}

function statusTimestampField(status) {
  return ({
    queued: "enqueuedAt",
    processing: "processingAt",
    responded: "respondedAt",
    sent: "sentAt",
    delivered: "deliveredAt",
    read: "readAt",
  })[status] || null;
}

function maskedPhone(phone) {
  return `••••${phone.slice(-4)}`;
}

export class MemoryConversationRepository {
  constructor({ environment = process.env.NODE_ENV, idFactory = randomUUID } = {}) {
    if (!ALLOWED_ENVIRONMENTS.has(environment)) {
      throw new Error("MemoryConversationRepository é permitido apenas em development ou test.");
    }
    if (typeof idFactory !== "function") throw new TypeError("idFactory deve ser uma função.");
    this.idFactory = idFactory;
    this.contacts = new Map();
    this.conversations = new Map();
    this.states = new Map();
    this.messages = new Map();
    this.externalMessages = new Map();
  }

  async openOrResume(input) {
    const empresaId = requireTenantId(input);
    const contactKey = `${empresaId}:${input.phone}`;
    const occurredAt = new Date(input.occurredAt);
    let contact = this.contacts.get(contactKey);
    if (!contact) {
      contact = {
        id: this.idFactory(),
        empresaId,
        phone: input.phone,
        maskedPhone: maskedPhone(input.phone),
        firstInteractionAt: occurredAt,
        lastInteractionAt: occurredAt,
        anonymizedAt: null,
      };
      this.contacts.set(contactKey, contact);
    } else if (occurredAt > contact.lastInteractionAt) {
      contact.lastInteractionAt = occurredAt;
    }

    const existing = [...this.conversations.values()].find((conversation) => (
      conversation.empresaId === empresaId
      && conversation.contactId === contact.id
      && conversation.numeroWhatsappId === input.numeroWhatsappId
      && conversation.status === "open"
    ));
    if (existing) return { contact: clone(contact), conversation: clone(existing) };

    const conversation = {
      id: this.idFactory(),
      empresaId,
      contactId: contact.id,
      numeroWhatsappId: input.numeroWhatsappId,
      status: "open",
      mode: "bot",
      operatorId: null,
      correlationId: input.correlationId || this.idFactory(),
      nextSequence: 1,
      version: 1,
      openedAt: occurredAt,
      closedAt: null,
      lastMessageAt: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };
    this.conversations.set(scoped(empresaId, conversation.id), conversation);
    this.states.set(scoped(empresaId, conversation.id), {
      empresaId,
      conversationId: conversation.id,
      flowKey: "main_menu",
      stage: "start",
      eventId: null,
      orderId: null,
      receiptMessageId: null,
      data: {},
      version: 1,
      expiresAt: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    return { contact: clone(contact), conversation: clone(conversation) };
  }

  async findConversation(input) {
    const empresaId = requireTenantId(input);
    return clone(this.conversations.get(scoped(empresaId, input.conversationId)) || null);
  }

  async appendMessage(input) {
    const empresaId = requireTenantId(input);
    const conversation = this.conversations.get(scoped(empresaId, input.conversationId));
    if (!conversation) throw new ConversationNotFoundError();

    if (input.externalMessageId) {
      const externalKey = scoped(empresaId, input.externalMessageId);
      const existingId = this.externalMessages.get(externalKey);
      if (existingId) return { ...clone(this.messages.get(scoped(empresaId, existingId))), inserted: false };
    }

    const createdAt = new Date(input.createdAt);
    const sequence = conversation.nextSequence;
    conversation.nextSequence += 1;
    conversation.version += 1;
    conversation.lastMessageAt = createdAt;
    conversation.updatedAt = createdAt;
    const message = {
      id: this.idFactory(),
      empresaId,
      conversationId: conversation.id,
      contactId: conversation.contactId,
      numeroWhatsappId: conversation.numeroWhatsappId,
      direction: input.direction,
      type: input.type,
      body: input.body,
      mediaExternalId: input.mediaExternalId,
      mediaStorageKey: input.mediaStorageKey,
      externalMessageId: input.externalMessageId,
      status: input.status,
      origin: input.origin,
      sequence,
      providerTimestamp: clone(input.providerTimestamp),
      attempts: 0,
      errorCode: null,
      errorSanitized: null,
      operatorId: input.operatorId,
      correlationId: input.correlationId,
      enqueuedAt: null,
      processingAt: null,
      respondedAt: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      redactedAt: null,
      expiresAt: clone(input.expiresAt),
      createdAt,
      updatedAt: createdAt,
      inserted: true,
    };
    const timestampField = statusTimestampField(input.status);
    if (timestampField) message[timestampField] = createdAt;
    this.messages.set(scoped(empresaId, message.id), message);
    if (input.externalMessageId) {
      this.externalMessages.set(scoped(empresaId, input.externalMessageId), message.id);
    }
    return clone(message);
  }

  async listMessages(input) {
    const empresaId = requireTenantId(input);
    if (!this.conversations.has(scoped(empresaId, input.conversationId))) {
      throw new ConversationNotFoundError();
    }
    const beforeSequence = input.beforeSequence ?? Number.POSITIVE_INFINITY;
    return [...this.messages.values()]
      .filter((message) => (
        message.empresaId === empresaId
        && message.conversationId === input.conversationId
        && message.sequence < beforeSequence
      ))
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, input.limit)
      .reverse()
      .map(clone);
  }

  async findState(input) {
    const empresaId = requireTenantId(input);
    return clone(this.states.get(scoped(empresaId, input.conversationId)) || null);
  }

  async saveState(input) {
    const empresaId = requireTenantId(input);
    const key = scoped(empresaId, input.conversationId);
    const current = this.states.get(key);
    if (!current) throw new ConversationNotFoundError();
    if (current.version !== input.expectedVersion) throw new ConversationStateConflictError();
    const next = {
      ...current,
      flowKey: input.flowKey,
      stage: input.stage,
      eventId: input.eventId,
      orderId: input.orderId,
      receiptMessageId: input.receiptMessageId,
      data: clone(input.data),
      expiresAt: clone(input.expiresAt),
      version: current.version + 1,
      updatedAt: new Date(input.updatedAt),
    };
    this.states.set(key, next);
    return clone(next);
  }

  async setMode(input) {
    const empresaId = requireTenantId(input);
    const key = scoped(empresaId, input.conversationId);
    const conversation = this.conversations.get(key);
    if (!conversation) return null;
    const previous = clone(conversation);
    input.transaction?.registerRollback?.(() => this.conversations.set(key, previous));
    conversation.mode = input.mode;
    conversation.operatorId = input.operatorId;
    conversation.version += 1;
    conversation.updatedAt = new Date(input.updatedAt);
    return clone(conversation);
  }

  async updateMessageStatus(input) {
    const empresaId = requireTenantId(input);
    const messageId = this.externalMessages.get(scoped(empresaId, input.externalMessageId));
    const message = messageId ? this.messages.get(scoped(empresaId, messageId)) : null;
    if (!message) return null;
    if (!canAdvanceMessageStatus(message.status, input.status)) {
      return { ...clone(message), changed: false };
    }
    message.status = input.status;
    message.providerTimestamp = new Date(input.occurredAt);
    message.updatedAt = new Date(input.occurredAt);
    message.errorCode = input.status === "failed" ? input.errorCode : null;
    message.errorSanitized = input.status === "failed" ? input.errorSanitized : null;
    const timestampField = statusTimestampField(input.status);
    if (timestampField) message[timestampField] = new Date(input.occurredAt);
    return { ...clone(message), changed: true };
  }

  async anonymizeMessagesBefore(input) {
    const empresaId = requireTenantId(input);
    const candidates = [...this.messages.values()]
      .filter((message) => (
        message.empresaId === empresaId
        && !message.redactedAt
        && message.createdAt < input.before
      ))
      .sort((left, right) => left.createdAt - right.createdAt || left.sequence - right.sequence)
      .slice(0, input.limit);
    for (const message of candidates) {
      message.body = null;
      message.mediaExternalId = null;
      message.mediaStorageKey = null;
      message.errorCode = null;
      message.errorSanitized = null;
      message.redactedAt = new Date(input.redactedAt);
      message.updatedAt = new Date(input.redactedAt);
    }
    return { anonymized: candidates.length, messageIds: candidates.map(({ id }) => id) };
  }
}
