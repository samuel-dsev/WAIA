import { randomUUID } from "node:crypto";
import { MetaMultiAppWebhookError } from "./multiapp-webhook-service.js";

function requireService(service) {
  if (typeof service?.verifySubscription !== "function" || typeof service?.ingest !== "function") {
    throw new TypeError("Serviço de webhook Meta multiaplicativo inválido.");
  }
  return service;
}

function correlationId(request) {
  return request.context?.correlationId || request.correlationId || randomUUID();
}

function rawBody(request) {
  if (Buffer.isBuffer(request.rawBody)) return request.rawBody;
  if (Buffer.isBuffer(request.body)) return request.body;
  if (typeof request.rawBody === "string") return Buffer.from(request.rawBody, "utf8");
  if (typeof request.body === "string") return Buffer.from(request.body, "utf8");
  return null;
}

function statusFor(error) {
  return error instanceof MetaMultiAppWebhookError ? error.statusCode : 503;
}

export function createMetaMultiAppVerificationHandler({ service } = {}) {
  const webhook = requireService(service);
  return async function metaMultiAppVerificationHandler(request, response) {
    try {
      const challenge = await webhook.verifySubscription({
        webhookPublicId: request.params?.webhookPublicId,
        mode: request.query?.["hub.mode"],
        verifyToken: request.query?.["hub.verify_token"],
        challenge: request.query?.["hub.challenge"],
        correlationId: correlationId(request),
      });
      return response.status(200).send(challenge);
    } catch (error) {
      return response.sendStatus(statusFor(error));
    }
  };
}

export function createMetaMultiAppIngestionHandler({ service } = {}) {
  const webhook = requireService(service);
  return async function metaMultiAppIngestionHandler(request, response) {
    try {
      await webhook.ingest({
        webhookPublicId: request.params?.webhookPublicId,
        rawBody: rawBody(request),
        signature: request.get?.("x-hub-signature-256")
          ?? request.headers?.["x-hub-signature-256"]
          ?? null,
        correlationId: correlationId(request),
      });
      return response.sendStatus(200);
    } catch (error) {
      return response.sendStatus(statusFor(error));
    }
  };
}
