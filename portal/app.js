const $ = (id) => document.getElementById(id);
let csrf = null, user = null, companyKey = null;
const incoming = new URLSearchParams(location.hash.slice(1));
let actionToken = incoming.get('verify') || incoming.get('reset');
history.replaceState(null, '', location.pathname);
function notice(message = '', error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function show(id) {
  document.querySelectorAll('.view').forEach((el) => { el.hidden = el.id !== id; });
  $('access-nav').hidden = id === 'home';
  [...$(id).querySelectorAll('input,button')].find((el) => el.getClientRects().length && !el.disabled)?.focus();
}
async function api(path, body, method = 'POST', key) {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: {
    ...(body ? { 'content-type': 'application/json' } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(key ? { 'idempotency-key': key } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    if (response.status === 401) { user = null; csrf = null; $('companies').replaceChildren(); show('login'); }
    throw new Error(data.message || 'Não foi possível concluir. Tente novamente.');
  }
  return data;
}
const account = (path, body, method) => api(`/api/account/v1/${path}`, body, method);
async function home() {
  const session = await account('session', null, 'GET'); user = session.user; csrf = session.csrfToken;
  $('greeting').textContent = `Olá, ${user.name}`;
  $('email-status').textContent = user.verified ? 'E-mail confirmado.' : 'Confira sua caixa de entrada para confirmar o e-mail.';
  $('resend').hidden = user.verified;
  $('company-form').hidden = !user.verified;
  $('profile-form').elements.name.value = user.name;
  const { companies } = await api('/api/app/v1/companies', null, 'GET');
  $('companies').replaceChildren();
  if (!companies.length) $('companies').textContent = 'Você ainda não tem uma empresa.';
  for (const company of companies) {
    const card = document.createElement('div'); card.className = 'company';
    const title = document.createElement('strong'); title.textContent = company.name;
    const state = document.createElement('span'); state.textContent = company.status === 'rascunho' ? 'Rascunho · configuração do atendimento pendente' : `Situação: ${company.status}`;
    card.append(title, state); $('companies').append(card);
  }
  show('home');
}
function form(id, handler) {
  $(id).addEventListener('submit', async (e) => {
    e.preventDefault(); notice();
    const button = e.submitter; if (button) button.disabled = true;
    try { await handler(Object.fromEntries(new FormData(e.currentTarget))); }
    catch (error) { notice(error.message, true); }
    finally { if (button) button.disabled = false; }
  });
}
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => { notice(); show(button.dataset.view); }));
form('register', async (data) => { const result = await account('register', { ...data, acceptedTerms: data.acceptedTerms === 'on' }); $('register').reset(); show('login'); notice(result.message); });
form('login', async (data) => { const result = await account('login', data); csrf = result.csrfToken; $('login').reset(); await home(); });
form('forgot', async (data) => { notice((await account('password/forgot', data)).message); });
form('verify', async () => { await account('email/verify', { token: actionToken }); actionToken = null; show('login'); notice('E-mail confirmado. Entre para continuar.'); });
form('reset', async ({ password, confirmation }) => { if (password !== confirmation) throw new Error('As senhas precisam ser iguais.'); await account('password/reset', { token: actionToken, password }); actionToken = null; $('reset').reset(); show('login'); notice('Senha alterada. Entre novamente.'); });
form('company-form', async (data) => { companyKey ||= crypto.randomUUID(); await api('/api/app/v1/companies', data, 'POST', companyKey); companyKey = null; $('company-form').reset(); await home(); notice('Empresa criada. Seu atendimento permanece em rascunho.'); });
$('company-form').elements.name.addEventListener('input', () => { companyKey = null; });
form('profile-form', async (data) => { await account('profile', data, 'PATCH'); await home(); notice('Perfil atualizado.'); });
form('password-form', async ({ currentPassword, password, confirmation }) => { if (password !== confirmation) throw new Error('As senhas precisam ser iguais.'); await account('password/change', { currentPassword, password }); csrf = null; user = null; $('password-form').reset(); $('companies').replaceChildren(); show('login'); notice('Senha alterada. Entre novamente.'); });
$('resend').addEventListener('click', async () => { try { notice((await account('email/resend', { email: user.email })).message); } catch (error) { notice(error.message, true); } });
$('logout').addEventListener('click', async () => { try { await account('logout', {}); csrf = null; user = null; $('companies').replaceChildren(); show('login'); notice(); } catch (error) { notice(error.message, true); } });
if (actionToken) show(incoming.has('verify') ? 'verify' : 'reset');
else home().catch(() => show('login'));
window.addEventListener('hashchange', () => {
  const link = new URLSearchParams(location.hash.slice(1));
  const value = link.get('verify') || link.get('reset');
  if (!value) return;
  actionToken = value;
  history.replaceState(null, '', location.pathname);
  notice(); show(link.has('verify') ? 'verify' : 'reset');
});
