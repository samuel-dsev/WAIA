import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogSalesFormat, parseCatalogSalesReply, normalizeCatalogBrowseState } from '../src/modules/business/catalog-sales.js';
import { parseCommercialInterest } from '../src/modules/business/commercial-interest.js';
import { customerNameTurn } from '../src/modules/ai/customer-name-turn.js';

const filters = (extra = {}) => ({ category: null, minPrice: null, maxPrice: null, models: [], minYear: null, maxYear: null, ...extra });
const item = (id, name, year, price = 50000) => ({ id: `turim:${id}`, name, year, price, active: true, availability: 'available' });
const items = [item(1, 'Chevrolet Onix Joy', 2019, 55900), item(2, 'Toyota Etios', 2017, 49000), item(3, 'Volkswagen Polo Track', 2018, 50000),
  item(4, 'Chevrolet Tracker', 2008, 45900), item(5, 'Jeep Compass Longitude', 2023, 139900), item(6, 'Jeep Compass Sport', 2018, 99000),
  item(7, 'Chevrolet Onix', 2017, 49500), item(8, 'Chevrolet Onix', null, 48000)];
const catalog = (extra = {}) => ({ source: { type: 'website_catalog', status: 'healthy' }, salesMode: true, items, ...extra });
const output = (query, action = 'browse', text = 'Estas são as opções dessa busca. Gostaria de mais detalhes?') => JSON.stringify({ text, catalogAction: action, productIds: [], filters: query });
const ids = (reply) => reply.messages?.[0].websiteInteraction.productIds;
const options = (message) => ({ contextualServiceEnabled: true, leadQualificationEnabled: true, message });

test('busca combina modelos alternativos com ano e orçamento sem mostrar estoque alheio', () => {
  const query = filters({ models: ['Ônix', 'Etios'], minYear: 2017, maxYear: 2018, maxPrice: 50000 });
  const reply = parseCatalogSalesReply(output(query), catalog(), options('Tem Onix ou Etios 2017/2018 até 50 mil?'));
  assert.deepEqual(ids(reply), ['turim:2', 'turim:7']);
  assert.doesNotMatch(reply.text, /Tracker|Compass|2019/u);
  assert.deepEqual(normalizeCatalogBrowseState({ filters: reply.catalogBrowse.filters, seenProductIds: ids(reply) }).filters, query);
});

test('Polo Track não vira Tracker; ano desconhecido não satisfaz intervalo', () => {
  const reply = parseCatalogSalesReply(output(filters({ models: ['Polo Track'] })), catalog(), options('Ou Polo Track'));
  assert.deepEqual(ids(reply), ['turim:3']); assert.doesNotMatch(reply.text, /Tracker/u);
  const dated = parseCatalogSalesReply(output(filters({ models: ['Onix'], minYear: 2017, maxYear: 2020 })), catalog(), options('Onix de 2017 a 2020'));
  assert.deepEqual(ids(dated), ['turim:1', 'turim:7']);
});

test('busca por nome mantém orçamento anterior; mudança explícita o substitui', () => {
  const stock = catalog({ browseState: { filters: filters({ maxPrice: 50000 }), seenProductIds: [] } });
  const query = filters({ models: ['Onix', 'Etios', 'Polo'] });
  assert.deepEqual(ids(parseCatalogSalesReply(output(query), stock, options('Busco Onix, Etios, Polo'))), ['turim:2', 'turim:3', 'turim:7']);
  const changed = parseCatalogSalesReply(output({ ...query, maxPrice: 60000 }), stock, options('Agora pode ser até 60 mil para Onix, Etios ou Polo'));
  assert.deepEqual(ids(changed), ['turim:1', 'turim:2', 'turim:3']);
  assert.equal(changed.catalogBrowse.filters.maxPrice, 60000);
});

test('busca geral pagina três por vez e mais opções mantém modelo e ano', () => {
  const first = parseCatalogSalesReply(output(filters()), catalog(), options('Mostre os modelos'));
  assert.equal(ids(first).length, 3);
  const stock = catalog({ browseState: { filters: filters({ models: ['Onix'], maxYear: 2019 }), seenProductIds: ['turim:1'] } });
  const next = parseCatalogSalesReply(output(filters(), 'more'), stock, options('Mais opções'));
  assert.deepEqual(ids(next), ['turim:7']); assert.equal(next.catalogBrowse.filters.maxYear, 2019);
});

