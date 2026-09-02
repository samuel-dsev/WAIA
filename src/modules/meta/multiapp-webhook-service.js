import { createHmac, timingSafeEqual } from "node:crypto";
import {
  parseWhatsAppWebhook,
  WhatsAppPayloadValidationError,
} from "../whatsapp/parser.js";

const DEFAULT_ROTATION_WINDOW_MS = 15 * 60 * 1_000;
const MAX_ROTATION_WINDOW_MS = 60 * 60 * 1_000;
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{16,200}$/u;

const PUBLIC_ERRORS = Object.freeze({
  META_WEBHOOK_NOT_FOUND: Object.freeze({
    statusCode: 404,
    message: "Webhook Meta não encontrado.",
  }),
  META_WEBHOOK_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "Webhook Meta temporariamente indisponível.",
  }),
  META_WEBHOOK_SIGNATURE_INVALID: Object.freeze({
    statusCode: 401,
    message: "Assinatura do webhook Meta inválida.",
  }),
  META_WEBHOOK_PAYLOAD_INVALID: Object.freeze({
    statusCode: 400,
    message: "Payload do webhook Meta inválido.",
  }),
  META_WEBHOOK_CONNECTION_MISMATCH: Object.freeze({
    statusCode: 403,
    message: "Webhook Meta não autorizado para esta conexão.",
  }),
  META_WEBHOOK_VERIFICATION_FAILED: Object.freeze({
    statusCode: 403,
    message: "Verificação do webhook Meta recusada.",
  }),
  META_WEBHOOK_INGESTION_FAILED: Object.freeze({
    statusCode: 503,
    message: "Webhook Meta temporariamente indisponível.",
  }),
});

export class MetaMultiAppWebhookError extends Error {
  constructor(code) {
    const descriptor = PUBLIC_ERRORS[code] || PUBLIC_ERRORS.META_WEBHOOK_UNAVAILABLE;
    super(descriptor.message);
    this.name = "MetaMultiAppWebhookError";
    this.code = PUBLIC_ERRORS[code] ? code : "META_WEBHOOK_UNAVAILABLE";
    this.statusCode = descriptor.statusCode;
  }

  toJSON() {
    return Object.freeze({
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
    });
  }
}

function fail(code) {
  throw new MetaMultiAppWebhookError(code);
}

function requireMethod(target, method, dependency) {
  if (typeof target?.[method] !== "function") {
    throw new TypeError(`${dependency}.${method} é obrigatório.`);
  }
}

function normalizedPublicId(value) {
  if (typeof value !== "string" || !PUBLIC_ID_PATTERN.test(value)) {
    fail("META_WEBHOOK_NOT_FOUND");
  }
  return value;
}

function isActive(value) {
  return value === true || value === "active" || value === "ativo";
}

function connectionState(connection) {
  return connection?.state ?? connection?.status ?? connection?.estado ?? null;
}

function canVerifySubscription(connection) {
  const state = String(connectionState(connection) || "").toLowerCase();
  return !["inactive", "inativo", "revoked", "revogado"].includes(state);
}

function normalizedIdentifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    ? value
    : null;
}

function connectionWabaIds(connection) {
  const identifiers = [
    connection?.wabaId,
    ...(Array.isArray(connection?.wabaIds) ? connection.wabaIds : []),
    ...(Array.isArray(connection?.numbers) ? connection.numbers.map((number) => number?.wabaId) : []),
  ].map(normalizedIdentifier).filter(Boolean);
  return new Set(identifiers);
}

function connectionNumbers(connection) {
  const entries = [];
  if (connection?.phoneNumberId) {
    entries.push({
      phoneNumberId: connection.phoneNumberId,
      numeroWhatsappId: connection.numeroWhatsappId ?? null,
      status: connection.numberStatus ?? "active",
    });
  }
  if (Array.isArray(connection?.phoneNumberIds)) {
    entries.push(...connection.phoneNumberIds.map((phoneNumberId) => ({
      phoneNumberId,
      numeroWhatsappId: null,
      status: "active",
    })));
  }
  if (Array.isArray(connection?.numbers)) entries.push(...connection.numbers);

  const unique = new Map();
  for (const entry of entries) {
    const phoneNumberId = normalizedIdentifier(
      typeof entry === "string" ? entry : entry?.phoneNumberId,
    );
    const status = typeof entry === "string" ? "active" : entry?.status ?? "active";
    if (!phoneNumberId || !isActive(status)) continue;
    unique.set(phoneNumberId, Object.freeze({
      phoneNumberId,
      numeroWhatsappId: typeof entry === "string" ? null : entry?.numeroWhatsappId ?? entry?.id ?? null,
    }));
  }
  return unique;
}

