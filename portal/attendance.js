import { createAttendanceScriptEditor } from '/panel/attendance-script.js';

const definitions = [
  ['greeting', 'Saudação', 1000], ['fallbackMessage', 'Resposta padrão', 1000],
  ['timezone', 'Fuso horário', 80, 'timezone'], ['schedules', 'Horários de atendimento', 300, 'lines'],
  ['publicRules', 'Regras e informações públicas', 1000, 'lines'], ['establishmentRules', 'Orientações do estabelecimento', 10000],
  ['script', 'Roteiro completo da IA', 20000], ['tone', 'Tom do atendimento', 2000],
  ['aiFallback', 'Mensagem quando não for possível responder', 1000], ['followUp', 'Pergunta de continuidade', 300],
  ['qualificationCriteria', 'Critérios de qualificação', 2000], ['qualificationClosing', 'Encerramento da qualificação', 1000],
  ['handoffMessage', 'Mensagem de encaminhamento humano', 1000], ['salesInterestMessage', 'Mensagem de interesse comercial', 1000],
];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const featureStates = { disabled: 'Não liberado', draft: 'Preparado no rascunho', needs_admin: 'Precisa de liberação administrativa', suspended: 'Empresa suspensa', ready: 'Disponível no atendimento' };
const element = (tag, text, className = '') => {
  const result = document.createElement(tag); result.textContent = text; result.className = className; return result;
};
export function createAttendanceEditor({ root, initial, companyId, api, onDirty, notice, onAccessDenied, onChange = () => {} }) {
  let model = initial, epoch = 0, scriptEditor, disposed = false, busy = false, publicationBlocked = false, catalogChanged = false;
  const controls = new Map(), replies = new Map();
  let form, status, conflict, save, reload, localDirty = false;
  let simulate, simulationMessage, simulationReply, publicationNote, review, confirmation, publish, accepted;
  let publicationAttempt = null;
  let resourcesSection;
  const path = `/api/app/v1/companies/${companyId}/attendance`;
  const values = () => {
    const changes = {};
    for (const [key, { input, kind }] of controls) {
      const value = kind === 'lines' ? input.value.split('\n').map((line) => line.trim()).filter(Boolean) : input.value;
      if (!same(value, model.fields[key])) changes[key] = value;
    }
    const changedReplies = [];
    for (const [key, input] of replies) if (input.value !== model.replies.find((reply) => reply.key === key)?.text) changedReplies.push({ key, text: input.value });
    if (changedReplies.length) changes.replies = changedReplies;
    return changes;
  };
  function changed() {
    for (const [key, { input, kind }] of controls) {
      const definition = definitions.find(([name]) => name === key), max = definition[2];
      let error = '';
      if (['script', 'qualificationCriteria'].includes(key) && !input.value.trim()) error = 'Preencha este campo antes de salvar.';
      if (kind === 'lines') {
        const lines = input.value.split('\n').map((line) => line.trim()).filter(Boolean);
        if (lines.length > (key === 'schedules' ? 50 : 100) || lines.some((line) => line.length > max)) error = 'Revise o número de linhas e o limite de caracteres indicado abaixo.';
      }
      if (kind === 'timezone') {
        try { new Intl.DateTimeFormat('pt-BR', { timeZone: input.value }).format(); }
        catch { error = 'Informe um fuso válido, como America/Sao_Paulo.'; }
      }
      input.setCustomValidity(error);
    }
    localDirty = Object.keys(values()).length > 0; onDirty(localDirty);
    if (localDirty && confirmation) { confirmation.hidden = true; accepted.checked = false; }
    refreshActions();
  }
  function refreshActions() {
    if (!model || disposed) return;
    const saved = !localDirty && !publicationBlocked;
    if (simulate) simulate.disabled = busy || !saved || !model.canSimulate;
    if (review) review.disabled = busy || !saved || !model.canPublish || !model.publication?.ready;
    if (publish) publish.disabled = busy || !saved || !model.canPublish || !model.publication?.ready || !accepted.checked;
    if (save) save.disabled = busy || !model.canEdit || catalogChanged;
    if (publicationNote) publicationNote.textContent = localDirty
      ? 'Salve as alterações antes de simular ou revisar a publicação.'
      : publicationBlocked ? 'Recarregue a versão atual antes de simular ou publicar.'
        : model.publication?.reason || 'Revise as alterações salvas antes de publicar.';
  }
  function setBusy(value) {
    busy = value;
    root.querySelectorAll('input,textarea,button').forEach((input) => { input.disabled = value; });
    refreshActions();
  }
  function showConflict() {
    publicationBlocked = true;
    if (confirmation) { confirmation.hidden = true; accepted.checked = false; }
    conflict.hidden = false;
    conflict.textContent = 'Este rascunho mudou em outra sessão. Seus textos continuam nesta tela. Recarregue a versão atual para revisar antes de salvar novamente.';
    refreshActions();
  }
  function render(data) {
    onChange(data);
    scriptEditor?.dispose(); model = data; controls.clear(); replies.clear(); root.replaceChildren();
    simulate = simulationMessage = simulationReply = publicationNote = review = confirmation = publish = accepted = null;
    busy = false; publicationBlocked = false; catalogChanged = false; publicationAttempt = null;
    localDirty = false; onDirty(false);
    const title = element('h3', 'Atendimento');
    status = element('p', `Rascunho ${data.draftVersion} · ${data.activeVersion ? `Publicado: versão ${data.activeVersion}` : 'Ainda não publicado'}`, 'attendance-state');
    root.append(title, status);
    if (data.savedAt) root.append(element('p', `Último salvamento: ${new Date(data.savedAt).toLocaleString('pt-BR')}${data.savedBy ? ` · ${data.savedBy}` : ''}`, 'help'));
    if (data.publishedAt) root.append(element('p', `Publicado em ${new Date(data.publishedAt).toLocaleString('pt-BR')}${data.publishedBy ? ` · ${data.publishedBy}` : ''}`, 'help'));
    root.append(element('p', 'Salvar prepara um rascunho. A versão publicada e o atendimento em uso permanecem como estão.', 'help'));
    if (!data.canEdit) root.append(element('p', 'Seu acesso permite somente consulta. Solicite permissão de edição à administração WAIA.', 'attendance-info'));
    resourcesSection = element('section', ''); resourcesSection.id = 'attendance-resources';
    resourcesSection.setAttribute('aria-label', 'Recursos do atendimento'); root.append(resourcesSection); renderResources(data.resources);
    form = document.createElement('form'); form.id = 'attendance-form';
    for (const [key, label, maxLength, kind = 'text'] of definitions) {
      if (!Object.hasOwn(data.fields, key)) continue;
      const limits = data.resources?.fieldLimits?.[key];
      const characters = Number.isSafeInteger(limits?.maxCharacters) ? limits.maxCharacters : maxLength;
      const maxItems = Number.isSafeInteger(limits?.maxItems) ? limits.maxItems : key === 'schedules' ? 50 : 100;
      const fieldEditable = data.canEdit && data.resources?.features?.find((feature) => feature.fields?.includes(key))?.canEdit !== false;
      let input;
      if (key === 'script') {
        scriptEditor = createAttendanceScriptEditor({ value: data.fields[key], readOnly: !fieldEditable, onInput: changed });
        input = scriptEditor.textarea; input.dataset.field = 'script'; form.append(scriptEditor.root);
      } else {
        const wrapper = element('label', label); input = document.createElement(kind === 'timezone' ? 'input' : 'textarea');
        input.id = `attendance-${key}`; input.name = key;
        input.value = kind === 'lines' ? data.fields[key].join('\n') : data.fields[key];
        input.maxLength = kind === 'lines' ? (characters + 1) * maxItems : characters;
        if (input.tagName === 'TEXTAREA') input.rows = key === 'establishmentRules' ? 5 : 3;
        input.readOnly = !fieldEditable; input.addEventListener('input', changed); wrapper.append(input);
        form.append(wrapper);
      }
      const help = element('small', kind === 'lines' ? `Uma informação por linha. Até ${maxItems} linhas de ${characters} caracteres.` : `Até ${characters.toLocaleString('pt-BR')} caracteres.`);
      help.id = `attendance-${key}-guidance`;
      if (data.resources?.guidance?.[key]) help.append(document.createTextNode(` ${data.resources.guidance[key]}`));
      input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), help.id].filter(Boolean).join(' '));
      if (key === 'script') scriptEditor.root.append(help); else input.parentElement.append(help);
      input.required = ['script', 'qualificationCriteria', 'timezone'].includes(key);
      controls.set(key, { input, kind });
    }
    if (!Object.hasOwn(data.fields, 'script')) form.append(element('p', 'O roteiro de IA precisa de habilitação pela administração WAIA.', 'help'));
    form.append(element('p', 'Saudações e respostas predefinidas são usadas antes da IA. O roteiro não substitui essas mensagens.', 'help'));
    if (data.replies.length) {
      form.append(element('h4', 'Respostas predefinidas e perguntas frequentes'));
      for (const reply of data.replies) {
        const label = element('label', reply.label), input = document.createElement('textarea');
        input.name = `reply-${reply.key}`; input.value = reply.text; input.maxLength = 2000; input.rows = 3; input.readOnly = !data.canEdit;
        input.addEventListener('input', changed); label.append(input); form.append(label); replies.set(reply.key, input);
      }
    } else form.append(element('p', 'Respostas predefinidas adicionais são liberadas pela administração WAIA.', 'help'));
    conflict = element('p', '', 'attendance-conflict'); conflict.hidden = true; conflict.setAttribute('role', 'alert');
    save = element('button', 'Salvar rascunho'); save.type = 'submit'; save.hidden = !data.canEdit;
    reload = element('button', 'Recarregar versão atual', 'text'); reload.type = 'button';
    reload.addEventListener('click', async () => {
      if (localDirty && !window.confirm('Descartar as alterações locais e carregar a versão atual?')) return;
      const version = ++epoch;
      setBusy(true);
      try { const latest = await api(path, null, 'GET');
        if (disposed || version !== epoch) return; render(latest); notice('Versão atual carregada.');
      } catch (error) { if (!disposed && version === epoch && error.name !== 'AbortError') handleError(error); }
      finally { if (!disposed && version === epoch) setBusy(false); }
    });
    form.append(conflict, save, reload); root.append(form);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (!data.canEdit || save.disabled) return;
      const changes = values(); if (!Object.keys(changes).length) { notice('Não há alterações para salvar.'); return; }
      const version = ++epoch;
      setBusy(true);
      try {
        const saved = await api(`${path}/draft`, { draftVersion: model.draftVersion, changes }, 'PATCH');
        if (disposed || version !== epoch) return; render(saved); notice(`Rascunho ${saved.draftVersion} salvo. O atendimento publicado foi preservado.`);
      } catch (error) { if (!disposed && version === epoch && error.name !== 'AbortError') handleError(error); }
      finally { if (!disposed && version === epoch) setBusy(false); }
    });
    renderRelease();
    refreshActions();
  }
  function renderResources(resources) {
    resourcesSection.replaceChildren();
    if (!resources || !Array.isArray(resources.features)) { resourcesSection.hidden = true; return; }
    resourcesSection.hidden = false;
    resourcesSection.append(element('h3', 'Recursos do atendimento'), element('p', 'Veja o que está liberado para preparar e o que já está disponível no atendimento publicado.', 'help'));
    const list = element('div', '');
    for (const feature of resources.features) {
      const card = document.createElement('details'); card.dataset.feature = feature.id;
      card.append(element('summary', `${feature.label} · ${featureStates[feature.state] || 'Não liberado'}`),
        element('p', feature.description, 'help'));
      if (feature.message) card.append(element('p', feature.message, 'help'));
      if (feature.enabled && !feature.canEdit) card.append(element('p', 'Disponível para consulta neste acesso.', 'help'));
      list.append(card);
    }
    resourcesSection.append(list);
    if (Array.isArray(resources.behaviors) && resources.behaviors.length) {
      const behaviorDetails = document.createElement('details'); behaviorDetails.id = 'attendance-behaviors';
      behaviorDetails.append(element('summary', 'Comportamentos liberados pela administração'));
      const behaviors = document.createElement('ul');
      for (const behavior of resources.behaviors) {
        const item = element('li', `${behavior.label}: rascunho ${behavior.draftEnabled ? 'habilitado' : 'desabilitado'}; atendimento publicado ${behavior.activeEnabled ? 'habilitado' : 'desabilitado'}.`);
        item.dataset.behavior = behavior.id; behaviors.append(item);
      }
      behaviorDetails.append(element('p', 'A administração WAIA controla essas habilitações. Os textos liberados podem ser editados nos campos abaixo.', 'help'), behaviors);
      resourcesSection.append(behaviorDetails);
    }
  }
  function renderRelease() {
    if (!model.canSimulate && !model.canPublish) return;
    const section = element('section', ''); section.setAttribute('aria-label', 'Simulação e publicação');
    section.append(element('h3', 'Simulação e publicação'));
    publicationNote = element('p', '', 'attendance-info'); section.append(publicationNote);
    if (model.canSimulate) {
      const simulation = document.createElement('form'); simulation.id = 'attendance-simulation';
      const label = element('label', 'Mensagem para testar'); simulationMessage = document.createElement('textarea');
      simulationMessage.id = 'attendance-simulation-message'; simulationMessage.name = 'message';
      simulationMessage.maxLength = 1000; simulationMessage.required = true; simulationMessage.rows = 3; label.append(simulationMessage);
      simulate = element('button', 'Simular rascunho'); simulate.type = 'submit';
      simulationReply = element('p', '', 'secret'); simulationReply.hidden = true; simulationReply.setAttribute('role', 'status');
      simulation.append(element('p', 'Teste o rascunho salvo. IA e integrações são fictícias nesta simulação; nenhuma mensagem é enviada pelo WhatsApp.', 'help'), label, simulate, simulationReply);
      section.append(simulation);
      simulation.addEventListener('submit', async (event) => {
        event.preventDefault(); if (simulate.disabled || !simulationMessage.value.trim()) return;
        const version = ++epoch, draftVersion = model.draftVersion, message = simulationMessage.value;
        setBusy(true); simulationReply.hidden = false; simulationReply.textContent = 'Simulando…';
        try {
          const result = await api(`${path}/simulate`, { draftVersion, message });
          if (disposed || version !== epoch) return;
          simulationReply.textContent = result.reply || 'A simulação não produziu uma resposta.';
          notice(`Simulação do rascunho ${result.draftVersion} concluída. Nenhuma mensagem enviada pelo WhatsApp.`);
        } catch (error) {
          if (!disposed && version === epoch && error.name !== 'AbortError') { simulationReply.textContent = ''; simulationReply.hidden = true; handleError(error); }
        } finally { if (!disposed && version === epoch) setBusy(false); }
      });
    }
    if (model.canPublish) {
      review = element('button', 'Revisar publicação'); review.type = 'button';
      confirmation = element('div', ''); confirmation.hidden = true; confirmation.setAttribute('role', 'group');
      confirmation.setAttribute('aria-label', 'Confirmar publicação do atendimento');
      confirmation.append(element('h4', `Publicar rascunho ${model.draftVersion}`),
        element('p', `Empresa: ${model.company.name}. Versão publicada atual: ${model.activeVersion ?? 'nenhuma'}.`));
      const changes = Array.isArray(model.publication?.changes) ? model.publication.changes : [];
      for (const change of changes) {
        const item = document.createElement('details');
        item.append(element('summary', change.label), element('p', 'Publicado', 'help'),
          element('pre', displayValue(change.before), 'secret'), element('p', 'Rascunho', 'help'), element('pre', displayValue(change.after), 'secret'));
        confirmation.append(item);
      }
      if (!changes.length) confirmation.append(element('p', 'Não há alterações de atendimento para publicar.', 'help'));
      const label = element('label', '', 'check'); accepted = document.createElement('input'); accepted.type = 'checkbox';
      accepted.id = 'attendance-publish-confirmation';
      label.append(accepted, document.createTextNode(`Conferi as alterações e confirmo publicar o rascunho ${model.draftVersion} para ${model.company.name}.`));
      publish = element('button', 'Confirmar publicação'); publish.type = 'button';
      const cancel = element('button', 'Cancelar revisão', 'text'); cancel.type = 'button';
      confirmation.append(label, publish, cancel); section.append(review, confirmation);
      accepted.addEventListener('change', refreshActions);
      cancel.addEventListener('click', () => { confirmation.hidden = true; accepted.checked = false; refreshActions(); review.focus(); });
      review.addEventListener('click', () => {
        if (review.disabled) return;
        confirmation.hidden = false; accepted.checked = false; refreshActions(); accepted.focus();
      });
      publish.addEventListener('click', async () => {
        if (publish.disabled || confirmation.hidden) return;
        const version = ++epoch, draftVersion = model.draftVersion, reviewToken = model.publication.reviewToken;
        publicationAttempt ??= crypto.randomUUID(); setBusy(true);
        try {
          const result = await api(`${path}/publish`, { draftVersion, reviewToken, idempotencyKey: publicationAttempt, confirmed: true });
          if (disposed || version !== epoch) return;
          // The acknowledged revision remains visible even if a subsequent refresh is unavailable.
          render({ ...model, activeVersion: result.activeVersion, publishedAt: result.publishedAt,
            publication: { ready: false, reason: 'Publicação concluída. Recarregue para revisar o estado atual.', changes: [], reviewToken: null } });
          notice(`Versão ${result.activeVersion} publicada para ${model.company.name}.`);
          try {
            const latest = await api(path, null, 'GET');
            if (!disposed && version === epoch) render(latest);
          } catch { /* The publication itself was acknowledged; do not offer an ambiguous retry. */ }
        } catch (error) { if (!disposed && version === epoch && error.name !== 'AbortError') handleError(error); }
        finally { if (!disposed && version === epoch) setBusy(false); }
      });
    }
    root.append(section);
  }
  function displayValue(value) {
    if (value == null || value === '') return 'Não preenchido';
    return Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : JSON.stringify(value);
  }
  function handleError(error) {
    if ([403, 404].includes(error.status)) { onAccessDenied(); return; }
    if (error.status === 409) showConflict();
    notice(error.message || 'Não foi possível concluir. Seus textos continuam nesta tela.', true);
  }
  render(initial);
  return {
    revalidate(latest) {
      if (disposed) return;
      if (!localDirty) { render(latest); return; }
      const accessChanged = latest.canEdit !== model.canEdit || !same(Object.keys(latest.fields), Object.keys(model.fields))
        || !same(latest.replies.map((reply) => reply.key), model.replies.map((reply) => reply.key));
      const resourcesChanged = !same(latest.resources, model.resources);
      if (latest.draftVersion !== model.draftVersion || accessChanged || resourcesChanged) {
        showConflict(); catalogChanged ||= accessChanged || resourcesChanged;
      }
      if (latest.activeVersion !== model.activeVersion || latest.publication?.reviewToken !== model.publication?.reviewToken) publicationBlocked = true;
      // Keep the editor's original baseline and local text until explicit reload;
      // the catalog and current permissions still update immediately.
      model = { ...model, canEdit: latest.canEdit, canSimulate: latest.canSimulate, canPublish: latest.canPublish,
        activeVersion: latest.activeVersion, publication: latest.publication, resources: latest.resources };
      renderResources(latest.resources);
      for (const [key, { input }] of controls) {
        const readOnly = !latest.canEdit || !Object.hasOwn(latest.fields, key)
          || latest.resources?.features?.find((feature) => feature.fields?.includes(key))?.canEdit === false;
        input.readOnly = readOnly;
        if (key === 'script') scriptEditor?.root.querySelectorAll('textarea').forEach((textarea) => { textarea.readOnly = readOnly; });
      }
      for (const [key, input] of replies) input.readOnly = !latest.canEdit || !latest.replies.some((reply) => reply.key === key);
      if (confirmation) { confirmation.hidden = true; accepted.checked = false; }
      publicationAttempt = null; refreshActions();
      if (accessChanged || resourcesChanged) notice('Os recursos do atendimento foram atualizados. Seus textos locais continuam nesta tela; recarregue para revisar antes de salvar.');
    },
    dispose() { disposed = true; epoch++; scriptEditor?.dispose(); controls.forEach(({ input }) => { input.value = ''; }); replies.forEach((input) => { input.value = ''; }); root.replaceChildren(); model = null; },
  };
}
