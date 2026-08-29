import { withTenantTransaction } from "../../infra/postgres/transaction.js";
import {
  ConversationNotFoundError,
  ConversationStateConflictError,
  canAdvanceMessageStatus,
  requireTenantId,
} from "./contracts.js";

const TO_DATABASE = Object.freeze({
  open: "aberta",
  closed: "fechada",
  archived: "arquivada",
  bot: "bot",
  human: "humano",
  paused: "pausado",
  inbound: "entrada",
  outbound: "saida",
  internal: "interna",
  text: "texto",
  image: "imagem",
  document: "documento",
  interactive: "interativo",
  system: "sistema",
  received: "recebida",
  queued: "enfileirada",
  processing: "processando",
  responded: "respondida",
  sent: "enviada",
  delivered: "entregue",
  read: "lida",
  failed: "falhou",
  duplicate_ignored: "ignorada_duplicidade",
  deterministic_flow: "fluxo_deterministico",
  operator: "operador",
});

const FROM_DATABASE = Object.freeze(Object.fromEntries(
  Object.entries(TO_DATABASE).map(([domain, database]) => [database, domain]),
));

const STATUS_TIMESTAMP_COLUMNS = Object.freeze({
  queued: "enqueued_at",
  processing: "processing_at",
  responded: "responded_at",
  sent: "sent_at",
  delivered: "delivered_at",
  read: "read_at",
});

function toDatabase(value) {
  return TO_DATABASE[value] || value;
}

function fromDatabase(value) {
  return FROM_DATABASE[value] || value;
}

function mapContact(row) {
  if (!row) return null;
  return {
    id: row.id,
    empresaId: row.empresa_id,
    phone: row.telefone_normalizado,
    maskedPhone: row.telefone_mascarado,
    firstInteractionAt: row.primeira_interacao_at,
    lastInteractionAt: row.ultima_interacao_at,
    anonymizedAt: row.anonimizado_at,
  };
}

function mapConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    empresaId: row.empresa_id,
    contactId: row.contato_id,
    numeroWhatsappId: row.numero_whatsapp_id,
    status: fromDatabase(row.status),
    mode: fromDatabase(row.modo_atendimento),
    operatorId: row.operador_usuario_id,
    correlationId: row.correlation_id,
    nextSequence: Number(row.next_sequence),
    version: Number(row.lock_version),
    openedAt: row.aberta_at,
    closedAt: row.fechada_at,
    lastMessageAt: row.ultima_mensagem_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    empresaId: row.empresa_id,
    conversationId: row.conversa_id,
    contactId: row.contato_id,
    numeroWhatsappId: row.numero_whatsapp_id,
    direction: fromDatabase(row.direcao),
    type: fromDatabase(row.tipo),
    body: row.corpo,
    mediaExternalId: row.media_external_id,
    mediaStorageKey: row.media_storage_key,
    externalMessageId: row.external_message_id,
    status: fromDatabase(row.status),
    origin: fromDatabase(row.origem_resposta),
    sequence: Number(row.sequence),
    providerTimestamp: row.provider_timestamp,
    attempts: row.tentativas,
    errorCode: row.error_code,
    errorSanitized: row.error_sanitized,
    operatorId: row.operador_usuario_id,
    correlationId: row.correlation_id,
    enqueuedAt: row.enqueued_at,
    processingAt: row.processing_at,
    respondedAt: row.responded_at,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    redactedAt: row.redacted_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  };
}

