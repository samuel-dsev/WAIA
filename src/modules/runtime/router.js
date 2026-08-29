import { createCanonicalModuleDefinitions } from "../business/handlers.js";
import { createModuleRegistry } from "./module-registry.js";
import { parseTenantRuntimeConfig } from "./tenant-runtime-config.js";

function requireMethod(target, method, name) {
  if (typeof target?.[method] !== "function") throw new TypeError(`${name}.${method} é obrigatório.`);
}

function normalized(value) {
  return String(value || "").trim().toLocaleLowerCase("pt-BR");
}

function menuReply(config) {
  return {
    source: "deterministic",
    module: null,
    text: config.menu.text || config.identity.welcomeMessage || `Olá! Você está falando com ${config.identity.name}. Como podemos ajudar?`,
    buttons: config.menu.options.map(({ id, label }) => ({ id, label })),
  };
}

function resolveCommand({ config, input, state, registry }) {
  if (state?.module === "orders" && ["awaiting_receipt", "awaiting_name"].includes(state.step)) {
    return { module: registry.get("orders"), action: "orders.continue", payload: {} };
  }
  if (state?.module === "appointments" && state.step === "awaiting_name") {
    return { module: registry.get("appointments"), action: "appointments.continue", payload: {} };
  }
  if (state?.module === "appointments" && state.step === "awaiting_slot") {
    const selectedRaw = String(input.selectionId || input.text || "").trim();
    const selected = normalized(selectedRaw);
    if (selected.startsWith("slot:")) {
      const service = config.appointments.services.find((item) => item.id === state.data.serviceId);
      const selectedId = selected.slice(5);
      const slotId = service?.slots.find((slot) => normalized(slot.id) === selectedId)?.id || selectedRaw.slice(5);
      return { module: registry.get("appointments"), action: "appointments.select_slot", payload: { slotId } };
    }
    return { module: registry.get("appointments"), action: "appointments.continue", payload: {} };
  }

  const action = String(input.action || "").trim();
  if (action) return { module: registry.resolveAction(action), action, payload: input.payload || {} };

  const selectedRaw = String(input.selectionId || input.text || "").trim();
  const selected = normalized(selectedRaw);
  const menuOption = config.menu.options.find((option) => normalized(option.id) === selected || normalized(option.label) === selected);
  if (menuOption) return { module: registry.get(menuOption.module), action: menuOption.action, payload: menuOption.payload };

  if (selected.startsWith("event:")) {
    const selectedId = selected.slice(6);
    const eventId = config.events.items.find((event) => normalized(event.id) === selectedId)?.id || selectedRaw.slice(6);
    return { module: registry.get("orders"), action: "orders.select_event", payload: { eventId } };
  }
  if (selected.startsWith("appointment:")) {
    const selectedId = selected.slice(12);
    const serviceId = config.appointments.services.find((service) => normalized(service.id) === selectedId)?.id || selectedRaw.slice(12);
    return { module: registry.get("appointments"), action: "appointments.select_service", payload: { serviceId } };
  }
  return null;
}

export function createTenantRuntimeRouter({
  config: configInput,
  stateRepository,
  registry,
  ...dependencies
} = {}) {
  const config = parseTenantRuntimeConfig(configInput);
  requireMethod(stateRepository, "load", "stateRepository");
  requireMethod(stateRepository, "save", "stateRepository");
  const moduleRegistry = registry || createModuleRegistry(createCanonicalModuleDefinitions(dependencies));
  const enabled = new Set(config.enabledModules);
  for (const option of config.menu.options) {
    const owner = moduleRegistry.resolveAction(option.action);
    if (!owner || owner.key !== option.module) {
      throw new TypeError(`A ação ${option.action} não pertence ao módulo ${option.module}.`);
    }
  }

  async function handle(input) {
    if (!input?.conversationId) throw new TypeError("input.conversationId é obrigatório.");
    const stateContext = { empresaId: config.empresaId, conversationId: input.conversationId };
    const state = await stateRepository.load(stateContext) || { module: null, step: null, data: {} };
    if (state.module === "human_handoff" && state.step === "waiting_operator") {
      return {
        source: "deterministic",
        module: "human_handoff",
        code: "AUTOMATION_PAUSED",
        text: config.humanHandoff.message || "A automação está pausada enquanto você aguarda um operador.",
        buttons: [],
      };
    }
    const command = resolveCommand({ config, input, state, registry: moduleRegistry });
    if (!command?.module) return menuReply(config);
    if (!enabled.has(command.module.key)) {
      return {
        source: "deterministic",
        module: command.module.key,
        code: "MODULE_DISABLED",
        text: "Este recurso não está habilitado para esta empresa.",
        buttons: [],
      };
    }

    const outcome = await command.module.handle({
      action: command.action,
      payload: command.payload,
      input,
      state,
      config,
    });
    if (Object.hasOwn(outcome, "state")) {
      await stateRepository.save(stateContext, outcome.state);
    }
    return {
      source: "deterministic",
      module: command.module.key,
      text: outcome.reply?.text || "",
      buttons: outcome.reply?.buttons || [],
    };
  }

  return Object.freeze({ config, registry: moduleRegistry, handle });
}
