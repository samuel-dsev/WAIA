import { randomUUID } from "node:crypto";
import { createWhatsAppReplyPayload } from "../whatsapp/outbound.js";
import { normalizeCatalogBrowseState } from "../business/catalog-sales.js";
import { normalizeWebsiteInteraction, normalizeWebsiteListFormatVersion, validCatalogContinuation } from "../business/website-catalog-interaction.js";
import { normalizeTradeInEvaluation } from "../business/trade-in-evaluation.js";

const invalid = () => Object.assign(new Error("Checkpoint de mensagens inválido."), { code: "BOT_REPLY_BATCH_INVALID", retryable: false });
const columns = "id, corpo, outbound_payload, external_message_id, status";
const maxReplyParts = 303; // Até três veículos com 100 fotos e a pergunta em texto.

export function websiteListFormatMetadata(part) {
  const interaction = normalizeWebsiteInteraction(part.websiteInteraction);
  const continuation = part.catalogContinuation;
  if (continuation !== undefined && (!validCatalogContinuation(continuation)
    || !(part.catalogListFormatVersion === 3 && interaction?.step === "list" && !part.imageUrl
      || ["gallery", "finance_accepted"].includes(interaction?.step) && part.imageUrl && part.catalogProductId === interaction.productIds.at(-1)))) throw invalid();
  const metadata = continuation === undefined ? {} : { catalogContinuation: continuation };
  if (part.catalogListFormatVersion === undefined) return metadata;
  if (normalizeWebsiteListFormatVersion(part.catalogListFormatVersion) === null
    || interaction?.step !== "list" || part.imageUrl || part.catalogListFormatVersion === 3 && continuation === undefined) throw invalid();
  return { ...metadata, catalogListFormatVersion: part.catalogListFormatVersion };
}

export function replyFromRow(row) {
  return row && {
    id: row.id, text: row.corpo, buttons: row.outbound_payload?.buttons || [],
    ...(row.outbound_payload?.imageUrl ? { imageUrl: row.outbound_payload.imageUrl } : {}),
    ...(row.outbound_payload?.catalogProductId ? { catalogProductId: row.outbound_payload.catalogProductId } : {}),
    ...(row.outbound_payload?.websiteInteraction ? { websiteInteraction: normalizeWebsiteInteraction(row.outbound_payload.websiteInteraction) } : {}),
    ...websiteListFormatMetadata(row.outbound_payload || {}),
    ...(row.outbound_payload?.tradeInEvaluation ? { tradeInEvaluation: normalizeTradeInEvaluation(row.outbound_payload.tradeInEvaluation) } : {}),
    ...(row.outbound_payload?.inboundTurnIncludesImages ? { inboundTurnIncludesImages: true } : {}),
    ...(Number.isInteger(row.outbound_payload?.catalogPhotoIndex) ? { catalogPhotoIndex: row.outbound_payload.catalogPhotoIndex } : {}),
    ...(row.outbound_payload?.nonLeadHandoff ? { nonLeadHandoff: row.outbound_payload.nonLeadHandoff } : {}),
    sendNotBefore: row.outbound_payload?.sendNotBefore || null,
    inboundTurnSequence: row.outbound_payload?.inboundTurnSequence,
    externalMessageId: row.external_message_id, status: row.status,
  };
}

