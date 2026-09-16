import { AdminValidationError } from "./errors.js";

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
  async lookupGlobalUser({ email }) {
    const item = [...this.#resource("users").values()].find((candidate) => (
      String(candidate.email || "").toLocaleLowerCase("en-US") === email
    ));
    if (!item) return null;
    return clone(Object.fromEntries(Object.entries({
      id: item.id,
      name: item.name,
      email: item.email,
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }).filter(([, value]) => value !== undefined)));
  }
  async getTenant({ empresaId }) { return clone(this.tenants.get(empresaId) || null); }
  async createTenant({ transaction: _transaction, ...input }) { const item = { ...clone(input), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; this.tenants.set(item.id, item); return clone(item); }
  async updateTenant({ empresaId, changes }) { const item = this.tenants.get(empresaId); if (!item) return null; Object.assign(item, clone(changes), { updatedAt: new Date().toISOString() }); return clone(item); }
  async replaceModules({ empresaId, enabledModules }) {
    const modules = ["catalog", "orders", "events", "appointments", "payments", "human_handoff", "ai_freeform", "external_integrations", "flows"];
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
    if (resource === "users") {
      const memberships = [...this.#resource("memberships").values()];
      const items = [...this.#resource("users").values()].flatMap((user) => {
        const membership = memberships.find((item) => item.empresaId === empresaId && item.userId === user.id);
        if (!membership && user.empresaId !== empresaId) return [];
        return [{
          ...clone(user),
          empresaId,
          role: membership?.role || user.role,
          permissions: clone(membership?.permissions || user.permissions || []),
          membershipStatus: membership?.status || user.membershipStatus || "active",
        }];
      }).slice(0, limit);
      return { items, pagination: { total: items.length, page: 1, pageSize: limit } };
    }
    const items = [...this.#resource(resource).values()].filter((item) => item.empresaId === empresaId).slice(0, limit).map(clone);
    return { items, pagination: { total: items.length, page: 1, pageSize: limit } };
  }
  async get({ resource, empresaId, id }) {
    if (resource === "users") return (await this.list({ resource, empresaId, limit: Number.MAX_SAFE_INTEGER })).items.find((item) => item.id === id) || null;
    const item = this.#resource(resource).get(id);
    return item?.empresaId === empresaId ? clone(item) : null;
  }
  async create({ resource, empresaId, id, data }) {
    const recordId = resource === "memberships" ? data.userId : id;
    const item = { id: recordId, empresaId, ...clone(data), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.#resource(resource).set(recordId, item);
    return clone(item);
  }
  async update({ resource, empresaId, id, changes }) { const item = this.#resource(resource).get(id); if (!item || item.empresaId !== empresaId) return null; Object.assign(item, clone(changes), { updatedAt: new Date().toISOString() }); return clone(item); }
  async assertTenantAdminContinuity({ empresaId, userId, resource, changes = {}, remove = false }) {
    const records = (await this.list({ resource: "users", empresaId, limit: Number.MAX_SAFE_INTEGER })).items;
    const current = records.find((item) => item.id === userId);
    if (!current || current.role !== "tenant_admin" || current.status !== "active" || current.membershipStatus !== "active") return;
    const nextRole = remove ? null : changes.role ?? current.role;
    const nextUserStatus = remove ? null : resource === "users" ? changes.status ?? current.status : current.status;
    const nextMembershipStatus = remove ? null : resource === "memberships" ? changes.status ?? current.membershipStatus : current.membershipStatus;
    if (nextRole === "tenant_admin" && nextUserStatus === "active" && nextMembershipStatus === "active") return;
    const activeAdmins = records.filter((item) => item.role === "tenant_admin" && item.status === "active" && item.membershipStatus === "active");
    if (activeAdmins.length <= 1) {
      throw new AdminValidationError("A empresa precisa manter ao menos um administrador ativo.", {
        field: changes.role !== undefined ? "role" : changes.status !== undefined ? "status" : undefined,
      });
    }
  }
  async remove({ resource, empresaId, id }) {
    if (resource === "users") {
      const membership = this.#resource("memberships").get(id);
      if (membership?.empresaId === empresaId) return this.#resource("memberships").delete(id);
      const user = this.#resource("users").get(id);
      if (user?.empresaId !== empresaId) return false;
      delete user.empresaId;
      delete user.role;
      delete user.permissions;
      delete user.membershipStatus;
      user.updatedAt = new Date().toISOString();
      return true;
    }
    const item = this.#resource(resource).get(id);
    return item?.empresaId === empresaId ? this.#resource(resource).delete(id) : false;
  }
  async listFailedJobs({ empresaId, limit = 25, page = 1, filters = {} }) {
    const all = [...this.#resource("failed-jobs").values()].filter((item) => {
      if (item.empresaId !== empresaId) return false;
      if (filters.status === "open" && item.resolvedAt) return false;
      if (filters.status === "resolved" && !item.resolvedAt) return false;
      return !filters.jobType || item.jobType === filters.jobType;
    });
    const items = all.slice((page - 1) * limit, page * limit).map(clone);
    return { items, pagination: { total: all.length, page, pageSize: limit } };
  }
  async getFailedJob({ empresaId, id }) {
    const item = this.#resource("failed-jobs").get(id);
    return item?.empresaId === empresaId ? clone(item) : null;
  }
  async retryFailedJob({ empresaId, id, retryJobId, actorId, reason, correlationId }) {
    const item = this.#resource("failed-jobs").get(id);
    if (!item || item.empresaId !== empresaId) return null;
    if (item.resolvedAt) throw new AdminValidationError("Este job falho já foi encerrado.");
    const now = new Date().toISOString();
    Object.assign(item, {
      resolvedAt: now,
      resolvedByUserId: actorId,
      resolutionKind: "reenfileirado",
      resolutionNote: reason,
      retryJobId,
      retryJobStatus: "pendente",
      status: "resolved",
      updatedAt: now,
    });
    this.#resource("outbox-jobs").set(retryJobId, {
      id: retryJobId,
      empresaId,
      jobType: item.jobType,
      conversationId: item.conversationId,
      messageId: item.messageId,
      correlationId,
      status: "pendente",
    });
    return clone(item);
  }
  async resolveFailedJob({ empresaId, id, actorId, reason }) {
    const item = this.#resource("failed-jobs").get(id);
    if (!item || item.empresaId !== empresaId) return null;
    if (item.resolvedAt) throw new AdminValidationError("Este job falho já foi encerrado.");
    const now = new Date().toISOString();
    Object.assign(item, {
      resolvedAt: now,
      resolvedByUserId: actorId,
      resolutionKind: "resolvido",
      resolutionNote: reason,
      status: "resolved",
      updatedAt: now,
    });
    return clone(item);
  }
  async userHasOtherMemberships() { return false; }
  async diagnostics({ empresaId }) { return { empresaId, ...clone(this.health) }; }
  async writeAudit(event, _options = {}) { this.audit.push(clone(event)); }
}
