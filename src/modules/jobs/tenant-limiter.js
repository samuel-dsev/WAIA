export class TenantConcurrencyLimiter {
  constructor({ maxPerTenant = 1 } = {}) {
    if (!Number.isInteger(maxPerTenant) || maxPerTenant < 1) {
      throw new TypeError("maxPerTenant deve ser um inteiro positivo.");
    }
    this.maxPerTenant = maxPerTenant;
    this.active = new Map();
  }

  acquire(empresaId) {
    const current = this.active.get(empresaId) || 0;
    if (current >= this.maxPerTenant) return null;
    this.active.set(empresaId, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.active.get(empresaId) || 1) - 1;
      if (next > 0) this.active.set(empresaId, next);
      else this.active.delete(empresaId);
    };
  }
}
