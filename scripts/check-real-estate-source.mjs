import { fetchRealEstateCatalog, realEstateCatalogFromCache } from '../src/integrations/real-estate-catalog/source.js';
import { parseTenantRuntimeConfig } from '../src/modules/runtime/tenant-runtime-config.js';

// Read-only public source verification. No database, AI provider or WhatsApp.
const started = Date.now();
try {
  const snapshot = await fetchRealEstateCatalog();
  const catalog = realEstateCatalogFromCache({ status: 'saudavel', last_success_at: new Date(), cache_snapshot: snapshot });
  const runtime = parseTenantRuntimeConfig({ empresaId: 'source-verification', identity: { name: 'Verificação pública' }, enabledModules: ['catalog'], catalog });
  console.log(JSON.stringify({ success: true, elapsedMs: Date.now() - started, properties: runtime.catalog.items.length,
    photos: runtime.catalog.items.reduce((sum, item) => sum + (item.imageUrls?.length || 0), 0),
    cities: [...new Set(runtime.catalog.items.map(item => item.city))].sort(),
    byOperation: Object.fromEntries(['sale', 'rent', 'seasonal'].map(operation => [operation, runtime.catalog.items.filter(item => item.operations.includes(operation)).length])) }));
} catch (error) {
  console.error(JSON.stringify({ success: false, elapsedMs: Date.now() - started, code: error.code || 'PROPERTY_SOURCE_VALIDATION_FAILED',
    stage: error.sourceStage, reference: error.sourceReference, category: error.sourceCategory,
    reason: String(error.message || '').slice(0, 180) }));
  process.exitCode = 1;
}
