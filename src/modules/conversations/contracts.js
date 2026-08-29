export const CONVERSATION_MODES = Object.freeze(["bot", "human", "paused"]);
export const CONVERSATION_STATUSES = Object.freeze(["open", "closed", "archived"]);
export const MESSAGE_DIRECTIONS = Object.freeze(["inbound", "outbound", "internal"]);
export const MESSAGE_TYPES = Object.freeze([
  "text",
  "image",
  "audio",
  "video",
  "document",
  "interactive",
  "status",
  "system",
]);
export const MESSAGE_ORIGINS = Object.freeze(["deterministic_flow", "ai", "operator", "system"]);
export const MESSAGE_STATUSES = Object.freeze([
  "received",
  "queued",
  "processing",
  "responded",
  "sent",
  "delivered",
  "read",
  "failed",
  "duplicate_ignored",
]);

const REQUIRED_REPOSITORY_METHODS = Object.freeze([
  "openOrResume",
  "findConversation",
  "appendMessage",
  "listMessages",
  "findState",
  "saveState",
  "setMode",
  "updateMessageStatus",
  "anonymizeMessagesBefore",
]);

const STATUS_RANK = Object.freeze({
  received: 10,
  queued: 20,
  processing: 30,
  responded: 35,
  sent: 40,
  delivered: 50,
  read: 60,
});

export class ConversationDomainError extends Error {
  constructor(message, { code = "CONVERSATION_ERROR", details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

export class ConversationNotFoundError extends ConversationDomainError {
  constructor() {
    super("Conversa não encontrada no contexto da empresa.", { code: "CONVERSATION_NOT_FOUND" });
  }
}

export class ConversationMessageNotFoundError extends ConversationDomainError {
  constructor() {
    super("Mensagem não encontrada no contexto da empresa.", { code: "CONVERSATION_MESSAGE_NOT_FOUND" });
  }
}

export class ConversationStateConflictError extends ConversationDomainError {
  constructor() {
    super("O estado da conversa foi alterado por outro processamento.", { code: "CONVERSATION_STATE_CONFLICT" });
  }
}

export function requireTenantId(input) {
  const empresaId = String(input?.empresaId || "").trim();
  if (!empresaId) {
    throw new ConversationDomainError("empresaId é obrigatório.", { code: "TENANT_REQUIRED" });
  }
  return empresaId;
}

export function requiredText(value, fieldName, { max = 500 } = {}) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > max) {
    throw new ConversationDomainError(`${fieldName} é obrigatório e deve ter no máximo ${max} caracteres.`, {
      code: "INVALID_CONVERSATION_INPUT",
      details: { field: fieldName },
    });
  }
  return normalized;
}

export function normalizePhone(value) {
  const normalized = String(value || "").replace(/\D/gu, "");
  if (!/^[1-9][0-9]{7,14}$/u.test(normalized)) {
    throw new ConversationDomainError("Telefone deve estar no formato internacional, somente com dígitos.", {
      code: "INVALID_PHONE",
    });
  }
  return normalized;
}

export function positiveInteger(value, fieldName, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw new ConversationDomainError(`${fieldName} deve ser um inteiro entre 1 e ${max}.`, {
      code: "INVALID_CONVERSATION_INPUT",
      details: { field: fieldName },
    });
  }
  return number;
}

export function validDate(value, fieldName) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ConversationDomainError(`${fieldName} deve ser uma data válida.`, {
      code: "INVALID_CONVERSATION_INPUT",
      details: { field: fieldName },
    });
  }
  return date;
}

export function oneOf(value, allowed, fieldName) {
  if (!allowed.includes(value)) {
    throw new ConversationDomainError(`${fieldName} possui valor inválido.`, {
      code: "INVALID_CONVERSATION_INPUT",
      details: { field: fieldName, allowed },
    });
  }
  return value;
}

export function assertConversationRepository(repository) {
  for (const method of REQUIRED_REPOSITORY_METHODS) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`Repositório de conversas deve implementar ${method}().`);
    }
  }
  return repository;
}

/**
 * Retorna true apenas para avanços válidos do ciclo de vida. `failed` e
 * `duplicate_ignored` são terminais; uma falha Meta tardia não regride uma
 * mensagem já entregue ou lida.
 */
export function canAdvanceMessageStatus(current, next) {
  oneOf(current, MESSAGE_STATUSES, "currentStatus");
  oneOf(next, MESSAGE_STATUSES, "nextStatus");
  if (current === next) return false;
  if (current === "failed" || current === "duplicate_ignored") return false;
  if (next === "duplicate_ignored") return current === "received";
  if (next === "failed") return (STATUS_RANK[current] ?? 0) <= STATUS_RANK.sent;
  if (current === "failed" || next === "failed") return false;
  return (STATUS_RANK[next] ?? 0) > (STATUS_RANK[current] ?? 0);
}
