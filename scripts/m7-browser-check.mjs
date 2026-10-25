import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Existing fictitious product dataset only. No seed, SQL, publication,
// provider configuration, contact data or external delivery.
const origin = 'http://127.0.0.1:5035';
const { chromium } = process.argv[2] ? await import(pathToFileURL(process.argv[2]).href) : await import('playwright');
const inspect = spawnSync('docker', ['inspect', 'waia-test-v2-preview'], { encoding: 'utf8' });
assert.equal(inspect.status, 0);
const preview = JSON.parse(inspect.stdout)[0];
assert.equal(preview.Config.Labels['waia.preview'], 'v2-local');
assert.deepEqual(Object.keys(preview.NetworkSettings.Networks), ['waia-test_v2_internal']);
const network = spawnSync('docker', ['network', 'inspect', 'waia-test_v2_internal'], { encoding: 'utf8' });
assert.equal(network.status, 0); assert.equal(JSON.parse(network.stdout)[0].Internal, true);
assert.ok(preview.Config.Env.includes('ACCOUNT_EMAIL_MODE=fake'));
assert.ok(preview.Config.Env.some((value) => value.startsWith('DATABASE_URL=') && new URL(value.slice(13)).pathname === '/waia_v2_app'));
const credentials = JSON.parse(readFileSync('.secrets/v2-m3-users.json', 'utf8'));
const anaEmail = 'ana.demo@waia.example', emptyEmail = 'semempresa.demo@waia.example';
const stateFile = '.secrets/v2-m7-ana-browser.json';
const priorState = existsSync(stateFile) ? stateFile : '.secrets/v2-m5-ana-browser.json';
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const errors = [], proof = [];
let page, context, restoreName = null, restoreGreeting = null, stage = 'login';
const login = async (ctx, email) => {
  const response = await ctx.request.post(`${origin}/api/account/v1/login`, {
    headers: { origin }, data: { email, password: credentials[email] },
  });
  assert.equal(response.status(), 200, 'Login sintético indisponível; conferir janela do limitador.');
};
const session = async () => {
  const response = await page.request.get(`${origin}/api/account/v1/session`); assert.equal(response.status(), 200); return response.json();
};
try {
  mkdirSync('.tmp/m7', { recursive: true });
  context = await browser.newContext(existsSync(priorState) ? { storageState: priorState } : {});
  page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  if ((await context.request.get(`${origin}/api/account/v1/session`)).status() !== 200) await login(context, anaEmail);
  await page.goto(`${origin}/portal/`); await page.locator('#home').waitFor({ state: 'visible' });
  const companies = await (await page.request.get(`${origin}/api/app/v1/companies`)).json();
  const aurora = companies.companies.find((item) => item.name === 'Aurora Serviços Demo');
  const horizonte = companies.companies.find((item) => item.name === 'Horizonte Comércio Demo');
  assert.ok(aurora && horizonte);
  await page.getByRole('button', { name: 'Abrir atendimento · Aurora Serviços Demo', exact: true }).click();
  await page.locator('#attendance-form').waitFor({ state: 'visible' });
  const overviewPath = `/api/app/v1/companies/${aurora.id}/overview`;
  const overviewResponse = await page.request.get(`${origin}${overviewPath}`);
  assert.equal(overviewResponse.status(), 200); const overview = await overviewResponse.json();
  assert.deepEqual(overview.optionalResources, { conversations: false, leads: false, media: false, humanActions: false });
  assert.ok((await page.locator('#attendance-overview').innerText()).includes(`Rascunho: ${overview.draftVersion}`));
  for (const resource of ['conversations', 'leads', 'messages/00000000-0000-4000-8000-000000000001/media']) {
    assert.equal((await page.request.get(`${origin}/api/app/v1/companies/${aurora.id}/${resource}`)).status(), 404);
  }
  assert.ok([401, 403].includes((await page.request.get(`${origin}/api/admin/tenants/${aurora.id}/conversations`)).status()));
  await page.screenshot({ path: '.tmp/m7/overview-desktop.png', fullPage: true });
  proof.push('Resumo com APIs reais e opcionais fechados; cookie customer não abre API administrativa.');

  stage = 'sincronização do resumo após salvar';
  const greeting = page.locator('#attendance-greeting');
  restoreGreeting = { id: aurora.id, text: await greeting.inputValue() };
  const saveGreeting = async (text) => {
    await greeting.fill(text);
    const pending = page.waitForResponse((r) => r.url().endsWith(`/companies/${aurora.id}/attendance/draft`) && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
    const response = await pending; assert.equal(response.status(), 200); const saved = await response.json();
    await page.waitForFunction((version) => document.getElementById('attendance-overview').textContent.includes(`Rascunho: ${version}`), saved.draftVersion);
    assert.equal(saved.activeVersion, overview.activeVersion);
  };
  await saveGreeting(`${restoreGreeting.text}\nRevisão fictícia M7.`);
  await saveGreeting(restoreGreeting.text); restoreGreeting = null;
  proof.push('Salvar atualiza a versão do resumo automaticamente sem publicar; saudação fictícia original restaurada pelo mesmo editor.');

  stage = 'perfil';
  await page.locator('#profile-open').click(); await page.locator('#profile').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#profile-email').textContent(), anaEmail);
  restoreName = (await session()).user.name;
  const literal = '<img src=x onerror=alert(1)> Ana Demo';
  await page.locator('#profile-form input').fill(literal);
  const changed = page.waitForResponse((r) => r.url().endsWith('/api/account/v1/profile') && r.request().method() === 'PATCH');
  await page.locator('#profile-form button').click(); assert.equal((await changed).status(), 200);
  assert.equal((await session()).user.name, literal); assert.equal(await page.locator('#profile img').count(), 0);
  const own = await session();
  assert.equal((await page.request.patch(`${origin}/api/account/v1/profile`, { headers: { origin, 'x-csrf-token': own.csrfToken },
    data: { name: 'Nome recusado', email: emptyEmail } })).status(), 422);
  assert.equal((await page.request.patch(`${origin}/api/account/v1/profile`, { headers: { origin, 'x-csrf-token': own.csrfToken },
    data: { name: restoreName } })).status(), 200); restoreName = null;
  await page.locator('#security-open').click(); await page.locator('#security').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#session-list').innerText()).includes('Esta sessão'));
  assert.ok((await page.locator('#session-list').innerText()).includes('expira'));
  proof.push('Perfil com e-mail somente leitura, nome literal seguro e mass assignment recusado; nome original restaurado. Segurança mostra sessões próprias e expiração.');

  stage = 'troca com resposta lenta';
  await page.locator('#security [data-home]').click(); await page.locator('#home').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Abrir atendimento · Aurora Serviços Demo', exact: true }).click();
  await page.locator('#attendance-form').waitFor({ state: 'visible' });
  let release, entered;
  const hold = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  await page.route(`**${overviewPath}`, async (route) => {
    const response = await route.fetch(); entered(); await hold;
    try { await route.fulfill({ response }); } catch { /* request cancelled by navigation */ }
  });
  await page.locator('#overview-refresh').click(); await started;
  await page.locator('#workspace-nav [data-home]').click(); await page.locator('#home').waitFor({ state: 'visible' });
  release(); await page.unroute(`**${overviewPath}`);
  await page.getByRole('button', { name: 'Abrir atendimento · Horizonte Comércio Demo', exact: true }).click();
  await page.locator('#attendance-form').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#workspace-name').textContent(), horizonte.name);
  const nextOverview = await (await page.request.get(`${origin}/api/app/v1/companies/${horizonte.id}/overview`)).json();
  assert.ok((await page.locator('#attendance-overview').innerText()).includes(`Rascunho: ${nextOverview.draftVersion}`));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#profile-open').focus(); await page.keyboard.press('Enter'); await page.locator('#profile').waitFor({ state: 'visible' });
  await page.screenshot({ path: '.tmp/m7/profile-mobile.png', fullPage: true });
  proof.push('Resposta real retida de Aurora não substitui Horizonte; perfil acessível pelo teclado e viewport390 sem overflow.');

  stage = 'revogação e troca de identidade';
  await page.locator('#security-open').click(); await page.locator('#security').waitFor({ state: 'visible' });
  await page.locator('#session-list .company').filter({ hasText: 'Esta sessão' }).getByRole('button').click();
  await page.locator('#login').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#attendance-overview').textContent(), '');
  assert.equal(await page.locator('#profile-email').textContent(), '');
  await login(context, anaEmail); await page.goto(`${origin}/portal/`); await page.locator('#home').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Abrir atendimento · Aurora Serviços Demo', exact: true }).click();
  await page.locator('#attendance-form').waitFor({ state: 'visible' });
  // Same cookie jar changes outside the displayed page, as in another window.
  await login(context, emptyEmail); await page.locator('#security-open').click();
  await page.locator('#home').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#companies').innerText()).includes('ainda não tem uma empresa'));
  assert.equal(await page.locator('#company-name').textContent(), '');
  assert.equal(await page.locator('#attendance-overview').textContent(), '');
  await login(context, anaEmail); await page.goto(`${origin}/portal/`); await page.locator('#home').waitFor({ state: 'visible' });
  await context.storageState({ path: stateFile });
  proof.push('Encerrar sessão atual retorna ao login e limpa dados; mudança de identidade enquanto a tela permanece aberta limpa empresa anterior e abre lista vazia sem travar.');
  assert.deepEqual(errors, []);
  const result = { status: 'passed', date: new Date().toISOString(), proof,
    limits: ['Sem WhatsApp/OpenAI/e-mail real, alteração de senha ou matrícula MFA no dataset compartilhado; segurança transacional é validada separadamente em PostgreSQL.'] };
  writeFileSync('.tmp/m7/browser-proof.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  console.error(`M7 browser: ${stage}. ${String(error.message).replace(/[A-Za-z0-9_-]{30,}/g, '[redacted]')}`); process.exitCode = 1;
} finally {
  if (restoreGreeting && page) {
    try {
      const own = await session(), path = `${origin}/api/app/v1/companies/${restoreGreeting.id}/attendance`;
      const draft = await (await page.request.get(path)).json();
      assert.equal((await page.request.patch(`${path}/draft`, { headers: { origin, 'x-csrf-token': own.csrfToken },
        data: { draftVersion: draft.draftVersion, changes: { greeting: restoreGreeting.text } },
      })).status(), 200);
    } catch { console.error('Restauração da saudação sintética não confirmada.'); process.exitCode = 1; }
  }
  if (restoreName && page) {
    try { const own = await session(); assert.equal((await page.request.patch(`${origin}/api/account/v1/profile`, {
      headers: { origin, 'x-csrf-token': own.csrfToken }, data: { name: restoreName },
    })).status(), 200); } catch { console.error('Restauração do nome sintético não confirmada.'); process.exitCode = 1; }
  }
  await browser.close();
}
