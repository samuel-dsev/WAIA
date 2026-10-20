import { withTenantTransaction } from "../../infra/postgres/transaction.js";
import { createRuntimeStateRepository } from "../business/repositories.js";
import { createConfiguredTenantRuntime } from "../../tenants/configured-runtime.js";
import { randomInt } from "node:crypto";
import { hydrateReply, prepareReplyBatch, loadCatalogBrowseState } from "./reply-batch.js";
import { normalizeAdReferral, catalogAdContext } from "../whatsapp/ad-referral.js";
import { acknowledgeReply } from "./sales-interest.js";
import { directCatalogInterest } from "../business/catalog-interest.js";

const TYPE_FROM_DATABASE = Object.freeze({
  texto: "text",
  imagem: "image",
  audio: "audio",
  video: "video",
  documento: "document",
  interativo: "interactive",
  status: "status",
  sistema: "system",
});

const MEDIA_POLICY_ERRORS = new Set(["META_MEDIA_TOO_LARGE", "META_MEDIA_MIME_NOT_ALLOWED", "META_MEDIA_MIME_MISMATCH"]);

function fromDatabase(value) {
  return TYPE_FROM_DATABASE[value] || value;
}

function permanent(message, code) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  return error;
}

export class PostgresJobHandlerRepository {
  constructor(pool) {
    if (!pool?.connect) throw new TypeError("Pool PostgreSQL invalido.");
    this.pool = pool;
  }

  inboundMessage({ empresaId, messageId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const result = await client.query(
        `SELECT m.id, m.empresa_id, m.conversa_id, m.contato_id, m.numero_whatsapp_id,
                m.tipo, m.corpo, m.media_external_id, m.media_storage_key,
                m.media_mime_type, m.media_size_bytes, m.media_sha256, m.external_message_id,
                m.correlation_id, m.outbound_payload, c.telefone_normalizado
           FROM mensagens m
           JOIN contatos c ON c.empresa_id = m.empresa_id AND c.id = m.contato_id
          WHERE m.empresa_id = $1 AND m.id = $2 AND m.direcao = 'entrada' AND c.deleted_at IS NULL
          LIMIT 1`,
        [empresaId, messageId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        empresaId: row.empresa_id,
        conversationId: row.conversa_id,
        contactId: row.contato_id,
        numeroWhatsappId: row.numero_whatsapp_id,
        type: fromDatabase(row.tipo),
        text: row.corpo || "",
        adReferral: normalizeAdReferral(row.outbound_payload?.adReferral),
        replyToExternalMessageId: row.outbound_payload?.replyToExternalMessageId || null,
        mediaId: row.media_external_id || null,
        mediaStorageKey: row.media_storage_key || null,
        mediaMimeType: row.media_mime_type || null,
        mediaSizeBytes: row.media_size_bytes == null ? null : Number(row.media_size_bytes),
        mediaSha256: row.media_sha256 || null,
        externalMessageId: row.external_message_id,
        correlationId: row.correlation_id,
        senderPhone: row.telefone_normalizado,
      };
    });
  }

