import { withTenantTransaction } from "../../infra/postgres/transaction.js";
import { createRuntimeStateRepository } from "../business/repositories.js";
import { createConfiguredTenantRuntime } from "../../tenants/configured-runtime.js";
import { INBOUND_COOLDOWN_MS, loadInboundTurn } from "./inbound-turn.js";
import { loadTradeInEvaluationSession } from "./trade-in-session.js";
import { normalizeTradeInEvaluation } from "../business/trade-in-evaluation.js";
import { inboundMessageContent } from "../ai/inbound-content.js";
import { storeInboundMedia } from "./store-inbound-media.js";
import { queueLeadImages } from "../group-notifier/delivery-images.js";
import { hydrateReply, prepareReplyBatch, loadCatalogBrowseState, websiteListFormatMetadata } from "./reply-batch.js";
import { normalizeAdReferral, catalogAdContext } from "../whatsapp/ad-referral.js";
import { acknowledgeReply } from "./sales-interest.js";
import { directCatalogInterest } from "../business/catalog-interest.js";
import { productMessage } from "../business/catalog-messages.js";
import { hasWebsiteCatalogLink } from "../business/catalog-sales.js";
import { matchesWebsiteGalleryPart, normalizeWebsiteInteraction, pendingWebsiteFinancingSession, websiteCatalogListText, websiteCatalogSelectionPrompt, normalizeWebsiteListFormatVersion, validCatalogContinuation } from "../business/website-catalog-interaction.js";
import { loadWebsiteCatalog } from "../../tenants/postgres-config-loader.js";

import { isRealEstateCatalogPart, canDispatchRealEstateReply } from './real-estate-dispatch.js';

async function canDispatchWebsiteReply(client, empresaId, part) {
  if (isRealEstateCatalogPart(part)) {
    let payload = part;
    // The stable worker hydrates parts separately. Recover the parent/query
    // checkpoint before revalidating captions, including partial-batch retries.
    if (part.id) {
      const { rows: [row] } = await client.query('SELECT corpo,outbound_payload FROM mensagens WHERE empresa_id=$1 AND id=$2', [empresaId, part.id]);
      if (!row || row.corpo !== part.text) return false;
      payload = row.outbound_payload;
    }
    return canDispatchRealEstateReply(client, empresaId, { outbound_payload: payload, corpo: part.text });
  }
  const productId = part.catalogProductId;
  const websiteCard = /^turim:[1-9]\d*$/u.test(productId);
  const redirect = hasWebsiteCatalogLink(part.text);
  const interaction = normalizeWebsiteInteraction(part.websiteInteraction);
  const listFormatVersion = normalizeWebsiteListFormatVersion(part.catalogListFormatVersion);
  const continuation = part.catalogContinuation;
  if (listFormatVersion === 3 && !validCatalogContinuation(continuation)) return false;
  if (continuation !== undefined && (!validCatalogContinuation(continuation)
    || !(interaction?.step === "list" && listFormatVersion === 3
      || ["gallery", "finance_accepted"].includes(interaction?.step) && websiteCard && interaction.productIds.at(-1) === productId))) return false;
  if (part.catalogListFormatVersion !== undefined && (listFormatVersion === null || interaction?.step !== "list")) return false;
  if (!websiteCard && !redirect && !interaction) return true;
  const catalog = await loadWebsiteCatalog(client, empresaId);
  if (!catalog) return !websiteCard && !interaction;
  if (redirect) return false;
  const live = await client.query(
    `SELECT 1 FROM empresas e JOIN configuracoes_revisoes r
       ON r.empresa_id = e.id AND r.config_version = e.configuracao_ativa_versao
      WHERE e.id = $1 AND e.configuracao_runtime_modo = 'versionado'
        AND e.versao_configuracao = e.configuracao_ativa_versao
        AND r.configuracao_compilada #> '{configuration,modules}' ? 'catalog'`, [empresaId],
  );
  if (!live.rowCount) return false;
  const trustedItem = (id) => catalog.items.find((candidate) => candidate.id === id && candidate.active !== false && candidate.availability !== "unavailable");
  if (interaction) {
    const items = interaction.productIds.map(trustedItem);
    if (items.some((item) => !item)) return false;
    if (interaction.step === "list") {
      return listFormatVersion !== 3 && part.text === websiteCatalogSelectionPrompt
        || part.text === websiteCatalogListText(items, { formatVersion: listFormatVersion, continuation });
    }
  }
  if (!websiteCard) return true;
  const item = trustedItem(productId);
  if (!item?.imageUrl) return false;
  if (Number.isInteger(part.catalogPhotoIndex)) return matchesWebsiteGalleryPart(item, part.catalogPhotoIndex, part);
  const current = productMessage(item);
  return current.text === part.text && current.imageUrl === part.imageUrl;
}

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

