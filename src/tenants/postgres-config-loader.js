import { withTenantTransaction } from "../infra/postgres/transaction.js";
import { catalogFromProductsCache } from "../integrations/google-sheets/products-snapshot.js";
import {
  materializeLegacyTenantDefinition,
  verifyCompiledTenantRuntimeConfigV2,
} from "../modules/configuration/index.js";

const actionModule = (action) => String(action || "").split(".")[0];

export class TenantRuntimeConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TenantRuntimeConfigurationError";
    this.code = code;
  }
}

function runtimeConfigurationError(code, message) {
  return new TenantRuntimeConfigurationError(code, message);
}

function usesGoogleSheetsAgenda(compiled) {
  return compiled.configuration.modules.includes("events")
    && compiled.configuration.integrations.some((integration) => (
      integration.enabled === true && integration.type === "google_sheets"
    ));
}

async function loadGoogleSheetsEvents(client, company, empresaId) {
  const timezone = company.timezone || "America/Sao_Paulo";
  const result = await client.query(
    `SELECT e.id, e.external_id, e.nome, e.atracoes, e.inicio_at, e.timezone,
            e.local, e.regra_vip, e.observacoes, price.preco
       FROM eventos e JOIN LATERAL (
         SELECT p.preco FROM eventos_produtos ep JOIN produtos_servicos p
           ON p.empresa_id = ep.empresa_id AND p.id = ep.produto_servico_id
          WHERE ep.empresa_id = e.empresa_id AND ep.evento_id = e.id
            AND p.ativo AND p.deleted_at IS NULL
          ORDER BY p.id LIMIT 1
       ) price ON true
      WHERE e.empresa_id = $1 AND e.origem_externa = 'google_sheets'
        AND e.status = 'publicado' AND e.deleted_at IS NULL
        AND e.inicio_at >= date_trunc('day', now() AT TIME ZONE $2::text) AT TIME ZONE $2::text
      ORDER BY e.inicio_at, e.id`,
    [empresaId, timezone],
  );
  return result.rows.map((row) => ({
    id: row.external_id || row.id,
    name: row.nome,
    attractions: row.atracoes,
    description: row.observacoes || undefined,
    startsAt: row.inicio_at.toISOString(),
    timezone: row.timezone || timezone,
    vipRule: row.regra_vip || undefined,
    location: row.local || undefined,
    price: Number(row.preco),
    active: true,
  }));
}

async function loadGoogleSheetsProducts(client, empresaId, publishedIntegrations) {
  const googleIntegrations = publishedIntegrations?.filter((item) => item.enabled && item.type === "google_sheets");
  if (googleIntegrations && !googleIntegrations.length) return null;
  const references = googleIntegrations
    ?.map((item) => item.id.startsWith("integration:") ? item.id.slice("integration:".length) : item.id)
    .filter((id) => /^[0-9a-f-]{36}$/iu.test(id));
  // The onboarding editor generates logical IDs from names. As in readiness,
  // resolve a logical reference by type only when the tenant has one connection.
  // A concrete UUID remains strict: it cannot fall back to another connection.
  if (googleIntegrations && !references.length && googleIntegrations.length !== 1) return null;
  const row = (await client.query(
    `SELECT configuracao, cache_snapshot, cache_version, status, last_success_at
       FROM integracoes i WHERE i.empresa_id = $1 AND i.tipo = 'google_sheets'
        AND i.habilitada AND i.deleted_at IS NULL AND i.configuracao->>'profile' = 'products'
        AND ($2::text[] IS NULL OR i.id::text = ANY($2::text[]))
        AND ($2::text[] IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM integracoes other WHERE other.empresa_id = $1
            AND other.tipo = 'google_sheets' AND other.habilitada AND other.deleted_at IS NULL
            AND other.id <> i.id
        ))
       ORDER BY i.created_at, i.id LIMIT 1`,
    [empresaId, references?.length ? references : null],
  )).rows[0];
  return row ? catalogFromProductsCache(row) : null;
}

