import { readPublicHtml, findHtml, hasClass, htmlText, decodeHtml } from './public-html.js';

export const REAL_ESTATE_CATALOG_TYPE = 'real_estate_catalog';
export const REAL_ESTATE_SITE = 'https://filaretti.com.br';
export const REAL_ESTATE_MEDIA = 'https://midia.imo.etc.br';
export const REAL_ESTATE_MAX_ITEMS = 500;
export const REAL_ESTATE_MAX_AGE_MS = 15 * 60_000;
const MAX_PAGES = 100, MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const normalize = value => String(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();
export const propertyError = code => Object.assign(new Error('Não foi possível atualizar o catálogo público de imóveis.'), { code });

export function propertyUrl(value) {
  let url;
  try { url = new URL(value, REAL_ESTATE_SITE); } catch { throw propertyError('PROPERTY_CATALOG_INVALID_URL'); }
  if (url.origin !== REAL_ESTATE_SITE || url.username || url.password || url.search || url.hash
    || !/^\/imovel\/[^/]+\/(?:venda|locacao|lancamento|temporada)\/[^/]+\/[^/]+\/[1-9]\d*\/?$/u.test(url.pathname)) throw propertyError('PROPERTY_CATALOG_INVALID_URL');
  return url.href.replace(/\/$/u, '');
}

export function propertyImageUrl(value, reference) {
  let url;
  try { url = new URL(value, REAL_ESTATE_SITE); } catch { throw propertyError('PROPERTY_CATALOG_INVALID_IMAGE'); }
  if (url.origin !== REAL_ESTATE_MEDIA || url.username || url.password || url.search || url.hash
    || !new RegExp(`^/filaretti/imoveis/${reference}/(?:[1-9]\\d*-(?:grande|media)|plantas/[1-9]\\d*)\\.(?:jpe?g|png|webp)$`, 'u').test(url.pathname)) throw propertyError('PROPERTY_CATALOG_INVALID_IMAGE');
  return url.href;
}

function amount(value) {
  const text = String(value).trim();
  if (!/^\d[\d.,]*$/u.test(text)) return null;
  const number = Number(text.includes(',') ? text.replace(/\./gu, '').replace(',', '.') : /^\d{1,3}(?:\.\d{3})+$/u.test(text) ? text.replace(/\./gu, '') : text);
  return Number.isFinite(number) && number >= 0 && number <= 1e9 ? number : null;
}
function bounded(value, limit) {
  if (value.length > limit) throw propertyError('PROPERTY_CATALOG_FIELD_TOO_LARGE');
  return value;
}

export function parsePropertyIndex(html, pageUrl = REAL_ESTATE_SITE + '/') {
  const tree = readPublicHtml(html), links = new Set(), pages = new Set();
  const categories = findHtml(tree, node => node.tag === 'select' && node.attrs.id === 'buscaTipo')
    .flatMap(node => findHtml(node, child => child.tag === 'option').map(child => child.attrs.value))
    .filter(value => /^[a-z]+(?:-[a-z]+)*$/u.test(value || ''));
  for (const node of findHtml(tree, node => node.tag === 'a' && node.attrs.href)) {
    const value = node.attrs.href;
    if (/\/imovel\//u.test(value)) { try { links.add(propertyUrl(value)); } catch { /* unrelated links are not requests */ } }
    let url;
    try { url = new URL(value, pageUrl); } catch { continue; }
    if (url.origin === REAL_ESTATE_SITE && !url.username && !url.password && !url.search && !url.hash
      && /^\/imoveis\/[a-z]+(?:-[a-z]+)*(?:\/[a-z]+(?:-[a-z]+)*)?(?:\/(?:venda|locacao|lancamento|temporada))?\/pagina\/[1-9]\d*\/?$/u.test(url.pathname)) pages.add(url.href.replace(/\/$/u, ''));
  }
  // Public map entries can include towns absent from the default search page.
  // Extract only constrained URL literals; never evaluate the JavaScript.
  for (const match of html.matchAll(/\bpermalink\s*:\s*["']([^"']+)["']/gu)) {
    try { links.add(propertyUrl(decodeHtml(match[1]))); } catch { /* not a supported public property URL */ }
  }
  const cards = findHtml(tree, node => hasClass(node, 'property-item'));
  const pageMarkers = findHtml(tree, node => node.attrs.id === 'paginaatual');
  const totalMarkers = findHtml(tree, node => node.attrs.id === 'totalpagina');
  const listingPath = new URL(pageUrl).pathname;
  if (listingPath.startsWith('/imoveis/') && (pageMarkers.length || totalMarkers.length)) {
    const current = htmlText(pageMarkers[0] || ''), total = htmlText(totalMarkers[0] || '');
    const expected = listingPath.match(/\/pagina\/(\d+)\/?$/u)?.[1] || '1';
    if (pageMarkers.length !== 1 || totalMarkers.length !== 1 || current !== expected || !/^\d+$/u.test(total)
      || Number(total) > MAX_PAGES || Number(current) > Math.max(1, Number(total))) throw propertyError('PROPERTY_CATALOG_INVALID_PAGINATION');
    const root = listingPath.replace(/\/pagina\/\d+\/?$/u, '').replace(/\/$/u, '');
    for (let page = 2; page <= Number(total); page++) pages.add(`${REAL_ESTATE_SITE}${root}/pagina/${page}`);
  }
  const empty = /(?:nenhum im[oó]vel|no properties found)/iu.test(htmlText(tree))
    || new URL(pageUrl).pathname.startsWith('/imoveis/')
      && findHtml(tree, node => node.attrs.id === 'property-items').length > 0
      && findHtml(tree, node => node.attrs.id === 'totalpagina' && htmlText(node) === '0').length === 1;
  if (!cards.length && !empty) throw propertyError('PROPERTY_CATALOG_INVALID_INDEX');
  return { urls: [...links], pages: [...pages], categories: [...new Set(categories)] };
}

export function parsePropertyPage(html, url) {
  url = propertyUrl(url);
  const segments = new URL(url).pathname.split('/').filter(Boolean), reference = segments.at(-1);
  const tree = readPublicHtml(html);
  const contents = findHtml(tree, node => node.tag === 'section' && hasClass(node, 'imovel-content'));
  if (contents.length !== 1) throw propertyError('PROPERTY_CATALOG_INVALID_PROPERTY');
  const content = contents[0];
  const titles = findHtml(content, node => hasClass(node, 'imovel-strip-desc') && /\bREF\s*#?\s*\d+/iu.test(htmlText(node)));
  if (titles.length !== 1 || htmlText(titles[0]).match(/\bREF\s*#?\s*(\d+)/iu)?.[1] !== reference) throw propertyError('PROPERTY_CATALOG_REFERENCE_MISMATCH');
  const name = bounded(htmlText(titles[0]).replace(/\s*REF\s*#?\s*\d+\s*$/iu, '').trim(), 160);
  if (!name) throw propertyError('PROPERTY_CATALOG_INVALID_PROPERTY');
  const prices = {}, operations = [];
  for (const node of findHtml(content, node => hasClass(node, 'finalidade'))) {
    const text = normalize(htmlText(node));
    const operation = /\blocacao\b/u.test(text) ? 'rent' : /\btemporada\b/u.test(text) ? 'seasonal' : /\b(?:venda|lancamento)\b/u.test(text) ? 'sale' : null;
    if (!operation) throw propertyError('PROPERTY_CATALOG_INVALID_PURPOSE');
    const parsed = amount(text.match(/r\$\s*([\d.,]+)/u)?.[1] || '');
    const value = parsed === 0 ? null : parsed;
    if (Object.hasOwn(prices, operation) && prices[operation] !== value) throw propertyError('PROPERTY_CATALOG_INCONSISTENT_PRICE');
    prices[operation] = value;
    if (!operations.includes(operation)) operations.push(operation);
  }
  if (!operations.length) throw propertyError('PROPERTY_CATALOG_INVALID_PURPOSE');
  const location = findHtml(content, node => hasClass(node, 'imovel-bairro'))[0];
  const neighborhood = location ? location.children.filter(child => typeof child === 'string').join(' ').replace(/\s+/gu, ' ').trim() : '';
  const city = location ? htmlText(findHtml(location, node => node.tag === 'span')[0] || '').split(/\s+em\s+/u).at(-1).trim() : '';
  if (!city) throw propertyError('PROPERTY_CATALOG_INVALID_LOCATION');
  const subtype = decodeURIComponent(segments[3]).replace(/-/gu, ' ');
  const type = /apartamento|cobertura|kitnet|studio|flat/u.test(subtype) ? 'apartamento'
    : /casa|sobrado/u.test(subtype) ? 'casa' : /terreno|lote|area/u.test(subtype) ? 'terreno'
      : /galpao/u.test(subtype) ? 'galpão' : /sitio|fazenda|chacara/u.test(subtype) ? 'rural'
        : /sala|loja|comercial|ponto/u.test(subtype) ? 'comercial' : subtype;
  const facts = {};
  for (const group of findHtml(content, node => hasClass(node, 'show-item'))) {
    for (const li of findHtml(group, node => node.tag === 'li')) {
      const text = normalize(htmlText(li)), value = amount(text.match(/^[\d.,]+/u)?.[0] || '');
      if (value == null) continue;
      const key = /quartos/u.test(text) ? 'bedrooms' : /suites/u.test(text) ? 'suites' : /banheiro/u.test(text) ? 'bathrooms' : /vaga/u.test(text) ? 'parkingSpaces' : /area total/u.test(text) ? 'totalArea' : /area const/u.test(text) ? 'builtArea' : null;
      if (key) facts[key] = value;
    }
  }
  const heading = content.children.findIndex(node => typeof node !== 'string' && node.tag === 'h5' && normalize(htmlText(node)) === 'descricao do imovel');
  const descriptionNode = heading < 0 ? null : content.children.slice(heading + 1).find(node => typeof node !== 'string');
  // The headings may be inside the section's article; search that same parent.
  const article = findHtml(content, node => node.tag === 'article')[0] || content;
  const at = article.children.findIndex(node => typeof node !== 'string' && node.tag === 'h5' && normalize(htmlText(node)) === 'descricao do imovel');
  const body = at < 0 ? descriptionNode : article.children.slice(at + 1).find(node => typeof node !== 'string');
  const description = bounded(body?.tag === 'div' && hasClass(body, 'imovel-desc') ? htmlText(body, { paragraphs: true }) : '', 12_000);
  const features = findHtml(content, node => node.tag === 'ul' && hasClass(node, 'itens-imovel'))
    .flatMap(node => findHtml(node, child => child.tag === 'li').map(child => bounded(htmlText(child), 500))).slice(0, 100);
  const values = findHtml(content, node => node.tag === 'strong' && /^(?:IPTU|Condomínio)$/iu.test(htmlText(node)));
  const costs = {};
  // Cost text is scoped to the detail section, never descriptions of related ads.
  const text = htmlText(content);
  for (const label of values.map(htmlText)) {
    const key = normalize(label) === 'iptu' ? 'propertyTax' : 'condominiumFee';
    const value = amount(text.match(new RegExp(`${label}\\s+R\\$\\s*([\\d.,]+)`, 'iu'))?.[1] || '');
    if (value > 0) costs[key] = value; // Legacy zero placeholders are not a promise of exemption.
  }
  if (/IPTU[^\n]{0,40}\(mensal\)/iu.test(text) && costs.propertyTax != null) costs.propertyTaxPeriod = 'monthly';
  const photos = new Map();
  for (const node of findHtml(tree, node => node.tag === 'a' || node.tag === 'img')) {
    const candidates = [node.attrs.href, node.attrs.src, ...(node.attrs.srcset || '').split(',').map(part => part.trim().split(/\s+/u)[0])].filter(Boolean);
    for (const value of candidates) {
      if (!value.includes(`/filaretti/imoveis/${reference}/`)) continue;
      const photo = propertyImageUrl(value, reference), photoId = new URL(photo).pathname.split('/').at(-1).split('-')[0];
      if (!photos.has(photoId) || photo.includes('-grande.')) photos.set(photoId, photo);
    }
  }
  const imageUrls = [...photos.values()].slice(0, 100);
  return { id: `imo:filaretti:${reference}`, reference, name, url, propertyType: type, propertySubtype: subtype,
    category: type, city: bounded(city, 100), neighborhood: bounded(neighborhood, 150), operations,
    salePrice: prices.sale ?? null, rentPrice: prices.rent ?? null, seasonalPrice: prices.seasonal ?? null,
    price: null, description, features, ...facts, ...costs,
    ...(imageUrls.length ? { imageUrls, imageUrl: imageUrls[0] } : {}),
    ...(photos.size > 100 ? { galleryTruncated: true, sourcePhotoCount: photos.size } : {}), availability: 'available', active: true };
}

export async function fetchRealEstateCatalog({ fetchImpl = fetch, signal } = {}) {
  const total = AbortSignal.timeout(180_000), cancellation = new AbortController();
  const combined = AbortSignal.any([total, cancellation.signal, ...(signal ? [signal] : [])]);
  let bytes = 0;
  async function get(url) {
    const requested = new URL(url);
    let response;
    for (let redirect = 0; redirect <= 2; redirect++) {
      response = await fetchImpl(url, { redirect: 'manual', headers: { Accept: 'text/html' }, signal: AbortSignal.any([combined, AbortSignal.timeout(15_000)]) });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location'); await response.body?.cancel();
      let next;
      try { next = new URL(location, url); } catch { throw propertyError('PROPERTY_CATALOG_UNSAFE_REDIRECT'); }
      // Accept only the provider's canonical trailing slash. Never follow a
      // redirect to another property, host, query, login or home fallback.
      if (!location || redirect === 2 || next.origin !== REAL_ESTATE_SITE || next.username || next.password || next.search || next.hash
        || next.pathname.replace(/\/$/u, '') !== requested.pathname.replace(/\/$/u, '')) throw propertyError('PROPERTY_CATALOG_UNSAFE_REDIRECT');
      url = next.href;
    }
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('text/html') || !response.body) { await response.body?.cancel(); throw propertyError('PROPERTY_CATALOG_HTTP_ERROR'); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength; bytes += chunk.byteLength;
      if (size > 2 * 1024 * 1024 || bytes > MAX_TOTAL_BYTES) { await response.body.cancel?.().catch(() => {}); throw propertyError('PROPERTY_CATALOG_RESPONSE_TOO_LARGE'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const queue = [REAL_ESTATE_SITE + '/'], visited = new Set(), properties = new Map();
  while (queue.length) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    if (visited.size >= MAX_PAGES) throw propertyError('PROPERTY_CATALOG_TOO_MANY_PAGES');
    visited.add(url);
    let page;
    try { page = parsePropertyIndex(await get(url), url); }
    catch (error) { throw Object.assign(error, { sourceStage: 'index', sourceCategory: new URL(url).pathname.split('/').filter(Boolean)[1] || 'home' }); }
    for (const property of page.urls) { const ref = new URL(property).pathname.split('/').at(-1); if (!properties.has(ref)) properties.set(ref, property); }
    if (properties.size > REAL_ESTATE_MAX_ITEMS) throw propertyError('PROPERTY_CATALOG_TOO_MANY_ITEMS');
    const next = [...page.pages, ...(url === REAL_ESTATE_SITE + '/' ? page.categories.map(category => `${REAL_ESTATE_SITE}/imoveis/${category}/`) : [])];
    queue.push(...next.filter(value => !visited.has(value) && !queue.includes(value)));
  }
  const urls = [...properties.values()].sort((a, b) => Number(new URL(a).pathname.split('/').at(-1)) - Number(new URL(b).pathname.split('/').at(-1)));
  const products = new Array(urls.length); let cursor = 0, failure;
  await Promise.all(Array.from({ length: Math.min(3, urls.length) }, async () => {
    while (cursor < urls.length && !failure) {
      const index = cursor++;
      try { products[index] = parsePropertyPage(await get(urls[index]), urls[index]); }
      catch (error) {
        failure ||= Object.assign(error, { sourceStage: 'property', sourceReference: new URL(urls[index]).pathname.split('/').at(-1) });
        cancellation.abort();
      }
    }
  }));
  if (failure) throw failure;
  return { profile: REAL_ESTATE_CATALOG_TYPE, schemaVersion: 1, products };
}

export function realEstateCatalogFromCache(row, now = Date.now()) {
  const timestamp = row?.last_success_at == null ? NaN : new Date(row.last_success_at).getTime(), snapshot = row?.cache_snapshot;
  const healthy = row?.status === 'saudavel' && now - timestamp >= 0 && now - timestamp <= REAL_ESTATE_MAX_AGE_MS
    && snapshot?.profile === REAL_ESTATE_CATALOG_TYPE && snapshot.schemaVersion === 1 && Array.isArray(snapshot.products) && snapshot.products.length <= REAL_ESTATE_MAX_ITEMS;
  return { items: healthy ? snapshot.products : [], source: { type: REAL_ESTATE_CATALOG_TYPE, status: healthy ? 'healthy' : 'unavailable', ...(Number.isFinite(timestamp) ? { lastSyncedAt: new Date(timestamp).toISOString() } : {}) } };
}
