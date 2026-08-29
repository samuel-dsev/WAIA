import {
  createCanonicalModuleDefinitions,
  createModuleRegistry,
  createTenantRuntimeRouter,
  parseTenantRuntimeConfig,
} from "../modules/runtime/index.js";

const ACTION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

function normalized(value) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR");
}

function requiredText(value, path, max = 1_000) {
  const text = String(value || "").trim();
  if (!text || text.length > max) throw new TypeError(`${path} deve ter entre 1 e ${max} caracteres.`);
  return text;
}

function list(value, path) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${path} deve ser um array.`);
  return value;
}

function parseExtensions(definition, config, moduleDefinitions) {
  const knownModules = new Set(config.enabledModules);
  const knownActions = new Map();
  for (const moduleDefinition of moduleDefinitions) {
    for (const action of moduleDefinition.actions) knownActions.set(action, moduleDefinition.key);
  }

  const publicReplies = list(definition.publicReplies, "publicReplies").map((entry, index) => {
    const path = `publicReplies[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError(`${path} deve ser um objeto.`);
    const module = requiredText(entry.module, `${path}.module`, 50);
    const action = requiredText(entry.action, `${path}.action`, 100);
    if (!knownModules.has(module)) throw new TypeError(`${path}.module precisa estar habilitado.`);
    if (!ACTION_PATTERN.test(action)) throw new TypeError(`${path}.action possui formato inválido.`);
    const owner = knownActions.get(action);
    if (owner && owner !== module) throw new TypeError(`${path}.action já pertence ao módulo ${owner}.`);
    knownActions.set(action, module);
    return Object.freeze({ module, action, text: requiredText(entry.text, `${path}.text`, 2_000) });
  });

  const aliases = list(definition.routing?.aliases, "routing.aliases").map((entry, index) => {
    const path = `routing.aliases[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError(`${path} deve ser um objeto.`);
    const action = requiredText(entry.action, `${path}.action`, 100);
    if (!knownActions.has(action)) throw new TypeError(`${path}.action não existe no registro de módulos.`);
    const terms = list(entry.terms, `${path}.terms`).map((term, termIndex) => (
      normalized(requiredText(term, `${path}.terms[${termIndex}]`, 160))
    ));
    if (terms.length === 0) throw new TypeError(`${path}.terms deve conter ao menos um termo.`);
    return Object.freeze({ action, terms: Object.freeze(terms) });
  });

  const greetings = new Set(list(definition.routing?.greetings, "routing.greetings").map(normalized));
  const fallbackAction = definition.routing?.fallbackAction == null
    ? null
    : requiredText(definition.routing.fallbackAction, "routing.fallbackAction", 100);
  if (fallbackAction && !knownActions.has(fallbackAction)) {
    throw new TypeError("routing.fallbackAction não existe no registro de módulos.");
  }
  return { publicReplies, aliases, greetings, fallbackAction };
}

function withConfiguredHandlers(baseDefinitions, { publicReplies, eventPresentation }) {
  const repliesByModule = new Map();
  for (const item of publicReplies) {
    const replies = repliesByModule.get(item.module) || new Map();
    replies.set(item.action, item.text);
    repliesByModule.set(item.module, replies);
  }
  return baseDefinitions.map((definition) => {
    const replies = repliesByModule.get(definition.key) || new Map();
    const actions = [...definition.actions, ...replies.keys()];
    if (definition.key !== "events" && replies.size === 0) return definition;
    return {
      ...definition,
      actions,
      async handle(context) {
        if (replies.has(context.action)) {
          return { reply: { text: replies.get(context.action), buttons: [] } };
        }
        if (definition.key === "events" && context.action === "events.list" && eventPresentation) {
          const events = context.config.events.items.filter((event) => event.active !== false);
          if (events.length === 0) {
            return { reply: { text: eventPresentation.emptyMessage, buttons: [] } };
          }
          const lines = events.map((event) => {
            const description = eventPresentation.includeDescription && event.description
              ? `\n${event.description}`
              : "";
            return `• ${event.name} — ${event.startsAt} — ${new Intl.NumberFormat("pt-BR", {
              style: "currency",
              currency: "BRL",
            }).format(event.price)}${description}`;
          });
          return {
            reply: {
              text: [eventPresentation.intro, ...lines].filter(Boolean).join("\n"),
              buttons: events.map((event) => ({ id: `event:${event.id}`, label: `Comprar: ${event.name}` })),
            },
          };
        }
        return definition.handle(context);
      },
    };
  });
}

function parseEventPresentation(input) {
  if (!input) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new TypeError("eventPresentation deve ser um objeto.");
  return Object.freeze({
    intro: input.intro == null ? "" : requiredText(input.intro, "eventPresentation.intro"),
    emptyMessage: input.emptyMessage == null
      ? "Não há eventos disponíveis no momento."
      : requiredText(input.emptyMessage, "eventPresentation.emptyMessage"),
    includeDescription: input.includeDescription === true,
  });
}

/**
 * Carrega e valida um TenantRuntimeConfig sem depender do nome ou do tipo da
 * empresa. Extensões determinísticas também vêm da configuração.
 */
export function loadConfiguredTenant(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new TypeError("A definição configurável da empresa é obrigatória.");
  }
  return parseTenantRuntimeConfig(definition.runtime);
}

export function createConfiguredTenantRuntime({ definition, stateRepository, ...dependencies } = {}) {
  const config = loadConfiguredTenant(definition);
  const defaultAiHandler = async () => ({
    reply: {
      text: requiredText(
        definition.ai?.fallbackMessage || config.identity.fallbackMessage || "Não consegui responder agora. Escolha uma opção do menu.",
        "ai.fallbackMessage",
      ),
      buttons: [],
    },
  });
  const baseDefinitions = createCanonicalModuleDefinitions({
    ...dependencies,
    aiHandler: dependencies.aiHandler || defaultAiHandler,
  });
  const extensions = parseExtensions(definition, config, baseDefinitions);
  const registry = createModuleRegistry(withConfiguredHandlers(baseDefinitions, {
    publicReplies: extensions.publicReplies,
    eventPresentation: parseEventPresentation(definition.eventPresentation),
  }));
  const router = createTenantRuntimeRouter({
    config,
    stateRepository,
    registry,
    ...dependencies,
  });

  async function handle(input) {
    const hasExplicitCommand = Boolean(String(input?.action || input?.selectionId || "").trim());
    if (hasExplicitCommand) return router.handle(input);
    const text = normalized(input?.text);
    if (!text || extensions.greetings.has(text)) return router.handle(input);
    const alias = extensions.aliases.find((candidate) => candidate.terms.includes(text));
    if (alias) return router.handle({ ...input, action: alias.action });
    if (extensions.fallbackAction) return router.handle({ ...input, action: extensions.fallbackAction });
    return router.handle(input);
  }

  return Object.freeze({ config, registry, handle });
}

