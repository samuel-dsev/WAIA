import { actionOwnerV2 } from "./action-catalog.js";
import { verifyCompiledTenantRuntimeConfigV2 } from "./compiler.js";
import { parseTenantRuntimeConfigV2 } from "./tenant-runtime-config-v2.js";

function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} deve ser um objeto.`);
  return value;
}

function text(value, path) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${path} é obrigatório.`);
  return normalized;
}

function optionalList(value, path) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${path} deve ser um array.`);
  return value;
}

function legacyReference(kind, empresaId) {
  return `credential:legacy-${kind}-${empresaId}`;
}

/**
 * Adapta o contrato V1 já carregado para o schema público V2. Valores secretos
 * do V1 são deliberadamente descartados: somente referências opacas atravessam
 * a fronteira do draft e entram no checksum da revisão.
 */
export function adaptLegacyTenantDefinitionToV2(definition, {
  paymentCredentialRef,
  aiCredentialRef,
  aiProvider = "openai",
  aiModel = "legacy-runtime-resolved",
  aiPrompt = "Responda somente com o contexto público validado desta empresa.",
  locale = "pt-BR",
  timezone = "America/Sao_Paulo",
  messageRetentionDays = 365,
  logRetentionDays = 90,
} = {}) {
  const legacy = object(definition, "definition");
  const runtime = object(legacy.runtime, "definition.runtime");
  const empresaId = text(runtime.empresaId, "definition.runtime.empresaId");
  const modules = optionalList(runtime.enabledModules, "definition.runtime.enabledModules").filter((key) => key !== "flows");
  const enabled = new Set(modules);
  const publicReplies = optionalList(legacy.publicReplies, "definition.publicReplies").map((reply) => ({
    action: reply.action,
    text: reply.text,
  }));
  const adapted = {
    schemaVersion: 2,
    identity: {
      name: runtime.identity?.name,
      displayName: runtime.identity?.name,
      locale,
      timezone,
      welcomeMessage: runtime.identity?.welcomeMessage,
      fallbackMessage: runtime.identity?.fallbackMessage,
      establishmentRules: runtime.identity?.establishmentRules,
    },
    retention: { messagesDays: messageRetentionDays, logsDays: logRetentionDays },
    modules,
    menu: {
      text: runtime.menu?.text,
      options: optionalList(runtime.menu?.options, "definition.runtime.menu.options").map((option) => ({
        id: option.id,
        label: option.label,
        action: option.action,
        params: option.payload || {},
      })),
    },
    routing: {
      greetings: optionalList(legacy.routing?.greetings, "definition.routing.greetings"),
      aliases: optionalList(legacy.routing?.aliases, "definition.routing.aliases").map((alias) => ({
        terms: alias.terms,
        action: alias.action,
        params: alias.payload || {},
      })),
      fallbackAction: legacy.routing?.fallbackAction || null,
    },
    publicReplies,
    catalog: { items: optionalList(runtime.catalog?.items, "definition.runtime.catalog.items") },
    events: {
      items: optionalList(runtime.events?.items, "definition.runtime.events.items"),
      presentation: legacy.eventPresentation || {},
    },
    appointments: { services: optionalList(runtime.appointments?.services, "definition.runtime.appointments.services") },
    payments: enabled.has("payments") ? {
      credentialRef: paymentCredentialRef || legacyReference("payments", empresaId),
    } : {},
    orders: runtime.orders || {},
    humanHandoff: runtime.humanHandoff || {},
    ai: enabled.has("ai_freeform") ? {
      enabled: true,
      provider: aiProvider,
      model: aiModel,
      prompt: aiPrompt,
      credentialRef: aiCredentialRef || legacyReference("ai", empresaId),
      keyMode: "own",
      fallbackMessage: legacy.ai?.fallbackMessage || runtime.identity?.fallbackMessage,
      followUpQuestion: legacy.ai?.followUpQuestion,
    } : { enabled: false },
    flows: { definitions: [] },
    integrations: [],
  };
  return parseTenantRuntimeConfigV2(JSON.parse(JSON.stringify(adapted)));
}

function requiredPaymentBinding(value) {
  const binding = object(value, "bindings.payment");
  return {
    key: text(binding.key, "bindings.payment.key"),
    recipient: text(binding.recipient, "bindings.payment.recipient"),
    instructions: binding.instructions == null ? undefined : text(binding.instructions, "bindings.payment.instructions"),
  };
}

/**
 * Ponte temporária para testes de caracterização do runtime V1. O binding de
 * pagamento é efêmero e nunca integra o draft, a revisão V2 ou seu checksum.
 */
export function materializeLegacyTenantDefinition(compiled, { payment: paymentBinding } = {}) {
  if (!verifyCompiledTenantRuntimeConfigV2(compiled)) throw new TypeError("A revisão V2 compilada é inválida.");
  const config = compiled.configuration;
  const paymentsEnabled = config.modules.includes("payments");
  const payment = paymentsEnabled ? requiredPaymentBinding(paymentBinding) : undefined;
  const presentation = config.events.presentation;
  return {
    runtime: {
      empresaId: compiled.empresaId,
      version: compiled.configVersion,
      identity: {
        name: config.identity.name,
        welcomeMessage: config.identity.welcomeMessage,
        fallbackMessage: config.identity.fallbackMessage,
        establishmentRules: config.identity.establishmentRules,
      },
      enabledModules: [...config.modules],
      menu: {
        text: config.menu.text,
        options: config.menu.options.map((option) => ({
          id: option.id,
          label: option.label,
          module: actionOwnerV2(option.action),
          action: option.action,
          payload: structuredClone(option.params),
        })),
      },
      catalog: { items: structuredClone(config.catalog.items) },
      events: { items: structuredClone(config.events.items) },
      payments: { pix: payment },
      orders: structuredClone(config.orders),
      appointments: { services: structuredClone(config.appointments.services) },
      flows: { definitions: structuredClone(config.flows.definitions) },
      humanHandoff: {
        message: config.humanHandoff.message,
        channel: config.humanHandoff.channel,
      },
    },
    publicReplies: config.publicReplies.map((reply) => ({
      module: actionOwnerV2(reply.action),
      action: reply.action,
      text: reply.text,
    })),
    eventPresentation: presentation.intro || presentation.emptyMessage || presentation.includeDescription
      ? structuredClone(presentation)
      : undefined,
    routing: {
      greetings: [...config.routing.greetings],
      aliases: config.routing.aliases.map((alias) => ({
        terms: [...alias.terms],
        action: alias.action,
        payload: structuredClone(alias.params),
      })),
      fallbackAction: config.routing.fallbackAction,
    },
    ai: {
      fallbackMessage: config.ai.fallbackMessage,
      followUpQuestion: config.ai.followUpQuestion,
    },
  };
}
