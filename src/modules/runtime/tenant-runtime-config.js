import { MODULE_KEYS } from "../../core/contracts.js";

const MODULE_SET = new Set(MODULE_KEYS);
const ACTION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

function requiredText(value, path, { max = 500 } = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`${path} é obrigatório.`);
  if (normalized.length > max) throw new TypeError(`${path} excede ${max} caracteres.`);
  return normalized;
}

function optionalText(value, path, options) {
  if (value == null || value === "") return undefined;
  return requiredText(value, path, options);
}

function stringId(value, path) {
  const id = requiredText(value, path, { max: 100 });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u.test(id)) {
    throw new TypeError(`${path} possui formato inválido.`);
  }
  return id;
}

function finiteAmount(value, path) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new TypeError(`${path} deve ser um valor não negativo.`);
  return amount;
}

function list(value, path, mapper, { max = 1000 } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${path} deve ser um array.`);
  if (value.length > max) throw new TypeError(`${path} excede ${max} itens.`);
  return value.map((item, index) => mapper(item, `${path}[${index}]`));
}

function unique(items, selector, path) {
  const seen = new Set();
  for (const item of items) {
    const key = selector(item);
    if (seen.has(key)) throw new TypeError(`${path} contém valor duplicado: ${key}.`);
    seen.add(key);
  }
}

function parseMenuOption(value, path, enabledModules) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} deve ser um objeto.`);
  }
  const module = requiredText(value.module, `${path}.module`, { max: 50 });
  if (!MODULE_SET.has(module)) throw new TypeError(`${path}.module não é uma capacidade canônica.`);
  if (!enabledModules.has(module)) throw new TypeError(`${path}.module referencia um módulo desabilitado.`);
  const action = requiredText(value.action, `${path}.action`, { max: 100 });
  if (!ACTION_PATTERN.test(action)) throw new TypeError(`${path}.action possui formato inválido.`);
  return {
    id: stringId(value.id, `${path}.id`),
    label: requiredText(value.label, `${path}.label`, { max: 80 }),
    module,
    action,
    payload: value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
      ? structuredClone(value.payload)
      : {},
  };
}

function parseCatalogItem(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} deve ser um objeto.`);
  return {
    id: stringId(value.id, `${path}.id`),
    name: requiredText(value.name, `${path}.name`, { max: 160 }),
    description: optionalText(value.description, `${path}.description`, { max: 500 }),
    price: value.price == null ? undefined : finiteAmount(value.price, `${path}.price`),
    active: value.active !== false,
  };
}

function parseEvent(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} deve ser um objeto.`);
  return {
    id: stringId(value.id, `${path}.id`),
    name: requiredText(value.name, `${path}.name`, { max: 160 }),
    startsAt: requiredText(value.startsAt, `${path}.startsAt`, { max: 80 }),
    timezone: optionalText(value.timezone, `${path}.timezone`, { max: 80 }),
    attractions: optionalText(value.attractions, `${path}.attractions`, { max: 1000 }),
    description: optionalText(value.description, `${path}.description`, { max: 500 }),
    vipRule: optionalText(value.vipRule, `${path}.vipRule`, { max: 1000 }),
    birthdayRule: optionalText(value.birthdayRule, `${path}.birthdayRule`, { max: 1000 }),
    location: optionalText(value.location, `${path}.location`, { max: 500 }),
    price: finiteAmount(value.price, `${path}.price`),
    active: value.active !== false,
  };
}

