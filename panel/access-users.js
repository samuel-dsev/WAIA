const CAPABILITIES = Object.freeze([
  ['attendance.read', 'Consultar atendimento'], ['attendance.edit', 'Editar e salvar rascunho'],
  ['attendance.simulate', 'Simular atendimento'], ['attendance.publish', 'Publicar atendimento'],
]);
const CAPABILITY_LABELS = Object.fromEntries(CAPABILITIES);
const STATUS_LABELS = { ativo: 'Ativo', bloqueado: 'Suspenso globalmente', desativado: 'Desativado' };
const DELIVERY_LABELS = { none: 'Sem envio', pending: 'Aguardando envio', sending: 'Em processamento',
  accepted: 'Aceito pelo provedor', sent: 'Aceito pelo provedor', failed: 'Falha no envio', expired: 'Prazo encerrado' };
const text = (tag, value, className = '') => {
  const element = document.createElement(tag); element.textContent = value; element.className = className; return element;
};
const button = (label, onClick, className = 'button button-secondary') => {
  const element = text('button', label, className); element.type = 'button';
  if (onClick) element.addEventListener('click', onClick); return element;
};
const input = (type, name, value = '') => {
  const element = document.createElement('input'); Object.assign(element, { type, name, value }); return element;
};
const field = (label, control) => {
  const wrapper = text('div', '', 'field'); const labelElement = text('label', label);
  control.id ||= `access-${control.name}-${crypto.randomUUID()}`; labelElement.htmlFor = control.id;
  wrapper.append(labelElement, control); return wrapper;
};
const capabilitySummary = (values) => (values || []).filter((value) => CAPABILITY_LABELS[value]).map((value) => CAPABILITY_LABELS[value]).join(', ') || 'Nenhuma capacidade';

