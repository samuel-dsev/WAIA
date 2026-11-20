import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePropertyPage, parsePropertyIndex, fetchRealEstateCatalog, realEstateCatalogFromCache, propertyUrl, propertyImageUrl, REAL_ESTATE_SITE, REAL_ESTATE_MAX_AGE_MS } from '../src/integrations/real-estate-catalog/source.js';
import { parseTenantRuntimeConfig } from '../src/modules/runtime/tenant-runtime-config.js';
import { catalogSalesFormat, parseCatalogSalesReply, normalizeCatalogBrowseState } from '../src/modules/business/catalog-sales.js';
import { EMPTY_PROPERTY_FILTERS, propertyMatch, propertyCardText } from '../src/modules/business/real-estate-catalog.js';
import { normalizeWebsiteInteraction } from '../src/modules/business/website-catalog-interaction.js';
import { allowlistedTenantContext } from '../src/modules/ai/guardrails.js';
import { createWhatsAppReplyPayload } from '../src/modules/whatsapp/outbound.js';

export const propertyPageUrl = (id = 1) => `${REAL_ESTATE_SITE}/imovel/taubate/venda/casa/casa-exemplo/${id}`;
export const propertyHtml = (id = 1, { price = '500.000,00', rent = '2.500,00', title = 'Casa exemplo', galleryId = id, body = 'Casa com quintal.', neighborId = 99, bedrooms = 3 } = {}) => `<html><body>
  <section><a href="https://midia.imo.etc.br/filaretti/imoveis/${galleryId}/101-grande.jpg"><img src="https://midia.imo.etc.br/filaretti/imoveis/${galleryId}/101-media.jpg"></a>
  <a href="https://midia.imo.etc.br/filaretti/imoveis/${galleryId}/102-grande.jpg"></a></section>
  <section class="imovel-content"><article>
    <ul class="imovel-desc"><li class="imovel-strip-desc">${title}<span class="ref">REF #${id}</span></li>
      <li><div class="finalidade"><b>Venda:</b> R$ ${price}</div>${rent === null ? '' : `<div class="finalidade"><b>Locação:</b> R$ ${rent}</div>`}
        <strong>IPTU</strong> R$ 0.00 (mensal)<br><strong>Condomínio</strong> R$ 350,00</li>
      <li class="imovel-bairro">Centro<span>Casa em Taubaté</span></li>
      <li class="mobile-info-desc"><div class="show-item"><ul><li>${bedrooms}<span>Quartos</span></li><li>2<span>Vaga(s)</span></li><li>125 m²<span>Área Total</span></li><li>72,5 m²<span>Área Const.</span></li></ul></div></li>
    </ul><h5>Itens do imóvel</h5><ul class="itens-imovel"><li>1 Quintal</li></ul>
    <h5>Descrição do imóvel</h5><div class="imovel-desc"><p>${body}</p></div>
    <h5>Medidas detalhadas</h5><div class="imovel-desc">Frente: 5m</div>
    <div class="finalidade"><span>R$ ${price}</span> Venda</div>
  </article></section><section class="relacionados"><div class="property-item"><a href="${propertyPageUrl(neighborId)}"><img src="https://midia.imo.etc.br/filaretti/imoveis/${neighborId}/999-grande.jpg"></a></div></section></body></html>`;
export const propertyIndex = (ids = [1], { next = '', categories = [], empty = false } = {}) => `<html><select id="buscaTipo">${categories.map(item => `<option value="${item}">${item}</option>`).join('')}</select>${ids.map(id => `<div class="property-item"><a href="${propertyPageUrl(id)}">Casa ${id}</a></div>`).join('')}${next ? `<a href="${next}">Próxima</a>` : ''}${empty ? 'No Properties Found.' : ''}</html>`;
export const propertyItem = (id = 1, fields = {}) => ({ ...parsePropertyPage(propertyHtml(id), propertyPageUrl(id)), ...fields });
export const propertyCatalog = (...items) => realEstateCatalogFromCache({ status: 'saudavel', last_success_at: new Date(), cache_snapshot: { profile: 'real_estate_catalog', schemaVersion: 1, products: items } });

