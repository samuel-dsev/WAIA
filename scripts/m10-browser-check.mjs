import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { totp } from '../src/modules/auth/totp.js';

// Product acceptance against the existing loopback preview. Provisioning and
// business configuration use the actual UI; no SQL, historical seed or route mocks.
const origin = 'http://127.0.0.1:5035';
const { chromium } = process.argv[2] ? await import(pathToFileURL(process.argv[2]).href) : await import('playwright');
const inspect = spawnSync('docker', ['inspect', 'waia-test-v2-preview'], { encoding: 'utf8' }); assert.equal(inspect.status, 0);
const metadata = JSON.parse(inspect.stdout)[0];
assert.equal(metadata.Config.Labels['waia.preview'], 'v2-local');
assert.deepEqual(Object.keys(metadata.NetworkSettings.Networks), ['waia-test_v2_internal']);
const env = Object.fromEntries(metadata.Config.Env.map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
assert.equal(env.NODE_ENV, 'development'); assert.equal(env.ACCOUNT_EMAIL_MODE, 'fake');
assert.equal(new URL(env.DATABASE_URL).host, 'v2-postgres:5432'); assert.equal(new URL(env.DATABASE_URL).pathname, '/waia_v2_app');
const network = spawnSync('docker', ['network', 'inspect', 'waia-test_v2_internal'], { encoding: 'utf8' });
assert.equal(network.status, 0); assert.equal(JSON.parse(network.stdout)[0].Internal, true);
const usersPath = '.secrets/v2-m3-users.json', users = JSON.parse(readFileSync(usersPath, 'utf8'));
const password = readFileSync('.secrets/v2-preview-bootstrap.env', 'utf8').match(/V2_PREVIEW_ADMIN_PASSWORD=(.+)/)[1].trim();
const mfa = JSON.parse(readFileSync('.secrets/v2-preview-admin-mfa.json', 'utf8'));
function currentCode() {
  let bits = 0, value = 0; const bytes = [];
  for (const c of mfa.secret) { value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); } }
  return totp(Buffer.from(bytes), Math.floor(Date.now() / 30000));
}
mkdirSync('.tmp/m10', { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const errors = [], proof = [], ids = {};
let stage = 'root-login', panel, page;
const watch = (target) => target.on('pageerror', (error) => errors.push(error.message));
try {
  const fresh = await browser.newContext({ viewport: { width: 1366, height: 900 } }); page = await fresh.newPage(); watch(page);
  await page.goto(origin + '/'); await page.locator('#login').waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).pathname, '/portal/');
  await page.screenshot({ path: '.tmp/m10/login-desktop.png', fullPage: true });
  proof.push('Raiz abre login cliente real em contexto sem cookies.'); await fresh.close();

  stage = 'admin-login-mfa';
  const admin = await browser.newContext({ viewport: { width: 1366, height: 900 } }); panel = await admin.newPage(); watch(panel);
  page = panel;
  await panel.goto(origin + '/panel/');
  await panel.locator('#loginEmail').fill('admin.local@waia.example'); await panel.locator('#loginPassword').fill(password);
  await panel.locator('#loginForm button').click(); await panel.locator('#mfaLoginForm').waitFor({ state: 'visible' });
  await panel.locator('#mfaLoginCode').fill(currentCode()); await panel.locator('#mfaLoginForm button[type=submit]').click();
  await panel.locator('#appShell').waitFor({ state: 'visible' });
  proof.push('Login administrativo por senha e TOTP, sem aproveitar sessão salva.');

  const companies = [
    ['Aurora Serviços Demo', 'Serviços e suporte', 'Pacote Aurora Demo', 'Atenda com clareza sobre os serviços fictícios da Aurora.'],
    ['Horizonte Comércio Demo', 'Comércio de demonstração', 'Produto Horizonte Demo', 'Apresente somente os produtos fictícios do Horizonte.'],
    ['Vale Atendimento Demo', 'Atendimento e orientação', 'Orientação Vale Demo', 'Ajude a entender o pedido, com uma pergunta por vez.'],
    ['Jardim Consultoria Demo', 'Consultoria de demonstração', 'Consultoria Jardim Demo', 'Atenda como assistente da Jardim Consultoria Demo, usando os dados fictícios cadastrados.'],
  ];
  const step = async (number) => { stage = `business-step-${number}`;
    const target = panel.getByRole('button', { name: new RegExp(`^${number}\\. `) });
    if (await target.getAttribute('aria-current') !== 'step') await target.click();
    await panel.getByRole('heading', { name: new RegExp(`^${number}\\. `) }).waitFor({ state: 'visible' });
  };
  const saved = async () => panel.waitForFunction(() => {
    const node = document.querySelector('.autosave-status');
    return node?.dataset.status === 'saved' || (!node?.dataset.status && /^Rascunho carregado/.test(node?.textContent || ''));
  }, null, { timeout: 20000 });
  const pruneOwnDuplicates = async (label) => {
    const rows = panel.locator('.wizard-item').filter({ has: panel.getByText(label, { exact: true }) });
    let count = await rows.count();
    while (count > 1) {
      await rows.last().getByRole('button', { name: 'Remover', exact: true }).click();
      await panel.locator('#confirmAccept').click();
      await panel.waitForFunction(({ label, expected }) => [...document.querySelectorAll('.wizard-item strong')]
        .filter((node) => node.textContent === label).length === expected, { label, expected: count - 1 });
      await saved(); count = await rows.count();
    }
  };
  for (const [name, segment, product, script] of companies) {
    stage = 'company-business-data';
    await panel.locator('[data-view=companies]').click();
    await panel.locator('#tenantSelect option').first().waitFor({ state: 'attached' });
    if (!await panel.locator('#tenantSelect option').filter({ hasText: name }).count()) {
      await panel.getByRole('button', { name: 'Nova empresa', exact: true }).click();
      await panel.locator('#dynamic-name').fill(name); await panel.locator('#dynamic-identity').fill(name);
      const created = panel.waitForResponse((r) => r.url().endsWith('/api/admin/tenants') && r.request().method() === 'POST');
      await panel.locator('#detailDialog').getByRole('button', { name: 'Salvar', exact: true }).click();
      assert.equal((await created).status(), 201); await panel.locator('#detailDialog').waitFor({ state: 'hidden' });
    }
    const choice = panel.locator('#tenantSelect option').filter({ hasText: name }); await choice.waitFor({ state: 'attached' });
    ids[name] = await choice.getAttribute('value');
    await panel.locator('#tenantSelect').selectOption(ids[name]); await panel.locator('[data-view=onboarding]').click();
    await panel.locator('.onboarding-wizard').waitFor();
    await step(1);
    for (const [field, text] of Object.entries({ publicIdentity: `${name} — empresa fictícia para testes locais.`, segment })) {
      await panel.locator(`[name=${field}]`).fill(text); await panel.locator(`[name=${field}]`).blur();
    }
    await saved(); await step(2);
    for (const key of ['catalog', 'ai_freeform', 'human_handoff']) await panel.locator(`.capability-card input[value=${key}]`).check();
    await saved(); await step(3);
    const fields = { welcomeMessage: `Olá! Você está no atendimento fictício da ${name}.`, fallbackMessage: 'Conte como podemos ajudar neste teste local.',
      address: 'Rua Exemplo, 100 — Cidade Demonstração (endereço fictício)', schedules: 'Segunda a sexta, das 9h às 18h',
      publicRules: 'Dados demonstrativos, sem contratação ou atendimento externo.\nUma pergunta por vez.',
      establishmentRules: 'Use apenas os dados fictícios. Solicite esclarecimento quando faltar informação.',
      privacyPolicy: 'Ambiente local de testes. Não inserir dados pessoais reais.', consentText: 'Concordo em testar com dados fictícios.',
      handoffMessage: 'Sua solicitação fictícia ficará disponível para análise da equipe de demonstração.', handoffChannel: 'Equipe Demo' };
    for (const [field, value] of Object.entries(fields)) { await panel.locator(`[name=${field}]`).fill(value); await panel.locator(`[name=${field}]`).blur(); }
    await panel.locator('textarea[name=attendanceScript]').fill(script + ' Faça uma pergunta útil por vez. Não invente preços ou condições.');
    await panel.locator('textarea[name=attendanceScript]').blur(); await saved();
    await step(4); await panel.locator('[name=menuText]').fill('Escolha: conhecer os serviços ou conversar com a equipe.'); await panel.locator('[name=menuText]').blur();
    await panel.locator('[name=greetings]').fill('oi\nolá\nbom dia'); await panel.locator('[name=greetings]').blur(); await saved();
    const menuLabel = 'Conhecer opções Demo';
    await pruneOwnDuplicates(menuLabel);
    if (!await panel.getByText(menuLabel, { exact: true }).count()) {
      await panel.getByRole('button', { name: 'Adicionar opção', exact: true }).click();
      const dialog = panel.locator('dialog[open]'); await dialog.locator('[name=label]').fill(menuLabel);
      await dialog.locator('[name=action]').selectOption('catalog.list'); await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
    }
    await step(5);
    await pruneOwnDuplicates(product);
    if (!await panel.getByText(product, { exact: true }).count()) {
      await panel.getByRole('button', { name: 'Adicionar produto ou serviço', exact: true }).click();
      const dialog = panel.locator('dialog[open]');
      await dialog.locator('[name=name]').fill(product); await dialog.locator('[name=description]').fill('Item fictício para testar catálogo, conteúdo e atendimento local.');
      await dialog.locator('[name=price]').fill('149.9');
      assert.equal(await dialog.locator('[name=price]').evaluate((input) => input.checkValidity()), true);
      assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
      await panel.screenshot({ path: '.tmp/m10/catalog-decimal.png', fullPage: true });
      await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
    }
    const persisted = await panel.request.get(`${origin}/api/admin/tenants/${ids[name]}/configuration/draft`);
    assert.equal(persisted.status(), 200);
    assert.equal((await persisted.json()).configuration.catalog.items.find((item) => item.name === product).price, 149.9);
    await step(7); await panel.locator('[name=enabled]').check();
    for (const flag of ['leadQualificationEnabled', 'leadIntakeOnlyEnabled', 'catalogSalesEnabled']) {
      await panel.locator(`[name=${flag}]`).uncheck();
    }
    await panel.locator('[name=provider]').selectOption('simulated');
    await panel.locator('[name=model]').fill('simulador-local-demo'); await panel.locator('[name=model]').blur();
    await panel.locator('[name=keyMode]').selectOption('simulated');
    await panel.locator('[name=personality]').fill('Profissional, acolhedor e objetivo.'); await panel.locator('[name=personality]').blur();
    await saved();
    await panel.locator('[data-view=companies]').click();
  }
  proof.push('Quatro empresas fictícias com identidade, roteiro, mensagens, horários, regras, menu e catálogo preenchidos pelo painel; sem credenciais/conexões externas.');

  stage = 'access-provisioning';
  const email = process.argv.includes('--activation-probe') ? 'ativacao.local@waia.example' : 'teste.local@waia.example';
  const name = process.argv.includes('--activation-probe') ? 'Ativação Local M10' : 'Teste Local M10';
  if (!users[email]) { users[email] = randomBytes(24).toString('base64url'); writeFileSync(usersPath, JSON.stringify(users), { mode: 0o600 }); }
  await panel.locator('#tenantSelect').selectOption(''); await panel.locator('[data-view=accessUsers]').click();
  await panel.getByRole('button', { name: 'Novo acesso', exact: true }).waitFor({ state: 'visible' });
  const manage = panel.getByRole('button', { name: `Gerenciar acesso de ${name}`, exact: true });
  const dialog = panel.locator('.access-dialog');
  const reused = (await manage.count()) > 0;
  const mailbox = () => {
    const result = spawnSync('docker', ['exec', 'waia-test-v2-preview', 'cat', '/tmp/waia-v2-fake-inbox.json'], { encoding: 'utf8' });
    return result.status === 0 ? JSON.parse(result.stdout) : [];
  };
  const priorActivations = new Set(reused ? mailbox().filter((message) => message.to === email && message.purpose === 'activate').map((message) => message.idempotencyKey) : []);
  if (reused) await manage.click();
  else {
    await panel.getByRole('button', { name: 'Novo acesso', exact: true }).click();
    await dialog.locator('[name=name]').fill(name); await dialog.locator('[name=email]').fill(email);
    const company = dialog.locator('.access-company-choice').filter({ hasText: 'Jardim Consultoria Demo' });
    await company.locator('input[name=company]').check();
    for (const capability of ['attendance.edit', 'attendance.simulate', 'attendance.publish']) await company.locator(`input[value="${capability}"]`).check();
    await dialog.getByRole('button', { name: 'Revisar e salvar acesso' }).click(); await panel.locator('#confirmAccept').click();
  }
  await dialog.locator('.access-email').waitFor();
  const pending = (await dialog.innerText()).includes('Pendente de ativação');
  if (pending && reused) {
    await dialog.getByRole('button', { name: 'Enviar ou reenviar ativação', exact: true }).click(); await panel.locator('#confirmAccept').click();
    await dialog.locator('.access-email').waitFor();
  }
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();
  const customer = await browser.newContext({ viewport: { width: 1366, height: 900 } }); page = await customer.newPage(); watch(page);
  if (pending) {
    stage = 'fake-mail-activation'; let link;
    for (let n = 0; n < 30; n++) {
      link = mailbox().filter((m) => m.to === email && m.purpose === 'activate' && !priorActivations.has(m.idempotencyKey)).at(-1)?.url;
      if (link) break; await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(link); assert.equal(new URL(link).origin, origin);
    await page.goto(link); await page.locator('#activate').waitFor({ state: 'visible' });
    await page.locator('#activate input[name=password]').fill(users[email]);
    await page.locator('#activate input[name=confirmation]').fill(users[email]);
    const activated = page.waitForResponse((response) => response.url().endsWith('/api/account/v1/activate') && response.request().method() === 'POST');
    await page.locator('#activate button').first().click(); const activatedResponse = await activated;
    const activationError = activatedResponse.status() === 204 ? null : await activatedResponse.json();
    assert.equal(activatedResponse.status(), 204, `Activation response: ${activationError?.code || 'UNKNOWN'}`);
    writeFileSync('.tmp/m10/activation-proof.json', JSON.stringify({ status: 'passed', imageId: metadata.Image,
      fakeDelivery: true, uiPasswordConfirmation: true, activationStatus: 204, tokenLogged: false }));
    await page.locator('#login').waitFor({ state: 'visible' });
  }
  stage = 'customer-login'; await page.goto(origin + '/');
  await page.locator('#login input[name=email]').fill(email); await page.locator('#login input[name=password]').fill(users[email]);
  await page.locator('#login button').first().click(); await page.locator('#home').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('button', { name: /^Abrir atendimento ·/ }).count(), 1);
  await page.getByRole('button', { name: 'Abrir atendimento · Jardim Consultoria Demo', exact: true }).click();
  await page.locator('#attendance-form').waitFor({ state: 'visible' });
  await page.locator('[data-field=script]').fill('Atendimento local da Jardim Demo. Pergunte o objetivo do cliente e use somente o catálogo fictício.');
  await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
  await page.locator('#notice').filter({ hasText: /Rascunho \d+ salvo/ }).waitFor();
  const other = await page.request.get(`${origin}/api/app/v1/companies/${ids['Aurora Serviços Demo']}/attendance`); assert.equal(other.status(), 404);
  const deniedAdmin = (await page.request.get(origin + '/api/admin/companies')).status();
  assert.ok([401, 403].includes(deniedAdmin));
  proof.push(`Acesso criado/reutilizado pelo painel; login visual; uma empresa; salvar real; empresa alheia404/admin${deniedAdmin}.`);
  await page.screenshot({ path: '.tmp/m10/customer-desktop.png', fullPage: true });
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `.tmp/m10/customer-${width}.png`, fullPage: true });
  }

  stage = 'session-revocation'; await manage.click(); await dialog.locator('.access-email').waitFor();
  await dialog.getByRole('button', { name: 'Revogar sessões', exact: true }).click(); await panel.locator('#confirmAccept').click();
  await dialog.locator('.access-email').waitFor(); await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.reload(); await page.locator('#login').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#attendance-form').count(), 0);
  proof.push('Revogação pelo painel invalida sessão cliente e limpa o editor após recarga.');

  stage = 'admin-simulator';
  await panel.locator('#tenantSelect').selectOption(ids['Jardim Consultoria Demo']); await panel.locator('[data-view=onboarding]').click();
  await step(10); await panel.getByRole('button', { name: 'Abrir simulador', exact: true }).click();
  const simulator = panel.locator('.simulator-dialog'); await simulator.locator('[name=message]').fill('oi');
  const result = panel.waitForResponse((r) => r.url().endsWith('/simulator/messages') && r.request().method() === 'POST');
  await simulator.getByRole('button', { name: 'Enviar texto', exact: true }).click(); assert.equal((await result).status(), 200);
  await simulator.locator('.simulator-message').first().waitFor(); await panel.screenshot({ path: '.tmp/m10/admin-simulator.png', fullPage: true });
  await simulator.getByRole('button', { name: 'Fechar simulador', exact: true }).click();
  await panel.getByRole('button', { name: 'Recalcular prontidão', exact: true }).click();
  await panel.getByText('Existem pendências', { exact: true }).waitFor();
  proof.push('Simulador administrativo executa o runtime interno200; prontidão continua bloqueando operação externa sem conexão.');
  await admin.storageState({ path: '.secrets/v2-m10-admin-browser.json' });
  assert.deepEqual(errors, []);
  writeFileSync('.tmp/m10/browser-proof.json', JSON.stringify({ status: 'passed', imageId: metadata.Image, proof,
    errors, productProvisionedBy: 'panel-ui', externalKeysCreated: 0, externalConnections: 0, fakeMail: true,
    activationPerformed: pending, humanAcceptance: 'pending', viewport: [1366, 390, 360] }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks: proof.length, imageId: metadata.Image, humanAcceptance: 'pending' }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: '.tmp/m10/failure.png', fullPage: true }).catch(() => {});
  let message = String(error?.message || 'Browser check failed.');
  for (const value of [password, mfa.secret, ...Object.values(users)]) message = message.replaceAll(value, '[redacted]');
  message = message.replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]');
  writeFileSync('.tmp/m10/failure.txt', message);
  console.error(JSON.stringify({ status: 'failed', stage, errors: errors.length })); process.exitCode = 1;
} finally { await browser.close(); }
