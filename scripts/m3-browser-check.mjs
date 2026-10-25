import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { totp } from '../src/modules/auth/totp.js';

// Opt-in E2E for the existing loopback-only v2 preview. All provision writes use UI.
const origin = 'http://127.0.0.1:5035';
const modulePath = process.argv[2];
const { chromium } = modulePath ? await import(pathToFileURL(modulePath).href) : await import('playwright');
const decode32 = (s) => {
  let bits = 0, value = 0; const result = [];
  for (const c of s) { value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c); bits += 5;
    if (bits >= 8) { bits -= 8; result.push((value >>> bits) & 255); } }
  return Buffer.from(result);
};
const code = (secret) => totp(decode32(secret), Math.floor(Date.now() / 30000));
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, 'Operação local do preview falhou.'); return result.stdout;
}
const preview = JSON.parse(docker(['inspect', 'waia-test-v2-preview']))[0];
assert.equal(preview.Config.Labels['waia.preview'], 'v2-local');
assert.deepEqual(Object.keys(preview.NetworkSettings.Networks), ['waia-test_v2_internal']);
assert.equal(JSON.parse(docker(['network', 'inspect', 'waia-test_v2_internal']))[0].Internal, true);
const settings = Object.fromEntries(preview.Config.Env.map((entry) => { const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]; }));
assert.equal(settings.NODE_ENV, 'development'); assert.equal(settings.ACCOUNT_EMAIL_MODE, 'fake');
assert.equal(new URL(settings.DATABASE_URL).pathname, '/waia_v2_app');
assert.equal(new URL(settings.DATABASE_URL).hostname, 'v2-postgres');
const proof = [], errors = [];
const usersFile = '.secrets/v2-m3-users.json';
const credentials = existsSync(usersFile) ? JSON.parse(readFileSync(usersFile, 'utf8')) : {};
const passwordFor = (email) => {
  if (!credentials[email]) { credentials[email] = randomBytes(24).toString('base64url');
    writeFileSync(usersFile, JSON.stringify(credentials), { mode: 0o600 }); }
  return credentials[email];
};
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
let stage = 'admin', diagnosticPage;
try {
  const state = '.secrets/v2-m3-admin-browser.json';
  const admin = await browser.newContext(existsSync(state) && !process.argv.includes('--fresh-admin-session') ? { storageState: state } : {});
  const panel = await admin.newPage(); diagnosticPage = panel; panel.on('pageerror', (error) => errors.push(error.message));
  panel.on('response', async (response) => {
    if (response.status() < 400 || !response.url().includes('/api/admin/')) return;
    const body = await response.json().catch(() => ({}));
    const code = body.code || body.error?.code;
    console.log(JSON.stringify({ stage: 'admin-response', status: response.status(), code: /^[A-Z_]+$/.test(code || '') ? code : 'UNKNOWN',
      path: new URL(response.url()).pathname.replace(/[0-9a-f-]{36}/gi, ':id') }));
  });
  await panel.goto(`${origin}/panel/`);
  const session = await panel.request.get(`${origin}/api/admin/session`);
  if (session.status() !== 200) {
    const password = readFileSync('.secrets/v2-preview-bootstrap.env', 'utf8').match(/V2_PREVIEW_ADMIN_PASSWORD=(.+)/)[1].trim();
    const mfa = JSON.parse(readFileSync('.secrets/v2-preview-admin-mfa.json', 'utf8'));
    await panel.locator('#loginEmail').fill('admin.local@waia.example'); await panel.locator('#loginPassword').fill(password);
    await panel.locator('#loginForm button').click(); await panel.locator('#mfaLoginCode').fill(code(mfa.secret));
    await panel.locator('#mfaLoginForm button[type=submit]').click();
  }
  await panel.locator('#appShell').waitFor({ state: 'visible' });
  await panel.locator('#tenantSelect option').first().waitFor({ state: 'attached' });
  const companyNames = ['Aurora Serviços Demo', 'Horizonte Comércio Demo', 'Vale Atendimento Demo'];
  const ids = {};
  for (const name of companyNames) {
    stage = `empresa ${name}`; console.log(stage);
    await panel.locator('[data-view=companies]').click();
    if (!await panel.locator('#tenantSelect option').filter({ hasText: name }).count()) {
      await panel.getByRole('button', { name: 'Nova empresa', exact: true }).click();
      await panel.locator('#dynamic-name').fill(name); await panel.locator('#dynamic-identity').fill(name);
      const saved = panel.waitForResponse((r) => r.url().endsWith('/api/admin/tenants') && r.request().method() === 'POST');
      await panel.locator('#detailDialog').getByRole('button', { name: 'Salvar', exact: true }).click();
      assert.equal((await saved).status(), 201);
      await panel.locator('#detailDialog').waitFor({ state: 'hidden' });
    }
    await panel.locator('#tenantSelect option').filter({ hasText: name }).waitFor({ state: 'attached' });
    ids[name] = await panel.locator('#tenantSelect option').filter({ hasText: name }).getAttribute('value');
  }
  await panel.locator('#tenantSelect').selectOption('');
  const dataset = [
    ['Ana Demo', 'ana.demo@waia.example', companyNames.slice(0, 2)],
    ['Bia Demo', 'bia.demo@waia.example', companyNames.slice(0, 1)],
    ['Caio Demo', 'caio.demo@waia.example', companyNames.slice(2)],
    ['Sem Empresa Demo', 'semempresa.demo@waia.example', []],
    ['Acesso Suspenso Demo', 'suspenso.demo@waia.example', companyNames.slice(0, 1)],
  ];
  const pendingEmails = new Set();
  for (const [name, email, companies] of dataset) {
    stage = `acesso ${name}`; console.log(stage); passwordFor(email);
    await panel.locator('[data-view=accessUsers]').click();
    await panel.getByRole('button', { name: 'Novo acesso', exact: true }).waitFor({ state: 'visible' });
    const existing = panel.getByRole('button', { name: `Gerenciar acesso de ${name}`, exact: true });
    const dialog = panel.locator('.access-dialog');
    if (await existing.count()) {
      // Later phases may have changed capabilities deliberately. Reuse the
      // existing access through the panel instead of overwriting its grants.
      await existing.click();
    } else {
    await panel.getByRole('button', { name: 'Novo acesso', exact: true }).click();
    await dialog.locator('input[name=name]').fill(name); await dialog.locator('input[name=email]').fill(email);
    for (const company of companies) {
      const choice = dialog.locator('.access-company-choice').filter({ hasText: company });
      await choice.locator('input[name=company]').check();
      if (name === 'Ana Demo') await choice.locator('input[value="attendance.edit"]').check();
    }
    await dialog.getByRole('button', { name: 'Revisar e salvar acesso' }).click(); await panel.locator('#confirmAccept').click();
    const reauth = panel.locator('.access-reauth-dialog');
    // The panel may ask for recent reauthentication before this mutation.
    await Promise.race([dialog.locator('.access-email').waitFor(), reauth.waitFor({ state: 'visible' })]);
    if (await reauth.isVisible()) {
      const password = readFileSync('.secrets/v2-preview-bootstrap.env', 'utf8').match(/V2_PREVIEW_ADMIN_PASSWORD=(.+)/)[1].trim();
      const mfa = JSON.parse(readFileSync('.secrets/v2-preview-admin-mfa.json', 'utf8'));
      await reauth.locator('input[name=password]').fill(password); await reauth.locator('input[name=code]').fill(code(mfa.secret));
      await reauth.getByRole('button', { name: 'Confirmar identidade', exact: true }).click();
    }
    }
    await dialog.locator('.access-email').waitFor();
    if (await dialog.locator('select[name=identityStatus]').inputValue() !== 'ativo') {
      await dialog.locator('select[name=identityStatus]').selectOption('ativo');
      await dialog.getByRole('button', { name: 'Alterar estado global', exact: true }).click(); await panel.locator('#confirmAccept').click();
      await dialog.getByRole('button', { name: 'Fechar', exact: true }).waitFor({ state: 'visible' });
    }
    if ((await dialog.innerText()).includes('Pendente de ativação')) {
      pendingEmails.add(email);
      // A re-used pending identity needs a fresh fake message in this preview process.
      const inbox = spawnSync('docker', ['exec', 'waia-test-v2-preview', 'cat', '/tmp/waia-v2-fake-inbox.json'], { encoding: 'utf8' });
      if (inbox.status !== 0 || !JSON.parse(inbox.stdout).some((message) => message.to === email && message.purpose === 'activate')) {
        await dialog.getByRole('button', { name: 'Enviar ou reenviar ativação', exact: true }).click(); await panel.locator('#confirmAccept').click();
        await dialog.locator('.access-email').waitFor();
      }
    }
    await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();
  }
  await admin.storageState({ path: state });
  proof.push('Dataset 3 empresas e 5 identidades cadastrado/reutilizado pelo painel.');

  async function mailbox(email, purpose) {
    for (let n = 0; n < 25; n++) {
      const result = spawnSync('docker', ['exec', 'waia-test-v2-preview', 'cat', '/tmp/waia-v2-fake-inbox.json'], { encoding: 'utf8' });
      if (result.status === 0) {
        const message = JSON.parse(result.stdout).filter((m) => m.to === email && m.purpose === purpose).at(-1);
        if (message) { assert.equal(new URL(message.url).origin, origin); return message.url; }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Mensagem fake não encontrada.');
  }
  async function login(page, email) {
    await page.locator('#login input[name=email]').fill(email); await page.locator('#login input[name=password]').fill(passwordFor(email));
    const response = page.waitForResponse((r) => r.url().endsWith('/api/account/v1/login') && r.request().method() === 'POST');
    await page.locator('#login button[type=submit],#login button:not([type])').first().click();
    const result = await response;
    if (result.status() === 429) {
      const seconds = Number(result.headers()['retry-after']); assert.ok(seconds > 0 && seconds <= 900);
      console.log(`Limite de login sintético respeitado; aguardando ${seconds}s.`);
      let remaining = seconds * 1000 + 500;
      while (remaining > 0) { const interval = Math.min(30000, remaining); await new Promise((resolve) => setTimeout(resolve, interval)); remaining -= interval; }
      return login(page, email);
    }
    assert.equal([200, 202].includes(result.status()), true, 'Login sintético recusado.');
    if ((await result.json()).mfaRequired) {
      const mfaFile = '.secrets/v2-m3-bia-mfa.json'; const mfa = JSON.parse(readFileSync(mfaFile, 'utf8'));
      assert.equal(email, 'bia.demo@waia.example'); assert.ok(mfa.recoveryCodes.length);
      await page.locator('#mfa input[name=code]').fill(mfa.recoveryCodes.shift());
      const completed = page.waitForResponse((r) => r.url().endsWith('/api/account/v1/mfa/login'));
      await page.locator('#mfa button').first().click(); assert.equal((await completed).status(), 200);
      writeFileSync(mfaFile, JSON.stringify(mfa), { mode: 0o600 });
    }
  }
  async function customer(email) {
    const context = await browser.newContext(); const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/`); await page.locator('#login').waitFor({ state: 'visible' });
    // Check first; only pending synthetic users have an activation mail.
    if (pendingEmails.has(email)) {
      await page.goto(await mailbox(email, 'activate')); await page.locator('#activate').waitFor({ state: 'visible' });
      assert.equal(new URL(page.url()).hash, '');
      await page.locator('#activate input[name=password]').fill(passwordFor(email));
      await page.locator('#activate input[name=confirmation]').fill(passwordFor(email));
      await page.locator('#activate button').first().click(); await page.locator('#login').waitFor({ state: 'visible' });
    }
    await login(page, email); await page.locator('#home').waitFor({ state: 'visible' }); return { context, page };
  }
  stage = 'Ana portal'; const ana = await customer(dataset[0][1]);
  assert.equal(await ana.page.locator('#companies article').count(), 2);
  assert.match(await ana.page.locator('#companies').innerText(), /Aurora Serviços Demo/);
  assert.doesNotMatch(await ana.page.locator('#companies').innerText(), /Vale/);
  await ana.page.getByRole('button', { name: `Abrir atendimento · ${companyNames[0]}`, exact: true }).click();
  await ana.page.locator('#workspace').waitFor({ state: 'visible' });
  assert.equal(await ana.page.locator('#company-name').innerText(), companyNames[0]);
  assert.equal(await ana.page.evaluate(() => document.activeElement.id), 'workspace-name');
  const foreign = await ana.page.request.get(`${origin}/api/app/v1/companies/${ids[companyNames[2]]}`);
  assert.equal(foreign.status(), 404); assert.doesNotMatch(await foreign.text(), /Vale|token|model|provider/i);
  await ana.page.evaluate((id) => { location.hash = `#/companies/${id}`; }, ids[companyNames[2]]);
  await ana.page.locator('#denied').waitFor({ state: 'visible' }); assert.equal(await ana.page.locator('#company-name').textContent(), '');
  await ana.page.locator('#denied [data-home]').click(); await ana.page.locator('#home').waitFor({ state: 'visible' });
  proof.push('Ana: duas empresas, workspace autorizado, 404 alheio e tela neutra.');
  stage = 'Caio e zero'; const caio = await customer(dataset[2][1]);
  assert.equal(await caio.page.locator('#companies article').count(), 1); assert.match(await caio.page.locator('#companies').innerText(), /Vale/);
  const zero = await customer(dataset[3][1]); assert.equal(await zero.page.locator('#companies article').count(), 0);
  assert.match(await zero.page.locator('#companies').innerText(), /administração WAIA/);
  assert.equal(await zero.page.locator('#register,#company-form,#team').count(), 0);
  proof.push('Caio: lista obrigatória com uma empresa; zero vínculo sem criação.');
  stage = 'MFA pessoal';
  const bia = await customer(dataset[1][1]);
  await bia.page.locator('#security-open').click(); await bia.page.locator('#security').waitFor({ state: 'visible' });
  async function background(page, view) {
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.locator(`#${view}`).waitFor({ state: 'visible' });
  }
  if (await bia.page.locator('#mfa-setup').isVisible()) {
    await bia.page.locator('#mfa-setup input').fill(passwordFor(dataset[1][1])); await bia.page.locator('#mfa-setup button').click();
    await bia.page.locator('#mfa').waitFor({ state: 'visible' });
    const secret = (await bia.page.locator('#mfa-secret').innerText()).split('\n').at(-1).trim();
    await background(bia.page, 'mfa'); assert.equal((await bia.page.locator('#mfa-secret').innerText()).includes(secret), true, 'Desafio MFA preservado ao retomar.');
    await bia.page.locator('#mfa input[name=code]').fill(code(secret)); await bia.page.locator('#mfa button').first().click();
    await bia.page.locator('#recovery').waitFor({ state: 'visible' });
    const recoveryCodes = (await bia.page.locator('#recovery-codes').innerText()).trim().split('\n');
    writeFileSync('.secrets/v2-m3-bia-mfa.json', JSON.stringify({ secret, recoveryCodes }), { mode: 0o600 });
    await background(bia.page, 'recovery'); assert.equal((await bia.page.locator('#recovery-codes').innerText()).trim().split('\n').length, recoveryCodes.length);
    await bia.page.locator('#recovery-done').click(); await bia.page.locator('#home').waitFor({ state: 'visible' });
  }
  await bia.page.locator('#logout').click(); await bia.page.locator('#login').waitFor({ state: 'visible' });
  await login(bia.page, dataset[1][1]); await bia.page.locator('#home').waitFor({ state: 'visible' });
  assert.equal(await bia.page.locator('#mfa-secret').textContent(), ''); assert.equal(await bia.page.locator('#recovery-codes').textContent(), '');
  proof.push('MFA pessoal: cadastro, retomada de desafio/códigos ao voltar da aba e login com recuperação.');
  stage = 'recuperação de senha';
  await zero.page.locator('#logout').click(); await zero.page.locator('#login').waitFor({ state: 'visible' });
  await zero.page.getByRole('button', { name: 'Esqueci minha senha' }).click();
  await zero.page.locator('#forgot input').fill(dataset[3][1]); await zero.page.locator('#forgot button').first().click();
  const resetUrl = await mailbox(dataset[3][1], 'reset'); await zero.page.goto(resetUrl);
  await zero.page.locator('#reset').waitFor({ state: 'visible' }); assert.equal(new URL(zero.page.url()).hash, '');
  await zero.page.locator('#reset input[name=password]').fill(passwordFor(dataset[3][1]));
  await zero.page.locator('#reset input[name=confirmation]').fill(passwordFor(dataset[3][1]));
  await zero.page.locator('#reset button').first().click(); await zero.page.locator('#login').waitFor({ state: 'visible' });
  await login(zero.page, dataset[3][1]); await zero.page.locator('#home').waitFor({ state: 'visible' });
  proof.push('Recuperação pelo portal com e-mail fake, token removido da URL e senha definida pelo usuário.');
  stage = 'mobile e edição'; await ana.page.setViewportSize({ width: 390, height: 844 });
  await ana.page.locator('#profile-open').click(); await ana.page.locator('#profile-form input').fill('Nome temporário');
  ana.page.once('dialog', (dialog) => dialog.dismiss()); await ana.page.locator('#profile [data-home]').click();
  assert.equal(await ana.page.locator('#profile').isVisible(), true);
  assert.equal(await ana.page.locator('#profile-form input').inputValue(), 'Nome temporário');
  await ana.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await ana.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await ana.page.locator('#profile').waitFor({ state: 'visible' });
  assert.equal(await ana.page.locator('#profile-form input').inputValue(), 'Nome temporário');
  ana.page.once('dialog', (dialog) => dialog.accept()); await ana.page.locator('#profile [data-home]').click(); await ana.page.locator('#home').waitFor({ state: 'visible' });
  assert.equal(await ana.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  mkdirSync('.tmp/m3', { recursive: true }); await ana.page.screenshot({ path: '.tmp/m3/mobile.png', fullPage: true });
  await ana.page.setViewportSize({ width: 1366, height: 900 });
  await ana.page.getByRole('button', { name: `Abrir atendimento · ${companyNames[1]}`, exact: true }).click();
  await ana.page.locator('#workspace').waitFor({ state: 'visible' }); await ana.page.screenshot({ path: '.tmp/m3/workspace.png', fullPage: true });
  proof.push('390px sem overflow, foco no título, confirmação de descarte e edição preservada ao retomar aba.');
  stage = 'troca durante resposta atrasada';
  for (const lateStatus of [200, 401]) {
    let release, received;
    const held = new Promise((resolve) => { release = resolve; });
    const arrived = new Promise((resolve) => { received = resolve; });
    const pattern = `**/api/app/v1/companies/${ids[companyNames[0]]}`;
    await ana.page.route(pattern, async (request) => {
      const response = await request.fetch(); received(); await held;
      try { await request.fulfill(lateStatus === 200 ? { response } : { status: 401, json: { code: 'SESSION_INVALID', message: 'Resposta antiga' } }); }
      catch { /* Browser request was aborted by navigation. */ }
    });
    await ana.page.evaluate((id) => { location.hash = `#/companies/${id}`; }, ids[companyNames[0]]); await arrived;
    assert.equal(await ana.page.locator('#workspace-name').textContent(), '');
    await ana.page.evaluate((id) => { location.hash = `#/companies/${id}`; }, ids[companyNames[1]]);
    await ana.page.locator('#workspace').waitFor({ state: 'visible' }); release();
    await ana.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await ana.page.locator('#company-name').innerText(), companyNames[1]);
    assert.equal(await ana.page.locator('#login').isVisible(), false);
    await ana.page.unroute(pattern);
  }
  proof.push('Troca com resposta 200/401 retida: cancela leitura anterior, limpa nome e mantém nova empresa.');
  stage = 'deep link após login';
  const deepContext = await browser.newContext(), deep = await deepContext.newPage();
  await deep.goto(`${origin}/portal/#/companies/${ids[companyNames[0]]}`); await deep.locator('#login').waitFor({ state: 'visible' });
  assert.equal(await deep.locator('#workspace-name').textContent(), '');
  await login(deep, dataset[0][1]); await deep.locator('#workspace').waitFor({ state: 'visible' });
  assert.equal(await deep.locator('#company-name').innerText(), companyNames[0]);
  await deepContext.close(); proof.push('Deep link sem sessão pede login e retorna somente à rota interna autorizada.');
  stage = 'revogação em tela';
  await caio.page.locator('#security-open').click(); await caio.page.locator('#security').waitFor({ state: 'visible' });
  await caio.page.locator('#session-list .company').filter({ hasText: 'Esta sessão' }).getByRole('button', { name: 'Encerrar sessão' }).click();
  await caio.page.locator('#login').waitFor({ state: 'visible' }); assert.equal(await caio.page.locator('#companies').textContent(), '');
  proof.push('Revogação da sessão pessoal retorna ao login e apaga a lista.');
  stage = 'suspensão pelo painel';
  const suspended = await customer(dataset[4][1]);
  await panel.locator('[data-view=accessUsers]').click();
  await panel.getByRole('button', { name: 'Gerenciar acesso de Acesso Suspenso Demo', exact: true }).click();
  const access = panel.locator('.access-dialog');
  await access.locator('select[name=identityStatus]').selectOption('bloqueado');
  await access.getByRole('button', { name: 'Alterar estado global', exact: true }).click();
  const changed = panel.waitForResponse((r) => /\/api\/admin\/access-users\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH');
  await panel.locator('#confirmAccept').click(); assert.equal((await changed).status(), 200);
  await suspended.page.reload(); await suspended.page.locator('#login').waitFor({ state: 'visible' });
  assert.equal(await suspended.page.locator('#companies').textContent(), '');
  proof.push('Suspensão global pelo painel invalida acesso já aberto no portal.');
  stage = 'logout'; await ana.page.locator('#logout').click(); await ana.page.locator('#login').waitFor({ state: 'visible' });
  assert.equal(await ana.page.locator('#company-name').textContent(), ''); assert.equal(await ana.page.locator('#companies').textContent(), '');
  assert.equal((await ana.page.request.get(`${origin}/api/account/v1/session`)).status(), 401);
  assert.equal(await ana.page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  proof.push('Logout revoga cookie no servidor, limpa DOM e não armazena sessão em Web Storage.');
  assert.deepEqual(errors, []);
  writeFileSync('.tmp/m3/browser-proof.json', JSON.stringify({ status: 'passed', date: new Date().toISOString(), proof }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks: proof }));
} catch (error) {
  mkdirSync('.tmp/m3', { recursive: true });
  if (diagnosticPage) {
    await diagnosticPage.screenshot({ path: '.tmp/m3/failure.png', fullPage: true }).catch(() => {});
    writeFileSync('.tmp/m3/failure.txt', await diagnosticPage.locator('.access-dialog,.access-reauth-dialog').allTextContents().then((rows) => rows.join('\n')).catch(() => ''));
  }
  console.error(`M3 browser falhou: ${stage}. ${String(error.message).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]')}`);
  process.exitCode = 1;
} finally { await browser.close(); }
