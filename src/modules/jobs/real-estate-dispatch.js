import { loadRealEstateCatalog } from '../../tenants/postgres-config-loader.js';
import { normalizeWebsiteInteraction } from '../business/website-catalog-interaction.js';
import { propertyFilters, propertyMatch, propertyCardText, propertyGalleryPart, validPropertyContinuation } from '../business/real-estate-catalog.js';

const propertyId = value => typeof value === 'string' && /^imo:filaretti:[1-9]\d*$/u.test(value);
export const isRealEstateCatalogPart = payload => propertyId(payload?.catalogProductId)
  || Array.isArray(payload?.websiteInteraction?.productIds) && payload.websiteInteraction.productIds.some(propertyId);

/** Revalidate every pending part against the CURRENT tenant publication/cache.
 * Prepared photos are never trusted after a price, gallery, source or policy change. */
export async function canDispatchRealEstateReply(client, empresaId, message, policy) {
  const { rows: [active] } = await client.query(`SELECT r.configuracao_compilada->'configuration' AS config
    FROM empresas e JOIN configuracoes_revisoes r ON r.empresa_id = e.id AND r.config_version = e.configuracao_ativa_versao
    WHERE e.id = $1 AND e.configuracao_runtime_modo = 'versionado' AND e.versao_configuracao = e.configuracao_ativa_versao`, [empresaId]);
  if (!active?.config?.modules?.includes('catalog')
    || !active.config.integrations?.some(item => item.enabled && item.type === 'real_estate_catalog')) return false;
  const catalog = await loadRealEstateCatalog(client, empresaId, active.config.integrations);
  if (catalog?.source?.status !== 'healthy') return false;
  const payload = message.outbound_payload || {}, interaction = normalizeWebsiteInteraction(payload.websiteInteraction);
  if (payload.websiteInteraction && (!interaction || interaction.productIds.some(id => !propertyId(id)))) return false;
  let browse = payload.catalogBrowse;
  if (!browse && payload.parentReplyId) {
    const { rows: [parent] } = await client.query('SELECT outbound_payload FROM mensagens WHERE empresa_id = $1 AND id = $2', [empresaId, payload.parentReplyId]);
    if (!parent) return false;
    browse = parent.outbound_payload?.catalogBrowse;
  }
  let filters = null;
  try { if (browse) filters = propertyFilters(browse.filters); } catch { return false; }
  const current = id => catalog.items.find(item => item.id === id && item.active !== false && item.availability !== 'unavailable');
  if (interaction) {
    const items = interaction.productIds.map(current);
    if (items.some(item => !item || filters && !propertyMatch(item, filters))) return false;
    if (interaction.step === 'list') return !payload.imageUrl && !payload.catalogProductId && payload.catalogListFormatVersion === 3
      && validPropertyContinuation(payload.catalogContinuation) && message.corpo === payload.catalogContinuation;
  }
  if (!payload.catalogProductId) return !payload.imageUrl && Boolean(interaction);
  const item = current(payload.catalogProductId);
  if (!item || filters && !propertyMatch(item, filters)) return false;
  if (!payload.imageUrl) return payload.catalogPhotoIndex == null && message.corpo === propertyCardText(item, filters);
  if (!Number.isInteger(payload.catalogPhotoIndex)) return false;
  if (payload.catalogContinuation !== undefined && (!interaction || interaction.step !== 'gallery' || interaction.productIds.at(-1) !== item.id)) return false;
  let expected;
  try { expected = propertyGalleryPart(item, payload.catalogPhotoIndex, { filters,
    ...(payload.catalogContinuation === undefined ? {} : { continuation: payload.catalogContinuation }) }); } catch { return false; }
  return expected?.imageUrl === payload.imageUrl && expected.text === message.corpo;
}
