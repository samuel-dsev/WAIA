import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalTestPreview, localAccessDocument, localMailDocument, localMfaCode,
  LOCAL_TEST_CONTAINER, LOCAL_TEST_NETWORK, LOCAL_TEST_ORIGIN } from '../src/operations/local-test-access.js';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
function preview() {
  return {
    Name: `/${LOCAL_TEST_CONTAINER}`, State: { Running: true },
    Config: { Labels: { 'waia.preview': 'v2-local' }, Env: [
      'NODE_ENV=development', 'ACCOUNT_EMAIL_MODE=fake',
      'DATABASE_URL=postgres://waia_v2_app:infrastructure-secret@v2-postgres:5432/waia_v2_app',
      `CUSTOMER_PORTAL_ORIGIN=${LOCAL_TEST_ORIGIN}`, `PANEL_ORIGIN=${LOCAL_TEST_ORIGIN}`,
    ] },
    NetworkSettings: { Networks: { [LOCAL_TEST_NETWORK]: {} } },
  };
}
const network = () => ({ Name: LOCAL_TEST_NETWORK, Internal: true });
const mail = (purpose = 'activate') => ({ to: 'ana.demo@waia.example', purpose,
  idempotencyKey: 'synthetic-message', url: `${LOCAL_TEST_ORIGIN}/portal/#${purpose}=${'a'.repeat(43)}` });

test('helper só admite preview fictício ativo, development/fake, DB e rede interna próprios', () => {
  const accepted = assertLocalTestPreview(preview(), network());
  assert.deepEqual(accepted, { container: LOCAL_TEST_CONTAINER, origin: LOCAL_TEST_ORIGIN });
  assert.doesNotMatch(JSON.stringify(accepted), /infrastructure-secret|DATABASE_URL/u);
  for (const mutate of [
    value => { value.Name = '/waia-prod-api-1'; },
    value => { value.State.Running = false; },
    value => { value.Config.Labels['waia.preview'] = 'production'; },
    value => { value.Config.Env[0] = 'NODE_ENV=production'; },
    value => { value.Config.Env[1] = 'ACCOUNT_EMAIL_MODE=http'; },
    value => { value.Config.Env[2] = 'DATABASE_URL=postgres://waia_v2_app:synthetic@v2-postgres:5432/waia'; },
    value => { value.Config.Env[2] = 'DATABASE_URL=postgres://waia_v2_app:synthetic@production:5432/waia_v2_app'; },
    value => { value.Config.Env[2] = 'DATABASE_URL=postgres://waia_v2_owner:synthetic@v2-postgres:5432/waia_v2_app'; },
    value => { value.Config.Env[3] = 'CUSTOMER_PORTAL_ORIGIN=https://real.example'; },
    value => { value.Config.Env.push('ACCOUNT_EMAIL_MODE=fake'); },
    value => { value.NetworkSettings.Networks.egress = {}; },
    value => { value.HostConfig = { PortBindings: { '3001/tcp': [{ HostIp: '0.0.0.0', HostPort: '3001' }] } }; },
    value => { value.NetworkSettings.Networks = { bridge: {} }; },
  ]) {
    const value = preview(); mutate(value);
    assert.throws(() => assertLocalTestPreview(value, network()), /Dados locais de teste inválidos/u);
  }
  assert.throws(() => assertLocalTestPreview(preview(), { ...network(), Internal: false }));
  assert.throws(() => assertLocalTestPreview(preview(), { ...network(), Name: 'production' }));
});

test('arquivo de acessos copia apenas senhas sintéticas salvas e MFA existente, sem infraestrutura/cookies/recovery codes', () => {
  const inputs = { bootstrap: 'NODE_ENV=development\nMASTER_KEYRING=never-export-infra\nSESSION_PEPPER=never-export-pepper\nV2_PREVIEW_ADMIN_PASSWORD=existing_admin_password_1234\n',
    users: { 'ana.demo@waia.example': 'existing_customer_password_1234' },
    mfa: { secret, recoveryCodes: ['never-export-recovery'], cookies: ['never-export-cookie'] } };
  const before = structuredClone(inputs);
  const output = localAccessDocument(inputs);
  assert.match(output.text, /existing_admin_password_1234/u);
  assert.match(output.text, /existing_customer_password_1234/u);
  assert.ok(output.text.includes(secret));
  assert.match(output.otpUri, /^otpauth:\/\/totp\/WAIA:/u);
  assert.doesNotMatch(output.text, /never-export|MASTER_KEYRING|SESSION_PEPPER/u);
  assert.match(output.text, /não redefine senhas, MFA, identidades ou permissões/u);
  assert.deepEqual(inputs, before);
});

