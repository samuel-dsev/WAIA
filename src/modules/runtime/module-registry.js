import { MODULE_KEYS } from "../../core/contracts.js";

function validateDefinition(definition) {
  if (!definition || typeof definition !== "object") throw new TypeError("Definição de módulo inválida.");
  if (!MODULE_KEYS.includes(definition.key)) throw new TypeError(`Capacidade não canônica: ${definition.key}.`);
  if (!Array.isArray(definition.actions) || definition.actions.length === 0) {
    throw new TypeError(`Módulo ${definition.key} deve declarar ações.`);
  }
  if (typeof definition.handle !== "function") throw new TypeError(`Módulo ${definition.key} deve possuir handle.`);
}

export function createModuleRegistry(definitions) {
  if (!Array.isArray(definitions)) throw new TypeError("definitions deve ser um array.");
  const byKey = new Map();
  const byAction = new Map();

  for (const definition of definitions) {
    validateDefinition(definition);
    if (byKey.has(definition.key)) throw new TypeError(`Módulo duplicado: ${definition.key}.`);
    const frozen = Object.freeze({ ...definition, actions: Object.freeze([...definition.actions]) });
    byKey.set(frozen.key, frozen);
    for (const action of frozen.actions) {
      if (byAction.has(action)) throw new TypeError(`Ação duplicada: ${action}.`);
      byAction.set(action, frozen);
    }
  }

  const missing = MODULE_KEYS.filter((key) => !byKey.has(key));
  if (missing.length > 0) throw new TypeError(`Registro incompleto; faltam: ${missing.join(", ")}.`);

  return Object.freeze({
    keys: () => Object.freeze([...byKey.keys()]),
    get: (key) => byKey.get(key) || null,
    resolveAction: (action) => byAction.get(action) || null,
  });
}