const MEDIA_POLICY_ERRORS = new Set(["META_MEDIA_TOO_LARGE", "META_MEDIA_MIME_NOT_ALLOWED", "META_MEDIA_MIME_MISMATCH", "YCLOUD_MEDIA_REFERENCE_INVALID", "YCLOUD_MEDIA_REFERENCE_MISSING"]);

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
  inboundTurn(input) { return loadInboundTurn(this.pool, input); }
  tradeInEvaluationSession(input) { return loadTradeInEvaluationSession(this.pool, input); }
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
                m.correlation_id, m.outbound_payload, m.sequence, c.telefone_normalizado
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
        sequence: Number(row.sequence),
        empresaId: row.empresa_id,
        conversationId: row.conversa_id,
        contactId: row.contato_id,
        numeroWhatsappId: row.numero_whatsapp_id,
        type: fromDatabase(row.tipo),
        text: row.corpo || "",
        adReferral: normalizeAdReferral(row.outbound_payload?.adReferral),
        replyToExternalMessageId: row.outbound_payload?.replyToExternalMessageId || null,
        mediaId: row.media_external_id || null,
        providerMedia: row.outbound_payload?.providerMedia || null,
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
                outbound_payload = outbound_payload - 'providerMedia',
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

  queueLeadImages(input) {
    return withTenantTransaction(this.pool, input, ({ client }) => queueLeadImages(client, input));
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

  websiteInteraction({ empresaId, conversationId, messageId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const { rows: [row] } = await client.query(
        `SELECT m.outbound_payload->'websiteInteraction' AS state, NOT EXISTS (
           SELECT 1 FROM mensagens newer WHERE newer.empresa_id = m.empresa_id AND newer.conversa_id = m.conversa_id
             AND newer.direcao = 'saida' AND newer.sequence > m.sequence AND newer.sequence < anchor.sequence AND newer.redacted_at IS NULL
             AND newer.status IN ('enviada', 'entregue', 'lida') AND newer.external_message_id IS NOT NULL
         ) AS direct
           FROM mensagens m JOIN mensagens anchor ON anchor.empresa_id = m.empresa_id AND anchor.conversa_id = m.conversa_id
             AND anchor.id = $3 AND anchor.direcao = 'entrada' AND anchor.redacted_at IS NULL
           WHERE m.empresa_id = $1 AND m.conversa_id = $2 AND m.direcao = 'saida' AND m.sequence < anchor.sequence
            AND m.origem_resposta IN ('ia', 'fluxo_deterministico') AND m.redacted_at IS NULL
            AND m.status IN ('enviada', 'entregue', 'lida') AND m.external_message_id IS NOT NULL
            AND m.outbound_payload ? 'websiteInteraction' AND NOT EXISTS (
              SELECT 1 FROM mensagens referral WHERE referral.empresa_id = m.empresa_id AND referral.conversa_id = m.conversa_id
                AND referral.direcao = 'entrada' AND referral.sequence > m.sequence AND referral.sequence <= anchor.sequence
                AND referral.redacted_at IS NULL AND referral.outbound_payload ? 'adReferral'
            ) ORDER BY m.sequence DESC LIMIT 1`, [empresaId, conversationId, messageId],
      );
      const state = normalizeWebsiteInteraction(row?.state);
      return state ? { ...state, direct: row.direct } : null;
    });
  }

  catalogPhotosPresented({ empresaId, conversationId, messageId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const { rows } = await client.query(`SELECT m.outbound_payload->>'catalogProductId' AS product_id
        FROM mensagens m JOIN mensagens anchor ON anchor.empresa_id=m.empresa_id AND anchor.conversa_id=m.conversa_id AND anchor.id=$3
        WHERE m.empresa_id=$1 AND m.conversa_id=$2 AND m.sequence<anchor.sequence AND m.direcao='saida' AND m.tipo='imagem'
          AND m.redacted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>now())
          AND m.external_message_id IS NOT NULL AND m.status IN ('enviada','entregue','lida')
          AND m.origem_resposta IN ('ia','fluxo_deterministico') AND m.outbound_payload ? 'catalogPhotoIndex'
          AND m.outbound_payload->>'catalogProductId' IS NOT NULL
        GROUP BY m.outbound_payload->>'catalogProductId' ORDER BY max(m.sequence) DESC LIMIT 100`, [empresaId, conversationId, messageId]);
      return rows.map((row) => row.product_id).reverse();
    });
  }

  financingSession({ empresaId, conversationId, messageId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const { rows } = await client.query(`SELECT m.outbound_payload->'websiteInteraction' AS state
        FROM mensagens m JOIN mensagens anchor ON anchor.empresa_id=m.empresa_id AND anchor.conversa_id=m.conversa_id AND anchor.id=$3
        WHERE m.empresa_id=$1 AND m.conversa_id=$2 AND m.direcao='saida' AND m.sequence<anchor.sequence
          AND m.redacted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>now())
          AND m.external_message_id IS NOT NULL AND m.status IN ('enviada','entregue','lida')
          AND m.outbound_payload#>>'{websiteInteraction,step}' IN ('finance_accepted','closed','declined')
        ORDER BY m.sequence`, [empresaId, conversationId, messageId]);
      return pendingWebsiteFinancingSession(rows.map((row) => row.state));
    });
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
      const listFormatMetadata = websiteListFormatMetadata(reply);
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
            ...listFormatMetadata,
            ...(reply.inboundTurnSequence == null ? {} : { inboundTurnSequence: reply.inboundTurnSequence }),
            ...(reply.inboundTurnIncludesImages ? { inboundTurnIncludesImages: true } : {}),
            ...(reply.salesInterest ? { salesInterest: reply.salesInterest } : {}),
            ...(reply.leadQualification ? { leadQualification: reply.leadQualification } : {}),
            ...(reply.websiteInteraction ? { websiteInteraction: normalizeWebsiteInteraction(reply.websiteInteraction) } : {}),
            ...(reply.tradeInEvaluation ? { tradeInEvaluation: normalizeTradeInEvaluation(reply.tradeInEvaluation) } : {}),
            ...(reply.nonLeadHandoff ? { nonLeadHandoff: reply.nonLeadHandoff } : {}) }),
        ],
      )).rows[0];
      if (row) return { ...websiteListFormatMetadata(row.outbound_payload || {}), id: row.id, text: row.corpo, buttons: row.outbound_payload?.buttons || [], sendNotBefore: row.outbound_payload?.sendNotBefore || null, inboundTurnSequence: row.outbound_payload?.inboundTurnSequence, status: row.status };
      const existing = (await client.query(
        `SELECT id, corpo, outbound_payload, external_message_id, status
           FROM mensagens WHERE empresa_id = $1 AND source_message_id = $2 AND direcao = 'saida'`,
        [empresaId, message.id],
      )).rows[0];
      return { ...websiteListFormatMetadata(existing.outbound_payload || {}), id: existing.id, text: existing.corpo, buttons: existing.outbound_payload?.buttons || [], sendNotBefore: existing.outbound_payload?.sendNotBefore || null, inboundTurnSequence: existing.outbound_payload?.inboundTurnSequence, externalMessageId: existing.external_message_id, status: existing.status };
    });
  }

  canSendBotReply(input) {
    return withTenantTransaction(this.pool, { empresaId: input.empresaId }, ({ client }) => this.canSendBotReplyInTransaction(client, input));
  }

  async canSendBotReplyInTransaction(client, { empresaId, messageId }) {
    return (await client.query(
      `SELECT 1 FROM mensagens m
         JOIN empresas e ON e.id = m.empresa_id AND e.status = 'ativa'
         JOIN conversas c ON c.empresa_id = m.empresa_id AND c.id = m.conversa_id
         JOIN contatos ct ON ct.empresa_id = m.empresa_id AND ct.id = m.contato_id
         JOIN numeros_whatsapp n ON n.empresa_id = m.empresa_id AND n.id = m.numero_whatsapp_id
        WHERE m.empresa_id = $1 AND m.id = $2 AND m.redacted_at IS NULL
          AND c.status = 'aberta' AND c.modo_atendimento = 'bot'
          AND NOT EXISTS (SELECT 1 FROM mensagens checkpoint JOIN mensagens newer
            ON newer.empresa_id=checkpoint.empresa_id AND newer.conversa_id=checkpoint.conversa_id
            WHERE checkpoint.empresa_id=m.empresa_id AND checkpoint.source_message_id=m.id
              AND checkpoint.outbound_payload ? 'inboundTurnSequence'
              AND newer.direcao='entrada' AND newer.redacted_at IS NULL
              AND newer.sequence>(checkpoint.outbound_payload->>'inboundTurnSequence')::bigint)
          AND ct.deleted_at IS NULL AND NOT ct.bloqueado AND NOT ct.bot_pausado
          AND n.deleted_at IS NULL AND n.status = 'ativo'`,
      [empresaId, messageId],
    )).rowCount > 0;
  }

  claimBotDispatch({ empresaId, messageId, replyId }) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      await client.query(`SELECT c.id FROM conversas c JOIN mensagens m ON m.empresa_id=c.empresa_id AND m.conversa_id=c.id
        WHERE m.empresa_id=$1 AND m.id=$2 FOR UPDATE OF c`, [empresaId, replyId]);
      const row = (await client.query('SELECT * FROM mensagens WHERE empresa_id=$1 AND id=$2 FOR UPDATE', [empresaId, replyId])).rows[0];
      if (!row || row.external_message_id) return { allowed: false };
      if (['started','uncertain'].includes(row.outbound_payload?.dispatchState)) return { allowed: false, uncertain: true };
      if (!['processando','enfileirada'].includes(row.status)) return { allowed: false };
      if (!await this.canSendBotReplyInTransaction(client, { empresaId, messageId })
        || !await canDispatchWebsiteReply(client, empresaId, { ...row.outbound_payload, text: row.corpo })) {
        await client.query("UPDATE mensagens SET status='ignorada_duplicidade' WHERE empresa_id=$1 AND id=$2", [empresaId, replyId]);
        return { allowed: false };
      }
      await client.query("UPDATE mensagens SET outbound_payload=jsonb_set(outbound_payload,'{dispatchState}','\"started\"') WHERE empresa_id=$1 AND id=$2", [empresaId, replyId]);
      return { allowed: true };
    });
  }

  markBotDispatchUncertain({ empresaId, replyId }) {
    return withTenantTransaction(this.pool, { empresaId }, ({ client }) => client.query(`UPDATE mensagens SET
      outbound_payload=jsonb_set(outbound_payload,'{dispatchState}','"uncertain"'),error_code='BOT_REPLY_RECONCILIATION_REQUIRED'
      WHERE empresa_id=$1 AND id=$2 AND external_message_id IS NULL AND outbound_payload->>'dispatchState'='started'`, [empresaId, replyId]));
  }

  canSendWebsiteReply({ empresaId, part }) {
    return withTenantTransaction(this.pool, { empresaId }, ({ client }) => canDispatchWebsiteReply(client, empresaId, part));
  }

  cancelPreparedReply({ empresaId, messageId }) {
    return withTenantTransaction(this.pool, { empresaId }, ({ client }) => client.query(
      `UPDATE mensagens SET status = 'ignorada_duplicidade', updated_at = now()
        WHERE empresa_id = $1 AND direcao = 'saida'
          AND (source_message_id = $2 OR outbound_payload->>'parentReplyId' IN (
            SELECT id::text FROM mensagens WHERE empresa_id = $1 AND source_message_id = $2 AND direcao = 'saida'
          ))
          AND external_message_id IS NULL AND status IN ('processando', 'enfileirada')
          AND coalesce(outbound_payload->>'dispatchState','pending') NOT IN ('started','uncertain')`,
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
  aiReplyDelayMs = () => INBOUND_COOLDOWN_MS,
} = {}) {
  if (typeof repository?.inboundMessage !== "function") throw new TypeError("repository.inboundMessage e obrigatorio.");
  if (typeof repository?.statusEvent !== "function") throw new TypeError("repository.statusEvent e obrigatorio.");
  if (typeof conversationService?.getConversation !== "function") throw new TypeError("conversationService.getConversation e obrigatorio.");
  if (typeof conversationService?.recordMessage !== "function") throw new TypeError("conversationService.recordMessage e obrigatorio.");
  if (typeof conversationService?.applyMetaStatus !== "function") throw new TypeError("conversationService.applyMetaStatus e obrigatorio.");
  if (typeof tenantDefinitionRepository?.load !== "function") throw new TypeError("tenantDefinitionRepository.load e obrigatorio.");
  if (typeof metaGateway?.sendReply !== "function") throw new TypeError("metaGateway.sendReply e obrigatorio.");

  async function dispatchBot(reference, message, prepared, part, payload) {
    const guarded = typeof repository.claimBotDispatch === 'function' && part?.id && prepared?.inboundTurnSequence != null;
    if (guarded) {
      const claim = await repository.claimBotDispatch({ empresaId: reference.empresaId, messageId: message.id, replyId: part.id });
      if (!claim.allowed) return { allowed: false, uncertain: claim.uncertain === true };
    }
    try {
      const result = await metaGateway.sendReply({ empresaId: reference.empresaId, numeroWhatsappId: message.numeroWhatsappId }, payload);
      if (guarded && !firstMetaMessageId(result)) throw permanent('Provedor não confirmou envio.', 'BOT_REPLY_SEND_ID_MISSING');
      return { allowed: true, result };
    } catch (error) {
      if (!guarded) throw error;
      await repository.markBotDispatchUncertain({ empresaId: reference.empresaId, replyId: part.id });
      return { allowed: false, uncertain: true };
    }
  }

  async function processInboundMessage(reference, _record, execution = {}) {
    let message = await repository.inboundMessage(reference);
    if (!message) throw permanent("Mensagem de entrada nao encontrada.", "INBOUND_MESSAGE_NOT_FOUND");
    const conversation = await conversationService.getConversation({
      empresaId: reference.empresaId,
      conversationId: message.conversationId,
    });
    let mediaRejected = false;
    async function storeMedia(target) {
      try {
        return await storeInboundMedia({ empresaId: reference.empresaId, message: target, metaGateway, mediaStore, repository });
      } catch (error) {
        if (!MEDIA_POLICY_ERRORS.has(error?.code)) throw error;
        mediaRejected = true;
        logger.info?.("whatsapp_media_rejected", {
          empresaId: reference.empresaId,
          conversationId: message.conversationId,
          code: error.code,
        });
        return target;
      }
    }
    message = await storeMedia(message);
    if (message.type === "image" && message.mediaStorageKey && conversation.mode !== "bot") {
      await repository.queueLeadImages?.({ empresaId: reference.empresaId, conversationId: message.conversationId, messageId: message.id });
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
    if (prepared && (message.type === "text" || prepared.inboundTurnIncludesImages && message.type === "image") && typeof repository.inboundTurn === "function") {
      const current = await repository.inboundTurn({ empresaId: reference.empresaId, conversationId: message.conversationId, messageId: message.id,
        ...(prepared.inboundTurnIncludesImages ? { includeImages: true } : {}) });
      if (current && current.sequence > message.sequence) {
        await repository.cancelPreparedReply?.({ empresaId: reference.empresaId, messageId: message.id });
        return { skipped: true, reason: "inbound_turn_changed" };
      }
    }
    let reply;
    let inboundTurn;
    if (!prepared) {
      const storedDefinition = mediaRejected ? null : await tenantDefinitionRepository.load(reference.empresaId);
      if (!mediaRejected && !storedDefinition) throw permanent("Configuracao da empresa nao encontrada.", "TENANT_RUNTIME_NOT_FOUND");
      const acceptsContextualImages = storedDefinition?.ai?.tradeInEvaluationEnabled === true || storedDefinition?.ai?.contextualServiceEnabled === true;
      const activeFlow = acceptsContextualImages
        ? await conversationService.getState?.({ empresaId: reference.empresaId, conversationId: message.conversationId }) : null;
      const includeImages = acceptsContextualImages && !["orders", "appointments", "flows"].includes(activeFlow?.flowKey);
      if ((message.type === "text" || includeImages && message.type === "image") && storedDefinition?.ai?.enabled === true
        && typeof repository.inboundTurn === "function") {
        inboundTurn = await repository.inboundTurn({ empresaId: reference.empresaId, conversationId: message.conversationId, messageId: message.id, ...(includeImages ? { includeImages: true } : {}) });
        if (!inboundTurn) return { skipped: true, reason: "inbound_turn_already_answered" };
        if (Date.parse(inboundTurn.readyAt) > clock().getTime()) return { deferUntil: inboundTurn.readyAt };
        if (message.id !== inboundTurn.messageId) {
          const latest = await repository.inboundMessage({ ...reference, messageId: inboundTurn.messageId });
          if (!latest) throw permanent("Mensagem de entrada nao encontrada.", "INBOUND_MESSAGE_NOT_FOUND");
          message = { ...latest, runtimeGeneration: message.runtimeGeneration };
          prepared = await repository.preparedReply?.({ empresaId: reference.empresaId, messageId: message.id });
          if (prepared) return { skipped: true, reason: "inbound_turn_checkpoint_exists" };
        }
        if (includeImages) {
          for (const part of inboundTurn.messages.filter((part) => part.type === "image")) {
            const image = part.id === message.id ? message : await repository.inboundMessage({ ...reference, messageId: part.id });
            if (!image) throw permanent("Mensagem de imagem não encontrada.", "INBOUND_MESSAGE_NOT_FOUND");
            const stored = await storeMedia(image);
            part.mediaStored = Boolean(stored.mediaStorageKey);
            if (stored.id === message.id) message = stored;
          }
        }
      }
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
        reply = { text: "Não consegui aceitar esse arquivo. Envie uma imagem JPEG, PNG ou WEBP, ou um PDF, com até 10 MB.", buttons: [] };
      } else {
        const definition = storedDefinition;
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
              const qualifiesLeads = definition.ai?.leadQualificationEnabled === true;
              const websiteCatalog = config.catalog.source?.type === "website_catalog" && config.enabledModules.includes("catalog");
              const sheetSales = config.catalog.source?.type === "google_sheets" && definition.ai?.catalogSalesEnabled === true;
              const realEstateCatalog = config.catalog.source?.type === 'real_estate_catalog' && config.enabledModules.includes('catalog');
              const salesMode = !intakeOnly && (websiteCatalog || realEstateCatalog || sheetSales) && config.catalog.source.status === "healthy";
              const referral = qualifiesLeads || salesMode
                ? message.adReferral || await repository.adReferral?.({ empresaId: config.empresaId, conversationId: input.conversationId, messageId: message.id })
                : null;
              const leadReferral = qualifiesLeads ? normalizeAdReferral(referral) : null;
              const currentReferral = Boolean(message.adReferral);
              const evaluationSession = definition.ai?.tradeInEvaluationEnabled === true
                ? await repository.tradeInEvaluationSession?.({ empresaId: config.empresaId, conversationId: input.conversationId, messageId: message.id }) : null;
              let browseState;
              if (salesMode) {
                if (typeof repository.catalogBrowseState !== "function") throw permanent("Paginação persistida do catálogo não configurada.", "CATALOG_BROWSE_STATE_REQUIRED");
                browseState = await repository.catalogBrowseState({ empresaId: config.empresaId, conversationId: input.conversationId });
              }
              const interaction = (websiteCatalog || realEstateCatalog) && !currentReferral ? await repository.websiteInteraction?.({ empresaId: config.empresaId, conversationId: input.conversationId, messageId: message.id }) : null;
              const financingSession = websiteCatalog ? await repository.financingSession?.({ empresaId: config.empresaId, conversationId: input.conversationId, messageId: message.id }) : null;
              const photoHistoryProductIds = websiteCatalog || realEstateCatalog ? await repository.catalogPhotosPresented?.({ empresaId: config.empresaId, conversationId: input.conversationId, messageId: message.id }) : null;
              const catalogContext = { ...config.catalog, ...(interaction ? { interaction } : {}), ...(financingSession ? { financingSession } : {}), ...(photoHistoryProductIds?.length ? { photoHistoryProductIds } : {}), ...(salesMode ? { salesMode: true, browseState,
                quotedProductId: await repository.quotedCatalogProduct?.({ empresaId: config.empresaId, conversationId: input.conversationId, messageId: message.id, externalMessageId: message.replyToExternalMessageId }) || null,
                adContext: catalogAdContext(referral, config.catalog, { current: currentReferral }),
                interestHandoff: { enabled: definition.ai?.catalogSalesEnabled === true && config.enabledModules.includes("human_handoff") && Boolean(config.humanHandoff.salesInterestMessage?.trim()), message: config.humanHandoff.salesInterestMessage || "" },
              } : {}) };
              const direct = salesMode && !qualifiesLeads && definition.ai?.contextualServiceEnabled !== true && definition.ai?.enabled === true && message.type === "text" ? directCatalogInterest(input.text, catalogContext) : null;
              if (direct) return { reply: direct };
              const aiReply = await aiService.reply({
                empresaId: config.empresaId,
                conversationId: input.conversationId,
                messageId: message.id,
                correlationId: message.correlationId,
                message: input.text,
                ...(inboundTurn ? { turnMessages: inboundTurn.messages } : {}),
                context: {
                  identity: config.identity,
                  menu: {
                    text: config.menu.text,
                    options: config.menu.options.map(({ label }) => ({ label })),
                  },
                  ...(qualifiesLeads ? { adContext: leadReferral ? { referral: leadReferral, current: currentReferral } : null } : {}),
                  ...(definition.ai?.tradeInEvaluationEnabled === true ? { tradeInEvaluation: { session: evaluationSession || null } } : {}),
                  ...(intakeOnly ? {} : {
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
          text: inboundTurn ? inboundTurn.messages.map(inboundMessageContent).join("\n") : message.text,
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
      if (inboundTurn && reply.module !== "human_handoff") {
        const current = await repository.inboundTurn({ empresaId: reference.empresaId, conversationId: message.conversationId, messageId: message.id, ...(inboundTurn.includesImages ? { includeImages: true } : {}) });
        if (current?.sequence !== inboundTurn.sequence) return current ? { deferUntil: current.readyAt } : { skipped: true, reason: "inbound_turn_changed" };
        reply.inboundTurnSequence = inboundTurn.sequence;
        if (inboundTurn.includesImages) reply.inboundTurnIncludesImages = true;
      }
      if (reply.code === "HANDOFF_COOLDOWN") {
        return { skipped: true, reason: "handoff_cooldown" };
      }
      if (reply.code === "NO_CUSTOMER_CONTENT") return { skipped: true, reason: "no_customer_content" };
      if (generatedByAi) {
        if (typeof repository.prepareReply !== "function") throw permanent("Persistência da resposta da IA não configurada.", "BOT_REPLY_CHECKPOINT_REQUIRED");
        const delayMs = !inboundTurn && responseDelayEnabled ? aiReplyDelayMs() : 0;
        if (delayMs && (!Number.isInteger(delayMs) || delayMs < 10_000 || delayMs > 15_000)) throw new TypeError("Espera da IA deve ficar entre 10 e 15 segundos.");
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
        ...(prepared.websiteInteraction ? { websiteInteraction: prepared.websiteInteraction } : {}),
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
        if (current.mode !== "bot" || !await repository.canSendBotReply({ empresaId: reference.empresaId, messageId: message.id })
          || (repository.canSendWebsiteReply && !await repository.canSendWebsiteReply({ empresaId: reference.empresaId, part }))) {
          await repository.cancelPreparedReply({ empresaId: reference.empresaId, messageId: message.id });
          return { skipped: true, reason: "bot_reply_cancelled" };
        }
        if (execution.canContinue && !execution.canContinue()) throw Object.assign(new Error("Lease de processamento foi perdido."), { code: "PROCESSING_LEASE_LOST", retryable: true });
        const dispatch = await dispatchBot(reference, message, prepared, part, {
          to: message.senderPhone, text: part.text, buttons: part.buttons, ...(part.imageUrl ? { imageUrl: part.imageUrl } : {}),
        });
        if (!dispatch.allowed) return dispatch.uncertain ? { reconciliationRequired: true } : { skipped: true, reason: 'bot_reply_cancelled' };
        const externalMessageId = firstMetaMessageId(dispatch.result);
        if (typeof externalMessageId !== "string" || !externalMessageId) throw permanent("Provedor não confirmou o identificador da mensagem.", "BOT_REPLY_SEND_ID_MISSING");
        await repository.markReplySent({ empresaId: reference.empresaId, replyId: part.id, externalMessageId });
      }
      return { replied: true };
    }
    if (repository.canSendWebsiteReply && !await repository.canSendWebsiteReply({ empresaId: reference.empresaId, part: reply })) {
      await repository.cancelPreparedReply?.({ empresaId: reference.empresaId, messageId: message.id });
      return { skipped: true, reason: "bot_reply_cancelled" };
    }
    const dispatch = await dispatchBot(reference, message, prepared, prepared, {
      to: message.senderPhone,
      text: reply.text,
      buttons: reply.buttons,
    });
    if (!dispatch.allowed) return dispatch.uncertain ? { reconciliationRequired: true } : { skipped: true, reason: 'bot_reply_cancelled' };
    const externalMessageId = firstMetaMessageId(dispatch.result);
    if ((reply.salesInterest || reply.leadQualification || reply.nonLeadHandoff || reply.websiteInteraction?.step === "closed")
      && (typeof externalMessageId !== "string" || !externalMessageId)) throw permanent("Provedor não confirmou o identificador da mensagem.", "BOT_REPLY_SEND_ID_MISSING");
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
