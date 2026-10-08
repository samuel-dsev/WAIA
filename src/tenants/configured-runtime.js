import {
  createCanonicalModuleDefinitions,
  createModuleRegistry,
  createTenantRuntimeRouter,
  parseTenantRuntimeConfig,
} from "../modules/runtime/index.js";
import { paginateInteractiveOptions, withPageIndicator } from "../modules/runtime/interactive-pagination.js";

const ACTION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

function normalized(value) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR");
}

function normalizedWords(value) {
  return ` ${normalized(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

function matchesAlias(text, terms) {
  const words = normalizedWords(text);
  return terms.some((term) => {
    const normalizedTerm = normalized(term);
    return normalizedTerm === text || words.includes(normalizedWords(normalizedTerm));
  });
}

const WEEKDAY_TERMS = Object.freeze([
  ["domingo"],
  ["segunda", "segunda feira"],
  ["terca", "terca feira"],
  ["quarta", "quarta feira"],
  ["quinta", "quinta feira"],
  ["sexta", "sexta feira"],
  ["sabado"],
]);

function eventLocalParts(event) {
  const date = new Date(event.startsAt);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("pt-BR", {
    timeZone: event.timezone || "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    weekday: normalized(parts.weekday).replace(/-feira$/u, "").trim(),
    date: `${parts.day}/${parts.month}`,
  };
}

function eventIntent(text, config) {
  if (!config.enabledModules.includes("orders")) return null;
  const words = normalizedWords(text);
  const hasEventLanguage = /\b(?:agenda|programacao|evento|show|atracao|atracoes|noite|convite|sexta|sabado|domingo|segunda|terca|quarta|quinta)\b/u.test(words);
  if (!hasEventLanguage) return null;
  const matching = config.events.items.filter((event) => {
    if (event.active === false) return false;
    const local = eventLocalParts(event);
    const searchable = normalizedWords(`${event.name} ${event.attractions || ""} ${event.startsAt || ""}`);
    if (local && (words.includes(` ${local.weekday} `) || words.includes(normalizedWords(local.date)))) return true;
    const weekday = WEEKDAY_TERMS.flat().find((term) => searchable.includes(` ${term} `));
    if (weekday && words.includes(` ${weekday} `)) return true;
    const normalizedName = normalizedWords(event.name).trim();
    return normalizedName.length > 3 && words.includes(` ${normalizedName} `);
  });
  return matching.length === 1 ? matching[0] : null;
}

function paymentCompletionIntent(text) {
  return /^(?:paguei|pago|ja\s+(?:fiz|paguei)|(?:fiz|paguei).{0,24}(?:pix|pagamento))\b/u.test(normalized(text));
}

function withFollowUpQuestion(outcome, question) {
  if (!question || !outcome?.reply?.text || /\?\s*$/u.test(outcome.reply.text)) return outcome;
  return {
    ...outcome,
    reply: { ...outcome.reply, text: `${outcome.reply.text.trim()}\n\n${question}` },
  };
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
    const payload = entry.payload == null ? {} : entry.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TypeError(`${path}.payload deve ser um objeto.`);
    }
    return Object.freeze({ action, terms: Object.freeze(terms), payload: Object.freeze(structuredClone(payload)) });
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
    const actions = [...new Set([...definition.actions, ...replies.keys()])];
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
          const pagination = paginateInteractiveOptions(events, {
            page: context.payload?.page,
            scope: "events",
            toButton: (event) => ({
              id: `event:${event.id}`,
              label: `Comprar: ${event.name}`,
              description: `${event.startsAt} — ${new Intl.NumberFormat("pt-BR", {
                style: "currency",
                currency: "BRL",
              }).format(event.price)}`,
            }),
          });
          const lines = pagination.items.map((event) => {
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
              text: withPageIndicator([eventPresentation.intro, ...lines].filter(Boolean).join("\n"), pagination),
              buttons: pagination.buttons,
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
  const hasScript = definition.ai?.enabled === true && Boolean(String(definition.ai?.prompt || "").trim())
    && config.enabledModules.includes("ai_freeform");
  const followUpQuestion = hasScript || definition.ai?.followUpQuestion == null
    ? null
    : requiredText(definition.ai.followUpQuestion, "ai.followUpQuestion", 300);
  const defaultAiHandler = async () => ({
    reply: {
      text: requiredText(
        definition.ai?.fallbackMessage || config.identity.fallbackMessage || "Não consegui responder agora. Escolha uma opção do menu.",
        "ai.fallbackMessage",
      ),
      buttons: [],
    },
  });
  const selectedAiHandler = dependencies.aiHandler || defaultAiHandler;
  const contextualAiHandler = async (context) => withFollowUpQuestion(
    await selectedAiHandler(context),
    followUpQuestion,
  );
  const baseDefinitions = createCanonicalModuleDefinitions({
    ...dependencies,
    aiHandler: contextualAiHandler,
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
    if (!text) return router.handle(input);
    if (extensions.greetings.has(text)) return router.handle({ ...input, resetToMenu: true });
    if (config.menu.options.some((option) => normalized(option.id) === text || normalized(option.label) === text)) {
      return router.handle(input);
    }
    if (paymentCompletionIntent(text)) return router.handle({ ...input, preferContinuation: true });
    const selectedEvent = eventIntent(text, config);
    if (selectedEvent) {
      return router.handle({
        ...input,
        action: "orders.select_event",
        payload: { eventId: selectedEvent.id },
      });
    }
    const alias = extensions.aliases.find((candidate) => matchesAlias(text, candidate.terms));
    if (alias) return router.handle({ ...input, action: alias.action, payload: alias.payload });
    const fallbackAction = hasScript ? "ai_freeform.reply" : extensions.fallbackAction;
    if (fallbackAction) {
      return router.handle({ ...input, action: fallbackAction, actionSource: "fallback" });
    }
    return router.handle(input);
  }

  return Object.freeze({ config, registry, handle });
}