test('modelo ou ano omitido e comparação relativa inválida bloqueiam lista geral', () => {
  for (const [message, query] of [['Tem Onix ou Etios?', filters()], ['Carros 2017/2018?', filters()], ['Compass mais antigo', filters({ models: ['Compass'] })]]) {
    assert.throws(() => parseCatalogSalesReply(output(query), catalog({ interaction: { step: 'discussion', productIds: ['turim:5'] } }), options(message)), { code: 'AI_INVALID_CATALOG_SELECTION' });
  }
  const older = parseCatalogSalesReply(output(filters({ models: ['Compass'], maxYear: 2022 })), catalog({ interaction: { step: 'discussion', productIds: ['turim:5'] } }), options('Compass mais antigo'));
  assert.deepEqual(ids(older), ['turim:6']);
});

test('modelo ausente nunca libera lista geral e resposta sem estoque permanece textual', () => {
  const stock = catalog({ items: items.filter((value) => !value.name.includes('Etios')) });
  assert.throws(() => parseCatalogSalesReply(output(filters()), stock, options('Tem Etios?')), { code: 'AI_INVALID_CATALOG_SELECTION' });
  const missing = parseCatalogSalesReply(output(filters({ models: ['Etios'] })), stock, options('Tem Etios?'));
  assert.match(missing.text, /^Não encontrei Etios/u);
  assert.match(missing.text, /Como alternativas/u); assert.equal(missing.messages, undefined);
  assert.ok(missing.websiteInteraction.productIds.length <= 3);
  const answer = parseCatalogSalesReply(JSON.stringify({ text: 'Não temos Etios no estoque atual. Posso procurar outras opções dentro do seu orçamento?', catalogAction: 'none', productIds: [], filters: filters() }), stock, options('Tem Etios?'));
  assert.equal(answer.messages, undefined); assert.doesNotMatch(answer.text, /Tracker|Compass|Onix/u);
});

test('novos filtros são estritos e preservam contrato anterior de planilhas', () => {
  const schema = catalogSalesFormat(catalog()).schema.properties.filters;
  assert.ok(schema.required.includes('models')); assert.ok(schema.required.includes('maxYear'));
  assert.deepEqual(catalogSalesFormat(catalog({ source: { type: 'google_sheets', status: 'healthy' } })).schema.properties.filters.required, ['category', 'minPrice', 'maxPrice']);
  for (const query of [filters({ models: [''] }), filters({ minYear: 2020, maxYear: 2017 }), filters({ maxYear: 2020.5 }), { ...filters(), unknown: true }]) {
    assert.throws(() => parseCatalogSalesReply(output(query), catalog(), options('Mostre os modelos')), { code: 'AI_INVALID_CATALOG_SELECTION' });
  }
});

test('confirmação comercial exige fonte original, oferta correta e ausência de recusa posterior', () => {
  const original = 'Quero negociar o Onix.';
  const confirmed = { status: 'confirmed', interestEvidence: original, offerEvidence: null, consentEvidence: original };
  assert.equal(parseCommercialInterest(confirmed, [{ role: 'user', content: original }]), true);
  for (const transcript of [[{ role: 'assistant', content: original }], [{ role: 'user', content: `Olá\n[Em resposta à mensagem: ${original}]` }], [{ role: 'user', content: original }, { role: 'user', content: 'Não quero mais contato de vendedor.' }]]) {
    assert.throws(() => parseCommercialInterest(confirmed, transcript), { code: 'AI_INVALID_CUSTOMER_SERVICE' });
  }
  const consent = 'Sim';
  const offer = 'Quer uma simulação para o Onix? O vendedor pode ajudar.';
  assert.throws(() => parseCommercialInterest({ ...confirmed, offerEvidence: offer, consentEvidence: consent }, [{ role: 'user', content: original }, { role: 'assistant', content: offer }, { role: 'user', content: consent }]), { code: 'AI_INVALID_CUSTOMER_SERVICE' });
});

test('nome em bloco é apenas pista literal e não incorpora cidade, pergunta ou citação', () => {
  const question = 'Para finalizar, como posso te chamar?';
  assert.deepEqual(customerNameTurn(question, [{ content: 'Sérgio\nSou de Roseira\nVcs são de onde' }]), ['Sérgio']);
  assert.deepEqual(customerNameTurn(question, [{ content: 'Bom dia\n[Em resposta à mensagem: Sérgio]' }]), []);
  assert.deepEqual(customerNameTurn('Qual carro?', [{ content: 'Sérgio' }]), []);
});
