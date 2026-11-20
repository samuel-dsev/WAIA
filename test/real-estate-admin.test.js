import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminService, MemoryAdminRepository } from '../src/modules/admin/index.js';
import { compileTenantRuntimeConfigV2 } from '../src/modules/configuration/index.js';

test('catálogo imobiliário administrativo respeita tenant, permissões e auditoria', async () => {
  const repository = new MemoryAdminRepository({ environment: 'test', tenants: [{ id: 'a', name: 'A', status: 'active' }, { id: 'b', name: 'B', status: 'active' }] });
  const calls = [];
  const service = new AdminService({ repository, realEstateCatalogIntegration: {
    async read(id) { calls.push(['read', id]); return { health: 'healthy', items: [] }; },
    async syncTenant(id) { calls.push(['sync', id]); return { health: 'healthy', productsImported: 1 }; },
  } });
  const admin = { audience: 'admin', user: { id: 'user-a' }, memberships: [{ empresaId: 'a', role: 'tenant_admin', permissions: [] }] };
  const operator = { ...admin, memberships: [{ empresaId: 'a', role: 'tenant_operator', permissions: ['*'] }] };
  assert.equal((await service.readRealEstateCatalog({ auth: admin, empresaId: 'a' })).health, 'healthy');
  assert.equal((await service.syncRealEstateCatalog({ auth: admin, empresaId: 'a', correlationId: 'sync-test' })).productsImported, 1);
  assert.ok(repository.audit.some(item => item.action === 'real_estate_catalog.sync' && item.result === 'success' && item.correlationId === 'sync-test'));
  for (const auth of [admin, operator]) await assert.rejects(service.syncRealEstateCatalog({ auth, empresaId: 'b' }), { status: 403 });
  await assert.rejects(service.readRealEstateCatalog({ auth: operator, empresaId: 'a' }), { status: 403 });
  assert.deepEqual(calls, [['read', 'a'], ['sync', 'a']]);
});

test('publicação rejeita fontes de sites conflitantes sem interferir em uma única fonte', () => {
  const config = { schemaVersion: 2, identity: { name: 'Teste' }, modules: ['catalog'], menu: { text: 'Menu', options: [] }, integrations: [
    { id: 'property', type: 'real_estate_catalog', name: 'Site imobiliário', enabled: true },
  ] };
  assert.equal(compileTenantRuntimeConfigV2(config, { empresaId: 'test', configVersion: 1 }).configuration.integrations.length, 1);
  config.integrations.push({ id: 'vehicles', type: 'website_catalog', name: 'Site automotivo', enabled: true });
  assert.throws(() => compileTenantRuntimeConfigV2(config, { empresaId: 'test', configVersion: 1 }), error => JSON.stringify(error).includes('CATALOG_SOURCE_CONFLICT'));
});
