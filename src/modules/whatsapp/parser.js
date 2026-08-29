const DEFAULT_LIMITS = Object.freeze({
  entries: 100,
  changesPerEntry: 100,
  events: 1_000,
  messagesPerChange: 1_000,
  statusesPerChange: 1_000,
  errorsPerStatus: 20,
  phoneNumberId: 128,
  displayPhoneNumber: 32,
  externalMessageId: 512,
  senderPhone: 32,
  messageType: 64,
  text: 4_096,
  caption: 1_024,
  interactiveValue: 256,
  mediaId: 512,
  status: 64,
  errorTitle: 256,
});

export class WhatsAppPayloadValidationError extends Error {
  constructor(code, path) {
    super("Payload do WhatsApp inválido.");
    this.name = "WhatsAppPayloadValidationError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, path) {
  throw new WhatsAppPayloadValidationError(code, path);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value, path, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (!isRecord(value)) fail("invalid_object", path);
  return value;
}

function array(value, path, maximum, { optional = false } = {}) {
  if (value == null && optional) return [];
  if (!Array.isArray(value)) fail("invalid_array", path);
  if (value.length > maximum) fail("array_limit_exceeded", path);
  return value;
}

function string(value, path, maximum, { optional = false, allowEmpty = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== "string") fail("invalid_string", path);
  if (value.length > maximum) fail("string_limit_exceeded", path);
  if (!allowEmpty && value.trim() === "") fail("empty_string", path);
  return value;
}

function timestamp(value, path) {
  if (value == null) return null;
  const raw = string(value, path, 20);
  if (!/^\d{1,13}$/.test(raw)) fail("invalid_timestamp", path);
  const milliseconds = Number(raw) * 1_000;
  const date = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || Number.isNaN(date.getTime())) {
    fail("invalid_timestamp", path);
  }
  return date.toISOString();
}

function optionalNestedString(container, key, path, maximum) {
  if (container?.[key] == null) return null;
  return string(container[key], `${path}.${key}`, maximum, { allowEmpty: true });
}

function messageContent(message, type, path, limits) {
  if (type === "text") {
    const text = record(message.text, `${path}.text`);
    return {
      text: string(text.body, `${path}.text.body`, limits.text, { allowEmpty: true }),
      interactiveSelection: null,
      media: null,
    };
  }

  if (type === "interactive") {
    const interactive = record(message.interactive, `${path}.interactive`);
    const buttonReply = record(interactive.button_reply, `${path}.interactive.button_reply`, { optional: true });
    const listReply = record(interactive.list_reply, `${path}.interactive.list_reply`, { optional: true });
    const reply = buttonReply || listReply;
    if (!reply) fail("missing_interactive_reply", `${path}.interactive`);
    const id = optionalNestedString(reply, "id", `${path}.interactive.reply`, limits.interactiveValue);
    const title = optionalNestedString(reply, "title", `${path}.interactive.reply`, limits.interactiveValue);
    if (!id && !title) fail("missing_interactive_value", `${path}.interactive`);
    return {
      text: id || title,
      interactiveSelection: { type: buttonReply ? "button_reply" : "list_reply", id, title },
      media: null,
    };
  }

  if (type === "button") {
    const button = record(message.button, `${path}.button`);
    const id = optionalNestedString(button, "payload", `${path}.button`, limits.interactiveValue);
    const title = optionalNestedString(button, "text", `${path}.button`, limits.interactiveValue);
    if (!id && !title) fail("missing_button_value", `${path}.button`);
    return {
      text: id || title,
      interactiveSelection: { type: "button", id, title },
      media: null,
    };
  }

  if (type === "image") {
    const image = record(message.image, `${path}.image`);
    const mediaId = string(image.id, `${path}.image.id`, limits.mediaId);
    const caption = optionalNestedString(image, "caption", `${path}.image`, limits.caption) || "";
    return {
      text: caption,
      interactiveSelection: null,
      media: {
        externalId: mediaId,
        mimeType: optionalNestedString(image, "mime_type", `${path}.image`, 128),
        caption,
      },
    };
  }

  const typedPayload = record(message[type], `${path}.${type}`, { optional: true });
  const mediaId = typedPayload?.id == null
    ? null
    : string(typedPayload.id, `${path}.${type}.id`, limits.mediaId);
  return {
    text: null,
    interactiveSelection: null,
    media: mediaId ? {
      externalId: mediaId,
      mimeType: optionalNestedString(typedPayload, "mime_type", `${path}.${type}`, 128),
      caption: null,
    } : null,
  };
}

function parseMessage(messageValue, context, path, limits) {
  const message = record(messageValue, path);
  const externalMessageId = string(message.id, `${path}.id`, limits.externalMessageId);
  const senderPhone = string(message.from, `${path}.from`, limits.senderPhone);
  const messageType = string(message.type, `${path}.type`, limits.messageType);
  const content = messageContent(message, messageType, path, limits);
  return {
    kind: "message",
    source: "whatsapp",
    phoneNumberId: context.phoneNumberId,
    displayPhoneNumber: context.displayPhoneNumber,
    wabaId: context.wabaId,
    externalMessageId,
    idempotencyKey: externalMessageId,
    senderPhone,
    occurredAt: timestamp(message.timestamp, `${path}.timestamp`),
    messageType,
    ...content,
  };
}