async function loadVersionedDefinition(client, company, empresaId, paymentResolver) {
  if (!company.configuracao_ativa_versao) {
    throw runtimeConfigurationError(
      "ACTIVE_CONFIGURATION_REQUIRED",
      "A empresa versionada não possui uma revisão ativa.",
    );
  }
  if (Number(company.versao_configuracao) !== Number(company.configuracao_ativa_versao)) {
    throw runtimeConfigurationError(
      "ACTIVE_CONFIGURATION_POINTER_INVALID",
      "A versão ativa da empresa está inconsistente.",
    );
  }
  const revision = (await client.query(
    `SELECT config_version, checksum, configuracao_compilada
       FROM configuracoes_revisoes
      WHERE empresa_id = $1 AND config_version = $2`,
    [empresaId, company.configuracao_ativa_versao],
  )).rows[0];
  if (!revision) {
    throw runtimeConfigurationError(
      "ACTIVE_CONFIGURATION_NOT_FOUND",
      "A revisão ativa da empresa não foi encontrada.",
    );
  }
  const compiled = revision.configuracao_compilada;
  const revisionMatchesEnvelope = compiled?.empresaId === empresaId
    && compiled?.configVersion === Number(revision.config_version)
    && compiled?.checksum === revision.checksum;
  if (!revisionMatchesEnvelope || !verifyCompiledTenantRuntimeConfigV2(compiled)) {
    throw runtimeConfigurationError(
      "ACTIVE_CONFIGURATION_CORRUPTED",
      "A revisão ativa da empresa falhou na verificação de integridade.",
    );
  }
  const paymentsEnabled = compiled.configuration.modules.includes("payments");
  if (paymentsEnabled && !paymentResolver) {
    throw runtimeConfigurationError("PAYMENT_RESOLVER_UNAVAILABLE", "O resolvedor de pagamento não está disponível.");
  }
  const payment = paymentsEnabled
    ? await paymentResolver.resolve({
      empresaId,
      type: "pix",
      credentialRef: compiled.configuration.payments.credentialRef,
      recipient: compiled.configuration.identity.displayName || compiled.configuration.identity.name,
    })
    : null;
  if (paymentsEnabled && !payment) {
    throw runtimeConfigurationError("PAYMENT_CREDENTIAL_UNAVAILABLE", "A credencial de pagamento da revisão ativa não está disponível.");
  }
  const definition = materializeLegacyTenantDefinition(compiled, {
    ...(paymentsEnabled ? { payment: {
      key: payment.value,
      recipient: payment.recipient,
      instructions: payment.instructions,
    } } : {}),
  });
  const sheetProducts = compiled.configuration.modules.includes("catalog") || usesGoogleSheetsAgenda(compiled)
    ? await loadGoogleSheetsProducts(client, empresaId, compiled.configuration.integrations) : null;
  const catalog = compiled.configuration.modules.includes("catalog") ? sheetProducts : null;
  const usesAgenda = !sheetProducts && usesGoogleSheetsAgenda(compiled);
  if (!usesAgenda && !catalog) return definition;
  const events = usesAgenda ? await loadGoogleSheetsEvents(client, company, empresaId) : null;
  return {
    ...definition,
    runtime: {
      ...definition.runtime,
      ...(events ? { events: { items: events } } : {}),
      ...(catalog ? { catalog } : {}),
    },
  };
}

export class PostgresTenantDefinitionRepository {
  constructor(pool, { paymentResolver } = {}) {
    this.pool = pool;
    this.paymentResolver = paymentResolver;
  }

