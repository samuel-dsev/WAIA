const clone = (value) => value == null ? value : structuredClone(value);

function cloneMap(source) {
  return new Map([...source.entries()].map(([key, value]) => [key, clone(value)]));
}

function cloneRecordMaps(source) {
  return new Map([...source.entries()].map(([resource, records]) => [resource, cloneMap(records)]));
}

export class MemoryAdminRepository {
  constructor({ tenants = [], records = {}, diagnostics = {}, environment = process.env.NODE_ENV || "development" } = {}) {
    if (!['development', 'test'].includes(environment)) throw new Error("Admin em memória permitido somente em desenvolvimento/teste.");
    this.tenants = new Map(tenants.map((item) => [item.id, clone(item)]));
    this.records = new Map(Object.entries(records).map(([resource, items]) => [resource, new Map(items.map((item) => [item.id, clone(item)]))]));
    this.audit = [];
    this.health = diagnostics;
  }
  #resource(name) { if (!this.records.has(name)) this.records.set(name, new Map()); return this.records.get(name); }
  async withAuditedMutation(_context, callback) {
    if (typeof callback !== "function") throw new TypeError("Callback transacional administrativo é obrigatório.");
    const rollbackHandlers = [];
    const transaction = Object.freeze({
      kind: "memory-admin-transaction",
      registerRollback(handler) {
        if (typeof handler !== "function") throw new TypeError("Handler de rollback inválido.");
        rollbackHandlers.push(handler);
      },
    });
    const snapshot = {
      tenants: cloneMap(this.tenants),
      records: cloneRecordMaps(this.records),
      audit: clone(this.audit),
    };
    try {
      return await callback(transaction);
    } catch (error) {
      for (const handler of rollbackHandlers.reverse()) await handler();
      this.tenants = snapshot.tenants;
      this.records = snapshot.records;
      this.audit.length = 0;
      this.audit.push(...snapshot.audit);
      throw error;
    }
  }
  async listTenants({ allowedIds, limit = 25 }) {
    const items = [...this.tenants.values()].filter((item) => !allowedIds || allowedIds.includes(item.id)).slice(0, limit).map(clone);
    return { items, pagination: { total: items.length, page: 1, pageSize: limit } };
  }
  async getTenant({ empresaId }) { return clone(this.tenants.get(empresaId) || null); }
  async createTenant({ transaction: _transaction, ...input }) { const item = { ...clone(input), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; this.tenants.set(item.id, item); return clone(item); }
  async updateTenant({ empresaId, changes }) { const item = this.tenants.get(empresaId); if (!item) return null; Object.assign(item, clone(changes), { updatedAt: new Date().toISOString() }); return clone(item); }
  async replaceModules({ empresaId, enabledModules }) {
    const modules = ["catalog", "orders", "events", "appointments", "payments", "human_handoff", "ai_freeform", "external_integrations"];
    const records = this.#resource("modules");
    for (const moduleKey of modules) {
      const id = `${empresaId}:${moduleKey}`;
      records.set(id, { id: moduleKey, empresaId, moduleKey, enabled: enabledModules.includes(moduleKey), configuration: {} });
    }
    return { items: [...records.values()].filter((item) => item.empresaId === empresaId).map(clone) };
  }
  async globalDashboard() { return { companies: this.tenants.size, activeCompanies: [...this.tenants.values()].filter((item) => item.status === "active").length, alerts: [] }; }
  async tenantDashboard({ empresaId }) {
    if (!this.tenants.has(empresaId)) return null;
    return { contacts: [...this.#resource("contacts").values()].filter((item) => item.empresaId === empresaId).length, conversations: [...this.#resource("conversations").values()].filter((item) => item.empresaId === empresaId).length };
  }
  async list({ resource, empresaId, limit = 25 }) {
    const items = [...this.#resource(resource).values()].filter((item) => item.empresaId === empresaId).slice(0, limit).map(clone);
    return { items, pagination: { total: items.length, page: 1, pageSize: limit } };
  }
  async get({ resource, empresaId, id }) { const item = this.#resource(resource).get(id); return item?.empresaId === empresaId ? clone(item) : null; }
  async create({ resource, empresaId, id, data }) { const item = { id, empresaId, ...clone(data), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; this.#resource(resource).set(id, item); return clone(item); }
  async update({ resource, empresaId, id, changes }) { const item = this.#resource(resource).get(id); if (!item || item.empresaId !== empresaId) return null; Object.assign(item, clone(changes), { updatedAt: new Date().toISOString() }); return clone(item); }
  async remove({ resource, empresaId, id }) { const item = this.#resource(resource).get(id); return item?.empresaId === empresaId ? this.#resource(resource).delete(id) : false; }
  async userHasOtherMemberships() { return false; }
  async diagnostics({ empresaId }) { return { empresaId, ...clone(this.health) }; }
  async writeAudit(event, _options = {}) { this.audit.push(clone(event)); }
}
