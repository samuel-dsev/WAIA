const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('Campo imobiliário inválido.');
  return value.trim();
};
export function propertyFacts(value) {
  if (!/^imo:filaretti:[1-9]\d*$/u.test(value.id) || value.reference !== value.id.split(':').at(-1)) throw new TypeError('Referência imobiliária inválida.');
  if (!Array.isArray(value.operations) || !value.operations.length || value.operations.length > 3
    || new Set(value.operations).size !== value.operations.length || value.operations.some(item => !['sale', 'rent', 'seasonal'].includes(item))) throw new TypeError('Finalidade imobiliária inválida.');
  const result = { reference: text(value.reference, 20), propertyType: text(value.propertyType, 100),
    propertySubtype: text(value.propertySubtype, 100), city: text(value.city, 100), neighborhood: value.neighborhood ? text(value.neighborhood, 150) : '',
    operations: [...value.operations], salePrice: null, rentPrice: null, seasonalPrice: null };
  for (const key of ['salePrice', 'rentPrice', 'seasonalPrice', 'bedrooms', 'suites', 'bathrooms', 'parkingSpaces', 'totalArea', 'builtArea', 'propertyTax', 'condominiumFee']) {
    if (value[key] == null) continue;
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1e9) throw new TypeError('Valor imobiliário inválido.');
    if (['bedrooms', 'suites', 'bathrooms', 'parkingSpaces'].includes(key) && (!Number.isSafeInteger(value[key]) || value[key] > 1000)) throw new TypeError('Quantidade imobiliária inválida.');
    result[key] = value[key];
  }
  if (value.propertyTaxPeriod != null) {
    if (!['monthly', 'annual'].includes(value.propertyTaxPeriod)) throw new TypeError('Periodicidade do IPTU inválida.');
    result.propertyTaxPeriod = value.propertyTaxPeriod;
  }
  if (value.features != null) {
    if (!Array.isArray(value.features) || value.features.length > 100) throw new TypeError('Características imobiliárias inválidas.');
    result.features = value.features.map(item => text(item, 500));
  }
  if (value.galleryTruncated != null) {
    if (value.galleryTruncated !== true || !Number.isSafeInteger(value.sourcePhotoCount) || value.sourcePhotoCount <= 100 || value.sourcePhotoCount > 100_000) throw new TypeError('Contagem de imagens inválida.');
    result.galleryTruncated = true; result.sourcePhotoCount = value.sourcePhotoCount;
  }
  return result;
}