  load(empresaId) {
    return withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      // Uma transação usa um único client do pg. As consultas precisam ser
      // sequenciais; executar Promise.all no mesmo client causa concorrência
      // não suportada e pode trocar resultados entre etapas no pg >= 9.
      const companyResult = await client.query("SELECT * FROM empresas WHERE id = $1 AND deleted_at IS NULL", [empresaId]);
      const company = companyResult.rows[0];
      if (!company) return null;
      const configurationMode = company.configuracao_runtime_modo;
      if (configurationMode === "versionado") {
        return loadVersionedDefinition(client, company, empresaId, this.paymentResolver);
      }
      if (configurationMode !== "legado") {
        throw runtimeConfigurationError(
          "CONFIGURATION_MODE_UNSUPPORTED",
          "O modo de configuração da empresa não é suportado.",
        );
      }
      const settingsResult = await client.query("SELECT * FROM configuracoes_empresa WHERE empresa_id = $1", [empresaId]);
      const aiResult = await client.query("SELECT habilitada, prompt FROM configuracoes_ia WHERE empresa_id = $1", [empresaId]);
      const modulesResult = await client.query("SELECT module_key, configuracao FROM modulos_empresa WHERE empresa_id = $1 AND habilitado", [empresaId]);
      const menuResult = await client.query(
          `SELECT m.mensagem, i.action_key, i.titulo, i.posicao
             FROM menus m JOIN menu_itens i ON i.empresa_id = m.empresa_id AND i.menu_id = m.id
            WHERE m.empresa_id = $1 AND m.ativo AND i.ativo
            ORDER BY m.version DESC, i.posicao ASC`,
          [empresaId],
        );
      const productsResult = await client.query(
          `SELECT id, sku, nome, descricao, preco, ativo FROM produtos_servicos
            WHERE empresa_id = $1 AND tipo IN ('produto','convite') AND deleted_at IS NULL ORDER BY nome, id`,
          [empresaId],
        );
      const eventsResult = await client.query(
          `SELECT e.id, e.external_id, e.nome, e.atracoes, e.inicio_at, e.timezone,
                  e.local, e.regra_vip, e.observacoes, price.preco
             FROM eventos e LEFT JOIN LATERAL (
               SELECT p.preco FROM eventos_produtos ep JOIN produtos_servicos p
                 ON p.empresa_id = ep.empresa_id AND p.id = ep.produto_servico_id
                WHERE ep.empresa_id = e.empresa_id AND ep.evento_id = e.id LIMIT 1
             ) price ON true
            WHERE e.empresa_id = $1 AND e.status = 'publicado' AND e.deleted_at IS NULL
            ORDER BY e.inicio_at, e.id`,
          [empresaId],
        );
      const servicesResult = await client.query(
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
        );
      const settings = settingsResult.rows[0] || {};
      const enabledModules = modulesResult.rows.map((row) => row.module_key);
      const sheetsCatalog = enabledModules.includes("catalog") ? await loadGoogleSheetsProducts(client, empresaId) : null;
      const moduleConfigurations = new Map(modulesResult.rows.map((row) => [row.module_key, row.configuracao || {}]));
      const orderConfig = moduleConfigurations.get("orders") || {};
      const payment = enabledModules.includes("payments") && this.paymentResolver
        ? await this.paymentResolver.resolve({ empresaId, type: "pix" })
        : null;
      const menuRows = menuResult.rows;
      const configuredReplies = Array.isArray(settings.respostas_publicas) ? settings.respostas_publicas : [];
      const dynamicReplies = [
        settings.endereco && { module: "catalog", action: "catalog.address", text: `📍 ${settings.endereco}` },
        settings.link_cardapio && {
          module: "catalog",
          action: "catalog.menu",
          text: `Veja o cardápio do ${company.nome_exibicao} aqui:\n${settings.link_cardapio}\nOs itens e a disponibilidade podem mudar sem aviso.`,
        },
        settings.regra_aniversariante && { module: "events", action: "events.birthday_rule", text: settings.regra_aniversariante },
      ].filter(Boolean);
      const dynamicActions = new Set(dynamicReplies.map((reply) => reply.action));
      return {
        runtime: {
          empresaId,
          version: Number(company.versao_configuracao),
          identity: {
            name: company.nome_exibicao,
            welcomeMessage: settings.saudacao,
            fallbackMessage: settings.mensagem_fallback,
            establishmentRules: settings.regras_estabelecimento,
          },
          enabledModules,
          menu: {
            text: menuRows[0]?.mensagem || settings.saudacao,
            options: menuRows.map((row) => ({ id: row.action_key, label: row.titulo, module: actionModule(row.action_key), action: row.action_key })),
          },
          catalog: sheetsCatalog || { items: productsResult.rows.map((row) => ({ id: row.sku || row.id, name: row.nome, description: row.descricao, price: Number(row.preco), active: row.ativo })) },
          events: { items: eventsResult.rows.map((row) => ({
            id: row.external_id || row.id,
            name: row.nome,
            attractions: row.atracoes,
            description: row.observacoes || undefined,
            startsAt: row.inicio_at.toISOString(),
            timezone: row.timezone || company.timezone || "America/Sao_Paulo",
            vipRule: row.regra_vip || undefined,
            birthdayRule: settings.regra_aniversariante || undefined,
            location: row.local || settings.endereco || undefined,
            price: Number(row.preco || 0),
            active: true,
          })) },
          payments: { pix: payment ? { key: payment.value, recipient: payment.recipient, instructions: payment.instructions } : undefined },
          orders: {
            pendingStatus: orderConfig.pendingStatus || "Aguardando conferência",
            selectionPrompt: orderConfig.selectionPrompt,
            paymentPrompt: orderConfig.paymentPrompt,
            receiptPrompt: orderConfig.receiptPrompt,
            namePrompt: orderConfig.namePrompt,
            successMessage: orderConfig.successMessage,
          },
          appointments: { services: servicesResult.rows.map((row) => ({ id: row.sku || row.id, name: row.nome, description: row.descricao, active: row.ativo, slots: row.slots })) },
          humanHandoff: { message: "A automação foi pausada. A equipe continuará o atendimento por esta conversa." },
        },
        publicReplies: [...configuredReplies.filter((reply) => !dynamicActions.has(reply?.action)), ...dynamicReplies],
        routing: settings.roteamento || {},
        ai: {
          enabled: aiResult.rows[0]?.habilitada === true,
          prompt: aiResult.rows[0]?.prompt || "",
          fallbackMessage: settings.mensagem_fallback,
          followUpQuestion: settings.roteamento?.aiFollowUpQuestion || null,
        },
      };
    });
  }
}