function validatedConnection(connection, { verification = false } = {}) {
  if (!connection || !normalizedIdentifier(connection.empresaId)) {
    fail("META_WEBHOOK_NOT_FOUND");
  }
  if (verification ? !canVerifySubscription(connection) : !isActive(connectionState(connection))) {
    fail("META_WEBHOOK_NOT_FOUND");
  }
  const wabaIds = connectionWabaIds(connection);
  const numbers = connectionNumbers(connection);
  if (verification) {
    if (!normalizedIdentifier(connection.verifyTokenCredentialId)) fail("META_WEBHOOK_UNAVAILABLE");
  } else if (!normalizedIdentifier(connection.appSecretCredentialId) || wabaIds.size === 0 || numbers.size === 0) {
    fail("META_WEBHOOK_UNAVAILABLE");
  }
  return { connection, wabaIds, numbers };
}

function signatureDigest(signature) {
  if (typeof signature !== "string" || !/^sha256=[a-f\d]{64}$/iu.test(signature)) return null;
  return Buffer.from(signature.slice(7), "hex");
}

function secretBuffer(secret) {
  if (typeof secret === "string" && secret.length > 0) return Buffer.from(secret, "utf8");
  if (Buffer.isBuffer(secret) && secret.length > 0) return Buffer.from(secret);
  return null;
}

function isUsableSecret(secret) {
  return (typeof secret === "string" && secret.length > 0)
    || (Buffer.isBuffer(secret) && secret.length > 0);
}

function validHmac({ rawBody, signature, secrets }) {
  const received = signatureDigest(signature);
  if (!received || !Buffer.isBuffer(rawBody)) return false;
  let valid = false;
  for (const secret of secrets) {
    const key = secretBuffer(secret);
    if (!key) continue;
    try {
      const expected = createHmac("sha256", key).update(rawBody).digest();
      valid = timingSafeEqual(received, expected) || valid;
    } finally {
      key.fill(0);
    }
  }
  return valid;
}

function validRotationWindow(connection, now, maximumWindowMs) {
  if (!normalizedIdentifier(connection?.previousAppSecretCredentialId)) return false;
  const startedAt = new Date(
    connection.previousAppSecretValidFrom
      ?? connection.appSecretRotatedAt
      ?? connection.updatedAt
      ?? Number.NaN,
  ).getTime();
  const configuredUntil = new Date(connection.previousAppSecretValidUntil ?? Number.NaN).getTime();
  const current = now.getTime();
  if (![startedAt, configuredUntil, current].every(Number.isFinite)) return false;
  const effectiveUntil = Math.min(configuredUntil, startedAt + maximumWindowMs);
  return current >= startedAt && current < effectiveUntil;
}

function parseRawPayload(rawBody, parser) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) fail("META_WEBHOOK_PAYLOAD_INVALID");
  try {
    const payload = JSON.parse(rawBody.toString("utf8"));
    return { payload, events: parser(payload) };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof WhatsAppPayloadValidationError) {
      fail("META_WEBHOOK_PAYLOAD_INVALID");
    }
    throw error;
  }
}

function assertPayloadBelongsToConnection(payload, wabaIds, numbers) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.entry)) return;
  for (const entry of payload.entry) {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!change || typeof change !== "object" || (change.field != null && change.field !== "messages")) continue;
      const metadata = change.value?.metadata;
      if (!wabaIds.has(entry.id) || !numbers.has(metadata?.phone_number_id)) {
        fail("META_WEBHOOK_CONNECTION_MISMATCH");
      }
    }
  }
}

function assertEventsBelongToConnection(events, wabaIds, numbers) {
  if (!Array.isArray(events)) fail("META_WEBHOOK_PAYLOAD_INVALID");
  for (const event of events) {
    if (!wabaIds.has(event?.wabaId) || !numbers.has(event?.phoneNumberId)) {
      fail("META_WEBHOOK_CONNECTION_MISMATCH");
    }
  }
}

function metaContext(connection, wabaIds, numbers) {
  return Object.freeze({
    empresaId: connection.empresaId,
    metaApplicationId: connection.id ?? connection.metaApplicationId ?? null,
    wabaIds: Object.freeze([...wabaIds]),
    numbers: Object.freeze([...numbers.values()]),
  });
}

