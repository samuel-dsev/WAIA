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
const element = (tag, text, className = '') => {
  const result = document.createElement(tag); result.textContent = text; result.className = className; return result;
};
export function createAttendanceEditor({ root, initial, companyId, api, onDirty, notice, onAccessDenied }) {
  let model = initial, epoch = 0, scriptEditor, disposed = false;
  const controls = new Map(), replies = new Map();
  let form, status, conflict, save, reload, localDirty = false;
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
  }
  function showConflict() {
    conflict.hidden = false;
    conflict.textContent = 'Este rascunho mudou em outra sessão. Seus textos continuam nesta tela. Recarregue a versão atual para revisar antes de salvar novamente.';
  }
  function render(data) {
    scriptEditor?.dispose(); model = data; controls.clear(); replies.clear(); root.replaceChildren();
    localDirty = false; onDirty(false);
    const title = element('h3', 'Atendimento');
    status = element('p', `Rascunho ${data.draftVersion} · ${data.activeVersion ? `Publicado: versão ${data.activeVersion}` : 'Ainda não publicado'}`, 'attendance-state');
    root.append(title, status);
    if (data.savedAt) root.append(element('p', `Último salvamento: ${new Date(data.savedAt).toLocaleString('pt-BR')}${data.savedBy ? ` · ${data.savedBy}` : ''}`, 'help'));
    if (data.publishedAt) root.append(element('p', `Publicado em ${new Date(data.publishedAt).toLocaleString('pt-BR')}${data.publishedBy ? ` · ${data.publishedBy}` : ''}`, 'help'));
    root.append(element('p', 'Salvar prepara um rascunho. A versão publicada e o atendimento em uso permanecem como estão.', 'help'));
    if (!data.canEdit) root.append(element('p', 'Seu acesso permite somente consulta. Solicite permissão de edição à administração WAIA.', 'attendance-info'));
    form = document.createElement('form'); form.id = 'attendance-form';
    for (const [key, label, maxLength, kind = 'text'] of definitions) {
      if (!Object.hasOwn(data.fields, key)) continue;
      let input;
      if (key === 'script') {
        scriptEditor = createAttendanceScriptEditor({ value: data.fields[key], readOnly: !data.canEdit, onInput: changed });
        input = scriptEditor.textarea; input.dataset.field = 'script'; form.append(scriptEditor.root);
      } else {
        const wrapper = element('label', label); input = document.createElement(kind === 'timezone' ? 'input' : 'textarea');
        input.id = `attendance-${key}`; input.name = key;
        input.value = kind === 'lines' ? data.fields[key].join('\n') : data.fields[key];
        input.maxLength = kind === 'lines' ? (maxLength + 1) * (key === 'schedules' ? 50 : 100) : maxLength;
        if (input.tagName === 'TEXTAREA') input.rows = key === 'establishmentRules' ? 5 : 3;
        input.readOnly = !data.canEdit; input.addEventListener('input', changed); wrapper.append(input);
        if (kind === 'lines') wrapper.append(element('small', `Uma informação por linha. Até ${key === 'schedules' ? 50 : 100} linhas de ${maxLength} caracteres.`));
        form.append(wrapper);
      }
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
      const inputs = [...form.querySelectorAll('input,textarea,button')]; inputs.forEach((input) => { input.disabled = true; });
      try { const latest = await api(`/api/app/v1/companies/${companyId}/attendance`, null, 'GET');
        if (disposed || version !== epoch) return; render(latest); notice('Versão atual carregada.');
      } catch (error) { if (!disposed && version === epoch && error.name !== 'AbortError') handleError(error); }
      finally { inputs.forEach((input) => { input.disabled = false; }); }
    });
    form.append(conflict, save, reload); root.append(form);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (!data.canEdit || save.disabled) return;
      const changes = values(); if (!Object.keys(changes).length) { notice('Não há alterações para salvar.'); return; }
      const version = ++epoch;
      const inputs = [...form.querySelectorAll('input,textarea,button')]; inputs.forEach((input) => { input.disabled = true; });
      try {
        const saved = await api(`/api/app/v1/companies/${companyId}/attendance/draft`, { draftVersion: model.draftVersion, changes }, 'PATCH');
        if (disposed || version !== epoch) return; render(saved); notice(`Rascunho ${saved.draftVersion} salvo. O atendimento publicado foi preservado.`);
      } catch (error) { if (!disposed && version === epoch && error.name !== 'AbortError') handleError(error); }
      finally { inputs.forEach((input) => { input.disabled = false; }); }
    });
  }
  function handleError(error) {
    if ([403, 404].includes(error.status)) { onAccessDenied(); return; }
    if (error.status === 409) showConflict();
    notice(error.message || 'Não foi possível salvar. Seus textos continuam nesta tela.', true);
  }
  render(initial);
  return {
    revalidate(latest) {
      if (!latest.canEdit || !same(Object.keys(latest.fields), Object.keys(model.fields))
        || !same(latest.replies.map((reply) => reply.key), model.replies.map((reply) => reply.key))) {
        render(latest); notice('As permissões do atendimento foram atualizadas.'); return;
      }
      if (latest.draftVersion !== model.draftVersion) showConflict();
    },
    dispose() { disposed = true; epoch++; scriptEditor?.dispose(); controls.forEach(({ input }) => { input.value = ''; }); replies.forEach((input) => { input.value = ''; }); root.replaceChildren(); model = null; },
  };
}
