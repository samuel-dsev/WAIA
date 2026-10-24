const companyRoute = /^#\/companies\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;

export function portalRoute(value = '') {
  if (value === '' || value === '#/companies') return { hash: '#/companies', companyId: null };
  const match = companyRoute.exec(value);
  return match ? { hash: `#/companies/${match[1]}`, companyId: match[1] } : null;
}
export function actionLink(hash) {
  const params = new URLSearchParams(hash.slice(1));
  for (const purpose of ['activate', 'reset', 'verify']) {
    const token = params.get(purpose);
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) return { purpose, token };
  }
  return null;
}
// Aborting alone is insufficient: a response may have completed before abort().
export function createRequestScope() {
  let controller = new AbortController(), epoch = 0;
  return {
    reset() { controller.abort(); controller = new AbortController(); epoch++; },
    capture() {
      const current = epoch;
      return { signal: controller.signal, check() {
        if (current !== epoch) throw new DOMException('Navegação substituída.', 'AbortError');
      } };
    },
  };
}
