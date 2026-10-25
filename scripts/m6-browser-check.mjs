import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { totp } from '../src/modules/auth/totp.js';

// Existing synthetic dataset only. No seed, SQL, number, credential, external
// connection, activation or publication is performed by this opt-in check.
const origin = 'http://127.0.0.1:5035';
const { chromium } = process.argv[2] ? await import(pathToFileURL(process.argv[2]).href) : await import('playwright');
const inspect = spawnSync('docker', ['inspect', 'waia-test-v2-preview'], { encoding: 'utf8' });
assert.equal(inspect.status, 0); const preview = JSON.parse(inspect.stdout)[0];
assert.equal(preview.Config.Labels['waia.preview'], 'v2-local');
assert.deepEqual(Object.keys(preview.NetworkSettings.Networks), ['waia-test_v2_internal']);
const network = spawnSync('docker', ['network', 'inspect', 'waia-test_v2_internal'], { encoding: 'utf8' });
assert.equal(network.status, 0); assert.equal(JSON.parse(network.stdout)[0].Internal, true);
assert.ok(preview.Config.Env.includes('ACCOUNT_EMAIL_MODE=fake'));
assert.ok(preview.Config.Env.some((value) => value.startsWith('DATABASE_URL=') && new URL(value.slice(13)).pathname === '/waia_v2_app'));
const credentials = JSON.parse(readFileSync('.secrets/v2-m3-users.json', 'utf8'));
const password = readFileSync('.secrets/v2-preview-bootstrap.env', 'utf8').match(/V2_PREVIEW_ADMIN_PASSWORD=(.+)/)[1].trim();
const mfa = JSON.parse(readFileSync('.secrets/v2-preview-admin-mfa.json', 'utf8'));
const code = (secret) => {
  let bits = 0, value = 0; const bytes = [];
  for (const c of secret) { value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); } }
  return totp(Buffer.from(bytes), Math.floor(Date.now() / 30000));
};
const hash = (data) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const proof = [], errors = [];
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
let stage = 'admin', panel, adminHeaders, id, restoreDraft = null;
try {
  const adminFile = '.secrets/v2-m3-admin-browser.json';
  const admin = await browser.newContext(existsSync(adminFile) ? { storageState: adminFile } : {});
  panel = await admin.newPage(); panel.on('pageerror', (e) => errors.push(e.message)); await panel.goto(`${origin}/panel/`);
  if ((await panel.request.get(`${origin}/api/admin/session`)).status() !== 200) {
    await panel.locator('#loginEmail').fill('admin.local@waia.example'); await panel.locator('#loginPassword').fill(password);
    await panel.locator('#loginForm button').click(); await panel.locator('#mfaLoginCode').fill(code(mfa.secret));
    await panel.locator('#mfaLoginForm button[type=submit]').click();
  }
  await panel.locator('#appShell').waitFor({ state: 'visible' });
  const choice = panel.locator('#tenantSelect option').filter({ hasText: 'Aurora Serviços Demo' });
  await choice.waitFor({ state: 'attached' }); id = await choice.getAttribute('value');
  const horizonte = await panel.locator('#tenantSelect option').filter({ hasText: 'Horizonte Comércio Demo' }).getAttribute('value');
  const vale = await panel.locator('#tenantSelect option').filter({ hasText: 'Vale Atendimento Demo' }).getAttribute('value');
  adminHeaders = { Origin: origin, 'x-csrf-token': decodeURIComponent((await admin.cookies(origin)).find((cookie) => cookie.name === 'waia_csrf').value) };
  const adminDraft = async (company = id) => {
    const response = await panel.request.get(`${origin}/api/admin/tenants/${company}/configuration/draft`);
    assert.equal(response.status(), 200); return response.json();
  };
  const before = await adminDraft(), neighbour = await adminDraft(horizonte);
  assert.ok(before?.configuration?.modules.includes('ai_freeform'), 'Dataset M4/M5 deve estar preparado.');
  await admin.storageState({ path: adminFile });

  stage = 'catálogo real';
  const customerFile = '.secrets/v2-m5-ana-browser.json';
  const customer = await browser.newContext(existsSync(customerFile) ? { storageState: customerFile } : {}), page = await customer.newPage();
  page.on('pageerror', (e) => errors.push(e.message)); await page.goto(`${origin}/portal/`);
  if ((await page.request.get(`${origin}/api/account/v1/session`)).status() !== 200) {
    await page.locator('#login').waitFor({ state: 'visible' }); await page.locator('#login input[name=email]').fill('ana.demo@waia.example');
    await page.locator('#login input[name=password]').fill(credentials['ana.demo@waia.example']);
    const login = page.waitForResponse((r) => r.url().endsWith('/api/account/v1/login'));
    await page.locator('#login button').first().click(); assert.equal((await login).status(), 200, 'Respeite a janela do limitador antes de repetir.');
  }
  await page.locator('#home').waitFor({ state: 'visible' }); await customer.storageState({ path: customerFile });
  await page.getByRole('button', { name: 'Abrir atendimento · Aurora Serviços Demo', exact: true }).click();
  await page.locator('#attendance-resources').waitFor();
  const attendancePath = `/api/app/v1/companies/${id}/attendance`;
  const read = async () => { const response = await page.request.get(`${origin}${attendancePath}`); assert.equal(response.status(), 200); return response.json(); };
  const dto = await read();
  const capabilityResponse = await page.request.get(`${origin}/api/app/v1/companies/${id}/capabilities`);
  assert.equal(capabilityResponse.status(), 200); const catalog = await capabilityResponse.json();
  assert.equal(catalog.companyId, id);
  const { companyId: _companyId, effectiveCapabilities: _capabilities, ...resources } = catalog;
  assert.deepEqual(resources, dto.resources);
  assert.equal((await page.request.get(`${origin}/api/app/v1/companies/${vale}/capabilities`)).status(), 404);
  assert.equal(catalog.features.length, 7); assert.ok(catalog.features.some((feature) => feature.id === 'script' && feature.enabled));
  const encoded = JSON.stringify(dto.resources);
  for (const forbidden of ['credential:', 'integration:', 'phoneNumberId', 'maxOutputTokens', 'keyMode', 'provider', before.configuration.ai.model]) {
    if (forbidden) assert.equal(encoded.includes(forbidden), false);
  }
  assert.equal(await page.locator('#attendance-resources input,#attendance-resources select').count(), 0);
  assert.match(await page.locator('#attendance-schedules-guidance').innerText(), /não criam agenda|não.*encerram/);
  assert.match(await page.locator('#attendance-greeting-guidance').innerText(), /menu.*prioridade/i);
  assert.match(await page.locator('#attendance-followUp-guidance').innerText(), /próprio roteiro/i);
  assert.equal(await page.locator('#attendance-tone').getAttribute('maxlength'), String(catalog.fieldLimits.tone.maxCharacters));
  await page.locator('#attendance-behaviors summary').click();
  assert.match(await page.locator('#attendance-behaviors').innerText(), /rascunho .*atendimento publicado/s);
  mkdirSync('.tmp/m6', { recursive: true });
  await page.setViewportSize({ width: 1366, height: 900 }); await page.screenshot({ path: '.tmp/m6/resources-desktop-real.png', fullPage: true });
  proof.push('Catálogo real com sete recursos e comportamentos somente leitura; limites/orientações por campo; endpoint equivale ao DTO e nega empresa alheia; sem modelos/refs/números na resposta.');

  stage = 'revalidação durante edição';
  const localScript = 'Texto local M6 que precisa sobreviver à desabilitação administrativa.';
  await page.locator('[data-field=script]').fill(localScript); await page.locator('#attendance-schedules').fill('Horário local ainda não salvo.');
  restoreDraft = before.configuration;
  const disabled = structuredClone(restoreDraft); disabled.modules = disabled.modules.filter((module) => module !== 'ai_freeform');
  disabled.ai.enabled = false; disabled.ai.leadQualificationEnabled = false;
  const disableResponse = await panel.request.put(`${origin}/api/admin/tenants/${id}/configuration/draft`, { headers: adminHeaders,
    data: { draftVersion: before.draftVersion, configuration: disabled } });
  assert.equal(disableResponse.status(), 200);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.locator('#workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-field=script]').inputValue(), localScript);
  assert.equal(await page.locator('[data-field=script]').getAttribute('readonly'), '');
  assert.equal(await page.locator('#attendance-schedules').inputValue(), 'Horário local ainda não salvo.');
  assert.equal(await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).isDisabled(), true);
  assert.match(await page.locator('[data-feature=script]').innerText(), /Não liberado/);
  const noAI = await read(); assert.equal(Object.hasOwn(noAI.fields, 'script'), false); assert.equal(Object.hasOwn(noAI.fields, 'qualificationCriteria'), false);
  assert.equal(noAI.resources.features.find((feature) => feature.id === 'script').enabled, false);
  assert.equal(Object.hasOwn(noAI.resources.fieldLimits, 'script'), false);
  const session = await (await page.request.get(`${origin}/api/account/v1/session`)).json();
  const unauthorized = await page.request.patch(`${origin}${attendancePath}/draft`, { headers: { Origin: origin, 'x-csrf-token': session.csrfToken },
    data: { draftVersion: noAI.draftVersion, changes: { script: 'Injeção em recurso desabilitado.' } } });
  assert.equal(unauthorized.status(), 403);
  assert.equal(hash((await adminDraft()).configuration), hash(disabled));
  assert.equal(hash((await adminDraft(horizonte)).configuration), hash(neighbour.configuration));
  proof.push('Desabilitação real da IA pelo admin atualiza catálogo durante edição sem apagar texto local, torna roteiro readonly e exige recarga; novo DTO omite campos/limites e PATCH forçado retorna403 sem efeito.');

  stage = 'recarga explícita e informações públicas';
  page.once('dialog', (dialog) => dialog.accept()); await page.getByRole('button', { name: 'Recarregar versão atual', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-field=script]'));
  assert.equal(await page.locator('#attendance-qualificationCriteria').count(), 0);
  await page.locator('#attendance-schedules').fill('Segunda a sexta, das 10h às 17h. Informação pública M6.');
  await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click(); await page.locator('#notice').filter({ hasText: /Rascunho \d+ salvo/ }).waitFor();
  const scheduleSaved = await adminDraft(); assert.deepEqual(scheduleSaved.configuration.identity.schedules, ['Segunda a sexta, das 10h às 17h. Informação pública M6.']);
  const expected = structuredClone(disabled); expected.identity.schedules = scheduleSaved.configuration.identity.schedules;
  assert.equal(hash(scheduleSaved.configuration), hash(expected));
  assert.equal((await read()).activeVersion, dto.activeVersion);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '.tmp/m6/resources-mobile-disabled-real.png', fullPage: true });
  proof.push('Após descarte explícito, campos desabilitados saem do DOM. Horários informativos continuam editáveis e salvam só no rascunho; versão ativa e técnico preservados. 390px sem overflow.');

  stage = 'restauração sintética';
  const restored = await panel.request.put(`${origin}/api/admin/tenants/${id}/configuration/draft`, { headers: adminHeaders,
    data: { draftVersion: (await adminDraft()).draftVersion, configuration: restoreDraft } });
  assert.equal(restored.status(), 200); restoreDraft = null;
  assert.equal(hash((await adminDraft()).configuration), hash(before.configuration));
  assert.equal(hash((await adminDraft(horizonte)).configuration), hash(neighbour.configuration));
  await page.getByRole('button', { name: 'Recarregar versão atual', exact: true }).click(); await page.locator('[data-field=script]').waitFor();
  assert.deepEqual(errors, []);
  proof.push('Configuração inicial de Aurora restaurada pela API administrativa; Horizonte intacta; somente versões/auditoria sintéticas avançaram. Nenhuma publicação/ativação externa.');
  const result = { status: 'passed', date: new Date().toISOString(), proof,
    limits: ['Preview sem base técnica aprovada: estados de runtime publicado e respostas de dois roteiros são comprovados pelos testes PostgreSQL/runtime separados.',
      'Navegador testou rascunho, capacidades, mensagens de orientação e módulo desabilitado com APIs reais; nenhuma fixture de publicação foi usada.'] };
  writeFileSync('.tmp/m6/browser-proof.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  console.error(`M6 browser: ${stage}. ${String(error.message).replace(/[A-Za-z0-9_-]{30,}/g, '[redacted]')}`); process.exitCode = 1;
} finally {
  if (restoreDraft && panel && id && adminHeaders) {
    try {
      const current = await (await panel.request.get(`${origin}/api/admin/tenants/${id}/configuration/draft`)).json();
      const restored = await panel.request.put(`${origin}/api/admin/tenants/${id}/configuration/draft`, { headers: adminHeaders,
        data: { draftVersion: current.draftVersion, configuration: restoreDraft } });
      assert.equal(restored.status(), 200); console.log('Configuração sintética restaurada após interrupção do teste.');
    } catch { console.error('Restauração sintética não confirmada: revisar Aurora pelo painel.'); process.exitCode = 1; }
  }
  await browser.close();
}