function equalText(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string" || expected.length === 0) return false;
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeLog(logger, level, event, correlationId, code) {
  logger?.[level]?.(event, {
    correlationId: typeof correlationId === "string" ? correlationId : null,
    code,
  });
}

/**
 * Dependências esperadas:
 * - connectionResolver.resolveByWebhookPublicId(webhookPublicId) -> conexão Meta tenant-scoped.
 * - credentialVault.getCredentialForUse({ empresaId, credentialId }) -> string ou Buffer.
 * - ingestionService.ingestEvents(events, { correlationId, metaContext }).
 */
export function createMetaMultiAppWebhookService({
  connectionResolver,
  credentialVault,
  ingestionService,
  parser = parseWhatsAppWebhook,
  logger = console,
  clock = () => new Date(),
  rotationWindowMs = DEFAULT_ROTATION_WINDOW_MS,
} = {}) {
  requireMethod(connectionResolver, "resolveByWebhookPublicId", "connectionResolver");
  requireMethod(credentialVault, "getCredentialForUse", "credentialVault");
  requireMethod(ingestionService, "ingestEvents", "ingestionService");
  if (typeof parser !== "function") throw new TypeError("parser é obrigatório.");
  if (!Number.isInteger(rotationWindowMs) || rotationWindowMs < 1_000 || rotationWindowMs > MAX_ROTATION_WINDOW_MS) {
    throw new TypeError("rotationWindowMs deve estar entre 1 segundo e 1 hora.");
  }

  async function resolve(webhookPublicId, options) {
    const publicId = normalizedPublicId(webhookPublicId);
    let connection;
    try {
      connection = await connectionResolver.resolveByWebhookPublicId(publicId);
    } catch {
      fail("META_WEBHOOK_UNAVAILABLE");
    }
    return validatedConnection(connection, options);
  }

  async function currentSecret(connection, credentialId) {
    try {
      const secret = await credentialVault.getCredentialForUse({
        empresaId: connection.empresaId,
        credentialId,
      });
      if (!isUsableSecret(secret)) fail("META_WEBHOOK_UNAVAILABLE");
      return secret;
    } catch (error) {
      if (error instanceof MetaMultiAppWebhookError) throw error;
      fail("META_WEBHOOK_UNAVAILABLE");
    }
  }

  async function appSecrets(connection) {
    const secrets = [await currentSecret(connection, connection.appSecretCredentialId)];
    if (validRotationWindow(connection, clock(), rotationWindowMs)) {
      try {
        secrets.push(await currentSecret(connection, connection.previousAppSecretCredentialId));
      } catch (error) {
        if (!(error instanceof MetaMultiAppWebhookError)) throw error;
      }
    }
    return secrets;
  }

  async function ingest({ webhookPublicId, rawBody, signature, correlationId } = {}) {
    try {
      const resolved = await resolve(webhookPublicId);
      const secrets = await appSecrets(resolved.connection);
      if (!validHmac({ rawBody, signature, secrets })) {
        fail("META_WEBHOOK_SIGNATURE_INVALID");
      }
      const { payload, events } = parseRawPayload(rawBody, parser);
      assertPayloadBelongsToConnection(payload, resolved.wabaIds, resolved.numbers);
      assertEventsBelongToConnection(events, resolved.wabaIds, resolved.numbers);
      try {
        await ingestionService.ingestEvents(events, {
          correlationId,
          metaContext: metaContext(resolved.connection, resolved.wabaIds, resolved.numbers),
        });
      } catch {
        fail("META_WEBHOOK_INGESTION_FAILED");
      }
      return Object.freeze({ accepted: true, eventCount: events.length });
    } catch (error) {
      const publicError = error instanceof MetaMultiAppWebhookError
        ? error
        : new MetaMultiAppWebhookError("META_WEBHOOK_UNAVAILABLE");
      safeLog(
        logger,
        publicError.statusCode >= 500 ? "error" : "warn",
        "meta_multiapp_webhook_rejected",
        correlationId,
        publicError.code,
      );
      throw publicError;
    }
  }

  async function verifySubscription({
    webhookPublicId,
    mode,
    verifyToken,
    challenge,
    correlationId,
  } = {}) {
    try {
      if (mode !== "subscribe" || typeof challenge !== "string" || challenge.length > 2_048) {
        fail("META_WEBHOOK_VERIFICATION_FAILED");
      }
      const resolved = await resolve(webhookPublicId, { verification: true });
      const credentialId = normalizedIdentifier(resolved.connection.verifyTokenCredentialId);
      if (!credentialId) fail("META_WEBHOOK_UNAVAILABLE");
      const expected = await currentSecret(resolved.connection, credentialId);
      const expectedText = Buffer.isBuffer(expected) ? expected.toString("utf8") : expected;
      if (!equalText(verifyToken, expectedText)) fail("META_WEBHOOK_VERIFICATION_FAILED");
      return challenge;
    } catch (error) {
      const publicError = error instanceof MetaMultiAppWebhookError
        ? error
        : new MetaMultiAppWebhookError("META_WEBHOOK_UNAVAILABLE");
      safeLog(
        logger,
        publicError.statusCode >= 500 ? "error" : "warn",
        "meta_multiapp_verification_rejected",
        correlationId,
        publicError.code,
      );
      throw publicError;
    }
  }

  return Object.freeze({ ingest, verifySubscription });
}

export {
  DEFAULT_ROTATION_WINDOW_MS,
  MAX_ROTATION_WINDOW_MS,
};