test('handoff recusa identidades reais e injeção Markdown/senha/chave MFA sem refletir valores no erro', () => {
  const valid = { bootstrap: 'V2_PREVIEW_ADMIN_PASSWORD=existing_admin_password_1234\n',
    users: { 'ana.demo@waia.example': 'existing_customer_password_1234' }, mfa: { secret } };
  for (const mutate of [
    value => { value.users = { 'ana@customer.com': 'existing_customer_password_1234' }; },
    value => { value.users = { 'ana@waia.example\n[attack](https://evil.test)': 'existing_customer_password_1234' }; },
    value => { value.users['ana.demo@waia.example'] = 'password`\n<script>alert(1)</script>'; },
    value => { value.bootstrap += 'V2_PREVIEW_ADMIN_PASSWORD=duplicate_password_1234\n'; },
    value => { value.mfa.secret = '[malicious](https://evil.test)'; },
  ]) {
    const value = structuredClone(valid); mutate(value);
    assert.throws(() => localAccessDocument(value), error => {
      assert.equal(error.message, 'Dados locais de teste inválidos; nenhum valor foi exportado.');
      return true;
    });
  }
});

test('caixa fake exporta somente links locais canônicos com finalidade e token correspondentes', () => {
  const messages = ['activate', 'reset', 'verify'].map(purpose => mail(purpose));
  messages.push({ to: 'admin.local@waia.example', purpose: 'mfa_changed' });
  messages.push({ to: 'ana.demo@waia.example', purpose: 'password_changed' });
  const copy = structuredClone(messages), document = localMailDocument(messages);
  assert.equal((document.match(/\[Abrir link local\]/gu) || []).length, 3);
  assert.ok(document.includes(mail().url));
  assert.doesNotMatch(document, /mfa_changed|password_changed|synthetic-message/u);
  assert.match(document, /Nenhum e-mail real foi enviado/u);
  assert.deepEqual(messages, copy);
  assert.match(localMailDocument([]), /Nenhum link/u);
});

test('caixa fake recusa destinatário real, origem remota, credenciais URL e caminhos/tokens adulterados', () => {
  for (const value of [
    { ...mail(), to: 'ana@customer.com' }, { ...mail(), to: 'ana@waia.invalid' },
    { ...mail(), url: 'javascript:alert(1)' },
    { ...mail(), url: mail().url.replace('127.0.0.1', 'attacker.example') },
    { ...mail(), url: mail().url.replace('127.0.0.1', '127.0.0.1.attacker.example') },
    { ...mail(), url: mail().url.replace('http://', 'http://name:password@') },
    { ...mail(), url: mail().url.replace('/portal/', '/panel/') },
    { ...mail(), url: mail().url.replace('/portal/', '/other/../portal/') },
    { ...mail(), url: mail().url.replace('/portal/', '/portal/?next=https://evil.test') },
    { ...mail(), url: mail().url.replace('#activate=', '#reset=') },
    { ...mail(), url: `${mail().url}&next=evil` },
    { ...mail(), purpose: 'unknown' }, { ...mail(), body: 'unexpected personal content' },
    { to: 'ana.demo@waia.example', purpose: 'mfa_changed', url: mail().url },
  ]) assert.throws(() => localMailDocument([value]), /Dados locais de teste inválidos/u);
});

test('TOTP local usa vetor RFC, expiração correta e não altera a chave persistida', () => {
  const code = localMfaCode(secret, new Date(59_000));
  assert.deepEqual(code, { code: '287082', expiresAt: new Date(60_000).toISOString() });
  assert.notEqual(localMfaCode(secret, new Date(60_000)).code, code.code);
  for (const invalid of ['secret\n', 'x'.repeat(32), '', undefined]) assert.throws(() => localMfaCode(invalid));
  assert.throws(() => localMfaCode(secret, 'invalid-date'));
});