function mapState(row) {
  if (!row) return null;
  return {
    empresaId: row.empresa_id,
    conversationId: row.conversa_id,
    flowKey: row.flow_key,
    stage: row.stage,
    eventId: row.evento_id,
    orderId: row.pedido_id,
    receiptMessageId: row.comprovante_mensagem_id,
    data: row.state_data,
    version: Number(row.lock_version),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function maskedPhone(phone) {
  return `••••${phone.slice(-4)}`;
}

export class PostgresConversationRepository {
  constructor(pool) {
    if (!pool?.connect) throw new TypeError("Pool PostgreSQL inválido.");
    this.pool = pool;
  }

  transaction(input, callback) {
    const empresaId = requireTenantId(input);
    if (input.transaction) {
      if (!input.transaction?.client?.query || (!input.transaction.isPlatformAdmin && input.transaction.tenantId !== empresaId)) {
        throw new TypeError("Transação de conversa incompatível com a empresa.");
      }
      return callback(input.transaction);
    }
    return withTenantTransaction(this.pool, { empresaId }, callback);
  }

  async openOrResume(input) {
    const empresaId = requireTenantId(input);
    return this.transaction(input, async ({ client }) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${empresaId}:${input.phone}:${input.numeroWhatsappId}`],
      );
      const contactResult = await client.query(
        `INSERT INTO contatos (
           empresa_id, telefone_normalizado, telefone_mascarado,
           primeira_interacao_at, ultima_interacao_at
         ) VALUES ($1,$2,$3,$4,$4)
         ON CONFLICT (empresa_id, telefone_normalizado) WHERE deleted_at IS NULL
         DO UPDATE SET ultima_interacao_at = GREATEST(
           contatos.ultima_interacao_at,
           EXCLUDED.ultima_interacao_at
         )
         RETURNING *`,
        [empresaId, input.phone, maskedPhone(input.phone), input.occurredAt],
      );
      const contact = contactResult.rows[0];
      let conversationResult = await client.query(
        `SELECT * FROM conversas
          WHERE empresa_id = $1 AND contato_id = $2
            AND numero_whatsapp_id = $3 AND status = 'aberta'
          FOR UPDATE`,
        [empresaId, contact.id, input.numeroWhatsappId],
      );
      if (!conversationResult.rows[0]) {
        conversationResult = await client.query(
          `INSERT INTO conversas (
             empresa_id, contato_id, numero_whatsapp_id, correlation_id, aberta_at
           ) VALUES ($1,$2,$3,COALESCE($4::uuid, gen_random_uuid()),$5)
           RETURNING *`,
          [empresaId, contact.id, input.numeroWhatsappId, input.correlationId, input.occurredAt],
        );
        await client.query(
          `INSERT INTO estados_conversa (empresa_id, conversa_id)
           VALUES ($1,$2) ON CONFLICT (empresa_id, conversa_id) DO NOTHING`,
          [empresaId, conversationResult.rows[0].id],
        );
      }
      return {
        contact: mapContact(contact),
        conversation: mapConversation(conversationResult.rows[0]),
      };
    });
  }

  async findConversation(input) {
    requireTenantId(input);
    return this.transaction(input, async ({ client }) => {
      const result = await client.query(
        "SELECT * FROM conversas WHERE empresa_id = $1 AND id = $2",
        [input.empresaId, input.conversationId],
      );
      return mapConversation(result.rows[0]);
    });
  }

  async appendMessage(input) {
    const empresaId = requireTenantId(input);
    return this.transaction(input, async ({ client }) => {
      if (input.externalMessageId) {
        const existing = await client.query(
          "SELECT * FROM mensagens WHERE empresa_id = $1 AND external_message_id = $2",
          [empresaId, input.externalMessageId],
        );
        if (existing.rows[0]) return mapMessage(existing.rows[0], { inserted: false });
      }
      const conversationResult = await client.query(
        `UPDATE conversas
            SET next_sequence = next_sequence + 1,
                lock_version = lock_version + 1,
                ultima_mensagem_at = GREATEST(COALESCE(ultima_mensagem_at, $3), $3)
          WHERE empresa_id = $1 AND id = $2
          RETURNING *, next_sequence - 1 AS allocated_sequence`,
        [empresaId, input.conversationId, input.createdAt],
      );
      const conversation = conversationResult.rows[0];
      if (!conversation) throw new ConversationNotFoundError();
      const timestampColumn = STATUS_TIMESTAMP_COLUMNS[input.status];
      const timestampName = timestampColumn ? `, ${timestampColumn}` : "";
      const timestampValue = timestampColumn ? ", $18" : "";
      const result = await client.query(
        `INSERT INTO mensagens (
           empresa_id, conversa_id, contato_id, numero_whatsapp_id, direcao, tipo,
           corpo, media_external_id, media_storage_key, external_message_id, status,
           origem_resposta, sequence, provider_timestamp, operador_usuario_id,
           correlation_id, expires_at, created_at${timestampName}
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18${timestampValue}
         )
         ON CONFLICT (empresa_id, external_message_id) WHERE external_message_id IS NOT NULL
         DO NOTHING
         RETURNING *`,
        [
          empresaId,
          conversation.id,
          conversation.contato_id,
          conversation.numero_whatsapp_id,
          toDatabase(input.direction),
          toDatabase(input.type),
          input.body,
          input.mediaExternalId,
          input.mediaStorageKey,
          input.externalMessageId,
          toDatabase(input.status),
          toDatabase(input.origin),
          conversation.allocated_sequence,
          input.providerTimestamp,
          input.operatorId,
          input.correlationId,
          input.expiresAt,
          input.createdAt,
        ],
      );
      if (!result.rows[0] && input.externalMessageId) {
        const duplicate = await client.query(
          "SELECT * FROM mensagens WHERE empresa_id = $1 AND external_message_id = $2",
          [empresaId, input.externalMessageId],
        );
        return mapMessage(duplicate.rows[0], { inserted: false });
      }
      return mapMessage(result.rows[0], { inserted: true });
    });
  }

  async listMessages(input) {
    requireTenantId(input);
    return this.transaction(input, async ({ client }) => {
      const conversation = await client.query(
        "SELECT id FROM conversas WHERE empresa_id = $1 AND id = $2",
        [input.empresaId, input.conversationId],
      );
      if (!conversation.rows[0]) throw new ConversationNotFoundError();
      const result = await client.query(
        `SELECT * FROM (
           SELECT * FROM mensagens
            WHERE empresa_id = $1 AND conversa_id = $2
              AND ($3::bigint IS NULL OR sequence < $3)
            ORDER BY sequence DESC
            LIMIT $4
         ) page ORDER BY sequence ASC`,
        [input.empresaId, input.conversationId, input.beforeSequence, input.limit],
      );
      return result.rows.map(mapMessage);
    });
  }

  async findState(input) {
    requireTenantId(input);
    return this.transaction(input, async ({ client }) => {
      const result = await client.query(
        "SELECT * FROM estados_conversa WHERE empresa_id = $1 AND conversa_id = $2",
        [input.empresaId, input.conversationId],
      );
      return mapState(result.rows[0]);
    });
  }

  async saveState(input) {
    requireTenantId(input);
    return this.transaction(input, async ({ client }) => {
      const result = await client.query(
        `UPDATE estados_conversa
            SET flow_key = $4, stage = $5, evento_id = $6, pedido_id = $7,
                comprovante_mensagem_id = $8, state_data = $9::jsonb,
                expires_at = $10, lock_version = lock_version + 1,
                updated_at = $11
          WHERE empresa_id = $1 AND conversa_id = $2 AND lock_version = $3
          RETURNING *`,
        [
          input.empresaId,
          input.conversationId,
          input.expectedVersion,
          input.flowKey,
          input.stage,
          input.eventId,
          input.orderId,
          input.receiptMessageId,
          JSON.stringify(input.data),
          input.expiresAt,
          input.updatedAt,
        ],
      );
      if (result.rows[0]) return mapState(result.rows[0]);
      const exists = await client.query(
        "SELECT 1 FROM estados_conversa WHERE empresa_id = $1 AND conversa_id = $2",
        [input.empresaId, input.conversationId],
      );
      if (!exists.rows[0]) throw new ConversationNotFoundError();
      throw new ConversationStateConflictError();
    });
  }

  async setMode(input) {
    requireTenantId(input);
    return this.transaction(input, async ({ client }) => {
      const result = await client.query(
        `UPDATE conversas
            SET modo_atendimento = $3, operador_usuario_id = $4,
                lock_version = lock_version + 1, updated_at = $5
          WHERE empresa_id = $1 AND id = $2
          RETURNING *`,
        [input.empresaId, input.conversationId, toDatabase(input.mode), input.operatorId, input.updatedAt],
      );
      return mapConversation(result.rows[0]);
    });
  }

  async updateMessageStatus(input) {
    requireTenantId(input);
    return this.transaction(input, async ({ client }) => {
      const existing = await client.query(
        `SELECT * FROM mensagens
          WHERE empresa_id = $1 AND external_message_id = $2
          FOR UPDATE`,
        [input.empresaId, input.externalMessageId],
      );
      const row = existing.rows[0];
      if (!row) return null;
      const current = fromDatabase(row.status);
      if (!canAdvanceMessageStatus(current, input.status)) {
        return mapMessage(row, { changed: false });
      }
      const timestampColumn = STATUS_TIMESTAMP_COLUMNS[input.status];
      const timestampUpdate = timestampColumn
        ? `, ${timestampColumn} = COALESCE(${timestampColumn}, $4)`
        : "";
      const result = await client.query(
        `UPDATE mensagens
            SET status = $3, provider_timestamp = $4,
                error_code = $5, error_sanitized = $6, updated_at = now()
                ${timestampUpdate}
          WHERE empresa_id = $1 AND id = $2
          RETURNING *`,
        [
          input.empresaId,
          row.id,
          toDatabase(input.status),
          input.occurredAt,
          input.status === "failed" ? input.errorCode : null,
          input.status === "failed" ? input.errorSanitized : null,
        ],
      );
      return mapMessage(result.rows[0], { changed: true });
    });
  }

  async anonymizeMessagesBefore(input) {
    requireTenantId(input);
    return this.transaction(input, async ({ client }) => {
      const result = await client.query(
        `WITH candidates AS (
           SELECT id FROM mensagens
            WHERE empresa_id = $1 AND redacted_at IS NULL AND created_at < $2
            ORDER BY created_at, id
            LIMIT $3
            FOR UPDATE SKIP LOCKED
         )
         UPDATE mensagens message
            SET corpo = NULL, media_external_id = NULL, media_storage_key = NULL,
                error_code = NULL, error_sanitized = NULL,
                redacted_at = $4, updated_at = $4
           FROM candidates
          WHERE message.empresa_id = $1 AND message.id = candidates.id
         RETURNING message.id`,
        [input.empresaId, input.before, input.limit, input.redactedAt],
      );
      return { anonymized: result.rowCount, messageIds: result.rows.map(({ id }) => id) };
    });
  }
}
