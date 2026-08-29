import { randomUUID } from "node:crypto";
import { withPlatformTransaction, withTenantTransaction } from "../transaction.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function uuidOrNew(value) {
  return UUID_PATTERN.test(String(value || "")) ? value : randomUUID();
}

function messageType(type) {
  return ({ text: "texto", image: "imagem", audio: "audio", video: "video", document: "documento", interactive: "interativo", button: "interativo" })[type] || "sistema";
}

function maskedPhone(phone) {
  const value = String(phone || "");
  return value.length > 4 ? `••••${value.slice(-4)}` : "••••";
}

export class PostgresTenantResolver {
  constructor(pool) {
    this.pool = pool;
  }

  async resolveByPhoneNumberId(phoneNumberId) {
    return withPlatformTransaction(this.pool, {}, async ({ client }) => {
      const result = await client.query(
        `SELECT n.id AS numero_whatsapp_id, n.empresa_id, n.status AS numero_status,
                e.status AS empresa_status, e.versao_configuracao
           FROM numeros_whatsapp n
           JOIN empresas e ON e.id = n.empresa_id
          WHERE n.phone_number_id = $1 AND n.deleted_at IS NULL AND e.deleted_at IS NULL
          LIMIT 1`,
        [String(phoneNumberId)],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        empresaId: row.empresa_id,
        numeroWhatsappId: row.numero_whatsapp_id,
        phoneNumberId: String(phoneNumberId),
        status: row.empresa_status === "ativa" ? "active" : row.empresa_status,
        numberStatus: row.numero_status === "ativo" ? "active" : row.numero_status,
        configVersion: Number(row.versao_configuracao),
      };
    });
  }
}

export class PostgresWebhookRepository {
  constructor(pool) {
    this.pool = pool;
  }

  withTenantTransaction(context, callback) {
    return withTenantTransaction(this.pool, { empresaId: context.empresaId }, callback);
  }

