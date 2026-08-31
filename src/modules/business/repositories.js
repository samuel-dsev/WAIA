import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../../infra/postgres/transaction.js";

function uuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(value || ""));
}

export function createRuntimeStateRepository(conversationService) {
  return Object.freeze({
    async load({ empresaId, conversationId }) {
      const state = await conversationService.getState({ empresaId, conversationId });
      if (state.flowKey === "idle" && state.stage === "idle") return null;
      return { module: state.flowKey, step: state.stage, data: state.data || {}, version: state.version };
    },
    async save({ empresaId, conversationId }, state) {
      const current = await conversationService.getState({ empresaId, conversationId });
      const next = state || { module: "idle", step: "idle", data: {} };
      return conversationService.saveState({
        empresaId,
        conversationId,
        expectedVersion: current.version,
        flowKey: next.module || "idle",
        stage: next.step || "idle",
        data: next.data || {},
      });
    },
  });
}

export class PostgresOrderRepository {
  constructor(pool) { this.pool = pool; }

  createPending(input) {
    return withTenantTransaction(this.pool, { empresaId: input.empresaId }, async ({ client }) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${input.empresaId}:${input.idempotencyKey}`,
      ]);
      const existing = await client.query(
        `SELECT id FROM pedidos
          WHERE empresa_id = $1 AND idempotency_key = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [input.empresaId, input.idempotencyKey],
      );
      if (existing.rows[0]) return { id: existing.rows[0].id, status: "Aguardando conferência" };
      const conversation = await client.query(
        `SELECT contato_id, numero_whatsapp_id, correlation_id FROM conversas
          WHERE empresa_id = $1 AND id = $2`,
        [input.empresaId, input.conversationId],
      );
      if (!conversation.rows[0]) throw Object.assign(new Error("Conversa não encontrada."), { code: "CONVERSATION_NOT_FOUND" });
      const receipt = await client.query(
        `SELECT id FROM mensagens
          WHERE empresa_id = $1 AND conversa_id = $2 AND media_external_id = $3
            AND direcao = 'entrada' AND tipo IN ('imagem', 'documento')
            AND media_storage_key IS NOT NULL AND media_sha256 IS NOT NULL
          ORDER BY sequence DESC LIMIT 1`,
        [input.empresaId, input.conversationId, input.receiptId],
      );
      if (!receipt.rows[0]) throw Object.assign(new Error("Comprovante não encontrado."), { code: "RECEIPT_NOT_FOUND" });
      const event = await client.query(
        `SELECT e.id, e.nome, COALESCE(price.preco, 0) AS preco
           FROM eventos e
           LEFT JOIN LATERAL (
             SELECT p.preco
               FROM eventos_produtos ep
               JOIN produtos_servicos p
                 ON p.empresa_id = ep.empresa_id AND p.id = ep.produto_servico_id
              WHERE ep.empresa_id = e.empresa_id AND ep.evento_id = e.id
                AND p.ativo AND p.deleted_at IS NULL
              ORDER BY p.created_at, p.id
              LIMIT 1
           ) price ON true
          WHERE e.empresa_id = $1
            AND (e.external_id = $2 OR e.id = $3::uuid)
            AND e.status = 'publicado' AND e.deleted_at IS NULL
          LIMIT 1`,
        [input.empresaId, input.eventId, uuid(input.eventId) ? input.eventId : null],
      );
      if (!event.rows[0]) throw Object.assign(new Error("Evento indisponível."), { code: "EVENT_NOT_AVAILABLE" });
      const amount = Number(event.rows[0].preco || 0);
      const order = await client.query(
        `INSERT INTO pedidos (
           empresa_id, contato_id, conversa_id, numero_whatsapp_id, nome_comprador,
           status, pagamento_status, total, comprovante_mensagem_id, idempotency_key, correlation_id
         ) VALUES ($1,$2,$3,$4,$5,'aguardando_conferencia','em_conferencia',$6,$7,$8,$9)
         RETURNING id`,
        [
          input.empresaId,
          conversation.rows[0].contato_id,
          input.conversationId,
          conversation.rows[0].numero_whatsapp_id,
          input.customerName,
          amount,
          receipt.rows[0].id,
          input.idempotencyKey,
          conversation.rows[0].correlation_id || randomUUID(),
        ],
      );
      const googleSheets = (await client.query(
        `SELECT id FROM integracoes
          WHERE empresa_id = $1 AND tipo = 'google_sheets' AND habilitada
            AND deleted_at IS NULL AND NULLIF(configuracao #>> '{exports,orders}', '') IS NOT NULL
          ORDER BY created_at, id LIMIT 1`,
        [input.empresaId],
      )).rows[0];
      if (googleSheets) {
        await client.query("UPDATE pedidos SET integracao_status = 'pendente' WHERE empresa_id = $1 AND id = $2", [input.empresaId, order.rows[0].id]);
        await client.query(
          `INSERT INTO outbox_jobs (empresa_id, conversa_id, job_type, dedup_key, payload, correlation_id)
           VALUES ($1,$2,'export_google_sheets_order',$3,$4::jsonb,$5)
           ON CONFLICT (empresa_id, dedup_key) DO NOTHING`,
          [input.empresaId, input.conversationId, `export_google_sheets_order:${order.rows[0].id}`,
            JSON.stringify({ orderId: order.rows[0].id, payloadVersion: 1 }), conversation.rows[0].correlation_id || randomUUID()],
        );
      }
      await client.query(
        `INSERT INTO itens_pedido (
           empresa_id, pedido_id, evento_id, descricao_snapshot, quantidade, preco_unitario, total
         )
         SELECT $1,$2,$3,$4,1,$5,$5
          WHERE NOT EXISTS (
            SELECT 1 FROM itens_pedido WHERE empresa_id = $1 AND pedido_id = $2
          )`,
        [
          input.empresaId,
          order.rows[0].id,
          event.rows[0].id,
          event.rows[0].nome,
          amount,
        ],
      );
      return { id: order.rows[0].id, status: "Aguardando conferência" };
    });
  }
}