test('imóveis: separa finalidades e valores, decodifica texto e exclui fotos de relacionados', () => {
  const item = parsePropertyPage(propertyHtml(1717, { body: 'Ilumina&ccedil;&atilde;o, su&iacute;te e &aacute;rea gourmet.<script>throw 1;</script>' }), propertyPageUrl(1717));
  assert.equal(item.id, 'imo:filaretti:1717');
  assert.equal(item.name, 'Casa exemplo');
  assert.deepEqual(item.operations, ['sale', 'rent']);
  assert.equal(item.salePrice, 500000); assert.equal(item.rentPrice, 2500);
  assert.equal(item.city, 'Taubaté'); assert.equal(item.neighborhood, 'Centro');
  assert.equal(item.bedrooms, 3); assert.equal(item.parkingSpaces, 2);
  assert.equal(item.totalArea, 125); assert.equal(item.builtArea, 72.5);
  assert.equal(item.propertyTax, undefined); assert.equal(item.condominiumFee, 350);
  assert.equal(item.imageUrls.length, 2); assert.ok(item.imageUrls.every(url => url.includes('/1717/') && url.endsWith('-grande.jpg')));
  assert.match(item.description, /Iluminação, suíte e área gourmet/u);
  assert.doesNotMatch(item.description, /throw|Frente|REF|99/u);
});

test('imóveis: páginas inválidas, troca de referência e destinos externos falham fechados', () => {
  assert.throws(() => parsePropertyPage(propertyHtml(2), propertyPageUrl(1)), { code: 'PROPERTY_CATALOG_REFERENCE_MISMATCH' });
  assert.throws(() => parsePropertyPage('<html>Temporariamente indisponível</html>', propertyPageUrl(1)), { code: 'PROPERTY_CATALOG_INVALID_PROPERTY' });
  for (const url of ['https://localhost/imovel/a/venda/casa/a/1', propertyPageUrl() + '?next=http://127.0.0.1', 'http://filaretti.com.br/imovel/a/venda/casa/a/1']) assert.throws(() => propertyUrl(url));
  assert.throws(() => propertyImageUrl('https://example.com/filaretti/imoveis/1/101-grande.jpg', '1'));
  assert.throws(() => propertyImageUrl('https://midia.imo.etc.br/filaretti/imoveis/2/101-grande.jpg', '1'));
  assert.throws(() => parsePropertyIndex('<html>Blocked</html>'), { code: 'PROPERTY_CATALOG_INVALID_INDEX' });
  assert.deepEqual(parsePropertyIndex(propertyIndex([], { empty: true })).urls, []);
});

test('imóveis: percorre categorias/paginação, deduplica IDs e só retorna lote completo', async () => {
  const pages = new Map([
    [REAL_ESTATE_SITE + '/', propertyIndex([1], { categories: ['casas-e-sobrados'] })],
    [REAL_ESTATE_SITE + '/imoveis/casas-e-sobrados/', propertyIndex([1], { next: '/imoveis/casas-e-sobrados/pagina/2' })],
    [REAL_ESTATE_SITE + '/imoveis/casas-e-sobrados/pagina/2', propertyIndex([2])],
    [propertyPageUrl(1), propertyHtml(1)], [propertyPageUrl(2), propertyHtml(2)],
  ]);
  const calls = [];
  const fetchImpl = async (url, options) => { assert.equal(options.redirect, 'manual'); calls.push(url); assert.ok(pages.has(url), url); return new Response(pages.get(url), { headers: { 'content-type': 'text/html; charset=utf-8' } }); };
  const snapshot = await fetchRealEstateCatalog({ fetchImpl });
  assert.deepEqual(snapshot.products.map(item => item.reference), ['1', '2']);
  assert.equal(calls.length, 5);
  pages.delete(propertyPageUrl(2));
  await assert.rejects(fetchRealEstateCatalog({ fetchImpl }), /imovel\/taubate/u);
});

