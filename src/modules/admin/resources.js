const definitions = {
  tenants: {
    read: "admin",
    write: "admin",
    fields: {
      slug: "string", name: "string", displayName: "string", identity: "string?", timezone: "string",
      locale: "string", status: "string", messageRetentionDays: "number", logRetentionDays: "number",
    },
    filters: ["status", "search"],
    sorts: ["createdAt", "name", "status"],
  },
  users: {
    read: "admin",
    write: "admin",
    fields: { email: "email", name: "string", role: "role", status: "string", initialPassword: "string" },
    filters: ["status", "search"],
    sorts: ["name", "email", "createdAt"],
  },
  memberships: {
    read: "admin",
    write: "admin",
    fields: { userId: "string", role: "role", status: "string", permissions: "array" },
    filters: ["role", "status", "userId"],
    sorts: ["createdAt", "userId"],
  },
  numbers: {
    read: "admin",
    write: "admin",
    fields: {
      phoneNumberId: "string", wabaId: "string?", numeroE164: "string?", numeroMascarado: "string?",
      nomeVerificado: "string?", status: "string", principal: "boolean",
    },
    filters: ["status", "principal", "search"],
    sorts: ["createdAt", "status", "nomeVerificado"],
  },
  credentials: {
    read: "admin",
    write: "credential",
    fields: {},
    filters: ["provider", "status"],
    sorts: ["createdAt", "provider", "status"],
  },
  "ai-config": {
    read: "admin",
    write: "admin",
    singleton: true,
    fields: {
      enabled: "boolean", provider: "string", model: "string", prompt: "string?", personality: "string?",
      keyType: "string", ownCredentialId: "string?", monthlyTokenLimit: "number?", monthlyCostLimit: "number?",
      alertPercent: "number", maxHistoryMessages: "number", maxOutputTokens: "number", fallbackMessage: "string?",
    },
    filters: [],
    sorts: ["updatedAt"],
  },
  "runtime-config": {
    read: "admin",
    write: "admin",
    singleton: true,
    fields: {
      greeting: "string", fallbackMessage: "string", address: "string?", menuUrl: "string?",
      birthdayRule: "string?", schedules: "object", publicReplies: "array", routing: "object",
    },
    filters: [],
    sorts: ["updatedAt"],
  },
  modules: {
    read: "all",
    write: "admin",
    fields: { moduleKey: "string", enabled: "boolean", configuration: "object" },
    filters: ["enabled", "moduleKey"],
    sorts: ["moduleKey", "updatedAt"],
  },
  menus: {
    read: "all",
    write: "admin",
    fields: { menuKey: "string", title: "string", message: "string", active: "boolean", version: "number" },
    filters: ["active", "menuKey"],
    sorts: ["menuKey", "createdAt", "updatedAt"],
  },
  "menu-items": {
    read: "all",
    write: "admin",
    fields: {
      menuId: "string", position: "number", title: "string", actionType: "string",
      actionKey: "string", configuration: "object", enabled: "boolean",
    },
    filters: ["menuId", "enabled"],
    sorts: ["position", "createdAt", "updatedAt"],
  },
  catalog: {
    read: "all",
    write: "admin",
    fields: {
      type: "string", sku: "string?", name: "string", description: "string?", price: "number",
      currency: "string", stockControl: "string", availableQuantity: "number?", active: "boolean",
    },
    filters: ["type", "active", "search"],
    sorts: ["name", "price", "createdAt", "updatedAt"],
  },
  events: {
    read: "all",
    write: "admin",
    fields: {
      externalSource: "string?", externalId: "string?", name: "string", attractions: "string?",
      startsAt: "date", endsAt: "date?", timezone: "string", location: "string?", birthdayRule: "string?",
      notes: "string?", capacity: "number?", status: "string",
    },
    filters: ["status", "from", "to", "search"],
    sorts: ["startsAt", "name", "createdAt"],
  },
  orders: {
    read: "all",
    write: "operator",
    fields: { status: "string", paymentStatus: "string", integrationStatus: "string" },
    filters: ["status", "paymentStatus", "contactId", "conversationId", "from", "to"],
    sorts: ["createdAt", "updatedAt", "status", "total"],
  },
  appointments: {
    read: "all",
    write: "operator",
    fields: { status: "string", notes: "string?", operatorId: "string?" },
    filters: ["status", "contactId", "conversationId", "from", "to"],
    sorts: ["startsAt", "createdAt", "status"],
  },
  contacts: {
    read: "all",
    write: "admin",
    fields: {
      name: "string?", consentStatus: "string", botPaused: "boolean", blocked: "boolean",
      deletionRequestedAt: "date?",
    },
    filters: ["botPaused", "blocked", "consentStatus", "search"],
    sorts: ["lastInteractionAt", "firstInteractionAt", "name", "createdAt"],
    pii: true,
  },
  conversations: {
    read: "all",
    write: "operator",
    fields: { status: "string", mode: "string", operatorId: "string?" },
    filters: ["status", "mode", "contactId", "numberId", "search"],
    sorts: ["lastMessageAt", "createdAt", "status"],
    pii: true,
  },
  messages: {
    read: "all",
    write: "none",
    fields: {},
    filters: ["conversationId", "contactId", "status", "direction", "type", "from", "to", "correlationId"],
    sorts: ["createdAt", "sequence", "status"],
    pii: true,
  },
  logs: {
    read: "admin",
    write: "none",
    fields: {},
    filters: ["severity", "category", "service", "correlationId", "conversationId", "messageId", "from", "to"],
    sorts: ["occurredAt", "severity", "createdAt"],
  },
  audit: {
    read: "admin",
    write: "none",
    fields: {},
    filters: ["action", "result", "actorId", "from", "to"],
    sorts: ["occurredAt", "action", "result"],
  },
  "ai-usage": {
    read: "admin",
    write: "none",
    fields: {},
    filters: ["model", "keyType", "success", "conversationId", "from", "to"],
    sorts: ["occurredAt", "totalTokens", "estimatedCost"],
  },
  integrations: {
    read: "admin",
    write: "admin",
    fields: {
      type: "string", name: "string", enabled: "boolean", requiredForConfirmation: "boolean",
      status: "string", configuration: "object",
    },
    filters: ["type", "enabled", "status"],
    sorts: ["createdAt", "name", "status"],
  },
  payments: {
    read: "admin",
    write: "admin",
    fields: {
      type: "string", name: "string", maskedIdentifier: "string?", recipient: "string?",
      instructions: "string?", credentialId: "string?", enabled: "boolean",
    },
    filters: ["type", "enabled"],
    sorts: ["createdAt", "name", "type"],
  },
  availability: {
    read: "all",
    write: "admin",
    fields: {
      productServiceId: "string", startsAt: "date", endsAt: "date", capacity: "number",
      reserved: "number", status: "string",
    },
    filters: ["productServiceId", "status", "from", "to"],
    sorts: ["startsAt", "createdAt", "updatedAt"],
  },
};

export const ADMIN_RESOURCES = Object.freeze(Object.fromEntries(
  Object.entries(definitions).map(([key, definition]) => [key, Object.freeze({
    ...definition,
    fields: Object.freeze({ ...definition.fields }),
    filters: Object.freeze([...definition.filters]),
    sorts: Object.freeze([...definition.sorts]),
  })]),
));

export function adminResource(name) {
  return ADMIN_RESOURCES[String(name)] || null;
}
