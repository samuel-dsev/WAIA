import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Supplemental M8 journey. Uses existing product fixtures and real APIs;
// browser routes are never replaced with successful fake publications.
const origin = 'http://127.0.0.1:5035';
const { chromium } = process.argv[2] ? await import(pathToFileURL(process.argv[2]).href) : await import('playwright');
const metadata = spawnSync('docker', ['inspect', 'waia-test-v2-preview'], { encoding: 'utf8' });
assert.equal(metadata.status, 0);
const preview = JSON.parse(metadata.stdout)[0];
assert.equal(preview.Config.Labels['waia.preview'], 'v2-local');
assert.deepEqual(Object.keys(preview.NetworkSettings.Networks), ['waia-test_v2_internal']);
assert.ok(preview.Config.Env.includes('ACCOUNT_EMAIL_MODE=fake'));
assert.ok(preview.Config.Env.some((value) => value.startsWith('DATABASE_URL=') && new URL(value.slice(13)).pathname === '/waia_v2_app'));
const network = spawnSync('docker', ['network', 'inspect', 'waia-test_v2_internal'], { encoding: 'utf8' });
assert.equal(network.status, 0); assert.equal(JSON.parse(network.stdout)[0].Internal, true);
const credentials = JSON.parse(readFileSync('.secrets/v2-m3-users.json', 'utf8'));
const stateFile = '.secrets/v2-m7-ana-browser.json';
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const proof = [], errors = [];
let context, page, restore = null, stage = 'session';
try {
  mkdirSync('.tmp/m8', { recursive: true });
  context = await browser.newContext(existsSync(stateFile) ? { storageState: stateFile } : {});
  if ((await context.request.get(`${origin}/api/account/v1/session`)).status() !== 200) {
    const response = await context.request.post(`${origin}/api/account/v1/login`, {
      headers: { origin }, data: { email: 'ana.demo@waia.example', password: credentials['ana.demo@waia.example'] },
    });
    assert.equal(response.status(), 200, 'Login sintético indisponível; conferir janela de rate limit.');
  }
  page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/portal/`); await page.locator('#home').waitFor({ state: 'visible' });
  const { companies } = await (await page.request.get(`${origin}/api/app/v1/companies`)).json();
  const company = companies.find((entry) => entry.name === 'Aurora Serviços Demo'); assert.ok(company);
  const path = `/api/app/v1/companies/${company.id}/attendance`;
  const read = async () => { const result = await page.request.get(`${origin}${path}`); assert.equal(result.status(), 200); return result.json(); };
  const initial = await read();
  await page.getByRole('button', { name: `Abrir atendimento · ${company.name}`, exact: true }).click();
  await page.locator('#attendance-form').waitFor({ state: 'visible' });
  stage = 'viewport/keyboard/labels';
  for (const width of [1366, 390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const unnamed = await page.locator('input,textarea,select,button').evaluateAll((controls) => controls
      .filter((control) => control.getClientRects().length && !control.hidden)
      .filter((control) => !control.getAttribute('aria-label') && !control.getAttribute('aria-labelledby')
        && !(control.labels?.length) && !(control.tagName === 'BUTTON' && control.textContent.trim()))
      .map((control) => control.id || control.tagName));
    assert.deepEqual(unnamed, [], 'Controles visíveis precisam de nome acessível.');
    await page.locator('#profile-open').focus(); await page.keyboard.press('Enter');
    await page.locator('#profile').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Seu perfil');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `.tmp/m8/profile-${width}.png`, fullPage: true });
    await page.locator('#profile [data-home]').click(); await page.locator('#home').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: `Abrir atendimento · ${company.name}`, exact: true }).click();
    await page.locator('#attendance-form').waitFor({ state: 'visible' });
    await page.screenshot({ path: `.tmp/m8/workspace-${width}.png` });
  }
  proof.push('1366/390/360px sem overflow, controles visíveis nomeados, Perfil por teclado e foco no título; capturas reais. Não equivale a auditoria completa de acessibilidade.');
  stage = 'simultaneous editors';
  const second = await context.newPage(); second.on('pageerror', (error) => errors.push(error.message));
  await second.goto(`${origin}/portal/#/companies/${company.id}`);
  await second.locator('#attendance-form').waitFor({ state: 'visible' });
  const base = await read(); restore = { companyId: company.id, greeting: base.fields.greeting };
  const firstText = `${restore.greeting}\nPrimeiro editor fictício M8.`;
  const secondText = `${restore.greeting}\nSegundo editor fictício M8.`;
  await page.locator('#attendance-greeting').fill(firstText);
  await second.locator('#attendance-greeting').fill(secondText);
  const saved = page.waitForResponse((r) => r.url().endsWith(`${path}/draft`) && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
  assert.equal((await saved).status(), 200);
  const conflict = second.waitForResponse((r) => r.url().endsWith(`${path}/draft`) && r.request().method() === 'PATCH');
  await second.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
  assert.equal((await conflict).status(), 409);
  assert.equal(await second.locator('#attendance-greeting').inputValue(), secondText);
  assert.equal((await read()).fields.greeting, firstText);
  const current = await read(), own = await (await page.request.get(`${origin}/api/account/v1/session`)).json();
  assert.equal(current.activeVersion, initial.activeVersion);
  const restored = await page.request.patch(`${origin}${path}/draft`, {
    headers: { origin, 'x-csrf-token': own.csrfToken },
    data: { draftVersion: current.draftVersion, changes: { greeting: restore.greeting } },
  });
  assert.equal(restored.status(), 200); restore = null;
  assert.deepEqual((await read()).fields, initial.fields);
  proof.push('Duas abas reais: primeira salva, segunda recebe409 e preserva texto local; rascunho original restaurado pela API, publicação inalterada.');
  stage = 'headers/private surfaces';
  for (const asset of ['/portal/', '/portal/app.js', '/portal/security.js', '/portal/attendance.js']) {
    const response = await page.request.get(`${origin}${asset}`); assert.equal(response.status(), 200);
    assert.equal(response.headers()['cache-control'], 'no-store');
    assert.match(response.headers()['content-security-policy'], /frame-ancestors 'none'/);
  }
  for (const target of ['/api/admin/session', `/api/admin/tenants/${company.id}/credentials`, '/metrics']) {
    const response = await page.request.get(`${origin}${target}`, { headers: { 'x-forwarded-for': '127.0.0.1', 'x-waia-role': 'platform_admin' } });
    assert.ok([401, 403, 404].includes(response.status()));
  }
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  proof.push('Assets no-store/CSP; cookie customer e headers forjados não abrem administração/métricas; sem sessão em Web Storage. Proxy público final depende da M9.');
  assert.deepEqual(errors, []); await context.storageState({ path: stateFile });
  const result = { status: 'passed', date: new Date().toISOString(), proof,
    limits: ['Nenhum provider, e-mail real ou publicação bem-sucedida no preview sem base técnica aprovada.',
      'Publicação/rollback/concurrency reais de banco e runtime são cobertos separadamente nas integrações e na carga técnica sintética.'] };
  writeFileSync('.tmp/m8/browser-proof.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  console.error(`M8 browser: ${stage}. ${String(error.message).replace(/[A-Za-z0-9_-]{30,}/g, '[redacted]')}`); process.exitCode = 1;
} finally {
  if (restore && page) {
    try {
      const path = `${origin}/api/app/v1/companies/${restore.companyId}/attendance`;
      const draft = await (await page.request.get(path)).json();
      const own = await (await page.request.get(`${origin}/api/account/v1/session`)).json();
      assert.equal((await page.request.patch(`${path}/draft`, { headers: { origin, 'x-csrf-token': own.csrfToken },
        data: { draftVersion: draft.draftVersion, changes: { greeting: restore.greeting } },
      })).status(), 200);
    } catch { console.error('Restauração da saudação sintética não confirmada.'); process.exitCode = 1; }
  }
  await browser.close();
}