function parseService(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} deve ser um objeto.`);
  const slots = list(value.slots, `${path}.slots`, (slot, slotPath) => {
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) throw new TypeError(`${slotPath} deve ser um objeto.`);
    return {
      id: stringId(slot.id, `${slotPath}.id`),
      label: requiredText(slot.label, `${slotPath}.label`, { max: 120 }),
      startsAt: optionalText(slot.startsAt, `${slotPath}.startsAt`, { max: 80 }),
      available: slot.available !== false,
    };
  });
  unique(slots, (slot) => slot.id, `${path}.slots`);
  return {
    id: stringId(value.id, `${path}.id`),
    name: requiredText(value.name, `${path}.name`, { max: 160 }),
    description: optionalText(value.description, `${path}.description`, { max: 500 }),
    slots,
    active: value.active !== false,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Validates the dynamic tenant configuration consumed by the deterministic runtime.
 * The returned object is detached and immutable so one tenant cannot mutate another
 * tenant's cached configuration.
 */
export function parseTenantRuntimeConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("TenantRuntimeConfig deve ser um objeto.");
  }

  const enabledModules = list(input.enabledModules, "enabledModules", (key, path) => {
    const module = requiredText(key, path, { max: 50 });
    if (!MODULE_SET.has(module)) throw new TypeError(`${path} não é uma capacidade canônica.`);
    return module;
  }, { max: MODULE_KEYS.length });
  unique(enabledModules, (key) => key, "enabledModules");
  const enabledSet = new Set(enabledModules);

  if (enabledSet.has("orders") && (!enabledSet.has("events") || !enabledSet.has("payments"))) {
    throw new TypeError("O fluxo inicial de orders requer os módulos events e payments habilitados.");
  }

  const options = list(input.menu?.options, "menu.options", (option, path) => parseMenuOption(option, path, enabledSet), { max: 30 });
  unique(options, (option) => option.id, "menu.options");

  const items = list(input.catalog?.items, "catalog.items", parseCatalogItem);
  const events = list(input.events?.items, "events.items", parseEvent);
  const services = list(input.appointments?.services, "appointments.services", parseService);
  unique(items, (item) => item.id, "catalog.items");
  unique(events, (event) => event.id, "events.items");
  unique(services, (service) => service.id, "appointments.services");

  const pix = input.payments?.pix;
  if (enabledSet.has("payments") && !pix) {
    throw new TypeError("payments.pix é obrigatório quando payments está habilitado.");
  }
  const parsed = {
    empresaId: requiredText(input.empresaId, "empresaId", { max: 100 }),
    version: Number.isSafeInteger(input.version) && input.version > 0 ? input.version : 1,
    identity: {
      name: requiredText(input.identity?.name, "identity.name", { max: 160 }),
      welcomeMessage: optionalText(input.identity?.welcomeMessage, "identity.welcomeMessage", { max: 1000 }),
      fallbackMessage: optionalText(input.identity?.fallbackMessage, "identity.fallbackMessage", { max: 1000 }),
      establishmentRules: optionalText(input.identity?.establishmentRules, "identity.establishmentRules", { max: 10_000 }),
    },
    enabledModules,
    menu: {
      text: optionalText(input.menu?.text, "menu.text", { max: 1000 }),
      options,
    },
    catalog: { items },
    events: { items: events },
    payments: {
      pix: pix ? {
        key: requiredText(pix.key, "payments.pix.key", { max: 200 }),
        recipient: requiredText(pix.recipient, "payments.pix.recipient", { max: 200 }),
        instructions: optionalText(pix.instructions, "payments.pix.instructions", { max: 1000 }),
      } : undefined,
    },
    orders: {
      pendingStatus: optionalText(input.orders?.pendingStatus, "orders.pendingStatus", { max: 80 }) || "Aguardando conferência",
      selectionPrompt: optionalText(input.orders?.selectionPrompt, "orders.selectionPrompt", { max: 500 }),
      paymentPrompt: optionalText(input.orders?.paymentPrompt, "orders.paymentPrompt", { max: 500 }),
      receiptPrompt: optionalText(input.orders?.receiptPrompt, "orders.receiptPrompt", { max: 500 }),
      namePrompt: optionalText(input.orders?.namePrompt, "orders.namePrompt", { max: 500 }),
      successMessage: optionalText(input.orders?.successMessage, "orders.successMessage", { max: 1000 }),
    },
    appointments: { services },
    humanHandoff: {
      message: optionalText(input.humanHandoff?.message, "humanHandoff.message", { max: 1000 }),
      channel: optionalText(input.humanHandoff?.channel, "humanHandoff.channel", { max: 300 }),
    },
  };

  return deepFreeze(parsed);
}
