import { withTenantTransaction } from "../infra/postgres/transaction.js";

const actionModule = (action) => String(action || "").split(".")[0];

export class PostgresTenantDefinitionRepository {
  constructor(pool, { paymentResolver } = {}) {
    this.pool = pool;
    this.paymentResolver = paymentResolver;
  }

  load(empresaId) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const [companyResult, settingsResult, modulesResult, menuResult, productsResult, eventsResult, servicesResult] = await Promise.all([
        client.query("SELECT * FROM empresas WHERE id = $1 AND deleted_at IS NULL", [empresaId]),
        client.query("SELECT * FROM configuracoes_empresa WHERE empresa_id = $1", [empresaId]),
        client.query("SELECT module_key FROM modulos_empresa WHERE empresa_id = $1 AND habilitado", [empresaId]),
        client.query(
          `SELECT m.mensagem, i.action_key, i.titulo, i.posicao
             FROM menus m JOIN menu_itens i ON i.empresa_id = m.empresa_id AND i.menu_id = m.id
            WHERE m.empresa_id = $1 AND m.ativo AND i.ativo
            ORDER BY m.version DESC, i.posicao ASC`,
          [empresaId],
        ),
        client.query(
          `SELECT id, sku, nome, descricao, preco, ativo FROM produtos_servicos
            WHERE empresa_id = $1 AND tipo IN ('produto','convite') AND deleted_at IS NULL ORDER BY nome, id`,
          [empresaId],
        ),
        client.query(
          `SELECT e.id, e.external_id, e.nome, e.atracoes, e.inicio_at, e.observacoes, price.preco
             FROM eventos e LEFT JOIN LATERAL (
               SELECT p.preco FROM eventos_produtos ep JOIN produtos_servicos p
                 ON p.empresa_id = ep.empresa_id AND p.id = ep.produto_servico_id
                WHERE ep.empresa_id = e.empresa_id AND ep.evento_id = e.id LIMIT 1
             ) price ON true
            WHERE e.empresa_id = $1 AND e.status = 'publicado' AND e.deleted_at IS NULL
            ORDER BY e.inicio_at, e.id`,
          [empresaId],
        ),
        client.query(
          `SELECT p.id, p.sku, p.nome, p.descricao, p.ativo,
                  COALESCE(jsonb_agg(jsonb_build_object(
                    'id', d.id, 'label', to_char(d.inicio_at AT TIME ZONE e.timezone, 'DD/MM/YYYY HH24:MI'),
                    'startsAt', d.inicio_at, 'available', d.status = 'disponivel' AND d.reservados < d.capacidade
                  ) ORDER BY d.inicio_at) FILTER (WHERE d.id IS NOT NULL), '[]'::jsonb) slots
             FROM produtos_servicos p JOIN empresas e ON e.id = p.empresa_id
             LEFT JOIN disponibilidades_servico d ON d.empresa_id = p.empresa_id
               AND d.produto_servico_id = p.id AND d.deleted_at IS NULL AND d.inicio_at >= now()
            WHERE p.empresa_id = $1 AND p.tipo = 'servico' AND p.deleted_at IS NULL
            GROUP BY p.id, p.sku, p.nome, p.descricao, p.ativo ORDER BY p.nome, p.id`,
          [empresaId],
        ),
      ]);
      const company = companyResult.rows[0];
      if (!company) return null;
      const settings = settingsResult.rows[0] || {};
      const enabledModules = modulesResult.rows.map((row) => row.module_key);
      const payment = enabledModules.includes("payments") && this.paymentResolver
        ? await this.paymentResolver.resolve({ empresaId, type: "pix" })
        : null;
      const menuRows = menuResult.rows;
      return {
        runtime: {
          empresaId,
          version: Number(company.versao_configuracao),
          identity: { name: company.nome_exibicao, welcomeMessage: settings.saudacao, fallbackMessage: settings.mensagem_fallback },
          enabledModules,
          menu: {
            text: menuRows[0]?.mensagem || settings.saudacao,
            options: menuRows.map((row) => ({ id: row.action_key, label: row.titulo, module: actionModule(row.action_key), action: row.action_key })),
          },
          catalog: { items: productsResult.rows.map((row) => ({ id: row.sku || row.id, name: row.nome, description: row.descricao, price: Number(row.preco), active: row.ativo })) },
          events: { items: eventsResult.rows.map((row) => ({ id: row.external_id || row.id, name: row.nome, description: [row.atracoes, row.observacoes].filter(Boolean).join(" — "), startsAt: row.inicio_at.toISOString(), price: Number(row.preco || 0), active: true })) },
          payments: { pix: payment ? { key: payment.value, recipient: payment.recipient, instructions: payment.instructions } : undefined },
          orders: { pendingStatus: "Aguardando conferência" },
          appointments: { services: servicesResult.rows.map((row) => ({ id: row.sku || row.id, name: row.nome, description: row.descricao, active: row.ativo, slots: row.slots })) },
          humanHandoff: { message: "A automação foi pausada. A equipe continuará o atendimento por esta conversa." },
        },
        publicReplies: settings.respostas_publicas || [],
        routing: settings.roteamento || {},
        ai: { fallbackMessage: settings.mensagem_fallback },
      };
    });
  }
}
