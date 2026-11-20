import { realEstateCatalogFromCache } from '../../src/integrations/real-estate-catalog/source.js';

export const propertyItem = (reference = 1, extra = {}) => ({
  id: `imo:filaretti:${reference}`, reference: String(reference), name: `Casa teste ${reference}`,
  url: `https://filaretti.com.br/imovel/taubate/venda/casa/casa-teste/${reference}`,
  propertyType: 'casa', propertySubtype: 'casa', category: 'casa', city: 'Taubaté', neighborhood: 'Centro',
  operations: ['sale', 'rent'], salePrice: 500000, rentPrice: 2500, seasonalPrice: null, price: null,
  bedrooms: 3, parkingSpaces: 2, totalArea: 125, description: 'Casa com quintal.', features: ['Quintal'],
  imageUrl: `https://midia.imo.etc.br/filaretti/imoveis/${reference}/101-grande.jpg`,
  imageUrls: [101, 102].map(id => `https://midia.imo.etc.br/filaretti/imoveis/${reference}/${id}-grande.jpg`),
  availability: 'available', active: true, ...extra,
});
export const propertySnapshot = (...items) => ({ profile: 'real_estate_catalog', schemaVersion: 1, products: items });
export const propertyCatalog = (...items) => realEstateCatalogFromCache({ status: 'saudavel', last_success_at: new Date(), cache_snapshot: propertySnapshot(...items) });
