function requireMethod(target, name, dependencyName) {
  if (typeof target?.[name] !== "function") {
    throw new TypeError(`${dependencyName}.${name} é obrigatório.`);
  }
}

function isActiveTenant(context) {
  return context?.status === "active"
    && (context.numberStatus == null || context.numberStatus === "active");
}

function tenantResult(context, outcome, extra = {}) {
  return {
    outcome,
    empresaId: context?.empresaId ?? null,
    numeroWhatsappId: context?.numeroWhatsappId ?? null,
    ...extra,
  };
}

/**
 * Repository contract:
 * - withTenantTransaction(tenantContext, callback(transaction))
 * - insertInboundMessage(transaction, input) -> { inserted, messageId, conversationId }
 * - insertStatusEvent(transaction, input) -> { inserted, statusEventId, messageId? }
 *
 * Outbox contract:
 * - add(transaction, jobReference)
 */
export function createWebhookIngestionService({
  tenantResolver,
  repository,
  outbox,
  logger = console,
} = {}) {
  requireMethod(tenantResolver, "resolveByPhoneNumberId", "tenantResolver");
  requireMethod(repository, "withTenantTransaction", "repository");
  requireMethod(repository, "insertInboundMessage", "repository");
  requireMethod(repository, "insertStatusEvent", "repository");
  requireMethod(outbox, "add", "outbox");

  async function ingestEvent(event, options = {}) {
    const { correlationId } = options;
    const tenant = Object.hasOwn(options, "tenantContext")
      ? options.tenantContext
      : await tenantResolver.resolveByPhoneNumberId(event.phoneNumberId);
    if (!tenant) {
      logger.warn?.("webhook_unknown_phone_number", { correlationId });
      return tenantResult(null, "unknown_number");
    }
    if (!isActiveTenant(tenant)) {
      logger.info?.("webhook_inactive_tenant_ignored", {
        correlationId,
        empresaId: tenant.empresaId,
      });
      return tenantResult(tenant, "inactive_tenant");
    }

    return repository.withTenantTransaction(tenant, async (transaction) => {
      if (event.kind === "message") {
        const persisted = await repository.insertInboundMessage(transaction, {
          empresaId: tenant.empresaId,
          numeroWhatsappId: tenant.numeroWhatsappId,
          event,
          correlationId,
        });
        if (!persisted?.inserted) {
          return tenantResult(tenant, "duplicate", {
            kind: event.kind,
            messageId: persisted?.messageId ?? null,
          });
        }
        if (!persisted.messageId || !persisted.conversationId) {
          throw new TypeError("insertInboundMessage deve retornar messageId e conversationId.");
        }
        await outbox.add(transaction, {
          type: "process_inbound_message",
          payloadVersion: 1,
          empresaId: tenant.empresaId,
          conversationId: persisted.conversationId,
          messageId: persisted.messageId,
          correlationId,
        });
        return tenantResult(tenant, "accepted", {
          kind: event.kind,
          messageId: persisted.messageId,
          conversationId: persisted.conversationId,
        });
      }

      if (event.kind === "status") {
        const persisted = await repository.insertStatusEvent(transaction, {
          empresaId: tenant.empresaId,
          numeroWhatsappId: tenant.numeroWhatsappId,
          event,
          correlationId,
        });
        if (!persisted?.inserted) {
          return tenantResult(tenant, "duplicate", {
            kind: event.kind,
            statusEventId: persisted?.statusEventId ?? null,
          });
        }
        if (!persisted.statusEventId) {
          throw new TypeError("insertStatusEvent deve retornar statusEventId.");
        }
        await outbox.add(transaction, {
          type: "apply_whatsapp_status",
          payloadVersion: 1,
          empresaId: tenant.empresaId,
          messageId: persisted.messageId ?? null,
          statusEventId: persisted.statusEventId,
          correlationId,
        });
        return tenantResult(tenant, "accepted", {
          kind: event.kind,
          messageId: persisted.messageId ?? null,
          statusEventId: persisted.statusEventId,
        });
      }

      throw new TypeError("Tipo de evento de webhook desconhecido.");
    });
  }

  async function ingestEvents(events, { correlationId } = {}) {
    if (!Array.isArray(events)) throw new TypeError("events deve ser um array.");
    const tenantCache = new Map();
    const results = [];
    for (const event of events) {
      if (!tenantCache.has(event.phoneNumberId)) {
        tenantCache.set(
          event.phoneNumberId,
          await tenantResolver.resolveByPhoneNumberId(event.phoneNumberId),
        );
      }
      results.push(await ingestEvent(event, {
        correlationId,
        tenantContext: tenantCache.get(event.phoneNumberId),
      }));
    }
    return results;
  }

  return Object.freeze({ ingestEvent, ingestEvents });
}
