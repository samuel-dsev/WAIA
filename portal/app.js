import { installSecurity } from './security.js';
import { portalRoute, actionLink, createRequestScope } from './navigation.js';

const $ = (id) => document.getElementById(id);
const scope = createRequestScope();
let csrf = null, user = null, company = null, securityUI;
let route = portalRoute(location.hash) || portalRoute();
let action = actionLink(location.hash);
let dirty = false, visible = 'loading', resumeView = null;
const states = { ativa: 'Ativa', ativo: 'Ativa', active: 'Ativa', suspensa: 'Suspensa', suspenso: 'Suspensa', suspended: 'Suspensa', arquivada: 'Arquivada', rascunho: 'Em preparação', inativo: 'Inativa' };
const statusText = (value) => states[value] || 'Em preparação';
const cancelled = (error) => error?.name === 'AbortError';

function notice(message = '', error = false) {
  $('notice').textContent = message; $('notice').classList.toggle('error', error);
}
function show(id) {
  visible = id;
  document.querySelectorAll('.view').forEach((el) => { el.hidden = el.id !== id; });
  $('account-nav').hidden = !user;
  $('workspace-nav').hidden = !company || !['workspace', 'profile', 'security', 'mfa', 'recovery'].includes(id);
  $('company-name').textContent = company?.name || '';
  document.body.classList.toggle('signed-in', Boolean(user));
  document.title = company ? `${company.name} · WAIA` : 'Meu atendimento · WAIA';
  const focus = $(id).querySelector('h2') || $(id).querySelector('input,button');
  if (focus?.tagName === 'H2') focus.tabIndex = -1;
  focus?.focus();
}
function clearCompany() {
  company = null; $('company-name').textContent = ''; $('workspace-name').textContent = '';
  $('workspace-state').textContent = ''; $('workspace-permissions').replaceChildren();
  $('workspace-nav').hidden = true; document.title = 'Meu atendimento · WAIA';
}
function clearForms() {
  for (const id of ['login', 'forgot', 'activate', 'reset', 'profile-form', 'password-form']) $(id).reset();
}
function begin() {
  scope.reset(); securityUI?.clear(); dirty = false; action = null;
  clearForms(); notice(); show('loading');
}
function clearAccount() {
  scope.reset(); securityUI?.clear(); user = null; csrf = null; dirty = false; action = null;
  clearCompany(); $('companies').replaceChildren(); $('greeting').textContent = '';
  clearForms(); show('login');
}
function setRoute(next) {
  route = next; history.replaceState(null, '', `${location.pathname}${next.hash}`);
}
function canLeave() { return !dirty || window.confirm('Há alterações não salvas. Deseja sair sem salvar?'); }
async function api(path, body, method = 'POST') {
  const request = scope.capture();
  const response = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store', signal: request.signal,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch((error) => { request.check(); throw error; });
  request.check();
  const data = response.status === 204 ? {} : await response.json().catch((error) => { request.check(); throw error; });
  request.check();
  if (!response.ok) {
    if (response.status === 401 && data.code !== 'MFA_INVALID' && user) {
      clearAccount(); notice('Sua sessão terminou. Entre novamente para continuar.', true);
      throw new DOMException('Sessão encerrada.', 'AbortError');
    }
    const error = new Error(data.message || 'Não foi possível concluir. Tente novamente.');
    error.status = response.status; error.code = data.code; throw error;
  }
  return data;
}
const account = (path, body, method) => api(`/api/account/v1/${path}`, body, method);
const report = (error) => { if (!cancelled(error)) notice(error.message || 'Serviço indisponível. Tente novamente.', true); };