/** Cursor advances only for product parts confirmed by the provider, never at generation time. */
export async function loadCatalogBrowseState(client, empresaId, conversationId) {
  const row = (await client.query(
    `SELECT ${columns} FROM mensagens WHERE empresa_id = $1 AND conversa_id = $2
       AND direcao = 'saida' AND origem_resposta IN ('ia', 'fluxo_deterministico') AND outbound_payload ? 'catalogBrowse'
       AND redacted_at IS NULL ORDER BY sequence DESC LIMIT 1`, [empresaId, conversationId],
  )).rows[0];
  if (!row) return null;
  const metadata = row.outbound_payload.catalogBrowse;
  const previous = normalizeCatalogBrowseState({ filters: metadata.filters, seenProductIds: metadata.priorSeenProductIds });
  const reply = await hydrateReply(client, empresaId, row);
  if (!reply.messages) throw invalid();
  const confirmed = reply.messages.filter((part) => part.externalMessageId && ["enviada", "entregue", "lida"].includes(part.status))
    .flatMap((part) => part.websiteInteraction?.step === "list" ? part.websiteInteraction.productIds : part.catalogProductId ? [part.catalogProductId] : []);
  // Conversation history protects model choices from spontaneous resends;
  // only the current query's cursor advances pagination.
  const history = (await client.query(
    `SELECT product.id AS catalog_product_id FROM mensagens
       CROSS JOIN LATERAL jsonb_array_elements_text(CASE
         WHEN outbound_payload#>>'{websiteInteraction,step}' = 'list' AND jsonb_typeof(outbound_payload#>'{websiteInteraction,productIds}') = 'array'
         THEN outbound_payload#>'{websiteInteraction,productIds}' ELSE jsonb_build_array(outbound_payload->>'catalogProductId') END) AS product(id)
       WHERE empresa_id = $1 AND conversa_id = $2 AND direcao = 'saida' AND origem_resposta IN ('ia', 'fluxo_deterministico')
         AND redacted_at IS NULL AND external_message_id IS NOT NULL AND product.id IS NOT NULL
         AND status IN ('enviada','entregue','lida')
       GROUP BY product.id ORDER BY min(sequence), product.id LIMIT 100`, [empresaId, conversationId],
  )).rows.map((part) => part.catalog_product_id);
  return normalizeCatalogBrowseState({ filters: previous.filters,
    seenProductIds: [...new Set([...previous.seenProductIds.filter((id) => history.includes(id)), ...confirmed])].slice(0, 100),
    presentedProductIds: [...new Set([...history, ...confirmed])].slice(0, 100) });
}

export async function hydrateReply(client, empresaId, row) {
  const reply = replyFromRow(row);
  const ids = row?.outbound_payload?.partIds;
  if (ids == null) return reply;
  if (!Array.isArray(ids) || !ids.length || ids.length > maxReplyParts || ids[0] !== row.id
    || new Set(ids).size !== ids.length || ids.some((id) => !/^[0-9a-f-]{36}$/iu.test(id))) throw invalid();
  const rows = (await client.query(
    `SELECT ${columns} FROM mensagens WHERE empresa_id = $1 AND id = ANY($2::uuid[])
       AND direcao = 'saida' ORDER BY array_position($2::uuid[], id)`, [empresaId, ids],
  )).rows;
  if (rows.length !== ids.length || rows.some((part, index) => part.id !== ids[index]
    || (index > 0 && part.outbound_payload?.parentReplyId !== row.id))) throw invalid();
  return { ...reply, messages: rows.map(replyFromRow) };
}