function parseStatusError(errorValue, path, limits) {
  const error = record(errorValue, path);
  const rawCode = error.code;
  if (typeof rawCode !== "number" && typeof rawCode !== "string") {
    fail("invalid_status_error_code", `${path}.code`);
  }
  const code = String(rawCode);
  if (code.length > 64) fail("string_limit_exceeded", `${path}.code`);
  return {
    code,
    title: error.title == null
      ? null
      : string(error.title, `${path}.title`, limits.errorTitle, { allowEmpty: true }),
  };
}

function parseStatus(statusValue, context, path, limits) {
  const statusEntry = record(statusValue, path);
  const externalMessageId = string(statusEntry.id, `${path}.id`, limits.externalMessageId);
  const metaStatus = string(statusEntry.status, `${path}.status`, limits.status).toLowerCase();
  const recipientPhone = string(statusEntry.recipient_id, `${path}.recipient_id`, limits.senderPhone);
  const occurredAt = timestamp(statusEntry.timestamp, `${path}.timestamp`);
  const errors = array(statusEntry.errors, `${path}.errors`, limits.errorsPerStatus, { optional: true })
    .map((value, index) => parseStatusError(value, `${path}.errors[${index}]`, limits));
  const conversation = record(statusEntry.conversation, `${path}.conversation`, { optional: true });
  const pricing = record(statusEntry.pricing, `${path}.pricing`, { optional: true });
  const statusTimestamp = statusEntry.timestamp || "unknown";
  return {
    kind: "status",
    source: "whatsapp",
    phoneNumberId: context.phoneNumberId,
    displayPhoneNumber: context.displayPhoneNumber,
    wabaId: context.wabaId,
    externalMessageId,
    idempotencyKey: `${externalMessageId}:${metaStatus}:${statusTimestamp}`,
    recipientPhone,
    occurredAt,
    status: ["sent", "delivered", "read", "failed"].includes(metaStatus) ? metaStatus : "unknown",
    metaStatus,
    conversationExternalId: conversation?.id == null
      ? null
      : string(conversation.id, `${path}.conversation.id`, limits.externalMessageId),
    pricingCategory: pricing?.category == null
      ? null
      : string(pricing.category, `${path}.pricing.category`, 128),
    errors,
  };
}

function metadataContext(entry, change, path, limits) {
  const value = record(change.value, `${path}.value`);
  const metadata = record(value.metadata, `${path}.value.metadata`);
  return {
    value,
    phoneNumberId: string(
      metadata.phone_number_id,
      `${path}.value.metadata.phone_number_id`,
      limits.phoneNumberId,
    ),
    displayPhoneNumber: metadata.display_phone_number == null
      ? null
      : string(
        metadata.display_phone_number,
        `${path}.value.metadata.display_phone_number`,
        limits.displayPhoneNumber,
      ),
    wabaId: entry.id == null ? null : string(entry.id, `${path}.entry.id`, 128),
  };
}

export function parseWhatsAppWebhook(payload, { limits: limitOverrides = {} } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const root = record(payload, "$payload");
  const entries = array(root.entry, "$payload.entry", limits.entries, { optional: true });
  const events = [];

  entries.forEach((entryValue, entryIndex) => {
    const entry = record(entryValue, `$payload.entry[${entryIndex}]`);
    const changes = array(
      entry.changes,
      `$payload.entry[${entryIndex}].changes`,
      limits.changesPerEntry,
      { optional: true },
    );
    changes.forEach((changeValue, changeIndex) => {
      const path = `$payload.entry[${entryIndex}].changes[${changeIndex}]`;
      const change = record(changeValue, path);
      if (change.field != null && change.field !== "messages") return;
      const value = record(change.value, `${path}.value`);
      const messages = array(
        value.messages,
        `${path}.value.messages`,
        limits.messagesPerChange,
        { optional: true },
      );
      const statuses = array(
        value.statuses,
        `${path}.value.statuses`,
        limits.statusesPerChange,
        { optional: true },
      );
      if (!messages.length && !statuses.length) return;
      const context = metadataContext(entry, change, path, limits);
      messages.forEach((message, messageIndex) => {
        events.push(parseMessage(message, context, `${path}.value.messages[${messageIndex}]`, limits));
      });
      statuses.forEach((status, statusIndex) => {
        events.push(parseStatus(status, context, `${path}.value.statuses[${statusIndex}]`, limits));
      });
      if (events.length > limits.events) fail("event_limit_exceeded", "$payload");
    });
  });

  return events;
}

export { DEFAULT_LIMITS as WHATSAPP_WEBHOOK_LIMITS };
