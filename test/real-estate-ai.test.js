import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAiConfigResolver, MemoryAiLedger, MemoryAiSecretResolver, MemoryPricingCatalog,
  MemoryResponsesClientFactory, MultiTenantAiService } from '../src/modules/ai/index.js';
import { EMPTY_PROPERTY_FILTERS } from '../src/modules/business/real-estate-catalog.js';
import { catalogAdContext } from '../src/modules/whatsapp/ad-referral.js';
import { propertyItem, propertyCatalog } from './support/real-estate-fixtures.js';

const catalog = { ...propertyCatalog(propertyItem(1), propertyItem(2)), salesMode: true };
const collecting = { status: 'collecting', name: null, summary: null, qualification: null };
function service(output, history = []) {
  const factory = new MemoryResponsesClientFactory(async () => ({ output_text: JSON.stringify(output), usage: { input_tokens: 10, output_tokens: 10 } }));
  const ai = new MultiTenantAiService({
    configResolver: new MemoryAiConfigResolver([{ empresaId: 'test', enabled: true, provider: 'openai', model: 'test', keyType: 'shared',
      prompt: 'Você é uma assistente imobiliária. Não confirme visitas; encaminhe ao corretor.',
      contextualServiceEnabled: true, leadQualificationEnabled: true, leadQualificationCriteria: 'Nome e pedido ou aceite explícito de visita.',
      allowedContextKeys: ['catalog'], version: 2, maxOutputTokens: 1200 }]),
    conversationService: { async getHistory() { return history; } }, clientFactory: factory,
    secretResolver: new MemoryAiSecretResolver({ sharedSecret: 'synthetic' }), ledger: new MemoryAiLedger(),
    pricingCatalog: new MemoryPricingCatalog({ test: { inputPerMillion: 1, outputPerMillion: 1, version: 'test' } }), logger: { warn() {}, info() {} },
  });
  return { ai, factory };
}
const output = (action, text, ids = [], filters = EMPTY_PROPERTY_FILTERS, leadQualification = collecting) => ({ text, catalogAction: action, productIds: ids, filters, leadQualification });
const request = message => ({ empresaId: 'test', conversationId: 'chat', correlationId: 'c', messageId: 'current', message, context: { catalog } });

test('IA imobiliária: schema próprio, contexto factual sem URLs das fotos e busca de aluguel', async () => {
  const { ai, factory } = service(output('browse', 'Algum chamou sua atenção?', [], { ...EMPTY_PROPERTY_FILTERS, operation: 'rent', city: 'Taubaté', maxPrice: 2600 }));
  const result = await ai.reply(request('Quero opções para alugar em Taubaté até 2600'));
  assert.equal(result.source, 'ai'); assert.equal(result.messages.length, 3);
  assert.match(result.messages[0].text, /Aluguel mensal: R\$\s*2\.500,00/u);
  assert.doesNotMatch(result.messages[0].text, /500\.000/u);
  const call = factory.requests[0].request;
  assert.match(call.instructions, /CATÁLOGO IMOBILIÁRIO VALIDADO/u);
  assert.ok(!call.text.format.schema.properties.catalogAction.enum.includes('finance'));
  assert.doesNotMatch(JSON.stringify(call.input), /101-grande\.jpg/u);
  assert.match(JSON.stringify(call.input), /photoCount/u);
  assert.equal(result.leadQualification, undefined);
});

test('IA imobiliária: pedido explícito de fotos envia somente a galeria escolhida', async () => {
  const { ai } = service(output('products', 'Gostou e tem interesse em uma visita com um corretor?', [propertyItem(2).id]));
  const result = await ai.reply(request('Envie as fotos da casa referência 2'));
  assert.equal(result.source, 'ai'); assert.equal(result.messages.length, 2);
  assert.ok(result.messages.every(part => part.imageUrl.includes('/2/')));
  assert.match(result.messages.at(-1).text, /visita/u);
  assert.equal(result.leadQualification, undefined);
});

test('IA imobiliária: galeria sem consentimento não dispara fotos nem qualifica', async () => {
  const { ai, factory } = service(output('products', 'Quer uma visita?', [propertyItem(1).id]));
  const result = await ai.reply(request('Qual é o valor da casa referência 1?'));
  assert.equal(factory.requests.length, 2); assert.equal(result.source, 'fallback');
  assert.equal(result.messages, undefined); assert.equal(result.leadQualification, undefined);
});

test('anúncio imobiliário: referência é cruzada com catálogo atual e não consulta URL enviada', () => {
  const ad = catalogAdContext({ sourceUrl: 'https://untrusted.test', body: 'Casa REF #2 em Taubaté' }, catalog, { current: true });
  assert.equal(ad.productId, propertyItem(2).id);
  const missing = catalogAdContext({ body: 'Imóvel referência 999' }, catalog, { current: true });
  assert.equal(missing.productId, null);
  assert.equal(catalogAdContext({ body: 'REF #1 e REF #2' }, catalog).match, 'ambiguous');
});