/** All parts and their order are committed atomically, using the existing checkpoint. */
export async function prepareReplyBatch(client, { empresaId, message, reply, origin }) {
  if (!Array.isArray(reply.messages) || !reply.messages.length || reply.messages.length > maxReplyParts) throw invalid();
  const messages = reply.messages.map((part) => {
    if (part.catalogProductId != null && (typeof part.catalogProductId !== "string" || !part.catalogProductId || part.catalogProductId.length > 200)) throw invalid();
    const websiteInteraction = normalizeWebsiteInteraction(part.websiteInteraction);
    const tradeInEvaluation = normalizeTradeInEvaluation(part.tradeInEvaluation);
    if (part.websiteInteraction && !websiteInteraction) throw invalid();
    if (part.catalogPhotoIndex != null && (!Number.isInteger(part.catalogPhotoIndex) || part.catalogPhotoIndex < 0 || part.catalogPhotoIndex >= 100 || !part.catalogProductId || !part.imageUrl)) throw invalid();
    const payload = createWhatsAppReplyPayload({ to: "validation", ...part });
    return { text: payload.type === "image" ? payload.image.caption || "" : part.text.trim(),
      buttons: part.buttons || [], ...(payload.type === "image" ? { imageUrl: payload.image.link } : {}),
      ...(part.catalogProductId ? { catalogProductId: part.catalogProductId } : {}),
      ...(websiteInteraction ? { websiteInteraction } : {}),
      ...websiteListFormatMetadata(part),
      ...(tradeInEvaluation ? { tradeInEvaluation } : {}),
      ...(part.catalogPhotoIndex != null ? { catalogPhotoIndex: part.catalogPhotoIndex } : {}) };
  });
  const browseState = reply.catalogBrowse == null ? null : normalizeCatalogBrowseState({ filters: reply.catalogBrowse.filters, seenProductIds: reply.catalogBrowse.priorSeenProductIds });
  if (browseState && !messages.some((part) => part.catalogProductId || part.websiteInteraction?.step === "list")) throw invalid();
  const existing = async () => (await client.query(
    `SELECT ${columns} FROM mensagens WHERE empresa_id = $1 AND source_message_id = $2 AND direcao = 'saida'`,
    [empresaId, message.id],
  )).rows[0];
  const before = await existing();
  if (before) return hydrateReply(client, empresaId, before);
  const sequence = Number((await client.query(
    `UPDATE conversas SET next_sequence = next_sequence + $3 WHERE empresa_id = $1 AND id = $2
       RETURNING next_sequence - $3 AS sequence`, [empresaId, message.conversationId, messages.length],
  )).rows[0]?.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw invalid();
  const ids = messages.map(() => randomUUID());
  let parent;
  for (const [index, part] of messages.entries()) {
    const payload = { buttons: part.buttons, ...(part.imageUrl ? { imageUrl: part.imageUrl } : {}),
      ...(reply.inboundTurnSequence == null ? {} : { inboundTurnSequence: reply.inboundTurnSequence }),
      ...(reply.inboundTurnIncludesImages ? { inboundTurnIncludesImages: true } : {}),
      ...(part.catalogProductId ? { catalogProductId: part.catalogProductId } : {}),
      ...(part.websiteInteraction ? { websiteInteraction: part.websiteInteraction } : {}),
      ...(part.catalogListFormatVersion === undefined ? {} : { catalogListFormatVersion: part.catalogListFormatVersion }),
      ...(part.catalogContinuation === undefined ? {} : { catalogContinuation: part.catalogContinuation }),
      ...(part.tradeInEvaluation ? { tradeInEvaluation: part.tradeInEvaluation } : {}),
      ...(part.catalogPhotoIndex != null ? { catalogPhotoIndex: part.catalogPhotoIndex } : {}),
      ...(index === 0 ? { partIds: ids, ...(reply.sendNotBefore ? { sendNotBefore: reply.sendNotBefore } : {}),
        ...(browseState ? { catalogBrowse: { filters: browseState.filters, priorSeenProductIds: browseState.seenProductIds } } : {}) } : { parentReplyId: ids[0] }) };
    const row = (await client.query(
      `INSERT INTO mensagens (id, empresa_id, conversa_id, contato_id, numero_whatsapp_id,
         direcao, tipo, corpo, status, origem_resposta, sequence, correlation_id, source_message_id, outbound_payload, processing_at)
       VALUES ($1,$2,$3,$4,$5,'saida',$6,$7,'processando',$8,$9,$10,$11,$12::jsonb,now())
       ON CONFLICT (empresa_id, source_message_id) WHERE source_message_id IS NOT NULL AND direcao = 'saida'
       DO NOTHING RETURNING ${columns}`,
      [ids[index], empresaId, message.conversationId, message.contactId, message.numeroWhatsappId,
        part.imageUrl ? "imagem" : part.buttons.length ? "interativo" : "texto", part.text,
        origin === "ai" ? "ia" : "fluxo_deterministico", sequence + index, message.correlationId,
        index === 0 ? message.id : null, JSON.stringify(payload)],
    )).rows[0];
    if (index === 0 && !row) return hydrateReply(client, empresaId, await existing());
    if (!row) throw invalid();
    if (index === 0) parent = row;
  }
  return hydrateReply(client, empresaId, parent);
}
