import { randomUUID } from "node:crypto";
import { createWhatsAppReplyPayload } from "../whatsapp/outbound.js";
import { normalizeCatalogBrowseState } from "../business/catalog-sales.js";

const invalid = () => Object.assign(new Error("Checkpoint de mensagens inválido."), { code: "BOT_REPLY_BATCH_INVALID", retryable: false });
const columns = "id, corpo, outbound_payload, external_message_id, status";

export function replyFromRow(row) {
  return row && {
    id: row.id, text: row.corpo, buttons: row.outbound_payload?.buttons || [],
    ...(row.outbound_payload?.imageUrl ? { imageUrl: row.outbound_payload.imageUrl } : {}),
    ...(row.outbound_payload?.catalogProductId ? { catalogProductId: row.outbound_payload.catalogProductId } : {}),
    sendNotBefore: row.outbound_payload?.sendNotBefore || null,
    externalMessageId: row.external_message_id, status: row.status,
  };
}

/** Cursor advances only for product parts confirmed by the provider, never at generation time. */
export async function loadCatalogBrowseState(client, empresaId, conversationId) {
  const row = (await client.query(
    `SELECT ${columns} FROM mensagens WHERE empresa_id = $1 AND conversa_id = $2
       AND direcao = 'saida' AND origem_resposta = 'ia' AND outbound_payload ? 'catalogBrowse'
       AND redacted_at IS NULL ORDER BY sequence DESC LIMIT 1`, [empresaId, conversationId],
  )).rows[0];
  if (!row) return null;
  const metadata = row.outbound_payload.catalogBrowse;
  const previous = normalizeCatalogBrowseState({ filters: metadata.filters, seenProductIds: metadata.priorSeenProductIds });
  const reply = await hydrateReply(client, empresaId, row);
  if (!reply.messages) throw invalid();
  const confirmed = reply.messages.filter((part) => part.catalogProductId && part.externalMessageId && ["enviada", "entregue", "lida"].includes(part.status)).map((part) => part.catalogProductId);
  // Conversation history protects model choices from spontaneous resends;
  // only the current query's cursor advances pagination.
  const history = (await client.query(
    `SELECT outbound_payload->>'catalogProductId' AS catalog_product_id FROM mensagens
       WHERE empresa_id = $1 AND conversa_id = $2 AND direcao = 'saida' AND origem_resposta = 'ia'
         AND redacted_at IS NULL AND external_message_id IS NOT NULL
         AND status IN ('enviada','entregue','lida') AND outbound_payload ? 'catalogProductId'
       GROUP BY outbound_payload->>'catalogProductId' ORDER BY min(sequence) LIMIT 100`, [empresaId, conversationId],
  )).rows.map((part) => part.catalog_product_id);
  return normalizeCatalogBrowseState({ filters: previous.filters,
    seenProductIds: [...new Set([...previous.seenProductIds.filter((id) => history.includes(id)), ...confirmed])].slice(0, 100),
    presentedProductIds: [...new Set([...history, ...confirmed])].slice(0, 100) });
}

export async function hydrateReply(client, empresaId, row) {
  const reply = replyFromRow(row);
  const ids = row?.outbound_payload?.partIds;
  if (ids == null) return reply;
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids[0] !== row.id
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
  if (!Array.isArray(reply.messages) || !reply.messages.length || reply.messages.length > 100) throw invalid();
  const messages = reply.messages.map((part) => {
    if (part.catalogProductId != null && (typeof part.catalogProductId !== "string" || !part.catalogProductId || part.catalogProductId.length > 200)) throw invalid();
    const payload = createWhatsAppReplyPayload({ to: "validation", ...part });
    return { text: payload.type === "image" ? payload.image.caption : part.text.trim(),
      buttons: part.buttons || [], ...(payload.type === "image" ? { imageUrl: payload.image.link } : {}),
      ...(part.catalogProductId ? { catalogProductId: part.catalogProductId } : {}) };
  });
  const browseState = reply.catalogBrowse == null ? null : normalizeCatalogBrowseState({ filters: reply.catalogBrowse.filters, seenProductIds: reply.catalogBrowse.priorSeenProductIds });
  if (browseState && !messages.some((part) => part.catalogProductId)) throw invalid();
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
      ...(part.catalogProductId ? { catalogProductId: part.catalogProductId } : {}),
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