  outboundHumanMessage({ empresaId, messageId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const row = (await client.query(
        `SELECT m.id, m.conversa_id, m.numero_whatsapp_id, m.corpo, m.external_message_id,
                m.status, m.correlation_id, c.telefone_normalizado
           FROM mensagens m
           JOIN contatos c ON c.empresa_id = m.empresa_id AND c.id = m.contato_id
          WHERE m.empresa_id = $1 AND m.id = $2 AND m.direcao = 'saida' AND c.deleted_at IS NULL
            AND m.tipo = 'texto' AND m.origem_resposta = 'operador'
          LIMIT 1`,
        [empresaId, messageId],
      )).rows[0];
      return row && {
        id: row.id,
        conversationId: row.conversa_id,
        numeroWhatsappId: row.numero_whatsapp_id,
        text: row.corpo,
        externalMessageId: row.external_message_id,
        status: row.status,
        correlationId: row.correlation_id,
        recipientPhone: row.telefone_normalizado,
      };
    });
  }

  markMediaStored({ empresaId, messageId, mediaId, stored }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const result = await client.query(
        `UPDATE mensagens
            SET media_storage_key = $4,
                media_mime_type = $5,
                media_size_bytes = $6,
                media_sha256 = $7,
                media_stored_at = now(),
                updated_at = now()
          WHERE empresa_id = $1 AND id = $2 AND media_external_id = $3
            AND direcao = 'entrada' AND tipo IN ('imagem', 'documento')
            AND (media_storage_key IS NULL OR media_storage_key = $4)
        RETURNING id`,
        [empresaId, messageId, mediaId, stored.storageKey, stored.mimeType, stored.sizeBytes, stored.sha256],
      );
      if (!result.rows[0]) throw permanent("Mensagem de mídia não encontrada.", "MEDIA_MESSAGE_NOT_FOUND");
      return result.rows[0];
    });
  }

  statusEvent({ empresaId, statusEventId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const result = await client.query(
        `SELECT id, mensagem_id, external_message_id, status, provider_timestamp, error_code
           FROM whatsapp_status_events
          WHERE empresa_id = $1 AND id = $2
          LIMIT 1`,
        [empresaId, statusEventId],
      );
      const row = result.rows[0];
      return row && {
        id: row.id,
        messageId: row.mensagem_id || null,
        externalMessageId: row.external_message_id,
        status: row.status,
        occurredAt: row.provider_timestamp,
        errorCode: row.error_code,
      };
    });
  }

  preparedReply({ empresaId, messageId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const row = (await client.query(
        `SELECT id, corpo, outbound_payload, external_message_id, status
           FROM mensagens
          WHERE empresa_id = $1 AND source_message_id = $2 AND direcao = 'saida'
          LIMIT 1`,
        [empresaId, messageId],
      )).rows[0];
      return hydrateReply(client, empresaId, row);
    });
  }

  catalogBrowseState({ empresaId, conversationId }) {
    return withTenantTransaction(this.pool, { empresaId }, ({ client }) => loadCatalogBrowseState(client, empresaId, conversationId));
  }

  adReferral({ empresaId, conversationId, messageId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const row = (await client.query(
        `SELECT m.outbound_payload FROM mensagens m
          JOIN mensagens anchor ON anchor.empresa_id=m.empresa_id AND anchor.conversa_id=m.conversa_id AND anchor.id=$3
         WHERE m.empresa_id=$1 AND m.conversa_id=$2 AND m.direcao='entrada'
           AND m.redacted_at IS NULL AND anchor.redacted_at IS NULL AND m.sequence<=anchor.sequence
           AND m.outbound_payload ? 'adReferral'
         ORDER BY m.sequence DESC LIMIT 1`, [empresaId, conversationId, messageId],
      )).rows[0];
      return normalizeAdReferral(row?.outbound_payload?.adReferral);
    });
  }

  quotedCatalogProduct({ empresaId, conversationId, messageId, externalMessageId }) {
    if (typeof externalMessageId !== "string" || !externalMessageId || externalMessageId.length > 512) return null;
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => (await client.query(
      `SELECT m.outbound_payload->>'catalogProductId' AS product_id FROM mensagens m
         JOIN mensagens anchor ON anchor.empresa_id=m.empresa_id AND anchor.conversa_id=m.conversa_id AND anchor.id=$4
        WHERE m.empresa_id=$1 AND m.conversa_id=$2 AND m.external_message_id=$3 AND m.direcao='saida'
          AND m.sequence<anchor.sequence AND m.redacted_at IS NULL AND anchor.redacted_at IS NULL
          AND m.status IN ('enviada','entregue','lida') AND m.outbound_payload ? 'catalogProductId'
        LIMIT 1`, [empresaId, conversationId, externalMessageId, messageId],
    )).rows[0]?.product_id || null);
  }

  prepareReply({ empresaId, message, reply, origin }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      if (reply.messages != null) return prepareReplyBatch(client, { empresaId, message, reply, origin });
      const sequence = (await client.query(
        `UPDATE conversas SET next_sequence = next_sequence + 1
          WHERE empresa_id = $1 AND id = $2
          RETURNING next_sequence - 1 AS sequence`,
        [empresaId, message.conversationId],
      )).rows[0]?.sequence;
      const row = (await client.query(
        `INSERT INTO mensagens (
           empresa_id, conversa_id, contato_id, numero_whatsapp_id, direcao, tipo,
           corpo, status, origem_resposta, sequence, correlation_id, source_message_id,
           outbound_payload, processing_at
         ) VALUES ($1,$2,$3,$4,'saida',$5,$6,'processando',$7,$8,$9,$10,$11::jsonb,now())
         ON CONFLICT (empresa_id, source_message_id)
           WHERE source_message_id IS NOT NULL AND direcao = 'saida'
         DO NOTHING
         RETURNING id, corpo, outbound_payload, external_message_id, status`,
        [
          empresaId, message.conversationId, message.contactId, message.numeroWhatsappId,
          reply.buttons?.length ? "interativo" : "texto", reply.text,
          origin === "ai" ? "ia" : "fluxo_deterministico", sequence, message.correlationId,
          message.id, JSON.stringify({ buttons: reply.buttons || [], ...(reply.sendNotBefore ? { sendNotBefore: reply.sendNotBefore } : {}),
            ...(reply.salesInterest ? { salesInterest: reply.salesInterest } : {}),
            ...(reply.leadQualification ? { leadQualification: reply.leadQualification } : {}),
            ...(reply.nonLeadHandoff ? { nonLeadHandoff: reply.nonLeadHandoff } : {}) }),
        ],
      )).rows[0];
      if (row) return { id: row.id, text: row.corpo, buttons: row.outbound_payload?.buttons || [], sendNotBefore: row.outbound_payload?.sendNotBefore || null, status: row.status };
      const existing = (await client.query(
        `SELECT id, corpo, outbound_payload, external_message_id, status
           FROM mensagens WHERE empresa_id = $1 AND source_message_id = $2 AND direcao = 'saida'`,
        [empresaId, message.id],
      )).rows[0];
      return { id: existing.id, text: existing.corpo, buttons: existing.outbound_payload?.buttons || [], sendNotBefore: existing.outbound_payload?.sendNotBefore || null, externalMessageId: existing.external_message_id, status: existing.status };
    });
  }

  canSendBotReply({ empresaId, messageId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => (await client.query(
      `SELECT 1 FROM mensagens m
         JOIN empresas e ON e.id = m.empresa_id AND e.status = 'ativa'
         JOIN conversas c ON c.empresa_id = m.empresa_id AND c.id = m.conversa_id
         JOIN contatos ct ON ct.empresa_id = m.empresa_id AND ct.id = m.contato_id
         JOIN numeros_whatsapp n ON n.empresa_id = m.empresa_id AND n.id = m.numero_whatsapp_id
        WHERE m.empresa_id = $1 AND m.id = $2 AND m.redacted_at IS NULL
          AND c.status = 'aberta' AND c.modo_atendimento = 'bot'
          AND ct.deleted_at IS NULL AND NOT ct.bloqueado AND NOT ct.bot_pausado
          AND n.deleted_at IS NULL AND n.status = 'ativo'`,
      [empresaId, messageId],
    )).rowCount > 0);
  }

  cancelPreparedReply({ empresaId, messageId }) {
    return withTenantTransaction(this.pool, { empresaId }, ({ client }) => client.query(
      `UPDATE mensagens SET status = 'ignorada_duplicidade', updated_at = now()
        WHERE empresa_id = $1 AND direcao = 'saida'
          AND (source_message_id = $2 OR outbound_payload->>'parentReplyId' IN (
            SELECT id::text FROM mensagens WHERE empresa_id = $1 AND source_message_id = $2 AND direcao = 'saida'
          ))
          AND external_message_id IS NULL AND status IN ('processando', 'enfileirada')`,
      [empresaId, messageId],
    ));
  }

  markReplySent({ empresaId, replyId, externalMessageId }) {
    return withTenantTransaction(this.pool, { empresaId }, ({ client }) => acknowledgeReply(client, { empresaId, replyId, externalMessageId }));
  }

  markHumanMessageSent({ empresaId, messageId, externalMessageId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const row = (await client.query(
        `UPDATE mensagens
            SET external_message_id = $3, status = 'enviada', sent_at = COALESCE(sent_at, now()),
                error_code = NULL, error_sanitized = NULL
          WHERE empresa_id = $1 AND id = $2 AND direcao = 'saida'
            AND origem_resposta = 'operador' AND status IN ('enfileirada', 'processando', 'enviada')
        RETURNING id, external_message_id, status`,
        [empresaId, messageId, externalMessageId],
      )).rows[0];
      if (!row) throw permanent("Mensagem humana não encontrada.", "HUMAN_MESSAGE_NOT_FOUND");
      return row;
    });
  }

  googleSheetsOrder({ empresaId, orderId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const row = (await client.query(
        `SELECT p.id, p.nome_comprador, p.status, p.created_at,
                c.telefone_normalizado, m.media_external_id,
                COALESCE(i.descricao_snapshot, e.nome, '') AS evento
           FROM pedidos p
           JOIN contatos c ON c.empresa_id = p.empresa_id AND c.id = p.contato_id
           LEFT JOIN mensagens m ON m.empresa_id = p.empresa_id AND m.id = p.comprovante_mensagem_id
           LEFT JOIN LATERAL (
             SELECT descricao_snapshot, evento_id FROM itens_pedido
              WHERE empresa_id = p.empresa_id AND pedido_id = p.id ORDER BY id LIMIT 1
           ) i ON true
           LEFT JOIN eventos e ON e.empresa_id = p.empresa_id AND e.id = i.evento_id
          WHERE p.empresa_id = $1 AND p.id = $2 AND p.deleted_at IS NULL LIMIT 1`,
        [empresaId, orderId],
      )).rows[0];
      return row && {
        id: row.id,
        customerName: row.nome_comprador,
        customerPhone: row.telefone_normalizado,
        eventName: row.evento,
        receiptId: row.media_external_id,
        status: "Aguardando conferência",
        createdAt: row.created_at?.toISOString?.() || row.created_at,
      };
    });
  }

  markGoogleSheetsOrder({ empresaId, orderId, status }) {
    return withTenantTransaction(this.pool, { empresaId }, ({ client }) => client.query(
      `UPDATE pedidos SET integracao_status = $3, updated_at = now()
        WHERE empresa_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [empresaId, orderId, status],
    ));
  }
}

export function createWorkerHandlers({
  repository,
  conversationService,
  tenantDefinitionRepository,
  metaGateway,
  aiService,
  orderRepository,
  appointmentRepository,
  handoffRepository,
  flowRepository,
  mediaStore,
  googleSheetsIntegration,
  logger = console,
  firstMetaMessageId = (result) => result?.messages?.[0]?.id || result?.id || null,
  clock = () => new Date(),
  aiReplyDelayMs = () => randomInt(30_000, 45_001),
} = {}) {
  if (typeof repository?.inboundMessage !== "function") throw new TypeError("repository.inboundMessage e obrigatorio.");
  if (typeof repository?.statusEvent !== "function") throw new TypeError("repository.statusEvent e obrigatorio.");
  if (typeof conversationService?.getConversation !== "function") throw new TypeError("conversationService.getConversation e obrigatorio.");
  if (typeof conversationService?.recordMessage !== "function") throw new TypeError("conversationService.recordMessage e obrigatorio.");
  if (typeof conversationService?.applyMetaStatus !== "function") throw new TypeError("conversationService.applyMetaStatus e obrigatorio.");
  if (typeof tenantDefinitionRepository?.load !== "function") throw new TypeError("tenantDefinitionRepository.load e obrigatorio.");
  if (typeof metaGateway?.sendReply !== "function") throw new TypeError("metaGateway.sendReply e obrigatorio.");

  async function processInboundMessage(reference, _record, execution = {}) {
    const message = await repository.inboundMessage(reference);
    if (!message) throw permanent("Mensagem de entrada nao encontrada.", "INBOUND_MESSAGE_NOT_FOUND");
    const conversation = await conversationService.getConversation({
      empresaId: reference.empresaId,
      conversationId: message.conversationId,
    });
    let mediaRejected = false;
    if (["image", "document"].includes(message.type) && message.mediaId && !message.mediaStorageKey) {
      if (typeof metaGateway?.downloadMedia !== "function" || typeof mediaStore?.put !== "function" || typeof repository.markMediaStored !== "function") {
        throw permanent("Armazenamento privado de mídia não configurado.", "MEDIA_STORAGE_NOT_CONFIGURED");
      }
      try {
        const downloaded = await metaGateway.downloadMedia({
          empresaId: reference.empresaId,
          numeroWhatsappId: message.numeroWhatsappId,
        }, {
          mediaId: message.mediaId,
          maxBytes: mediaStore.maxBytes,
          allowedMimeTypes: [...mediaStore.allowedMimeTypes],
        });
        const stored = await mediaStore.put({
          empresaId: reference.empresaId,
          messageId: message.id,
          data: downloaded.data,
          mimeType: downloaded.mimeType,
        });
        try {
          await repository.markMediaStored({
            empresaId: reference.empresaId,
            messageId: message.id,
            mediaId: message.mediaId,
            stored,
          });
        } catch (error) {
          await mediaStore.delete({ empresaId: reference.empresaId, storageKey: stored.storageKey }).catch(() => {});
          throw error;
        }
        message.mediaStorageKey = stored.storageKey;
        message.mediaMimeType = stored.mimeType;
        message.mediaSizeBytes = stored.sizeBytes;
        message.mediaSha256 = stored.sha256;
      } catch (error) {
        if (!MEDIA_POLICY_ERRORS.has(error?.code)) throw error;
        mediaRejected = true;
        logger.info?.("whatsapp_media_rejected", {
          empresaId: reference.empresaId,
          conversationId: message.conversationId,
          code: error.code,
        });
      }
    }
    if (conversation.mode !== "bot") {
      await repository.cancelPreparedReply?.({ empresaId: reference.empresaId, messageId: message.id });
      logger.info?.("conversation_automation_skipped", {
        empresaId: reference.empresaId,
        conversationId: message.conversationId,
        mode: conversation.mode,
      });
      return { skipped: true, reason: "conversation_not_in_bot_mode" };
    }
    let prepared = await repository.preparedReply?.({ empresaId: reference.empresaId, messageId: message.id });
    if (!prepared?.messages && prepared?.externalMessageId && ["enviada", "entregue", "lida"].includes(prepared.status)) {
      return { replied: true, resumed: true };
    }
    let reply;
    if (!prepared) {
      let generatedByAi = false;
      let responseDelayEnabled = true;
      try {
        await metaGateway.markRead?.({
          empresaId: reference.empresaId,
          numeroWhatsappId: message.numeroWhatsappId,
        }, { messageId: message.externalMessageId });
      } catch (error) {
        logger.warn?.("whatsapp_mark_read_failed", {
          empresaId: reference.empresaId,
          conversationId: message.conversationId,
          code: error?.code || "META_MARK_READ_FAILED",
        });
      }
      if (mediaRejected) {
        reply = { text: "Não consegui aceitar esse comprovante. Envie uma imagem JPEG, PNG ou WEBP, ou um PDF, com até 10 MB.", buttons: [] };
      } else {
        const definition = await tenantDefinitionRepository.load(reference.empresaId);
        if (!definition) throw permanent("Configuracao da empresa nao encontrada.", "TENANT_RUNTIME_NOT_FOUND");
        responseDelayEnabled = definition.ai?.responseDelayEnabled !== false;
        const runtime = createConfiguredTenantRuntime({
          definition,
          clock,
          stateRepository: createRuntimeStateRepository(conversationService),
          orderRepository,
          appointmentRepository,
          handoffRepository,
          flowRepository,
          aiHandler: aiService
            ? async ({ config, input }) => {
              const intakeOnly = definition.ai?.leadIntakeOnlyEnabled === true;
              const salesMode = !intakeOnly && definition.ai?.catalogSalesEnabled === true && config.catalog?.source?.type === "google_sheets" && config.catalog.source.status === "healthy";
              const intakeReferral = intakeOnly ? normalizeAdReferral(message.adReferral || await repository.adReferral?.({ empresaId: config.empresaId, conversationId: input.conversationId, messageId: message.id })) : null;
              let browseState;
              if (salesMode) {
                if (typeof repository.catalogBrowseState !== "function") throw permanent("Paginação persistida do catálogo não configurada.", "CATALOG_BROWSE_STATE_REQUIRED");
                browseState = await repository.catalogBrowseState({ empresaId: config.empresaId, conversationId: input.conversationId });
              }
              const catalogContext = { ...config.catalog, ...(salesMode ? { salesMode: true, browseState,
                quotedProductId: await repository.quotedCatalogProduct?.({ empresaId: config.empresaId, conversationId: input.conversationId, messageId: message.id, externalMessageId: message.replyToExternalMessageId }) || null,
                adContext: catalogAdContext(message.adReferral || await repository.adReferral?.({ empresaId: config.empresaId, conversationId: input.conversationId, messageId: message.id }), config.catalog, { current: Boolean(message.adReferral) }),
                interestHandoff: { enabled: config.enabledModules.includes("human_handoff") && Boolean(config.humanHandoff.salesInterestMessage?.trim()), message: config.humanHandoff.salesInterestMessage || "" },
              } : {}) };
              const direct = salesMode && definition.ai?.leadQualificationEnabled !== true && definition.ai?.enabled === true && message.type === "text" ? directCatalogInterest(input.text, catalogContext) : null;
              if (direct) return { reply: direct };
              const aiReply = await aiService.reply({
                empresaId: config.empresaId,
                conversationId: input.conversationId,
                messageId: message.id,
                correlationId: message.correlationId,
                message: input.text,
                context: {
                  identity: config.identity,
                  menu: {
                    text: config.menu.text,
                    options: config.menu.options.map(({ label }) => ({ label })),
                  },
                  ...(intakeOnly ? { adContext: intakeReferral ? { referral: intakeReferral, current: Boolean(message.adReferral) } : null } : {
                  events: config.events,
                  catalog: catalogContext,
                  services: config.appointments?.services || [],
                  knowledgeBase: (definition.publicReplies || [])
                    .filter((item) => item?.module !== "payments" && !/(?:pix|payment|pagamento)/iu.test(String(item?.action || "")))
                    .map(({ module, action, text }) => ({ module, action, text })),
                  }),
                },
              });
              generatedByAi = aiReply.source === "ai";
              return { reply: aiReply };
            }
            : null,
          logger,
        });
        reply = await runtime.handle({
          conversationId: message.conversationId,
          contactId: message.contactId,
          type: message.type,
          text: message.text,
          selectionId: message.type === "interactive" ? message.text : undefined,
          mediaId: message.mediaId,
          messageId: message.id,
          correlationId: message.correlationId,
          mediaStorageKey: message.mediaStorageKey,
          mediaMimeType: message.mediaMimeType,
          mediaSizeBytes: message.mediaSizeBytes,
          mediaSha256: message.mediaSha256,
        });
      }
      if (reply.code === "HANDOFF_COOLDOWN") {
        return { skipped: true, reason: "handoff_cooldown" };
      }
      if (generatedByAi) {
        if (typeof repository.prepareReply !== "function") throw permanent("Persistência da resposta da IA não configurada.", "BOT_REPLY_CHECKPOINT_REQUIRED");
        const delayMs = responseDelayEnabled ? aiReplyDelayMs() : 0;
        if (responseDelayEnabled && (!Number.isInteger(delayMs) || delayMs < 30_000 || delayMs > 45_000)) throw new TypeError("Espera da IA deve ficar entre 30 e 45 segundos.");
        reply = { ...reply, sendNotBefore: new Date(clock().getTime() + delayMs).toISOString() };
      }
      if (reply.salesInterest || reply.leadQualification || reply.nonLeadHandoff) {
        if (typeof repository.prepareReply !== "function" || typeof repository.markReplySent !== "function" || typeof repository.canSendBotReply !== "function") {
          throw permanent("Persistência e permissão do encerramento comercial obrigatórias.", "BOT_REPLY_CHECKPOINT_REQUIRED");
        }
        reply = { ...reply, sendNotBefore: reply.sendNotBefore || clock().toISOString() };
      }
      if (repository.prepareReply) {
        prepared = await repository.prepareReply({
          empresaId: reference.empresaId,
          message,
          reply,
          origin: reply.module === "ai_freeform" ? "ai" : "deterministic_flow",
        });
        if (reply.messages && !prepared?.messages?.length) throw permanent("Persistência de cada mensagem obrigatória.", "BOT_REPLY_CHECKPOINT_REQUIRED");
      }
    } else {
      reply = { text: prepared.text, buttons: prepared.buttons, ...(prepared.messages ? { messages: prepared.messages } : {}),
        ...(prepared.nonLeadHandoff ? { nonLeadHandoff: prepared.nonLeadHandoff } : {}) };
    }
    const sendNotBefore = prepared?.sendNotBefore || reply.sendNotBefore;
    if (sendNotBefore && !Number.isFinite(Date.parse(sendNotBefore))) throw permanent("Horário de envio da resposta inválido.", "BOT_REPLY_SCHEDULE_INVALID");
    if (prepared?.status === "ignorada_duplicidade") return { skipped: true, reason: "bot_reply_cancelled" };
    if (prepared?.messages?.some((part) => part.status === "ignorada_duplicidade")) return { skipped: true, reason: "bot_reply_cancelled" };
    if (prepared?.messages?.every((part) => part.externalMessageId)) return { replied: true, resumed: true };
    if (sendNotBefore && Date.parse(sendNotBefore) > clock().getTime()) {
      return { deferUntil: sendNotBefore };
    }
    if (sendNotBefore) {
      const currentConversation = await conversationService.getConversation({ empresaId: reference.empresaId, conversationId: message.conversationId });
      if (currentConversation.mode !== "bot" || (repository.canSendBotReply && !await repository.canSendBotReply({ empresaId: reference.empresaId, messageId: message.id }))) {
        await repository.cancelPreparedReply?.({ empresaId: reference.empresaId, messageId: message.id });
        return { skipped: true, reason: "bot_reply_cancelled" };
      }
    }
    if (execution.canContinue && !execution.canContinue()) {
      throw Object.assign(new Error("Lease de processamento foi perdido."), { code: "PROCESSING_LEASE_LOST", retryable: true });
    }
    if (reply.messages) {
      if (!prepared?.messages || typeof repository.markReplySent !== "function" || typeof repository.canSendBotReply !== "function") {
        throw permanent("Persistência de cada mensagem obrigatória.", "BOT_REPLY_CHECKPOINT_REQUIRED");
      }
      for (const part of prepared.messages) {
        if (part.externalMessageId) continue;
        const current = await conversationService.getConversation({ empresaId: reference.empresaId, conversationId: message.conversationId });
        if (current.mode !== "bot" || !await repository.canSendBotReply({ empresaId: reference.empresaId, messageId: message.id })) {
          await repository.cancelPreparedReply({ empresaId: reference.empresaId, messageId: message.id });
          return { skipped: true, reason: "bot_reply_cancelled" };
        }
        if (execution.canContinue && !execution.canContinue()) throw Object.assign(new Error("Lease de processamento foi perdido."), { code: "PROCESSING_LEASE_LOST", retryable: true });
        const sent = await metaGateway.sendReply({ empresaId: reference.empresaId, numeroWhatsappId: message.numeroWhatsappId }, {
          to: message.senderPhone, text: part.text, buttons: part.buttons, ...(part.imageUrl ? { imageUrl: part.imageUrl } : {}),
        });
        const externalMessageId = firstMetaMessageId(sent);
        if (typeof externalMessageId !== "string" || !externalMessageId) throw permanent("Provedor não confirmou o identificador da mensagem.", "BOT_REPLY_SEND_ID_MISSING");
        await repository.markReplySent({ empresaId: reference.empresaId, replyId: part.id, externalMessageId });
      }
      return { replied: true };
    }
    const sent = await metaGateway.sendReply({
      empresaId: reference.empresaId,
      numeroWhatsappId: message.numeroWhatsappId,
    }, {
      to: message.senderPhone,
      text: reply.text,
      buttons: reply.buttons,
    });
    const externalMessageId = firstMetaMessageId(sent);
    if ((reply.salesInterest || reply.leadQualification || reply.nonLeadHandoff) && (typeof externalMessageId !== "string" || !externalMessageId)) throw permanent("Provedor não confirmou o identificador da mensagem.", "BOT_REPLY_SEND_ID_MISSING");
    if (prepared && repository.markReplySent) {
      await repository.markReplySent({ empresaId: reference.empresaId, replyId: prepared.id, externalMessageId });
    } else {
      await conversationService.recordMessage({
        empresaId: reference.empresaId,
        conversationId: message.conversationId,
        direction: "outbound",
        type: reply.buttons?.length ? "interactive" : "text",
        body: reply.text,
        externalMessageId,
        status: "sent",
        origin: reply.module === "ai_freeform" ? "ai" : "deterministic_flow",
        correlationId: message.correlationId,
      });
    }
    return { replied: true };
  }

  async function applyWhatsappStatus(reference) {
    const status = await repository.statusEvent(reference);
    if (!status) throw permanent("Evento de status nao encontrado.", "STATUS_EVENT_NOT_FOUND");
    if (status.status === "unknown") return { skipped: true, reason: "unknown_status" };
    if (!status.messageId) return { skipped: true, reason: "message_not_found" };
    await conversationService.applyMetaStatus({
      empresaId: reference.empresaId,
      externalMessageId: status.externalMessageId,
      status: status.status,
      occurredAt: status.occurredAt || new Date(),
      errorCode: status.errorCode,
    });
    return { applied: true, status: status.status };
  }

  async function sendHumanMessage(reference) {
    if (typeof repository.outboundHumanMessage !== "function" || typeof repository.markHumanMessageSent !== "function") {
      throw permanent("Envio humano não configurado no worker.", "HUMAN_MESSAGE_HANDLER_NOT_CONFIGURED");
    }
    const message = await repository.outboundHumanMessage(reference);
    if (!message) throw permanent("Mensagem humana não encontrada.", "HUMAN_MESSAGE_NOT_FOUND");
    if (message.externalMessageId && ["enviada", "entregue", "lida"].includes(message.status)) {
      return { sent: true, resumed: true };
    }
    const result = await metaGateway.sendReply({
      empresaId: reference.empresaId,
      numeroWhatsappId: message.numeroWhatsappId,
    }, {
      to: message.recipientPhone,
      text: message.text,
      buttons: [],
    });
    const externalMessageId = firstMetaMessageId(result);
    if (!externalMessageId) {
      const error = new Error("A Meta não retornou o identificador da mensagem.");
      error.code = "META_MESSAGE_ID_MISSING";
      error.retryable = true;
      throw error;
    }
    await repository.markHumanMessageSent({
      empresaId: reference.empresaId,
      messageId: message.id,
      externalMessageId,
    });
    return { sent: true };
  }

  async function exportGoogleSheetsOrder(reference) {
    if (typeof repository.googleSheetsOrder !== "function" || typeof repository.markGoogleSheetsOrder !== "function"
        || typeof googleSheetsIntegration?.exportOrder !== "function") {
      throw permanent("Exportação Google Sheets não configurada no worker.", "GOOGLE_ORDER_HANDLER_NOT_CONFIGURED");
    }
    const order = await repository.googleSheetsOrder(reference);
    if (!order) throw permanent("Pedido não encontrado.", "ORDER_NOT_FOUND");
    try {
      const result = await googleSheetsIntegration.exportOrder({ empresaId: reference.empresaId }, order, { idempotencyKey: order.id });
      await repository.markGoogleSheetsOrder({ empresaId: reference.empresaId, orderId: order.id, status: "sincronizada" });
      return { exported: true, duplicate: Boolean(result?.duplicate) };
    } catch (error) {
      await repository.markGoogleSheetsOrder({ empresaId: reference.empresaId, orderId: order.id, status: "falhou" }).catch(() => {});
      throw error;
    }
  }

  return Object.freeze({
    process_inbound_message: processInboundMessage,
    apply_whatsapp_status: applyWhatsappStatus,
    send_human_message: sendHumanMessage,
    export_google_sheets_order: exportGoogleSheetsOrder,
  });
}
