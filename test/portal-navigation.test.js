import test from 'node:test';
import assert from 'node:assert/strict';
import { portalRoute, actionLink, createRequestScope } from '../portal/navigation.js';

const aurora = '018f610d-e7b2-4ce5-891f-0dac85ab464a';
const horizonte = '018f610d-e7b2-4ce5-891f-0dac85ab464b';
const token = 'synthetic_token-'.repeat(3).slice(0, 43);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const abortError = (error) => error?.name === 'AbortError';

test('portal aceita lista e links internos de empresas sem selecionar automaticamente uma empresa', () => {
  assert.deepEqual(portalRoute(), { hash: '#/companies', companyId: null });
  assert.deepEqual(portalRoute('#/companies'), { hash: '#/companies', companyId: null });
  for (const id of [aurora, horizonte]) {
    assert.deepEqual(portalRoute(`#/companies/${id}`), { hash: `#/companies/${id}`, companyId: id });
  }
});

test('retorno ao portal recusa URL externa, travessia, query e caminhos administrativos', () => {
  for (const value of [
    'https://evil.example/', '//evil.example/', '#//evil.example/', '/panel/', '#/panel/',
    `#/companies/${aurora}/../${horizonte}`, `#/companies/${aurora}/`,
    `#/companies/${aurora}?return=https://evil.example/`, `#/companies/${aurora}#fragment`,
    `#/companies/%2f${aurora}`, '#/companies/not-a-uuid', '#/companies/<script>',
    `#/companies/${aurora}\n`, '#/companies/../../api/admin',
  ]) assert.equal(portalRoute(value), null, value);
});

test('links de ativação, reset e verificação mantêm finalidade e token próprios', () => {
  assert.equal(token.length, 43);
  for (const purpose of ['activate', 'reset', 'verify']) {
    assert.deepEqual(actionLink(`#${purpose}=${token}`), { purpose, token });
  }
});

test('links desconhecidos ou malformados não iniciam operação de conta', () => {
  for (const value of [
    '', '#/companies', `#invite=${token}`, `#transfer=${token}`, '#activate=',
    `#activate=${token.slice(1)}`, `#reset=${token}x`, '#verify=<script>',
    `#activate=${'a'.repeat(42)}%2F`,
  ]) assert.equal(actionLink(value), null, value);
});

test('troca de empresa cancela todas as leituras anteriores e permite novas requisições', () => {
  const scope = createRequestScope();
  const auroraSummary = scope.capture();
  const auroraCapabilities = scope.capture();
  assert.equal(auroraSummary.signal.aborted, false);
  scope.reset();
  assert.equal(auroraSummary.signal.aborted, true);
  assert.equal(auroraCapabilities.signal.aborted, true);
  assert.throws(() => auroraSummary.check(), abortError);
  assert.throws(() => auroraCapabilities.check(), abortError);
  const horizonteSummary = scope.capture();
  assert.equal(horizonteSummary.signal.aborted, false);
  assert.doesNotThrow(() => horizonteSummary.check());
});

test('resposta concluída antes de abortar continua inválida após troca de empresa', async () => {
  const scope = createRequestScope();
  const request = scope.capture();
  const body = deferred();
  const load = (async () => {
    request.check();
    const value = await body.promise;
    request.check();
    return value;
  })();
  scope.reset();
  body.resolve({ id: aurora, name: 'Aurora Serviços Demo' });
  await assert.rejects(load, abortError);
  assert.doesNotThrow(() => scope.capture().check());
});

test('erro tardio de sessão anterior não é autorizado a substituir sessão atual', async () => {
  const scope = createRequestScope();
  const previousSession = scope.capture();
  const response = deferred();
  const checkFailure = (async () => {
    try { await response.promise; }
    catch (error) { previousSession.check(); throw error; }
  })();
  scope.reset();
  const currentSession = scope.capture();
  response.reject(Object.assign(new Error('Sessão anterior expirada'), { status: 401 }));
  await assert.rejects(checkFailure, abortError);
  assert.doesNotThrow(() => currentSession.check());
});

test('logout e navegações sucessivas não tornam válido nenhum escopo antigo', () => {
  const scope = createRequestScope();
  const previous = [];
  for (let index = 0; index < 5; index++) {
    previous.push(scope.capture());
    scope.reset();
  }
  for (const request of previous) {
    assert.equal(request.signal.aborted, true);
    assert.throws(() => request.check(), abortError);
  }
  assert.doesNotThrow(() => scope.capture().check());
});
