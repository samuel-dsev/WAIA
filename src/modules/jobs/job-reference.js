import { sanitizeError } from "../../security/redaction.js";

const ALLOWED_FIELDS = new Set([
  "jobId",
  "empresaId",
  "conversationId",
  "messageId",
  "statusEventId",
  "orderId",
  "type",
  "correlationId",
  "payloadVersion",
]);

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new TypeError(`${field} deve ser uma string não vazia de até 200 caracteres.`);
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value == null || value === "") return null;
  return requiredString(value, field);
}

export function normalizeJobReference(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Referência de job inválida.");
  }
  for (const field of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(field)) {
      throw new TypeError(`Jobs devem carregar somente IDs; campo não permitido: ${field}.`);
    }
  }
  const payloadVersion = Number(input.payloadVersion ?? 1);
  if (!Number.isInteger(payloadVersion) || payloadVersion < 1) {
    throw new TypeError("payloadVersion deve ser um inteiro positivo.");
  }
  const normalized = {
    jobId: requiredString(input.jobId, "jobId"),
    empresaId: requiredString(input.empresaId, "empresaId"),
    conversationId: optionalString(input.conversationId, "conversationId"),
    messageId: optionalString(input.messageId, "messageId"),
    statusEventId: optionalString(input.statusEventId, "statusEventId"),
    orderId: optionalString(input.orderId, "orderId"),
    type: requiredString(input.type, "type"),
    correlationId: requiredString(input.correlationId, "correlationId"),
    payloadVersion,
  };
  if (["process_inbound_message", "send_human_message"].includes(normalized.type)
      && (!normalized.conversationId || !normalized.messageId)) {
    throw new TypeError("Job de mensagem exige conversationId e messageId.");
  }
  if (normalized.type === "apply_whatsapp_status" && !normalized.statusEventId) {
    throw new TypeError("Job de status exige statusEventId.");
  }
  if (normalized.type === "export_google_sheets_order" && !normalized.orderId) {
    throw new TypeError("Job de exportação Google Sheets exige orderId.");
  }
  return Object.freeze(normalized);
}

export function queueJobId(reference) {
  const job = normalizeJobReference(reference);
  return `${job.empresaId}__${job.jobId}`;
}

export function sanitizeJobError(error) {
  const redacted = sanitizeError(error);
  const code = typeof redacted.code === "string"
    ? redacted.code.replace(/[^A-Z0-9_.-]/giu, "_").slice(0, 100)
    : "JOB_PROCESSING_ERROR";
  const message = typeof redacted.message === "string"
    ? redacted.message.replace(/[\r\n\t]+/gu, " ").slice(0, 500)
    : "Falha no processamento do job.";
  return { code, message };
}

export class RetryableJobError extends Error {
  constructor(message, code = "JOB_RETRYABLE") {
    super(message);
    this.name = "RetryableJobError";
    this.code = code;
    this.retryable = true;
  }
}
