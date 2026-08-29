import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  parseWhatsAppWebhook,
  WhatsAppPayloadValidationError,
} from "../whatsapp/parser.js";

function requestSignature(request) {
  return request.get?.("x-hub-signature-256")
    ?? request.headers?.["x-hub-signature-256"]
    ?? null;
}

function requestCorrelationId(request) {
  return request.context?.correlationId || request.correlationId || randomUUID();
}

function parsedPayload(request) {
  if (Buffer.isBuffer(request.body)) {
    return JSON.parse(request.body.toString("utf8"));
  }
  if (typeof request.body === "string") return JSON.parse(request.body);
  return request.body;
}

function rawBody(request) {
  if (Buffer.isBuffer(request.rawBody) || typeof request.rawBody === "string") {
    return request.rawBody;
  }
  if (Buffer.isBuffer(request.body) || typeof request.body === "string") return request.body;
  return null;
}

export function createWebhookHandler({
  signatureVerifier,
  ingestionService,
  parser = parseWhatsAppWebhook,
  logger = console,
} = {}) {
  if (typeof signatureVerifier?.verify !== "function") {
    throw new TypeError("signatureVerifier.verify é obrigatório.");
  }
  if (typeof ingestionService?.ingestEvents !== "function") {
    throw new TypeError("ingestionService.ingestEvents é obrigatório.");
  }

  return async function webhookHandler(request, response) {
    const correlationId = requestCorrelationId(request);
    try {
      const validSignature = await signatureVerifier.verify({
        rawBody: rawBody(request),
        signature: requestSignature(request),
      });
      if (!validSignature) {
        logger.warn?.("webhook_signature_rejected", { correlationId });
        return response.sendStatus(401);
      }

      const events = parser(parsedPayload(request));
      await ingestionService.ingestEvents(events, { correlationId });
      return response.sendStatus(200);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof WhatsAppPayloadValidationError) {
        logger.warn?.("webhook_payload_rejected", {
          correlationId,
          code: error.code || "invalid_json",
        });
        return response.sendStatus(400);
      }
      logger.error?.("webhook_ingestion_failed", {
        correlationId,
        code: typeof error?.code === "string" ? error.code : "internal_error",
      });
      return response.sendStatus(503);
    }
  };
}

function equalToken(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string" || !expected) return false;
  const receivedBuffer = Buffer.from(received, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return receivedBuffer.length === expectedBuffer.length
    && timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function createWebhookVerificationHandler({ verifyToken } = {}) {
  return function webhookVerificationHandler(request, response) {
    const mode = request.query?.["hub.mode"];
    const token = request.query?.["hub.verify_token"];
    const challenge = request.query?.["hub.challenge"];
    if (mode === "subscribe" && equalToken(token, verifyToken) && typeof challenge === "string") {
      return response.status(200).send(challenge);
    }
    return response.sendStatus(403);
  };
}