  async #contact(tx, empresaId, phone, occurredAt) {
    const result = await tx.client.query(
      `INSERT INTO contatos (
         empresa_id, telefone_normalizado, telefone_mascarado,
         primeira_interacao_at, ultima_interacao_at
       ) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), COALESCE($4::timestamptz, now()))
       ON CONFLICT (empresa_id, telefone_normalizado) WHERE deleted_at IS NULL
       DO UPDATE SET ultima_interacao_at = GREATEST(
         contatos.ultima_interacao_at,
         COALESCE(EXCLUDED.ultima_interacao_at, contatos.ultima_interacao_at)
       )
       RETURNING id`,
      [empresaId, phone, maskedPhone(phone), occurredAt],
    );
    return result.rows[0].id;
  }

  async #conversation(tx, { empresaId, contatoId, numeroWhatsappId, correlationId }) {
    const existing = await tx.client.query(
      `SELECT id FROM conversas
        WHERE empresa_id = $1 AND contato_id = $2 AND numero_whatsapp_id = $3 AND status = 'aberta'
        FOR UPDATE`,
      [empresaId, contatoId, numeroWhatsappId],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const created = await tx.client.query(
      `INSERT INTO conversas (empresa_id, contato_id, numero_whatsapp_id, correlation_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (empresa_id, contato_id, numero_whatsapp_id) WHERE status = 'aberta'
       DO UPDATE SET updated_at = conversas.updated_at
       RETURNING id`,
      [empresaId, contatoId, numeroWhatsappId, uuidOrNew(correlationId)],
    );
    await tx.client.query(
      `INSERT INTO estados_conversa (empresa_id, conversa_id)
       VALUES ($1, $2)
       ON CONFLICT (empresa_id, conversa_id) DO NOTHING`,
      [empresaId, created.rows[0].id],
    );
    return created.rows[0].id;
  }

  async insertInboundMessage(tx, { empresaId, numeroWhatsappId, event, correlationId }) {
    const duplicate = await tx.client.query(
      `SELECT id, conversa_id FROM mensagens
        WHERE empresa_id = $1 AND external_message_id = $2
        LIMIT 1`,
      [empresaId, event.externalMessageId],
    );
    if (duplicate.rows[0]) {
      return { inserted: false, messageId: duplicate.rows[0].id, conversationId: duplicate.rows[0].conversa_id };
    }
    const contatoId = await this.#contact(tx, empresaId, event.senderPhone, event.occurredAt);
    const conversationId = await this.#conversation(tx, {
      empresaId,
      contatoId,
      numeroWhatsappId,
      correlationId,
    });
    const sequenceResult = await tx.client.query(
      `UPDATE conversas
          SET next_sequence = next_sequence + 1,
              ultima_mensagem_at = GREATEST(
                COALESCE(ultima_mensagem_at, COALESCE($3::timestamptz, now())),
                COALESCE($3::timestamptz, now())
              )
        WHERE empresa_id = $1 AND id = $2
        RETURNING next_sequence - 1 AS sequence`,
      [empresaId, conversationId, event.occurredAt],
    );
    const inserted = await tx.client.query(
      `INSERT INTO mensagens (
         empresa_id, conversa_id, contato_id, numero_whatsapp_id, direcao, tipo,
         corpo, media_external_id, external_message_id, status, sequence,
         provider_timestamp, correlation_id, enqueued_at
       ) VALUES ($1,$2,$3,$4,'entrada',$5,$6,$7,$8,'enfileirada',$9,$10,$11,now())
       ON CONFLICT (empresa_id, external_message_id) WHERE external_message_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        empresaId,
        conversationId,
        contatoId,
        numeroWhatsappId,
        messageType(event.messageType),
        event.text,
        event.media?.externalId || null,
        event.externalMessageId,
        sequenceResult.rows[0].sequence,
        event.occurredAt,
        uuidOrNew(correlationId),
      ],
    );
    if (!inserted.rows[0]) {
      const row = await tx.client.query(
        `SELECT id, conversa_id FROM mensagens WHERE empresa_id = $1 AND external_message_id = $2`,
        [empresaId, event.externalMessageId],
      );
      return { inserted: false, messageId: row.rows[0]?.id, conversationId: row.rows[0]?.conversa_id };
    }
    return { inserted: true, messageId: inserted.rows[0].id, conversationId };
  }

  async insertStatusEvent(tx, { empresaId, numeroWhatsappId, event, correlationId }) {
    const message = await tx.client.query(
      `SELECT id FROM mensagens
        WHERE empresa_id = $1 AND numero_whatsapp_id = $2 AND external_message_id = $3
        LIMIT 1`,
      [empresaId, numeroWhatsappId, event.externalMessageId],
    );
    const result = await tx.client.query(
      `INSERT INTO whatsapp_status_events (
         empresa_id, numero_whatsapp_id, mensagem_id, external_message_id,
         idempotency_key, status, provider_timestamp, error_code, correlation_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (empresa_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        empresaId,
        numeroWhatsappId,
        message.rows[0]?.id || null,
        event.externalMessageId,
        event.idempotencyKey,
        event.status,
        event.occurredAt,
        event.errors?.[0]?.code || null,
        uuidOrNew(correlationId),
      ],
    );
    if (!result.rows[0]) {
      const existing = await tx.client.query(
        `SELECT id, mensagem_id FROM whatsapp_status_events
          WHERE empresa_id = $1 AND idempotency_key = $2`,
        [empresaId, event.idempotencyKey],
      );
      return { inserted: false, statusEventId: existing.rows[0]?.id, messageId: existing.rows[0]?.mensagem_id };
    }
    return { inserted: true, statusEventId: result.rows[0].id, messageId: message.rows[0]?.id || null };
  }
}

export class PostgresOutboxRepository {
  async add(tx, job) {
    const dedupKey = job.statusEventId
      ? `${job.type}:${job.statusEventId}`
      : `${job.type}:${job.messageId}`;
    const result = await tx.client.query(
      `INSERT INTO outbox_jobs (
         empresa_id, conversa_id, mensagem_id, job_type, dedup_key, payload, correlation_id
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
       ON CONFLICT (empresa_id, dedup_key) DO NOTHING
       RETURNING id`,
      [
        job.empresaId,
        job.conversationId || null,
        job.messageId || null,
        job.type,
        dedupKey,
        JSON.stringify({ statusEventId: job.statusEventId || null, payloadVersion: job.payloadVersion || 1 }),
        uuidOrNew(job.correlationId),
      ],
    );
    return result.rows[0]?.id || null;
  }
}