test('imóveis: não aceita HTTP de erro ou corpo de tamanho ilimitado', async () => {
  await assert.rejects(fetchRealEstateCatalog({ fetchImpl: async () => new Response('Erro', { status: 404 }) }), { code: 'PROPERTY_CATALOG_HTTP_ERROR' });
  await assert.rejects(fetchRealEstateCatalog({ fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/html' } }) }), { code: 'PROPERTY_CATALOG_RESPONSE_TOO_LARGE' });
});

test('imóveis: paginação explícita cobre páginas sem link e rejeita fallback para primeira página', () => {
  const marker = '<span id="paginaatual">1</span><span id="totalpagina">3</span>';
  const root = REAL_ESTATE_SITE + '/imoveis/casas-e-sobrados/';
  assert.equal(parsePropertyIndex(propertyIndex([1]) + marker, root).pages.length, 2);
  assert.throws(() => parsePropertyIndex(propertyIndex([1]) + marker, root + 'pagina/2'), { code: 'PROPERTY_CATALOG_INVALID_PAGINATION' });
  const empty = '<div id="property-items"></div><span id="paginaatual">1</span><span id="totalpagina">0</span>';
  assert.equal(parsePropertyIndex(empty, root).urls.length, 0);
});

test('imóveis: só segue redirecionamento canônico de barra final', async () => {
  for (const location of ['https://localhost/', REAL_ESTATE_SITE + '/login', REAL_ESTATE_SITE + '/?next=1']) {
    await assert.rejects(fetchRealEstateCatalog({ fetchImpl: async () => new Response(null, { status: 302, headers: { location } }) }), { code: 'PROPERTY_CATALOG_UNSAFE_REDIRECT' });
  }
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.endsWith('/pagina/2')) return new Response(null, { status: 301, headers: { location: url + '/' } });
    return new Response(url.endsWith('/pagina/2/') ? propertyIndex([], { empty: true })
      : propertyIndex([], { empty: true, next: '/imoveis/casas-e-sobrados/pagina/2' }), { headers: { 'content-type': 'text/html' } });
  };
  assert.equal((await fetchRealEstateCatalog({ fetchImpl })).products.length, 0);
  assert.equal(calls.length, 3);
});

test('imóveis: galerias extensas informam limite e pergunta longa não apaga fatos da foto única', () => {
  const photos = Array.from({ length: 113 }, (_, index) => `<a href="https://midia.imo.etc.br/filaretti/imoveis/1/${index + 1000}-grande.jpg"></a>`).join('');
  const item = parsePropertyPage(propertyHtml(1) + photos, propertyPageUrl(1));
  assert.equal(item.imageUrls.length, 100); assert.equal(item.sourcePhotoCount, 115); assert.equal(item.galleryTruncated, true);
  assert.match(propertyCardText(item), /100 das 115/u);
  const single = propertyItem(2); single.imageUrls = single.imageUrls.slice(0, 1);
  const reply = parseCatalogSalesReply(JSON.stringify({ catalogAction: 'products', productIds: [single.id], filters: EMPTY_PROPERTY_FILTERS,
    text: 'Você gostaria de conversar com o corretor sobre esta casa? '.repeat(14).trim() }), propertyCatalog(single));
  assert.equal(reply.messages.length, 2);
  assert.match(reply.messages[0].text, /500\.000/u);
  assert.match(reply.messages[0].text, /confirmação pelo corretor/u);
  assert.equal(reply.messages[1].imageUrl, undefined);
});

test('imóveis: cache vencido ou indisponível não expõe anúncios antigos', () => {
  const now = Date.now(), row = { status: 'saudavel', last_success_at: new Date(now), cache_snapshot: { profile: 'real_estate_catalog', schemaVersion: 1, products: [propertyItem()] } };
  assert.equal(realEstateCatalogFromCache(row, now).items.length, 1);
  assert.equal(realEstateCatalogFromCache(row, now + REAL_ESTATE_MAX_AGE_MS + 1).items.length, 0);
  assert.equal(realEstateCatalogFromCache({ ...row, status: 'indisponivel' }, now).items.length, 0);
});

test('imóveis: runtime preserva dados estruturados e o contexto inclui referências após a centésima', () => {
  const catalog = propertyCatalog(...Array.from({ length: 120 }, (_, index) => propertyItem(index + 1)));
  const config = parseTenantRuntimeConfig({ empresaId: 'fixture', identity: { name: 'Empresa teste' }, enabledModules: ['catalog'], catalog });
  assert.equal(config.catalog.items[119].reference, '120');
  assert.equal(config.catalog.items[0].rentPrice, 2500);
  assert.equal(allowlistedTenantContext({ catalog: config.catalog }, ['catalog']).catalog.items.length, 120);
  assert.equal(catalogSalesFormat(catalog).name, 'real_estate_catalog_reply');
  assert.ok(!catalogSalesFormat(catalog).schema.properties.catalogAction.enum.includes('finance'));
});

test('imóveis: orçamento, cidade e finalidade são rígidos; diferenças aceitas ficam explícitas', () => {
  const filters = { ...EMPTY_PROPERTY_FILTERS, operation: 'rent', city: 'Taubaté', maxPrice: 2600, minBedrooms: 3 };
  assert.ok(propertyMatch(propertyItem(), filters));
  assert.equal(propertyMatch(propertyItem(2, { rentPrice: 2601 }), filters), null);
  assert.equal(propertyMatch(propertyItem(2, { city: 'Tremembé' }), filters), null);
  assert.equal(propertyMatch(propertyItem(2, { operations: ['sale'] }), filters), null);
  assert.equal(propertyMatch(propertyItem(2, { bedrooms: 2 }), filters), null);
  const flexible = { ...filters, flexibleCriteria: ['minBedrooms'] };
  assert.match(propertyCardText(propertyItem(2, { bedrooms: 2 }), flexible), /Quartos: 2; solicitado: pelo menos 3/u);
  assert.doesNotMatch(propertyCardText(propertyItem(), filters), /500\.000/u);
});

test('imóveis: opções enviam capas corretas; fotos específicas enviam galeria e pergunta na última', () => {
  const catalog = propertyCatalog(propertyItem(1), propertyItem(2), propertyItem(3), propertyItem(4));
  const filters = { ...EMPTY_PROPERTY_FILTERS, operation: 'sale', maxPrice: 600000 };
  const selection = { text: 'Algum desses imóveis chamou sua atenção?', catalogAction: 'browse', productIds: [], filters };
  const reply = parseCatalogSalesReply(JSON.stringify(selection), catalog);
  assert.equal(reply.messages.length, 4);
  assert.equal(reply.messages.filter(part => part.imageUrl).length, 3);
  assert.equal(reply.messages.at(-1).websiteInteraction.step, 'list');
  reply.messages.forEach(part => createWhatsAppReplyPayload({ to: 'fixture', ...part }));
  const state = normalizeCatalogBrowseState({ filters, seenProductIds: ['imo:filaretti:1', 'imo:filaretti:2', 'imo:filaretti:3'] });
  const more = parseCatalogSalesReply(JSON.stringify({ ...selection, catalogAction: 'more' }), { ...catalog, browseState: state });
  assert.equal(more.messages[0].catalogProductId, 'imo:filaretti:4');
  const gallery = parseCatalogSalesReply(JSON.stringify({ ...selection, text: 'Quer combinar uma visita com um corretor?', catalogAction: 'products', productIds: ['imo:filaretti:2'] }), catalog);
  assert.equal(gallery.messages.length, 2);
  assert.ok(gallery.messages.every(part => part.imageUrl.includes('/2/')));
  assert.match(gallery.messages.at(-1).text, /visita/u);
  assert.doesNotMatch(gallery.messages.map(part => part.text).join(' '), /vendedor|veículo|simulação/u);
  assert.equal(normalizeWebsiteInteraction(gallery.messages.at(-1).websiteInteraction).step, 'gallery');
  assert.equal(normalizeWebsiteInteraction({ step: 'finance_accepted', productIds: ['imo:filaretti:2'] }), null);
});