export class PostgresAppointmentRepository {
  constructor(pool) { this.pool = pool; }

  createPending(input) {
    return withTenantTransaction(this.pool, { empresaId: input.empresaId }, async ({ client }) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${input.empresaId}:${input.idempotencyKey}`,
      ]);
      const existing = await client.query(
        `SELECT id FROM agendamentos
          WHERE empresa_id = $1 AND idempotency_key = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [input.empresaId, input.idempotencyKey],
      );
      if (existing.rows[0]) return { id: existing.rows[0].id, status: "Pendente" };
      const conversation = await client.query(
        `SELECT contato_id, correlation_id FROM conversas WHERE empresa_id = $1 AND id = $2`,
        [input.empresaId, input.conversationId],
      );
      if (!conversation.rows[0]) throw Object.assign(new Error("Conversa não encontrada."), { code: "CONVERSATION_NOT_FOUND" });
      const service = await client.query(
        `SELECT id FROM produtos_servicos
          WHERE empresa_id = $1 AND tipo = 'servico' AND (sku = $2 OR id = $3::uuid)
            AND ativo AND deleted_at IS NULL
          LIMIT 1`,
        [input.empresaId, input.serviceId, uuid(input.serviceId) ? input.serviceId : null],
      );
      if (!service.rows[0]) throw Object.assign(new Error("Serviço indisponível."), { code: "SERVICE_NOT_AVAILABLE" });
      if (!uuid(input.slotId)) throw Object.assign(new Error("Horário inválido."), { code: "INVALID_APPOINTMENT_SLOT" });
      const slot = await client.query(
        `SELECT id, inicio_at, fim_at
           FROM disponibilidades_servico
          WHERE empresa_id = $1 AND id = $2 AND produto_servico_id = $3
            AND status = 'disponivel' AND reservados < capacidade
            AND deleted_at IS NULL AND inicio_at >= now()
          LIMIT 1`,
        [input.empresaId, input.slotId, service.rows[0].id],
      );
      if (!slot.rows[0]) throw Object.assign(new Error("Horário indisponível."), { code: "APPOINTMENT_SLOT_UNAVAILABLE" });
      const result = await client.query(
        `INSERT INTO agendamentos (
           empresa_id, contato_id, conversa_id, produto_servico_id, disponibilidade_id, inicio_at, fim_at,
           status, observacoes, idempotency_key, correlation_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'solicitado',$8,$9,$10)
         RETURNING id`,
        [
          input.empresaId,
          conversation.rows[0].contato_id,
          input.conversationId,
          service.rows[0].id,
          slot.rows[0].id,
          slot.rows[0].inicio_at,
          slot.rows[0].fim_at,
          `Solicitado por ${input.customerName}; slot ${input.slotId}`,
          input.idempotencyKey,
          conversation.rows[0].correlation_id || randomUUID(),
        ],
      );
      return { id: result.rows[0].id, status: "Pendente" };
    });
  }
}

export class ConversationHandoffRepository {
  constructor(conversationService) { this.conversationService = conversationService; }
  request({ empresaId, conversationId }) {
    return this.conversationService.pauseBot({ empresaId, conversationId });
  }
}

export class MemoryBusinessRepository {
  constructor() {
    this.orders = new Map();
    this.appointments = new Map();
    this.handoffs = new Map();
  }
  async createPending(input) {
    const target = input.eventId ? this.orders : this.appointments;
    if (!target.has(`${input.empresaId}:${input.idempotencyKey}`)) {
      target.set(`${input.empresaId}:${input.idempotencyKey}`, structuredClone(input));
    }
    return structuredClone(target.get(`${input.empresaId}:${input.idempotencyKey}`));
  }
  async request(input) {
    this.handoffs.set(`${input.empresaId}:${input.idempotencyKey}`, structuredClone(input));
    return structuredClone(input);
  }
}