async function home({ resume = false } = {}) {
  begin(); clearCompany(); $('companies').replaceChildren();
  try {
    const session = await account('session', null, 'GET'); user = session.user; csrf = session.csrfToken;
    const { companies } = await api('/api/app/v1/companies', null, 'GET');
    $('greeting').textContent = `Olá, ${user.name}`;
    if (!companies.length) {
      const empty = document.createElement('p');
      empty.textContent = 'Seu acesso ainda não tem uma empresa vinculada. Solicite a liberação à administração WAIA.';
      $('companies').append(empty);
    }
    for (const item of companies) {
      const card = document.createElement('article'); card.className = 'company';
      const title = document.createElement('h3'); title.textContent = item.name;
      const state = document.createElement('p'); state.textContent = statusText(item.status);
      const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Abrir atendimento';
      open.setAttribute('aria-label', `Abrir atendimento · ${item.name}`);
      open.addEventListener('click', () => navigate({ hash: `#/companies/${item.id}`, companyId: item.id }));
      card.append(title, state, open); $('companies').append(card);
    }
    if (resume && route.companyId) { await workspace(route); return; }
    setRoute(portalRoute()); show('home');
  } catch (error) {
    if (cancelled(error)) return;
    if (error.status === 401) { clearAccount(); return; }
    clearCompany(); show('unavailable'); report(error);
  }
}
async function workspace(next) {
  begin(); clearCompany(); $('companies').replaceChildren(); setRoute(next);
  try {
    const summary = await api(`/api/app/v1/companies/${next.companyId}`, null, 'GET'); company = summary;
    $('workspace-name').textContent = summary.name; $('workspace-state').textContent = statusText(summary.status);
    for (const [capability, label] of [['attendance.read', 'Consultar atendimento'], ['attendance.edit', 'Editar atendimento'],
      ['attendance.simulate', 'Simular atendimento'], ['attendance.publish', 'Publicar atendimento']]) {
      if (!summary.effectiveCapabilities.includes(capability)) continue;
      const item = document.createElement('li'); item.textContent = label; $('workspace-permissions').append(item);
    }
    $('suspended-note').hidden = !['suspensa', 'suspenso', 'suspended'].includes(summary.status); show('workspace');
  } catch (error) {
    if (cancelled(error)) return;
    clearCompany(); show([403, 404].includes(error.status) ? 'denied' : 'unavailable');
    notice([403, 404].includes(error.status) ? 'Este atendimento não está disponível para o seu acesso. Solicite orientação à administração WAIA.' : 'Não foi possível carregar o atendimento. Tente novamente.', true);
  }
}
async function navigate(next) {
  if (!canLeave()) { setRoute(route); return; }
  if (!user) { setRoute(next); clearAccount(); return; }
  if (next.companyId) await workspace(next); else await home();
}
function form(id, handler) {
  $(id).addEventListener('submit', async (event) => {
    event.preventDefault(); notice(); const button = event.submitter; if (button) button.disabled = true;
    const request = scope.capture();
    try { await handler(Object.fromEntries(new FormData(event.currentTarget))); }
    catch (error) { try { request.check(); report(error); } catch { /* old view */ } }
    finally { if (button) button.disabled = false; }
  });
}
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
  if (!canLeave()) return; begin(); show(button.dataset.view);
}));
document.querySelectorAll('[data-home]').forEach((button) => button.addEventListener('click', () => navigate(portalRoute())));
form('login', async (data) => {
  const result = await account('login', data); $('login').reset();
  if (result.mfaRequired) { securityUI.showChallenge(result); return; }
  csrf = result.csrfToken; user = result.user; await home({ resume: true });
});
form('forgot', async (data) => { notice((await account('password/forgot', data)).message); });
form('verify', async () => {
  await account('email/verify', { token: action?.token }); action = null;
  clearAccount(); notice('E-mail confirmado. Entre para continuar.');
});
for (const id of ['activate', 'reset']) form(id, async ({ password, confirmation }) => {
  if (password !== confirmation) throw new Error('As senhas precisam ser iguais.');
  await account(id === 'activate' ? 'activate' : 'password/reset', { token: action?.token, password });
  action = null; $(id).reset(); clearAccount();
  notice(id === 'activate' ? 'Acesso ativado. Entre com seu e-mail e a senha que acabou de definir.' : 'Senha alterada. Entre novamente.');
});
$('profile-open').addEventListener('click', () => {
  if (!canLeave()) return; begin(); $('profile-form').elements.name.value = user.name; show('profile');
});
form('profile-form', async (data) => {
  const result = await account('profile', data, 'PATCH'); user = result.user;
  dirty = $('profile-form').elements.name.value !== data.name || [...$('password-form').querySelectorAll('input')].some((input) => input.value);
  notice('Nome atualizado.');
});
form('password-form', async ({ currentPassword, password, confirmation }) => {
  if (password !== confirmation) throw new Error('As senhas precisam ser iguais.');
  await account('password/change', { currentPassword, password }); clearAccount(); notice('Senha alterada. Entre novamente.');
});
$('profile').addEventListener('input', () => { dirty = true; });
$('logout').addEventListener('click', async () => {
  if (!canLeave()) return;
  begin(); clearCompany(); $('companies').replaceChildren();
  user = null; show('loading');
  try { await account('logout', {}); setRoute(portalRoute()); clearAccount(); notice('Você saiu da conta.'); }
  catch (error) { if (!cancelled(error)) { clearAccount(); notice('Não foi possível confirmar a saída. Entre novamente para encerrar a sessão.', true); } }
});
securityUI = installSecurity({ $, account, home: () => home({ resume: true }), show, notice, form,
  getUser: () => user, onLogin: (result) => { csrf = result.csrfToken; user = result.user; },
  isCurrent: () => Boolean(user) || visible === 'mfa',
  beforeOpen: canLeave, onOpen: begin,
});
$('retry').addEventListener('click', () => user && route.companyId ? workspace(route) : home({ resume: true }));
function receiveLocation() {
  const next = portalRoute(location.hash);
  if (next) { void navigate(next); return; }
  if (!canLeave()) { setRoute(route); return; }
  const link = actionLink(location.hash);
  if (link) {
    begin(); clearCompany(); $('companies').replaceChildren(); user = null; csrf = null;
    action = link; history.replaceState(null, '', location.pathname); show(link.purpose); return;
  }
  setRoute(portalRoute()); void home();
}
window.addEventListener('hashchange', receiveLocation);
window.addEventListener('beforeunload', (event) => { if (user && dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { clearAccount(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) void home({ resume: true }); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && user) {
    resumeView = visible; scope.reset(); show('loading'); document.title = 'Meu atendimento · WAIA';
  } else if (!document.hidden && user) {
    void (async () => {
      try {
        const session = await account('session', null, 'GET');
        if (session.user.id !== user?.id || session.csrfToken !== csrf) {
          clearAccount(); user = session.user; csrf = session.csrfToken;
          await home({ resume: true }); return;
        }
        user = session.user; csrf = session.csrfToken;
        if (company) await api(`/api/app/v1/companies/${company.id}`, null, 'GET');
        if (['profile', 'security', 'mfa', 'recovery'].includes(resumeView)) show(resumeView);
        else await home({ resume: true });
      } catch (error) {
        if (cancelled(error)) return;
        if ([403, 404].includes(error.status)) { begin(); clearCompany(); show('denied'); }
        else { show('unavailable'); report(error); }
      }
    })();
  }
});
if (action) { history.replaceState(null, '', location.pathname); show(action.purpose); }
else { setRoute(route); void home({ resume: true }); }