export function createAccessUsersPanel({ root, apiFetch, confirmAction, toast, getTenants,
  onSessionExpired = () => {} }) {
  let disposed = false, busy = false, dirty = false, empresaId = '', readSignal, sequence = 0;
  let page = 1, pageSize = 20, search = '', status = '', detailSequence = 0;
  let dialog, dialogContent, dialogTitle, dialogError, reauthDialog;
  const intents = new Map();
  const disabledBeforeBusy = new WeakMap();
  const isCurrent = (id) => !disposed && !readSignal?.aborted && id === sequence;

  function intent(path, method, body) {
    const fingerprint = JSON.stringify([path, method, body]);
    if (!intents.has(fingerprint)) {
      if (intents.size >= 50) intents.delete(intents.keys().next().value);
      intents.set(fingerprint, crypto.randomUUID());
    }
    return { fingerprint, key: intents.get(fingerprint) };
  }
  function showError(error, target = dialogError) {
    if (error?.name === 'AbortError' || disposed) return;
    if (error?.status === 401) return onSessionExpired();
    const message = error?.code === 'ACCESS_VERSION_CONFLICT'
      ? 'Este acesso mudou. Recarregue os dados e revise a operação antes de tentar novamente.'
      : error?.message || 'Não foi possível concluir a operação. Tente novamente.';
    if (target) { target.textContent = message; target.hidden = false; }
    else toast(message);
  }
  function controlsDisabled(value) {
    const controls = [...root.querySelectorAll('button,input,select,textarea'), ...(dialog?.querySelectorAll('button,input,select,textarea') || [])];
    for (const element of controls) {
      if (value) {
        if (!disabledBeforeBusy.has(element)) disabledBeforeBusy.set(element, element.disabled);
        element.disabled = true;
      } else if (disabledBeforeBusy.has(element)) {
        element.disabled = disabledBeforeBusy.get(element); disabledBeforeBusy.delete(element);
      }
    }
  }
  function closeDialog(force = false) {
    if (!force && busy) { toast('Aguarde a conclusão da operação.'); return; }
    if (dialog?.open) dialog.close();
    if (dialogContent) dialogContent.replaceChildren();
    dirty = false; detailSequence += 1;
  }
  async function canLeave() {
    if (busy) { toast('Aguarde a conclusão da operação.'); return false; }
    if (dirty && !await confirmAction('Há alterações de acesso que ainda não foram salvas. Deseja descartá-las?', 'Alterações não salvas')) return false;
    closeDialog(true); return true;
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = text('dialog', '', 'access-dialog');
    dialogTitle = text('h2', 'Acesso'); dialogTitle.id = `access-title-${crypto.randomUUID()}`;
    dialog.setAttribute('aria-labelledby', dialogTitle.id);
    const card = text('div', '', 'dialog-card dialog-wide');
    const heading = text('div', '', 'dialog-heading');
    const close = button('Fechar', async () => { if (await canLeave()) closeDialog(true); }, 'button button-quiet');
    heading.append(dialogTitle, close); dialogError = text('p', '', 'alert alert-error');
    dialogError.setAttribute('role', 'alert'); dialogError.hidden = true;
    dialogContent = text('div', '', 'access-dialog-content'); card.append(heading, dialogError, dialogContent); dialog.append(card);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); canLeave(); });
    dialog.addEventListener('close', () => { dirty = false; });
    document.body.append(dialog);
  }
  function displayDialog(title) {
    ensureDialog(); dialogTitle.textContent = title; dialogError.hidden = true; dialogContent.replaceChildren(); dirty = false;
    if (!dialog.open) dialog.showModal();
  }
  async function reauthenticate() {
    return new Promise((resolve) => {
      const modal = text('dialog', '', 'access-reauth-dialog'); reauthDialog = modal;
      const form = text('form', '', 'dialog-card');
      const title = text('h2', 'Confirme sua identidade'); title.id = `access-reauth-${crypto.randomUUID()}`;
      modal.setAttribute('aria-labelledby', title.id);
      const password = input('password', 'password'); password.required = true; password.maxLength = 256; password.autocomplete = 'current-password';
      const code = input('text', 'code'); code.required = true; code.maxLength = 32; code.autocomplete = 'one-time-code';
      const error = text('p', '', 'alert alert-error'); error.setAttribute('role', 'alert'); error.hidden = true;
      const submit = button('Confirmar identidade', null, 'button button-primary'); submit.type = 'submit';
      const actions = text('div', '', 'dialog-actions'); actions.append(button('Cancelar', () => finish(false)), submit);
      form.append(title, text('p', 'Informe sua senha e um código do autenticador ou de recuperação para concluir esta ação.'),
        field('Senha atual', password), field('Código de autenticação', code), error, actions); modal.append(form);
      let finished = false;
      function finish(value) {
        if (finished) return; finished = true; password.value = ''; code.value = '';
        if (modal.open) modal.close(); modal.remove(); if (reauthDialog === modal) reauthDialog = null; resolve(value);
      }
      modal.addEventListener('cancel', (event) => { event.preventDefault(); if (!submit.disabled) finish(false); });
      modal.addEventListener('close', () => finish(false));
      form.addEventListener('submit', async (event) => {
        event.preventDefault(); if (!form.reportValidity()) return; submit.disabled = true; error.hidden = true;
        try {
          await apiFetch('/auth/reauthenticate', { method: 'POST', body: { password: password.value, code: code.value.trim() } });
          finish(true);
        } catch (failure) {
          password.value = ''; code.value = '';
          if (failure.status === 401 && failure.code === 'AUTHENTICATION_REQUIRED') { finish(false); onSessionExpired(); }
          else { error.textContent = failure.message || 'Não foi possível confirmar sua identidade.'; error.hidden = false; password.focus(); }
        } finally { submit.disabled = false; }
      });
      document.body.append(modal); modal.showModal(); password.focus();
    });
  }
  async function mutate(path, method, body) {
    const request = intent(path, method, body);
    const options = { method, body, headers: { 'Idempotency-Key': request.key } };
    busy = true; controlsDisabled(true); dialogError && (dialogError.hidden = true);
    try {
      let payload;
      try { payload = await apiFetch(path, options); }
      catch (error) {
        if (error.status !== 403 || error.code !== 'REAUTH_REQUIRED') throw error;
        if (!await reauthenticate()) return null;
        // Reauthentication retries exactly the same intent, payload and key.
        payload = await apiFetch(path, options);
      }
      intents.delete(request.fingerprint); dirty = false; return payload;
    } catch (error) { showError(error); return null; }
    finally { busy = false; controlsDisabled(false); }
  }
  async function presentMutation(payload, message) {
    // Keep the complete refresh/detail transition atomic. A newly rendered row
    // must not permit a second form before this operation presents its result.
    busy = true; controlsDisabled(true); closeDialog(true);
    try {
      toast(message);
      await loadList();
      if (!disposed && !readSignal?.aborted) await showUser(payload.user);
    } finally { busy = false; controlsDisabled(false); }
  }
  function capabilityPicker(selected = [], { disabled = false } = {}) {
    const fieldset = text('fieldset', '', 'access-capabilities'); fieldset.append(text('legend', 'Permissões de atendimento'));
    const checkboxes = CAPABILITIES.map(([value, label]) => {
      const checkbox = input('checkbox', 'capabilities', value); checkbox.checked = selected.includes(value); checkbox.disabled = disabled;
      const wrapper = text('label', '', 'access-check'); wrapper.append(checkbox, text('span', label)); fieldset.append(wrapper); return checkbox;
    });
    return { element: fieldset, values: () => checkboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value),
      enable: (value) => checkboxes.forEach((checkbox) => { checkbox.disabled = !value; }) };
  }
  function observeForm(form) {
    form.addEventListener('input', () => { dirty = true; }); form.addEventListener('change', () => { dirty = true; });
  }
  function tenantChoices() {
    return (getTenants() || []).filter((tenant) => tenant?.id).map((tenant) => ({ id: String(tenant.id), name: tenant.name || tenant.displayName || 'Empresa' }));
  }
  async function createAccess() {
    if (!await canLeave()) return;
    displayDialog('Criar ou vincular acesso');
    const form = document.createElement('form'); const name = input('text', 'name'); name.required = true; name.maxLength = 160; name.minLength = 2; name.autocomplete = 'name';
    const email = input('email', 'email'); email.required = true; email.maxLength = 254; email.autocomplete = 'email';
    form.append(field('Nome da pessoa', name), field('E-mail de acesso', email),
      text('p', 'Se o e-mail já tiver um acesso, os novos vínculos serão acrescentados sem alterar nome, senha ou autenticação dessa pessoa.', 'muted'),
      text('h3', 'Empresas e permissões'), text('p', 'É permitido criar um acesso sem empresa. Selecione somente as permissões que deseja liberar.', 'muted'));
    const choices = [];
    for (const tenant of tenantChoices()) {
      const card = text('div', '', 'access-company-choice'); const selected = input('checkbox', 'company', tenant.id); selected.checked = tenant.id === empresaId;
      const label = text('label', '', 'access-check access-company-label'); label.append(selected, text('strong', tenant.name));
      const picker = capabilityPicker(['attendance.read'], { disabled: !selected.checked });
      selected.addEventListener('change', () => picker.enable(selected.checked)); card.append(label, picker.element); form.append(card);
      choices.push({ tenant, selected, picker });
    }
    if (!choices.length) form.append(text('p', 'Nenhuma empresa cadastrada. O acesso será criado sem vínculos.', 'muted'));
    const actions = text('div', '', 'dialog-actions'); const submit = button('Revisar e salvar acesso', null, 'button button-primary'); submit.type = 'submit';
    actions.append(button('Cancelar', () => canLeave()), submit); form.append(actions); observeForm(form);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (!form.reportValidity() || busy) return;
      const companies = choices.filter((item) => item.selected.checked).map((item) => ({ empresaId: item.tenant.id, status: 'ativo', capabilities: item.picker.values() }));
      const summary = companies.length ? choices.filter((item) => item.selected.checked).map((item) => `${item.tenant.name}: ${capabilitySummary(item.picker.values())}`).join('; ') : 'Sem empresas vinculadas';
      if (!await confirmAction(`${email.value.trim()} — ${summary}. Confirma a criação ou reutilização deste acesso?`, 'Revisar acesso e permissões')) return;
      const payload = await mutate('/access-users', 'POST', { name: name.value.trim(), email: email.value.trim().toLowerCase(), companies });
      if (!payload) return;
      await presentMutation(payload, payload.existing ? 'Acesso existente reutilizado; vínculos revisados.' : 'Acesso criado. Ativação enfileirada para envio.');
    });
    dialogContent.append(form); name.focus();
  }
  function deliveryNode(delivery) {
    const panel = text('div', '', 'access-delivery');
    panel.append(text('strong', DELIVERY_LABELS[delivery?.status] || 'Sem envio'),
      text('span', delivery?.purpose === 'reset' ? 'Recuperação de acesso' : ['activate', 'activation'].includes(delivery?.purpose) ? 'Ativação do acesso' : 'Entrega transacional'));
    if (Number.isInteger(delivery?.attempts)) panel.append(text('small', `${delivery.attempts} tentativa(s)`));
    if (['accepted', 'sent'].includes(delivery?.status)) panel.append(text('small', 'Aceitação pelo provedor não confirma recebimento do e-mail.'));
    return panel;
  }
  async function action(user, actionName, label, { identityConfirmed = false } = {}) {
    if (!await confirmAction(`${label} para ${user.email}? A alteração será auditada.`, label)) return;
    const payload = await mutate(`/access-users/${encodeURIComponent(user.id)}/${actionName}`, 'POST',
      { expectedVersion: user.version, ...(identityConfirmed ? { identityConfirmed: true } : {}) });
    if (payload) await presentMutation(payload, 'Solicitação registrada. Confira o estado atualizado da entrega ou do acesso.');
  }
  async function openUser(id) {
    if (!await canLeave()) return;
    const requestId = ++detailSequence;
    displayDialog('Acesso'); dialogContent.append(text('p', 'Carregando acesso…'));
    try {
      const user = await apiFetch(`/access-users/${encodeURIComponent(id)}`, { signal: readSignal });
      if (!disposed && !readSignal?.aborted && dialog.open && requestId === detailSequence) await showUser(user);
    } catch (error) { if (requestId === detailSequence) showError(error); }
  }
  async function showUser(user) {
    if (!user || disposed) return;
    displayDialog(user.name || 'Acesso');
    dialogContent.append(text('p', user.email, 'access-email'));
    const summary = text('dl', '', 'detail-list');
    for (const [label, value] of [['Conta', STATUS_LABELS[user.status] || 'Indisponível'],
      ['Ativação', user.activationStatus === 'pending' ? 'Pendente de ativação' : 'Ativação concluída'],
      ['Autenticação em duas etapas', user.mfaEnabled ? 'Habilitada' : 'Não habilitada']]) summary.append(text('dt', label), text('dd', value));
    dialogContent.append(summary, text('h3', 'Empresas vinculadas'));
    const list = text('div', '', 'access-memberships');
    for (const membership of user.companies || []) {
      const card = text('section', '', 'access-membership');
      const info = text('div', '', 'access-membership-info'); info.append(text('h4', membership.name || 'Empresa'),
        text('p', membership.status === 'suspenso' ? 'Vínculo suspenso' : 'Vínculo ativo'), text('p', capabilitySummary(membership.capabilities), 'muted'));
      const actions = text('div', '', 'access-row-actions'); actions.append(button('Alterar vínculo', () => editMembership(user, membership)),
        button('Remover vínculo', async () => {
          if (!await confirmAction(`Remover o acesso de ${user.email} a ${membership.name}? A identidade e o histórico serão preservados.`, 'Remover vínculo')) return;
          const payload = await mutate(`/access-users/${encodeURIComponent(user.id)}/companies/${encodeURIComponent(membership.empresaId)}`, 'DELETE', { expectedVersion: user.version });
          if (payload) await presentMutation(payload, 'Vínculo removido.');
        }, 'button button-danger'));
      card.append(info, actions); list.append(card);
    }
    if (!list.children.length) list.append(text('p', 'Este acesso não possui empresas vinculadas.', 'muted'));
    dialogContent.append(list, button('Vincular empresa', () => editMembership(user)));
    const operations = text('section', '', 'access-identity-operations'); operations.append(text('h3', 'Estado global e segurança'),
      text('p', 'Suspender a conta impede acesso a todas as empresas. A suspensão de um vínculo afeta somente aquela empresa.', 'muted'));
    const select = document.createElement('select'); select.name = 'identityStatus';
    for (const [value, label] of Object.entries(STATUS_LABELS)) select.append(new Option(label, value)); select.value = user.status;
    select.addEventListener('change', () => { dirty = select.value !== user.status; });
    const statusRow = text('div', '', 'access-status-row'); statusRow.append(field('Estado da conta', select), button('Alterar estado global', async () => {
      if (select.value === user.status) return toast('Selecione um estado diferente.');
      if (!await confirmAction(`Alterar a conta ${user.email} para ${STATUS_LABELS[select.value]}? Esta ação afeta todas as empresas vinculadas.`, 'Alterar estado global')) return;
      const payload = await mutate(`/access-users/${encodeURIComponent(user.id)}`, 'PATCH', { expectedVersion: user.version, status: select.value });
      if (payload) await presentMutation(payload, 'Estado global atualizado.');
    })); operations.append(statusRow);
    const securityActions = text('div', '', 'access-row-actions');
    if (user.activationStatus === 'pending') securityActions.append(button('Enviar ou reenviar ativação', () => action(user, 'activation', 'Emitir ativação')));
    securityActions.append(button('Revogar sessões', () => action(user, 'revoke-sessions', 'Revogar todas as sessões'), 'button button-danger'));
    const confirmed = input('checkbox', 'identityConfirmed');
    const confirmation = text('label', '', 'access-check'); confirmation.append(confirmed, text('span', 'Confirmei a titularidade para solicitar recuperação de acesso.'));
    const reset = button('Solicitar recuperação', () => {
      if (!confirmed.checked) { toast('Confirme a titularidade antes de solicitar a recuperação.'); confirmed.focus(); return; }
      action(user, 'reset', 'Solicitar recuperação de acesso', { identityConfirmed: true });
    }); operations.append(securityActions, confirmation, reset, text('h3', 'Última entrega'), deliveryNode(user.delivery));
    operations.append(button('Recarregar dados do acesso', () => openUser(user.id), 'button button-quiet')); dialogContent.append(operations);
  }
  async function editMembership(user, membership = null) {
    if (!await canLeave()) return;
    displayDialog(membership ? 'Alterar vínculo e permissões' : 'Vincular empresa');
    const form = document.createElement('form');
    const select = document.createElement('select'); select.name = 'empresaId'; select.required = true;
    select.append(new Option('Selecione uma empresa', ''));
    const linkedIds = new Set((user.companies || []).map((item) => item.empresaId));
    const available = tenantChoices().filter((tenant) => membership?.empresaId === tenant.id || !linkedIds.has(tenant.id));
    if (membership && !available.some((tenant) => tenant.id === membership.empresaId)) available.push({ id: membership.empresaId, name: membership.name });
    for (const tenant of available) select.append(new Option(tenant.name, tenant.id));
    if (membership) { select.value = membership.empresaId; select.disabled = true; }
    const statusSelect = document.createElement('select'); statusSelect.name = 'membershipStatus';
    statusSelect.append(new Option('Ativo', 'ativo'), new Option('Suspenso', 'suspenso')); statusSelect.value = membership?.status || 'ativo';
    const picker = capabilityPicker(membership?.capabilities || ['attendance.read']);
    form.append(text('p', user.email), field('Empresa', select), field('Estado do vínculo', statusSelect), picker.element,
      text('p', 'Simular e publicar também dependem do estado e dos recursos habilitados da empresa.', 'muted'));
    const actions = text('div', '', 'dialog-actions'); const submit = button('Revisar e salvar vínculo', null, 'button button-primary'); submit.type = 'submit';
    submit.disabled = !available.length; actions.append(button('Voltar ao acesso', async () => { if (await canLeave()) await showUser(user); }), submit); form.append(actions);
    observeForm(form);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (!form.reportValidity() || busy) return;
      const tenant = available.find((item) => item.id === select.value); if (!tenant) return;
      const capabilities = picker.values();
      if (!await confirmAction(`${user.email} em ${tenant.name}: vínculo ${statusSelect.value === 'ativo' ? 'ativo' : 'suspenso'}; ${capabilitySummary(capabilities)}. Confirma?`, 'Revisar vínculo')) return;
      const payload = await mutate(`/access-users/${encodeURIComponent(user.id)}/companies/${encodeURIComponent(tenant.id)}`, 'PUT',
        { expectedVersion: user.version, status: statusSelect.value, capabilities });
      if (payload) await presentMutation(payload, 'Vínculo atualizado.');
    });
    if (!available.length) form.prepend(text('p', 'Todas as empresas disponíveis já estão vinculadas a esta pessoa.', 'muted'));
    dialogContent.append(form); select.focus();
  }
  async function loadList() {
    const requestId = ++sequence;
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search) params.set('search', search); if (status) params.set('status', status); if (empresaId) params.set('empresaId', empresaId);
    try {
      const payload = await apiFetch(`/access-users?${params}`, { signal: readSignal });
      if (!isCurrent(requestId)) return;
      renderList(payload);
    } catch (error) {
      if (!isCurrent(requestId)) return;
      root.replaceChildren(); const message = text('p', '', 'alert alert-error'); message.setAttribute('role', 'alert'); root.append(message, button('Tentar novamente', loadList)); showError(error, message);
      if (busy) controlsDisabled(true);
    }
  }
  function renderList(payload) {
    root.replaceChildren(); root.classList.add('access-users');
    const tools = text('div', '', 'access-toolbar');
    const filter = text('form', '', 'access-filter'); const searchInput = input('search', 'search', search); searchInput.maxLength = 120;
    const select = document.createElement('select'); select.name = 'status'; select.append(new Option('Todos os estados', ''));
    for (const [value, label] of Object.entries(STATUS_LABELS)) select.append(new Option(label, value)); select.value = status;
    const apply = button('Pesquisar', null, 'button button-primary'); apply.type = 'submit';
    filter.append(field('Nome ou e-mail', searchInput), field('Estado da conta', select), apply);
    filter.addEventListener('submit', (event) => { event.preventDefault(); search = searchInput.value.trim(); status = select.value; page = 1; loadList(); });
    tools.append(filter, button(empresaId ? 'Criar ou vincular acesso' : 'Novo acesso', createAccess, 'button button-primary')); root.append(tools);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    if (!items.length) root.append(text('p', 'Nenhum acesso encontrado para os filtros atuais.', 'state-card'));
    else {
      const wrap = text('div', '', 'table-wrap'); const table = text('table', '', 'data-table');
      table.append(text('caption', empresaId ? 'Usuários com acesso à empresa selecionada' : 'Acessos da instalação', 'visually-hidden'));
      const head = document.createElement('thead'); const headings = document.createElement('tr');
      for (const title of ['Pessoa', 'Conta', 'Ativação', 'Empresas', 'Última entrega', 'Ações']) headings.append(text('th', title)); head.append(headings); table.append(head);
      const body = document.createElement('tbody');
      for (const user of items) {
        const row = document.createElement('tr'); const person = text('td', '', 'access-person'); person.dataset.label = 'Pessoa'; person.append(text('strong', user.name), text('span', user.email)); row.append(person);
        const values = [['Conta', STATUS_LABELS[user.status] || 'Indisponível'], ['Ativação', user.activationStatus === 'pending' ? 'Pendente' : 'Concluída'],
          ['Empresas', String(user.companies?.length ?? user.companiesCount ?? 0)], ['Última entrega', DELIVERY_LABELS[user.delivery?.status] || 'Sem envio']];
        for (const [label, value] of values) { const cell = text('td', value); cell.dataset.label = label; row.append(cell); }
        const actions = document.createElement('td'); actions.dataset.label = 'Ações'; const open = button('Gerenciar acesso', () => openUser(user.id));
        open.setAttribute('aria-label', `Gerenciar acesso de ${user.name || user.email}`); actions.append(open); row.append(actions); body.append(row);
      }
      table.append(body); wrap.append(table); root.append(wrap);
    }
    const meta = payload?.pagination || { page, pageSize, total: items.length, totalPages: 1 };
    page = Number(meta.page) || 1;
    const pagination = text('nav', '', 'pagination access-pagination'); pagination.setAttribute('aria-label', 'Paginação de acessos');
    const previous = button('Anterior', () => { page = Math.max(1, page - 1); loadList(); }); previous.disabled = page <= 1;
    const next = button('Próxima', () => { page += 1; loadList(); }); next.disabled = page >= Number(meta.totalPages || 1);
    const description = text('span', `Página ${page} de ${meta.totalPages || 1} · ${meta.total || 0} acesso(s)`); description.setAttribute('aria-live', 'polite');
    pagination.append(previous, description, next); root.append(pagination);
    if (busy) controlsDisabled(true);
  }
  return {
    async render({ empresaId: selectedEmpresaId = '', signal } = {}) {
      empresaId = selectedEmpresaId; readSignal = signal; page = 1;
      const loading = text('p', 'Carregando acessos…', 'state-card'); loading.setAttribute('role', 'status'); root.replaceChildren(loading);
      await loadList();
    },
    canLeave,
    hasUnsavedChanges: () => dirty || busy,
    dispose() { disposed = true; sequence += 1; dirty = false; closeDialog(true); dialog?.remove(); reauthDialog?.close(); reauthDialog?.remove(); root.classList.remove('access-users'); intents.clear(); },
  };
}
