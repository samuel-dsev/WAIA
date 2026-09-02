import { validateFlowDefinition } from "../flows/index.js";

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

export function identityIsComplete(configuration) {
  const identity = configuration?.identity;
  return Boolean(identity && text(identity.name) && text(identity.displayName) && text(identity.locale) && text(identity.timezone));
}

export function retentionIsValid(configuration) {
  const retention = configuration?.retention;
  return Number.isSafeInteger(retention?.messagesDays)
    && retention.messagesDays >= 1
    && retention.messagesDays <= 3_650
    && Number.isSafeInteger(retention?.logsDays)
    && retention.logsDays >= 1
    && retention.logsDays <= 3_650;
}

export function selectedModules(configuration) {
  return new Set(list(configuration?.modules).filter((key) => text(key)));
}

export function moduleDependenciesAreValid(configuration, capabilityCatalog) {
  const enabled = selectedModules(configuration);
  if (enabled.size === 0) return false;
  const definitions = new Map(list(capabilityCatalog).map((definition) => [definition.key, definition]));
  for (const key of enabled) {
    const definition = definitions.get(key);
    if (!definition) return false;
    if (list(definition.dependencies).some((dependency) => !enabled.has(dependency))) return false;
  }
  return true;
}

export function menuIsValid(configuration, { actionOwner, validateActionParams }) {
  const enabled = selectedModules(configuration);
  const options = configuration?.menu?.options;
  if (!Array.isArray(options) || options.length === 0) return false;
  const ids = new Set();
  for (const option of options) {
    if (!option || !text(option.id) || !text(option.label) || !text(option.action) || ids.has(option.id)) return false;
    ids.add(option.id);
    const owner = actionOwner(option.action);
    if (!owner || !enabled.has(owner)) return false;
    const params = option.params == null ? {} : option.params;
    if (validateActionParams && !validateActionParams(option.action, params, { context: "menu" })?.valid) return false;
  }
  return true;
}

export function hasTenantAdministrator(snapshot) {
  if (Number.isSafeInteger(snapshot?.administratorCount)) return snapshot.administratorCount > 0;
  return list(snapshot?.users).some((user) => {
    const role = String(user?.role || "").toLocaleLowerCase("pt-BR");
    const status = String(user?.status || "active").toLocaleLowerCase("pt-BR");
    return ["tenant_admin", "administrador"].includes(role) && ["active", "ativo"].includes(status);
  });
}

export function whatsappNumberIsComplete(snapshot) {
  const number = snapshot?.whatsapp?.primaryNumber;
  const status = String(number?.status || "").toLocaleLowerCase("pt-BR");
  const isPrimary = number?.primary === true || number?.principal === true;
  return Boolean(
    isPrimary
    && text(number?.phoneNumberId)
    && text(number?.wabaId)
    && /^\+[1-9][0-9]{7,14}$/u.test(String(number?.numeroE164 || ""))
    && ["active", "ativo"].includes(status),
  );
}

export function whatsappTokenIsConfigured(snapshot) {
  return snapshot?.whatsapp?.accessTokenConfigured === true || snapshot?.whatsapp?.tokenConfigured === true;
}

export function metaApplicationIsValid(snapshot) {
  return snapshot?.whatsapp?.applicationValid === true || snapshot?.whatsapp?.appValid === true;
}

function credentialReferences(snapshot) {
  const direct = list(snapshot?.credentialReferences).filter(text);
  const records = list(snapshot?.credentials)
    .filter((credential) => ["active", "ativo", "configured", "configurado"].includes(String(credential?.status || "").toLocaleLowerCase("pt-BR")))
    .map((credential) => credential.reference)
    .filter(text);
  return new Set([...direct, ...records]);
}

export function referenceIsAvailable(snapshot, reference) {
  return text(reference) && credentialReferences(snapshot).has(reference);
}

export function aiIsReady(configuration, snapshot) {
  if (!selectedModules(configuration).has("ai_freeform")) return true;
  const ai = configuration?.ai;
  if (!ai?.enabled || !text(ai.provider) || !text(ai.model) || !text(ai.prompt)) return false;
  if (ai.keyMode === "own") return referenceIsAvailable(snapshot, ai.credentialRef);
  if (ai.keyMode === "shared") return snapshot?.platformAiCredentialConfigured === true;
  return ai.keyMode === "simulated" && snapshot?.environment === "test";
}

export function paymentIsReady(configuration, snapshot) {
  if (!selectedModules(configuration).has("payments")) return true;
  if (referenceIsAvailable(snapshot, configuration?.payments?.credentialRef)) return true;
  const integrationRef = configuration?.payments?.integrationRef;
  return text(integrationRef) && list(snapshot?.integrations).some((integration) => (
    integration.reference === integrationRef
    && ["healthy", "simulated"].includes(integration.status)
    && (integration.status !== "simulated" || snapshot?.environment === "test")
  ));
}

export function appointmentsAreReady(configuration) {
  if (!selectedModules(configuration).has("appointments")) return true;
  return list(configuration?.appointments?.services).some((service) => service?.active !== false && text(service?.id) && text(service?.name));
}

export function flowsAreReady(configuration) {
  if (!selectedModules(configuration).has("flows")) return true;
  const definitions = list(configuration?.flows?.definitions);
  return definitions.length > 0 && definitions.every((flow) => validateFlowDefinition(flow).valid);
}

export function requiredIntegrationsAreAvailable(configuration, snapshot) {
  const health = new Map(list(snapshot?.integrations).map((integration) => [integration.id, integration.status]));
  return list(configuration?.integrations)
    .filter((integration) => integration?.enabled !== false && integration?.required === true)
    .every((integration) => {
      const status = health.get(integration.id);
      return status === "healthy" || (status === "simulated" && snapshot?.environment === "test");
    });
}
