import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { totp } from '../src/modules/auth/totp.js';

// Opt-in check against the existing synthetic preview. Real server denials and
// intercepted UI fixtures have separate proof arrays; a fixture never proves a
// publication, simulator runtime or external integration worked on the server.
const origin = 'http://127.0.0.1:5035';
const { chromium } = process.argv[2] ? await import(pathToFileURL(process.argv[2]).href) : await import('playwright');
const inspect = spawnSync('docker', ['inspect', 'waia-test-v2-preview'], { encoding: 'utf8' });
assert.equal(inspect.status, 0, 'Preview sintético deve estar disponível.');
const preview = JSON.parse(inspect.stdout)[0];
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
const realServer = [], uiFixtures = [], errors = [];
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
let stage = 'admin', restoreDraft = null, panel, adminHeaders, id;
try {
  const adminFile = '.secrets/v2-m3-admin-browser.json';
  const admin = await browser.newContext(existsSync(adminFile) ? { storageState: adminFile } : {});
  panel = await admin.newPage(); panel.on('pageerror', (e) => errors.push(e.message));
  await panel.goto(`${origin}/panel/`);
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
  const adminCompany = async () => (await panel.request.get(`${origin}/api/admin/tenants/${id}`)).json();
  const before = await adminDraft(), neighbour = await adminDraft(horizonte), initialCompany = await adminCompany();
  assert.ok(before?.configuration?.ai?.prompt, 'Dataset M4 deve estar preparado antes deste teste.');

  stage = 'capacidade pelo painel';
  await panel.locator('#tenantSelect').selectOption(''); await panel.locator('[data-view=accessUsers]').click();
  await panel.getByRole('button', { name: 'Gerenciar acesso de Ana Demo', exact: true }).click();
  const dialog = panel.locator('.access-dialog'), card = dialog.locator('.access-membership').filter({ hasText: 'Aurora Serviços Demo' });
  await card.getByRole('button', { name: 'Alterar vínculo', exact: true }).click();
  const required = ['attendance.read', 'attendance.edit', 'attendance.simulate', 'attendance.publish'];
  const needsGrant = (await Promise.all(required.map((key) => dialog.locator(`input[value="${key}"]`).isChecked()))).some((checked) => !checked);
  if (needsGrant) {
    for (const key of required) await dialog.locator(`input[value="${key}"]`).check();
    const changed = panel.waitForResponse((r) => r.url().includes(`/companies/${id}`) && r.request().method() === 'PUT' && r.status() === 200);
    await dialog.getByRole('button', { name: 'Revisar e salvar vínculo', exact: true }).click(); await panel.locator('#confirmAccept').click();
    const reauth = panel.locator('.access-reauth-dialog');
    await Promise.race([changed, reauth.waitFor({ state: 'visible' })]);
    if (await reauth.isVisible()) {
      await reauth.locator('input[name=password]').fill(password); await reauth.locator('input[name=code]').fill(code(mfa.secret));
      await reauth.getByRole('button', { name: 'Confirmar identidade', exact: true }).click();
    }
    await changed; await dialog.locator('.access-email').waitFor();
    realServer.push('Permissões de simulação/publicação da Ana em Aurora liberadas pelo painel; empresa não ativada.');
  } else {
    await dialog.getByRole('button', { name: 'Voltar ao acesso', exact: true }).click();
    realServer.push('Permissões de simulação/publicação da Ana em Aurora já estavam liberadas.');
  }
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).click(); await admin.storageState({ path: adminFile });

  stage = 'cliente real';
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
  await page.locator('[data-field=script]').waitFor();
  const attendancePath = `/api/app/v1/companies/${id}/attendance`;
  const read = async () => (await page.request.get(`${origin}${attendancePath}`)).json();
  const csrf = (await (await page.request.get(`${origin}/api/account/v1/session`)).json()).csrfToken;
  const customerHeaders = { Origin: origin, 'x-csrf-token': csrf };
  const originalDto = await read(); assert.equal(originalDto.publication.ready, false);
  assert.equal(originalDto.publication.reviewToken, null); assert.deepEqual(originalDto.publication.changes, []);
  assert.equal((await page.request.get(`${origin}/api/app/v1/companies/${vale}/attendance`)).status(), 404);
  await page.locator('[data-field=script]').fill(`Roteiro M5 sintético: responda somente sobre Aurora. Teste ${new Date().toISOString()}.`);
  await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
  await page.locator('#notice').filter({ hasText: /Rascunho \d+ salvo/ }).waitFor();
  const savedDto = await read(), saved = await adminDraft();
  assert.equal(savedDto.activeVersion, originalDto.activeVersion); assert.equal((await adminCompany()).status, initialCompany.status);
  const technical = (configuration) => { const copy = structuredClone(configuration); delete copy.ai.prompt; return copy; };
  assert.equal(hash(technical(saved.configuration)), hash(technical(before.configuration)));
  assert.equal(hash((await adminDraft(horizonte)).configuration), hash(neighbour.configuration));
  const deniedSimulation = await page.request.post(`${origin}${attendancePath}/simulate`, { headers: customerHeaders, data: { draftVersion: savedDto.draftVersion, message: 'Olá' } });
  const deniedPublish = await page.request.post(`${origin}${attendancePath}/publish`, { headers: customerHeaders,
    data: { draftVersion: savedDto.draftVersion, reviewToken: 'a'.repeat(64), idempotencyKey: randomUUID(), confirmed: true } });
  assert.ok([403, 409].includes(deniedSimulation.status())); assert.ok([403, 409].includes(deniedPublish.status()));
  realServer.push('Cliente salva somente roteiro; revisão ativa/status/técnico/Horizonte preservados. Simulação e publicação reais negadas sem base técnica aprovada/empresa ativa.');
  stage = 'readiness real';
  const readiness = await (await panel.request.get(`${origin}/api/admin/tenants/${id}/readiness`)).json();
  assert.equal(readiness.ready, false);
  const blockedAdmin = await panel.request.post(`${origin}/api/admin/tenants/${id}/configuration/publish`, { headers: adminHeaders, data: { draftVersion: saved.draftVersion } });
  assert.equal(blockedAdmin.status(), 409);
  assert.equal((await read()).activeVersion, originalDto.activeVersion);
  realServer.push('Pipeline administrativo real recusa publicação com readiness incompleta, preservando revisão anterior. Nenhum número/token/app/provider real criado.');

  stage = 'rascunho técnico administrativo';
  restoreDraft = saved.configuration;
  const changedTechnical = structuredClone(restoreDraft); changedTechnical.ai.model = 'modelo-sintetico-M5-pendente';
  const altered = await panel.request.put(`${origin}/api/admin/tenants/${id}/configuration/draft`, { headers: adminHeaders,
    data: { draftVersion: saved.draftVersion, configuration: changedTechnical } });
  assert.equal(altered.status(), 200);
  const hidden = await read(); assert.equal(hidden.publication.ready, false);
  assert.equal(JSON.stringify(hidden).includes('modelo-sintetico-M5-pendente'), false);
  const restoration = await panel.request.put(`${origin}/api/admin/tenants/${id}/configuration/draft`, { headers: adminHeaders,
    data: { draftVersion: (await adminDraft()).draftVersion, configuration: restoreDraft } });
  assert.equal(restoration.status(), 200); restoreDraft = null;
  realServer.push('Modelo técnico alterado pelo admin permanece ausente do DTO e não publicável; rascunho restaurado pela API administrativa.');

  stage = 'fixtures explícitas da UI';
  const fixture = { ...savedDto, draftVersion: 7001, activeVersion: 7000, canEdit: true, canSimulate: true, canPublish: true,
    company: { ...savedDto.company, status: 'ativa' }, fields: { ...savedDto.fields, script: 'Roteiro sintético novo da Aurora.' },
    publication: { ready: true, reason: null, reviewToken: 'b'.repeat(64), changes: [
      { key: 'script', label: 'Roteiro completo da IA', before: 'Roteiro sintético anterior da Aurora.', after: 'Roteiro sintético novo da Aurora.' },
    ] } };
  let publishRequests = [], failPublish = true, conflictPublish = false, holdSimulation = null;
  const pattern = new RegExp(`/api/app/v1/companies/${id}/attendance(?:/[^?]+)?(?:\\?.*)?$`);
  await page.route(pattern, async (intercept) => {
    const request = intercept.request(), url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === attendancePath) return intercept.fulfill({ json: fixture });
    if (url.pathname.endsWith('/simulate')) {
      if (holdSimulation) { holdSimulation.started(); await holdSimulation.wait; }
      try { return await intercept.fulfill({ json: { draftVersion: fixture.draftVersion,
        reply: 'Resposta fictícia de UI <img src=x onerror=alert(1)>', message: 'Fixture de UI; sem runtime.' } }); } catch { return; }
    }
    if (url.pathname.endsWith('/publish')) {
      publishRequests.push(request.postDataJSON());
      if (conflictPublish) return intercept.fulfill({ status: 409, json: { code: 'DRAFT_VERSION_CONFLICT', message: 'Fixture: outra sessão alterou o atendimento.' } });
      if (failPublish) { failPublish = false; return intercept.fulfill({ status: 503, json: { code: 'ATTENDANCE_UNAVAILABLE', message: 'Fixture de indisponibilidade temporária.' } }); }
      fixture.activeVersion = 7001; fixture.publishedAt = new Date().toISOString();
      fixture.publication = { ready: false, reason: 'Fixture publicada na UI.', changes: [], reviewToken: null };
      return intercept.fulfill({ json: { draftVersion: fixture.draftVersion, activeVersion: fixture.activeVersion, publishedAt: fixture.publishedAt } });
    }
    return intercept.abort(); // Fixtures must never forward an unexpected mutation.
  });
  await page.reload(); await page.locator('[data-field=script]').waitFor();
  await page.locator('[data-field=script]').fill('Texto local ainda não salvo.');
  assert.equal(await page.getByRole('button', { name: 'Simular rascunho', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Revisar publicação', exact: true }).isDisabled(), true);
  await page.locator('[data-field=script]').fill(fixture.fields.script);
  await page.locator('#attendance-simulation-message').fill('Olá, teste sintético');
  await page.getByRole('button', { name: 'Simular rascunho', exact: true }).click();
  await page.locator('#attendance-simulation [role=status]').filter({ hasText: 'Resposta fictícia' }).waitFor();
  assert.equal(await page.locator('#attendance-simulation img').count(), 0);
  await page.getByRole('button', { name: 'Revisar publicação', exact: true }).click();
  const confirm = page.getByRole('group', { name: 'Confirmar publicação do atendimento' });
  assert.equal(await confirm.getByRole('button', { name: 'Confirmar publicação', exact: true }).isDisabled(), true);
  assert.match(await confirm.innerText(), /7001/); assert.match(await confirm.innerText(), /Aurora Serviços Demo/);
  await confirm.locator('summary').click(); assert.match(await confirm.innerText(), /Roteiro sintético anterior/); assert.match(await confirm.innerText(), /Roteiro sintético novo/);
  mkdirSync('.tmp/m5', { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '.tmp/m5/review-mobile-ui-fixture.png', fullPage: true });
  await page.setViewportSize({ width: 1366, height: 900 }); await page.screenshot({ path: '.tmp/m5/review-desktop-ui-fixture.png', fullPage: true });
  await page.locator('#attendance-publish-confirmation').check();
  await confirm.getByRole('button', { name: 'Confirmar publicação', exact: true }).click();
  await page.locator('#notice').filter({ hasText: 'Fixture de indisponibilidade' }).waitFor();
  await confirm.getByRole('button', { name: 'Confirmar publicação', exact: true }).click();
  await page.locator('#notice').filter({ hasText: 'Versão 7001 publicada' }).waitFor();
  assert.equal(publishRequests.length, 2); assert.deepEqual(publishRequests[0], publishRequests[1]);
  uiFixtures.push('Respostas page.route fictícias: dirty bloqueia simulação/publicação; resposta renderizada como texto; diff antes/depois; checkbox empresa/versão; retry503 mantém mesma chave/payload; recibo fictício atualiza UI. Não comprova publicação/simulação real.');

  stage = 'conflito fixture';
  fixture.publication = { ready: true, reason: null, reviewToken: 'c'.repeat(64), changes: [
    { key: 'script', label: 'Roteiro completo da IA', before: 'Antes fixture', after: 'Depois fixture' },
  ] }; fixture.draftVersion = 7002; conflictPublish = true;
  await page.reload(); await page.getByRole('button', { name: 'Revisar publicação', exact: true }).click();
  await page.locator('#attendance-publish-confirmation').check(); await page.getByRole('button', { name: 'Confirmar publicação', exact: true }).click();
  await page.locator('.attendance-conflict').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('button', { name: 'Revisar publicação', exact: true }).isDisabled(), true);
  uiFixtures.push('409 fictício na confirmação invalida revisão e exige recarga; texto salvo permanece. Concorrência real é coberta na integração PostgreSQL.');

  stage = 'troca durante simulação fixture'; conflictPublish = false;
  await page.reload(); await page.locator('#attendance-simulation-message').fill('Simulação retida');
  let release, received;
  holdSimulation = { wait: new Promise((resolve) => { release = resolve; }), started: () => received() };
  const arrived = new Promise((resolve) => { received = resolve; });
  await page.getByRole('button', { name: 'Simular rascunho', exact: true }).click(); await arrived;
  await page.evaluate((company) => { location.hash = `#/companies/${company}`; }, horizonte);
  await page.locator('#company-name').filter({ hasText: 'Horizonte Comércio Demo' }).waitFor(); release();
  await page.locator('#attendance-form').waitFor();
  assert.equal(await page.locator('#attendance-editor').innerText().then((text) => text.includes('Resposta fictícia')), false);
  await page.unroute(pattern);
  uiFixtures.push('Simulação fictícia retida durante troca: cancelamento e descarte impedem resposta da Aurora no workspace real de Horizonte.');
  assert.equal(hash((await adminDraft()).configuration), hash(saved.configuration));
  assert.equal(hash((await adminDraft(horizonte)).configuration), hash(neighbour.configuration));
  assert.equal((await adminCompany()).status, initialCompany.status);
  assert.equal((await read()).activeVersion, originalDto.activeVersion);
  assert.deepEqual(errors, []);
  const proof = { status: 'passed', date: new Date().toISOString(), realServer, uiFixtures,
    limits: ['Preview sem base técnica aprovada e sem dependências externas: publicação/simulação bem-sucedidas no navegador são fixtures explícitas.',
      'Publicação, idempotência, concorrência e revisão do runtime reais precisam das integrações PostgreSQL/Redis separadas.'],
    finalState: 'Roteiro sintético M5 salvo; técnico restaurado; nenhuma publicação/ativação real; permissões M5 liberadas em Aurora; Horizonte intacta.' };
  writeFileSync('.tmp/m5/browser-proof.json', JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof));
} catch (error) {
  console.error(`M5 browser: ${stage}. ${String(error.message).replace(/[A-Za-z0-9_-]{30,}/g, '[redacted]')}`); process.exitCode = 1;
} finally {
  if (restoreDraft && panel && id && adminHeaders) {
    try {
      const current = await (await panel.request.get(`${origin}/api/admin/tenants/${id}/configuration/draft`)).json();
      const restored = await panel.request.put(`${origin}/api/admin/tenants/${id}/configuration/draft`, { headers: adminHeaders,
        data: { draftVersion: current.draftVersion, configuration: restoreDraft } });
      assert.equal(restored.status(), 200); console.log('Rascunho técnico sintético restaurado após interrupção do teste.');
    } catch { console.error('Não foi possível confirmar restauração do rascunho sintético; revisar pelo painel antes de continuar.'); process.exitCode = 1; }
  }
  await browser.close();
}
