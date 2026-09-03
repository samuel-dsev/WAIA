const STEPS = Object.freeze([
  [1, "Empresa", "Identidade, idioma e retenção"],
  [2, "Módulos", "Capacidades e dependências"],
  [3, "Atendimento", "Mensagens, regras e handoff"],
  [4, "Menus e roteamento", "Ações por nome e aliases"],
  [5, "Operação", "Catálogo, eventos, serviços e integrações"],
  [6, "Fluxos", "Triagens declarativas"],
  [7, "IA", "Modelo, limites e credencial"],
  [8, "WhatsApp e Meta", "Aplicativo, número e saúde"],
  [9, "Equipe", "Pessoas, papéis e handoff"],
  [10, "Revisão", "Checklist, publicação e ativação"],
]);

const FALLBACK_CAPABILITIES = Object.freeze([
  { key: "catalog", label: "Catálogo", description: "Produtos, serviços e respostas públicas.", dependencies: [] },
  { key: "events", label: "Eventos", description: "Agenda e regras de eventos.", dependencies: [] },
  { key: "payments", label: "Pagamentos", description: "Instruções protegidas pelo cofre.", dependencies: [] },
  { key: "orders", label: "Pedidos", description: "Compra com conferência humana.", dependencies: ["events", "payments"] },
  { key: "appointments", label: "Agendamentos", description: "Serviços e horários disponíveis.", dependencies: [] },
  { key: "human_handoff", label: "Atendimento humano", description: "Transferência segura para a equipe.", dependencies: [] },
  { key: "ai_freeform", label: "IA para texto livre", description: "Respostas públicas com limites.", dependencies: [] },
  { key: "external_integrations", label: "Integrações externas", description: "Conectores administrados.", dependencies: [] },
  { key: "flows", label: "Fluxos", description: "Triagens declarativas sem código.", dependencies: [] },
]);

const FLOW_TYPES = Object.freeze([
  ["message", "Mensagem"], ["single_choice", "Escolha única"], ["text", "Texto"],
  ["name", "Nome"], ["email", "E-mail"], ["phone", "Telefone"], ["date", "Data"],
  ["consent", "Consentimento"], ["document", "Documento ou imagem"],
  ["service_selection", "Seleção de serviço"], ["schedule_selection", "Seleção de horário"],
  ["handoff", "Atendimento humano"], ["completion", "Conclusão"], ["condition", "Condição simples"],
]);

const clone = (value) => JSON.parse(JSON.stringify(value));
const list = (payload) => Array.isArray(payload) ? payload : payload?.items || payload?.results || payload?.data || [];
const text = (value) => String(value ?? "").trim();
const bool = (value) => value === true || value === "true";
const number = (value, fallback = 0) => value == null || value === "" || !Number.isFinite(Number(value)) ? fallback : Number(value);
const encoded = (value) => encodeURIComponent(String(value));
const localDateTime = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};
const slug = (value, fallback = "item") => text(value).normalize("NFD").replace(/[\u0300-\u036f]/gu, "")
  .toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 60) || `${fallback}_${crypto.randomUUID().slice(0, 8)}`;

function buildFlowStep(values, current = null) {
  const next = {
    id: current?.id || slug(values.message || values.field || values.type, "etapa"),
    type: values.type,
    ...(values.message ? { message: values.message } : {}),
  };
  if (values.type === "single_choice") {
    next.field = slug(values.field, "campo");
    next.required = Boolean(values.required);
    next.options = text(values.choiceLabels).split(/\r?\n/u).map(text).filter(Boolean).map((label) => ({ id: slug(label, "opcao"), label, nextStepId: values.choiceTargetStepId }));
  } else if (values.type === "condition") {
    next.condition = { field: values.conditionField, operator: values.conditionOperator, ...(values.conditionOperator === "equals" ? { value: values.conditionValue } : {}) };
    next.whenTrueStepId = values.whenTrueStepId;
    next.whenFalseStepId = values.whenFalseStepId;
  } else if (!["completion", "handoff"].includes(values.type)) {
    if (values.type !== "message") {
      next.field = slug(values.field, "campo");
      next.required = Boolean(values.required);
    }
    next.nextStepId = values.nextStepId || undefined;
  }
  return next;
}

function element(tag, className, content) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (content != null) result.textContent = String(content);
  return result;
}

function button(label, className = "button button-secondary", type = "button") {
  const result = element("button", className, label);
  result.type = type;
  return result;
}

function emptyDraft(tenant = {}) {
  return {
    schemaVersion: 2,
    identity: {
      name: tenant.name || "", displayName: tenant.displayName || tenant.name || "",
      publicIdentity: tenant.identity || "", segment: "", locale: tenant.locale || "pt-BR",
      timezone: tenant.timezone || "America/Sao_Paulo", welcomeMessage: "", fallbackMessage: "",
      address: "", schedules: [], publicRules: [], establishmentRules: "", privacyPolicy: "", consentText: "",
    },
    retention: { messagesDays: tenant.messageRetentionDays || 365, logsDays: tenant.logRetentionDays || 90 },
    modules: [], menu: { text: "", options: [] }, routing: { greetings: [], aliases: [], fallbackAction: null },
    publicReplies: [], catalog: { items: [] }, events: { items: [], presentation: {} },
    appointments: { services: [] }, payments: {}, orders: {}, humanHandoff: {},
    ai: { enabled: false, keyMode: "shared", maxOutputTokens: 800, monthlyTokenLimit: 1000000, monthlyCostLimit: 100 },
    flows: { definitions: [] }, integrations: [],
  };
}

function normalizeDraft(source, tenant) {
  const base = emptyDraft(tenant);
  const draft = source && typeof source === "object" ? clone(source) : {};
  for (const key of ["identity", "retention", "menu", "routing", "catalog", "events", "appointments", "payments", "orders", "humanHandoff", "ai", "flows"]) {
    draft[key] = { ...base[key], ...(draft[key] || {}) };
  }
  for (const key of ["modules", "publicReplies", "integrations"]) if (!Array.isArray(draft[key])) draft[key] = base[key];
  for (const [parent, key] of [["menu", "options"], ["routing", "greetings"], ["routing", "aliases"], ["catalog", "items"], ["events", "items"], ["appointments", "services"], ["flows", "definitions"]]) {
    if (!Array.isArray(draft[parent][key])) draft[parent][key] = [];
  }
  return { ...base, ...draft, schemaVersion: 2 };
}

function pathValue(object, path) {
  return path.split(".").reduce((current, part) => current?.[part], object);
}

function setPath(object, path, value) {
  const parts = path.split(".");
  const last = parts.pop();
  const target = parts.reduce((current, part) => current[part] ||= {}, object);
  target[last] = value;
}

function field({ name, label, value = "", type = "text", required = false, disabled = false, options = [], help = "", min, max, rows = 3 }) {
  const wrap = element("div", "wizard-field");
  const id = `onboarding-${name.replace(/[^a-z0-9]/giu, "-")}-${crypto.randomUUID().slice(0, 5)}`;
  const labelNode = element("label", "", label);
  labelNode.htmlFor = id;
  let input;
  if (type === "select") {
    input = document.createElement("select");
    for (const [optionValue, optionLabel] of options) input.append(new Option(optionLabel, optionValue));
  } else if (type === "textarea") {
    input = document.createElement("textarea");
    input.rows = rows;
  } else {
    input = document.createElement("input");
    input.type = type;
  }
  input.id = id;
  input.name = name;
  input.required = required;
  input.disabled = disabled;
  if (min != null) {
    if (["text", "email", "tel", "url", "password", "textarea"].includes(type)) input.minLength = Number(min);
    else input.min = String(min);
  }
  if (max != null) input.max = String(max);
  if (["text", "email", "tel", "url", "password", "textarea"].includes(type)) input.maxLength = type === "textarea" ? 20000 : 500;
  if (type === "checkbox") input.checked = bool(value); else input.value = value ?? "";
  if (type === "password") input.autocomplete = "new-password";
  input.dataset.wizardField = name;
  const error = element("span", "field-error");
  error.id = `${id}-error`;
  error.setAttribute("role", "alert");
  input.setAttribute("aria-describedby", `${help ? `${id}-help ` : ""}${error.id}`.trim());
  wrap.append(labelNode, input);
  if (help) {
    const hint = element("small", "muted", help);
    hint.id = `${id}-help`;
    wrap.append(hint);
  }
  wrap.append(error);
  return wrap;
}

function readForm(form, schema) {
  const values = {};
  for (const definition of schema) {
    const input = form.elements[definition.name];
    let value = definition.type === "checkbox" ? input.checked : input.value;
    if (definition.valueType === "number") value = number(value);
    if (definition.valueType === "lines") value = text(value).split(/\r?\n/u).map(text).filter(Boolean);
    if (definition.optional && text(value) === "") value = undefined;
    values[definition.name] = value;
  }
  return values;
}

function collectionCard(title, subtitle, actions = []) {
  const card = element("article", "wizard-item");
  const copy = element("div");
  copy.append(element("strong", "", title || "Sem título"), element("small", "muted", subtitle || ""));
  const group = element("div", "row-actions");
  for (const action of actions) group.append(action);
  card.append(copy, group);
  return card;
}

function makeDialog(title, schema, initial, onSave) {
  const dialog = document.createElement("dialog");
  dialog.className = "wizard-dialog";
  dialog.setAttribute("aria-labelledby", `dialog-title-${crypto.randomUUID()}`);
  const form = document.createElement("form");
  form.method = "dialog";
  form.className = "dialog-card dialog-wide";
  const heading = element("div", "dialog-heading");
  const headingTitle = element("h2", "", title);
  headingTitle.id = dialog.getAttribute("aria-labelledby");
  const close = button("×", "icon-button");
  close.setAttribute("aria-label", "Fechar");
  close.addEventListener("click", () => dialog.close());
  heading.append(headingTitle, close);
  const grid = element("div", "wizard-form-grid");
  for (const item of schema) grid.append(field({ ...item, value: initial?.[item.name] ?? item.value ?? "" }));
  const refreshConditionalFields = () => {
    const selectedType = form.elements.type?.value;
    [...grid.children].forEach((wrapper, index) => {
      const definition = schema[index];
      const visible = !definition.showFor || definition.showFor.includes(selectedType);
      wrapper.hidden = !visible;
      const control = wrapper.querySelector("input, select, textarea");
      if (control) control.disabled = Boolean(definition.disabled) || !visible;
    });
  };
  form.elements.type?.addEventListener("change", refreshConditionalFields);
  refreshConditionalFields();
  const formError = element("p", "alert alert-error");
  formError.hidden = true;
  formError.setAttribute("role", "alert");
  const clearFieldErrors = () => {
    for (const input of form.querySelectorAll("[data-wizard-field]")) {
      input.removeAttribute("aria-invalid");
      const error = input.closest(".wizard-field")?.querySelector(".field-error");
      if (error) error.textContent = "";
    }
  };
  const showFieldErrors = (error) => {
    const issues = Array.isArray(error?.issues) ? [...error.issues] : [];
    if (!issues.length && (error?.path || error?.field)) issues.push({ path: error.path || error.field, message: error.message });
    let firstInvalid = null;
    let matched = 0;
    for (const issue of issues) {
      const issuePath = String(issue.path || issue.field || "").replace(/^\/configuration\/?/u, "").replace(/^\//u, "").replaceAll("/", ".");
      const definition = schema.find((item) => issuePath === item.name
        || issuePath === item.path
        || issuePath.endsWith(`.${item.name}`)
        || (item.path && issuePath.endsWith(`.${item.path}`)));
      const input = definition ? form.elements[definition.name] : null;
      const target = input?.closest(".wizard-field")?.querySelector(".field-error");
      if (!input || !target) continue;
      target.textContent = issue.message || error.message || "Valor inválido.";
      input.setAttribute("aria-invalid", "true");
      if (!firstInvalid && !input.disabled) firstInvalid = input;
      matched += 1;
    }
    firstInvalid?.focus();
    return matched;
  };
  const actions = element("div", "dialog-actions");
  const cancel = button("Cancelar");
  cancel.addEventListener("click", () => dialog.close());
  const submit = button("Salvar", "button button-primary", "submit");
  actions.append(cancel, submit);
  form.append(heading, grid, formError, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    clearFieldErrors();
    formError.hidden = true;
    submit.disabled = true;
    cancel.disabled = true;
    close.disabled = true;
    form.setAttribute("aria-busy", "true");
    try {
      const saved = await onSave(readForm(form, schema));
      if (saved === false) return;
      dialog.close();
    } catch (error) {
      const matched = showFieldErrors(error);
      formError.textContent = matched
        ? `${error.message || "Não foi possível salvar."} Revise os campos destacados.`
        : error.message || "Não foi possível salvar.";
      formError.hidden = false;
    } finally {
      submit.disabled = false;
      cancel.disabled = false;
      close.disabled = false;
      form.removeAttribute("aria-busy");
    }
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
  form.querySelector("input, select, textarea")?.focus();
}

export function createOnboardingWizard({ apiFetch, confirmAction, toast, onSessionExpired, canActivate = () => false } = {}) {
  if (![apiFetch, confirmAction, toast].every((item) => typeof item === "function")) throw new TypeError("Dependências do wizard são obrigatórias.");
  const state = {
    empresaId: "", mount: null, tenant: {}, configuration: emptyDraft(), draftVersion: 0,
    progress: { revision: 0, currentStep: 1, completedSteps: [] }, capabilities: [],
    credentials: [], numbers: [], metaApps: [], users: [], currentStep: 1,
    saveTimer: null, saving: null, generation: 0, savedGeneration: 0, disposed: false,
    conflict: null, statusNode: null, issueNodes: new Map(),
    tenantDirty: false,
  };

  const endpoint = (suffix = "") => `/tenants/${encoded(state.empresaId)}${suffix}`;

  async function optional(path, signal, { allowNotFound = false } = {}) {
    try { return await apiFetch(path, { signal }); } catch (error) {
      if (error.status === 401) onSessionExpired?.();
      if (allowNotFound && error.status === 404) return null;
      throw error;
    }
  }

  function setSaveStatus(status, message) {
    if (!state.statusNode) return;
    state.statusNode.dataset.status = status;
    state.statusNode.textContent = message;
  }

  function scheduleSave() {
    state.generation += 1;
    clearTimeout(state.saveTimer);
    if (state.conflict) {
      setSaveStatus("conflict", "Conflito pendente. Recarregue antes de salvar.");
      return;
    }
    setSaveStatus("pending", "Alterações pendentes…");
    state.saveTimer = setTimeout(() => flushDraft().catch(() => {}), 700);
  }

  async function flushDraft() {
    clearTimeout(state.saveTimer);
    if (state.conflict) return;
    if (state.disposed || (state.generation === state.savedGeneration && !state.tenantDirty)) return;
    if (state.saving) {
      await state.saving;
      return flushDraft();
    }
    const generation = state.generation;
    const snapshot = clone(state.configuration);
    const tenantSnapshot = clone(state.tenant);
    setSaveStatus("saving", "Salvando rascunho…");
    state.saving = (async () => {
      let draftConfirmed = false;
      try {
        const result = await apiFetch(endpoint("/configuration/draft"), {
          method: "PUT", body: { draftVersion: state.draftVersion, configuration: snapshot },
        });
        state.draftVersion = number(result?.draftVersion, state.draftVersion + 1);
        state.savedGeneration = generation;
        draftConfirmed = true;
        if (state.tenantDirty && text(tenantSnapshot.slug) && text(snapshot.identity.name) && text(snapshot.identity.displayName)) {
          await saveTenantIfNeeded({ configuration: snapshot, tenant: tenantSnapshot, generation });
        }
        state.conflict = null;
        setSaveStatus("saved", `Rascunho salvo · revisão ${state.draftVersion}`);
      } catch (error) {
        error.draftConfirmed = draftConfirmed;
        if (error.status === 401) onSessionExpired?.();
        if (!draftConfirmed && (error.status === 409 || /CONFLICT/u.test(error.code || ""))) {
          error.onboardingConcurrencyConflict = true;
          state.conflict = error;
          setSaveStatus("conflict", "Outra sessão alterou o rascunho. Recarregue para continuar.");
          renderConflict();
        } else {
          setSaveStatus("error", error.message || "Falha ao salvar o rascunho.");
          showIssues(error);
        }
        throw error;
      } finally {
        state.saving = null;
      }
    })();
    return state.saving;
  }

  function renderConflict() {
    const region = state.mount?.querySelector("[data-wizard-alert]");
    if (!region || !state.conflict) return;
    region.replaceChildren();
    const alert = element("div", "alert alert-error wizard-conflict");
    alert.setAttribute("role", "alert");
    alert.append(element("span", "", "O rascunho mudou em outra sessão. Suas alterações locais não serão sobrescritas automaticamente."));
    const reload = button("Recarregar versão atual", "button button-secondary button-small");
    reload.addEventListener("click", () => render({ empresaId: state.empresaId, mount: state.mount }));
    alert.append(reload);
    region.append(alert);
  }

  function showIssues(error) {
    let firstInvalid = null;
    for (const node of state.issueNodes.values()) {
      node.textContent = "";
      const input = node.parentElement?.querySelector("input, select, textarea");
      input?.removeAttribute("aria-invalid");
    }
    const issues = Array.isArray(error?.issues) ? [...error.issues] : [];
    if (!issues.length && (error?.path || error?.field)) issues.push({ path: error.path || error.field, message: error.message });
    for (const issue of issues) {
      const key = String(issue.path || "").replace(/^\/configuration\/?/u, "").replace(/^\//u, "").replaceAll("/", ".");
      const target = state.issueNodes.get(key);
      if (target) {
        target.textContent = issue.message;
        const input = target.parentElement?.querySelector("input, select, textarea");
        input?.setAttribute("aria-invalid", "true");
        if (!firstInvalid && input && !input.disabled) firstInvalid = input;
      }
    }
    firstInvalid?.focus();
  }

  function bindDraftForm(form, schema, apply) {
    state.issueNodes.clear();
    for (const definition of schema) {
      const input = form.elements[definition.name];
      const error = input?.parentElement?.querySelector(".field-error");
      if (error) state.issueNodes.set(definition.path || definition.name, error);
    }
    const update = () => {
      apply(readForm(form, schema));
      scheduleSave();
    };
    form.addEventListener("input", update);
    form.addEventListener("change", update);
  }

  function stepForm(schema, apply) {
    const form = document.createElement("form");
    form.className = "wizard-form-grid";
    for (const definition of schema) form.append(field(definition));
    bindDraftForm(form, schema, apply);
    return form;
  }

  function section(title, description) {
    const card = element("section", "wizard-section");
    card.append(element("h2", "", title));
    if (description) card.append(element("p", "muted", description));
    return card;
  }

  async function persistCollectionMutation(mutate, rollback) {
    const previousConfiguration = clone(state.configuration);
    const previousGeneration = state.generation;
    mutate();
    scheduleSave();
    try {
      await flushDraft();
    } catch (error) {
      if (!error.draftConfirmed) {
        if (rollback) rollback(); else state.configuration = previousConfiguration;
        state.generation = previousGeneration;
      }
      renderStep();
      if (error.draftConfirmed) return;
      throw error;
    }
    renderStep();
  }

  async function persistCollectionItem(target, index, next) {
    const position = index == null ? target.length : index;
    const previous = index == null ? undefined : clone(target[index]);
    await persistCollectionMutation(
      () => { target[position] = next; },
      () => { if (index == null) target.splice(position, 1); else target[position] = previous; },
    );
  }

  function collection(container, items, { empty, title, subtitle, edit, remove, addLabel, add }) {
    const rows = element("div", "wizard-items");
    if (!items.length) rows.append(element("p", "wizard-empty", empty));
    items.forEach((item, index) => {
      const editButton = button("Editar", "button button-secondary button-small");
      editButton.addEventListener("click", () => edit(item, index));
      const removeButton = button("Remover", "button button-danger button-small");
      removeButton.addEventListener("click", async () => {
        if (!await confirmAction(`Remover “${title(item)}” deste rascunho?`, "Remover item")) return;
        try { await persistCollectionMutation(() => remove(index)); } catch (error) { toast(error.message || "Não foi possível remover o item."); }
      });
      rows.append(collectionCard(title(item), subtitle(item), [editButton, removeButton]));
    });
    const addButton = button(addLabel, "button button-secondary");
    addButton.addEventListener("click", add);
    container.append(rows, addButton);
  }

  function renderCompany(root) {
    const card = section("1. Empresa", "Estes dados identificam a empresa e definem a retenção padrão.");
    const identity = state.configuration.identity;
    const retention = state.configuration.retention;
    const schema = [
      { name: "name", path: "identity.name", label: "Nome legal", value: identity.name, required: true },
      { name: "displayName", path: "identity.displayName", label: "Nome de exibição", value: identity.displayName, required: true },
      { name: "slug", label: "Endereço curto", value: state.tenant.slug, required: true, help: "Gerado a partir do nome; pode ser ajustado antes da ativação." },
      { name: "publicIdentity", path: "identity.publicIdentity", label: "Identidade pública", value: identity.publicIdentity, type: "textarea" },
      { name: "segment", path: "identity.segment", label: "Segmento", value: identity.segment },
      { name: "locale", path: "identity.locale", label: "Idioma", value: identity.locale, type: "select", options: [["pt-BR", "Português (Brasil)"], ["en-US", "English (US)"], ["es", "Español"]] },
      { name: "timezone", path: "identity.timezone", label: "Fuso horário", value: identity.timezone, type: "select", options: [["America/Sao_Paulo", "Brasília"], ["America/Manaus", "Manaus"], ["America/Recife", "Recife"], ["America/Fortaleza", "Fortaleza"], ["America/Cuiaba", "Cuiabá"]] },
      { name: "messagesDays", path: "retention.messagesDays", label: "Retenção de mensagens (dias)", value: retention.messagesDays, type: "number", valueType: "number", min: 1, max: 3650 },
      { name: "logsDays", path: "retention.logsDays", label: "Retenção de logs (dias)", value: retention.logsDays, type: "number", valueType: "number", min: 1, max: 3650 },
    ];
    const form = stepForm(schema, (values) => {
      Object.assign(identity, { name: values.name, displayName: values.displayName, publicIdentity: values.publicIdentity, segment: values.segment, locale: values.locale, timezone: values.timezone });
      Object.assign(retention, { messagesDays: values.messagesDays, logsDays: values.logsDays });
      state.tenant = { ...state.tenant, slug: values.slug, name: values.name, displayName: values.displayName, identity: values.publicIdentity, locale: values.locale, timezone: values.timezone, messageRetentionDays: values.messagesDays, logRetentionDays: values.logsDays };
      state.tenantDirty = true;
    });
    form.dataset.tenantForm = "true";
    card.append(form);
    root.append(card);
  }

  function renderModules(root) {
    const card = section("2. Módulos", "Dependências são marcadas automaticamente. Desmarque primeiro as capacidades dependentes.");
    const selected = new Set(state.configuration.modules);
    const catalog = state.capabilities.length ? state.capabilities : FALLBACK_CAPABILITIES;
    const grid = element("div", "capability-grid");
    for (const capability of catalog.filter((item) => item.reserved !== true)) {
      const label = element("label", "capability-card");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = capability.key;
      input.checked = selected.has(capability.key);
      const copy = element("span");
      copy.append(element("strong", "", capability.label), element("small", "muted", capability.description));
      if (capability.dependencies?.length) copy.append(element("small", "dependency-note", `Inclui: ${capability.dependencies.map((key) => catalog.find((item) => item.key === key)?.label || key).join(", ")}`));
      input.addEventListener("change", () => {
        const enabled = new Set(state.configuration.modules);
        if (input.checked) {
          enabled.add(capability.key);
          for (const dependency of capability.dependencies || []) enabled.add(dependency);
        } else {
          const dependents = catalog.filter((item) => enabled.has(item.key) && item.dependencies?.includes(capability.key));
          if (dependents.length) {
            input.checked = true;
            toast(`Desative primeiro: ${dependents.map((item) => item.label).join(", ")}.`);
            return;
          }
          enabled.delete(capability.key);
        }
        state.configuration.modules = catalog.map((item) => item.key).filter((key) => enabled.has(key));
        scheduleSave();
        renderStep();
      });
      label.append(input, copy);
      grid.append(label);
    }
    card.append(grid);
    root.append(card);
  }

  function renderService(root) {
    const card = section("3. Atendimento", "Tudo aqui é público. Credenciais e chaves devem ser cadastradas somente no cofre.");
    const identity = state.configuration.identity;
    const handoff = state.configuration.humanHandoff;
    const schema = [
      { name: "welcomeMessage", path: "identity.welcomeMessage", label: "Saudação", value: identity.welcomeMessage, type: "textarea", required: true },
      { name: "fallbackMessage", path: "identity.fallbackMessage", label: "Mensagem de contingência", value: identity.fallbackMessage, type: "textarea", required: true },
      { name: "address", path: "identity.address", label: "Endereço público", value: identity.address, type: "textarea" },
      { name: "schedules", path: "identity.schedules", label: "Horários (um por linha)", value: identity.schedules.join("\n"), type: "textarea", valueType: "lines" },
      { name: "publicRules", path: "identity.publicRules", label: "Regras públicas (uma por linha)", value: identity.publicRules.join("\n"), type: "textarea", valueType: "lines" },
      { name: "establishmentRules", path: "identity.establishmentRules", label: "Orientações públicas do estabelecimento", value: identity.establishmentRules, type: "textarea", rows: 5 },
      { name: "privacyPolicy", path: "identity.privacyPolicy", label: "Política de privacidade", value: identity.privacyPolicy, type: "textarea", rows: 5 },
      { name: "consentText", path: "identity.consentText", label: "Texto de consentimento", value: identity.consentText, type: "textarea" },
      { name: "handoffMessage", path: "humanHandoff.message", label: "Mensagem de atendimento humano", value: handoff.message || "", type: "textarea" },
      { name: "handoffChannel", path: "humanHandoff.channel", label: "Canal humano", value: handoff.channel || "" },
      { name: "assigneeRef", path: "humanHandoff.assigneeRef", label: "Responsável padrão", value: handoff.assigneeRef || "", type: "select", optional: true, options: [["", "Definir mais tarde"], ...state.users.map((user) => [`user:${user.id}`, `${user.name} · ${user.email}`])] },
    ];
    card.append(stepForm(schema, (values) => {
      Object.assign(identity, { welcomeMessage: values.welcomeMessage, fallbackMessage: values.fallbackMessage, address: values.address, schedules: values.schedules, publicRules: values.publicRules, establishmentRules: values.establishmentRules, privacyPolicy: values.privacyPolicy, consentText: values.consentText });
      state.configuration.humanHandoff = { message: values.handoffMessage, channel: values.handoffChannel, ...(values.assigneeRef ? { assigneeRef: values.assigneeRef } : {}) };
    }));
    root.append(card);
  }

  function actionOptions(context) {
    const selected = new Set(state.configuration.modules);
    return state.capabilities.filter((capability) => selected.has(capability.key)).flatMap((capability) => (capability.actionDefinitions || capability.actions?.map((key) => ({ key, label: key, contexts: ["menu", "alias", "runtime"] })) || [])
      .filter((action) => action.contexts?.includes(context)).map((action) => [action.key, `${action.label} · ${capability.label}`]));
  }

  function actionParams(action, values = {}) {
    if (action === "flows.start") return values.flowRef ? { flowRef: values.flowRef } : {};
    if (action === "external_integrations.run") return values.integrationId ? { integrationId: values.integrationId } : {};
    return {};
  }

  function editMenuOption(current, index) {
    const actions = actionOptions("menu");
    makeDialog(index == null ? "Adicionar opção" : "Editar opção", [
      { name: "label", label: "Texto exibido", required: true },
      { name: "action", label: "O que deve acontecer", type: "select", required: true, options: actions },
      { name: "flowRef", label: "Fluxo (quando a ação iniciar fluxo)", type: "select", options: [["", "Não se aplica"], ...state.configuration.flows.definitions.map((flow) => [`flow:${flow.key}`, flow.name])] },
      { name: "integrationId", label: "Integração (quando a ação executar integração)", type: "select", options: [["", "Não se aplica"], ...state.configuration.integrations.map((integration) => [integration.id, integration.name])] },
    ], { ...current, flowRef: current?.params?.flowRef, integrationId: current?.params?.integrationId }, async (values) => {
      const next = { id: current?.id || slug(values.label, "opcao"), label: values.label, action: values.action, params: actionParams(values.action, values) };
      await persistCollectionItem(state.configuration.menu.options, index, next);
    });
  }

  function editAlias(current, index) {
    makeDialog(index == null ? "Adicionar alias" : "Editar alias", [
      { name: "terms", label: "Termos reconhecidos (um por linha)", type: "textarea", valueType: "lines", required: true },
      { name: "action", label: "Ação", type: "select", required: true, options: actionOptions("alias") },
      { name: "flowRef", label: "Fluxo (quando a ação iniciar fluxo)", type: "select", options: [["", "Não se aplica"], ...state.configuration.flows.definitions.map((flow) => [`flow:${flow.key}`, flow.name])] },
    ], { ...current, terms: current?.terms?.join("\n") || "", flowRef: current?.params?.flowRef }, async (values) => {
      const next = { terms: values.terms, action: values.action, params: actionParams(values.action, values) };
      await persistCollectionItem(state.configuration.routing.aliases, index, next);
    });
  }

  function editPublicReply(current, index) {
    makeDialog(index == null ? "Adicionar resposta" : "Editar resposta", [
      { name: "action", label: "Ação", type: "select", required: true, options: actionOptions("runtime") },
      { name: "text", label: "Resposta pública", type: "textarea", required: true },
    ], current, async (values) => {
      await persistCollectionItem(state.configuration.publicReplies, index, values);
    });
  }

  function renderRouting(root) {
    const card = section("4. Menus e roteamento", "Escolha ações pelo nome. Identificadores e payloads são gerados pelo painel.");
    const schema = [
      { name: "menuText", path: "menu.text", label: "Texto do menu raiz", value: state.configuration.menu.text, type: "textarea", required: true },
      { name: "greetings", path: "routing.greetings", label: "Saudações reconhecidas (uma por linha)", value: state.configuration.routing.greetings.join("\n"), type: "textarea", valueType: "lines" },
      { name: "fallbackAction", path: "routing.fallbackAction", label: "Fallback de texto livre", value: state.configuration.routing.fallbackAction || "", type: "select", optional: true, options: [["", "Responder com a mensagem de contingência"], ...actionOptions("fallback")] },
    ];
    card.append(stepForm(schema, (values) => {
      state.configuration.menu.text = values.menuText;
      state.configuration.routing.greetings = values.greetings;
      state.configuration.routing.fallbackAction = values.fallbackAction || null;
    }));
    const options = section("Opções do menu", "A ordem abaixo é a ordem enviada ao WhatsApp.");
    collection(options, state.configuration.menu.options, {
      empty: "Nenhuma opção configurada.", title: (item) => item.label, subtitle: (item) => actionLabel(item.action),
      edit: editMenuOption, remove: (index) => state.configuration.menu.options.splice(index, 1), addLabel: "Adicionar opção", add: () => editMenuOption(null, null),
    });
    const aliases = section("Aliases", "Variações de linguagem que levam a uma ação segura.");
    collection(aliases, state.configuration.routing.aliases, {
      empty: "Nenhum alias configurado.", title: (item) => item.terms.join(", "), subtitle: (item) => actionLabel(item.action),
      edit: editAlias, remove: (index) => state.configuration.routing.aliases.splice(index, 1), addLabel: "Adicionar alias", add: () => editAlias(null, null),
    });
    const replies = section("Respostas públicas", "Textos usados pelas ações determinísticas.");
    collection(replies, state.configuration.publicReplies, {
      empty: "Nenhuma resposta pública configurada.", title: (item) => actionLabel(item.action), subtitle: (item) => item.text,
      edit: editPublicReply, remove: (index) => state.configuration.publicReplies.splice(index, 1), addLabel: "Adicionar resposta", add: () => editPublicReply(null, null),
    });
    root.append(card, options, aliases, replies);
  }

  function actionLabel(action) {
    for (const capability of state.capabilities) {
      const found = capability.actionDefinitions?.find((item) => item.key === action);
      if (found) return found.label;
    }
    return action || "Ação não definida";
  }

  function editorFor(kind, current, index) {
    const definitions = {
      product: {
        title: "produto ou serviço", target: state.configuration.catalog.items,
        schema: [{ name: "name", label: "Nome", required: true }, { name: "description", label: "Descrição", type: "textarea" }, { name: "price", label: "Preço", type: "number", valueType: "number", min: 0 }, { name: "active", label: "Ativo", type: "checkbox" }],
        make: (v) => ({ id: current?.id || slug(v.name, "produto"), ...v }),
      },
      event: {
        title: "evento", target: state.configuration.events.items,
        schema: [{ name: "name", label: "Nome", required: true }, { name: "startsAt", label: "Data e hora", type: "datetime-local", required: true }, { name: "timezone", label: "Fuso", value: state.configuration.identity.timezone, required: true }, { name: "location", label: "Local" }, { name: "description", label: "Descrição", type: "textarea" }, { name: "price", label: "Preço", type: "number", valueType: "number", min: 0 }, { name: "active", label: "Ativo", type: "checkbox" }],
        make: (v) => ({ id: current?.id || slug(v.name, "evento"), attractions: "", birthdayRule: "", vipRule: "", ...v, startsAt: v.startsAt ? new Date(v.startsAt).toISOString() : "" }),
      },
      service: {
        title: "serviço", target: state.configuration.appointments.services,
        schema: [{ name: "name", label: "Nome", required: true }, { name: "description", label: "Descrição", type: "textarea" }, { name: "slots", label: "Horários (rótulo | data e hora, um por linha)", type: "textarea", help: "Exemplo: Terça 14h | 2026-09-08T14:00:00-03:00" }, { name: "active", label: "Ativo", type: "checkbox" }],
        make: (v) => ({ id: current?.id || slug(v.name, "servico"), ...v, slots: text(v.slots).split(/\r?\n/u).map((line) => line.split("|").map(text)).filter(([label]) => label).map(([label, startsAt]) => ({ id: slug(`${label}_${startsAt}`, "horario"), label, startsAt: startsAt || undefined, available: true })) }),
      },
      integration: {
        title: "integração", target: state.configuration.integrations,
        schema: [{ name: "name", label: "Nome", required: true }, { name: "type", label: "Tipo", type: "select", options: [["google_sheets", "Google Sheets"], ["webhook", "Webhook administrado"], ["other", "Outro conector"]] }, { name: "enabled", label: "Ativa", type: "checkbox" }, { name: "required", label: "Obrigatória para operar", type: "checkbox" }],
        make: (v) => ({ id: current?.id || slug(v.name, "integracao"), credentialRefs: current?.credentialRefs || [], ...v }),
      },
    };
    const definition = definitions[kind];
    makeDialog(`${index == null ? "Adicionar" : "Editar"} ${definition.title}`, definition.schema, { active: true, enabled: true, ...current, ...(kind === "event" ? { startsAt: localDateTime(current?.startsAt) } : {}), ...(kind === "service" ? { slots: current?.slots?.map((slot) => `${slot.label} | ${slot.startsAt || ""}`).join("\n") || "" } : {}) }, async (values) => {
      const next = definition.make(values);
      await persistCollectionItem(definition.target, index, next);
    });
  }

  function renderOperation(root) {
    const enabled = new Set(state.configuration.modules);
    const card = section("5. Operação", "Somente áreas relacionadas aos módulos selecionados são exibidas.");
    if (!enabled.size) card.append(element("p", "wizard-empty", "Selecione módulos na etapa anterior."));
    if (enabled.has("catalog")) collection(card, state.configuration.catalog.items, { empty: "Nenhum produto ou serviço.", title: (i) => i.name, subtitle: (i) => `${i.active === false ? "Inativo" : "Ativo"} · ${Number(i.price || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`, edit: (i, x) => editorFor("product", i, x), remove: (x) => state.configuration.catalog.items.splice(x, 1), addLabel: "Adicionar produto ou serviço", add: () => editorFor("product", null, null) });
    if (enabled.has("events")) collection(card, state.configuration.events.items, { empty: "Nenhum evento.", title: (i) => i.name, subtitle: (i) => `${i.location || "Sem local"} · ${i.startsAt ? new Date(i.startsAt).toLocaleString("pt-BR") : "Sem data"}`, edit: (i, x) => editorFor("event", i, x), remove: (x) => state.configuration.events.items.splice(x, 1), addLabel: "Adicionar evento", add: () => editorFor("event", null, null) });
    if (enabled.has("appointments")) collection(card, state.configuration.appointments.services, { empty: "Nenhum serviço agendável.", title: (i) => i.name, subtitle: (i) => `${i.slots?.length || 0} horário(s) · ${i.active === false ? "Inativo" : "Ativo"}`, edit: (i, x) => editorFor("service", i, x), remove: (x) => state.configuration.appointments.services.splice(x, 1), addLabel: "Adicionar serviço", add: () => editorFor("service", null, null) });
    if (enabled.has("payments")) {
      const payment = section("Pagamento", "Escolha uma credencial mascarada; o segredo não entra no rascunho.");
      const schema = [{ name: "credentialRef", path: "payments.credentialRef", label: "Credencial de pagamento", value: state.configuration.payments.credentialRef || "", type: "select", optional: true, options: [["", "Selecionar"], ...state.credentials.filter((item) => item.provider === "payment").map((item) => [`credential:${item.id}`, `${item.purpose} · ${item.maskedSecret || "mascarada"}`])] }];
      payment.append(stepForm(schema, (v) => { state.configuration.payments = v.credentialRef ? { credentialRef: v.credentialRef } : {}; }));
      const addPaymentCredential = button("Cadastrar credencial de pagamento", "button button-secondary");
      addPaymentCredential.addEventListener("click", () => makeDialog("Cadastrar dado protegido", [{ name: "purpose", label: "Finalidade", required: true, value: "pix" }, { name: "secret", label: "Valor protegido", type: "password", required: true }], {}, async (values) => { const id = await createCredential({ provider: "payment", purpose: values.purpose, secret: values.secret }); state.configuration.payments = { credentialRef: `credential:${id}` }; scheduleSave(); renderStep(); toast("Credencial cadastrada e selecionada."); }));
      payment.append(addPaymentCredential);
      card.append(payment);
    }
    if (enabled.has("external_integrations")) collection(card, state.configuration.integrations, { empty: "Nenhuma integração.", title: (i) => i.name, subtitle: (i) => `${i.type} · ${i.enabled ? "Ativa" : "Inativa"}`, edit: (i, x) => editorFor("integration", i, x), remove: (x) => state.configuration.integrations.splice(x, 1), addLabel: "Adicionar integração", add: () => editorFor("integration", null, null) });
    root.append(card);
  }

  function editFlow(current, index) {
    makeDialog(index == null ? "Adicionar fluxo" : "Editar fluxo", [
      { name: "name", label: "Nome do fluxo", required: true },
      { name: "version", label: "Versão", type: "number", valueType: "number", min: 1, required: true },
    ], { version: 1, ...current }, async (values) => {
      const next = current ? { ...current, ...values } : { key: slug(values.name, "fluxo"), name: values.name, version: values.version, startStepId: "inicio", steps: [{ id: "inicio", type: "message", message: "Vamos começar.", nextStepId: "conclusao", required: false, options: [] }, { id: "conclusao", type: "completion", message: "Concluído.", required: false, options: [] }] };
      await persistCollectionItem(state.configuration.flows.definitions, index, next);
    });
  }

  function editFlowStep(flowIndex, current, index) {
    const flow = state.configuration.flows.definitions[flowIndex];
    const destinations = [["", "Sem próxima etapa"], ...flow.steps.filter((_, i) => i !== index).map((step) => [step.id, `${step.message || FLOW_TYPES.find(([key]) => key === step.type)?.[1]} · ${step.id}`])];
    const inputTypes = ["text", "name", "email", "phone", "date", "consent", "document", "service_selection", "schedule_selection"];
    const nextTypes = ["message", ...inputTypes];
    const collectedFields = [["", "Selecione um campo coletado"], ...flow.steps
      .filter((step, stepIndex) => stepIndex !== index && step.field)
      .map((step) => [step.field, step.message || step.field])];
    makeDialog(index == null ? "Adicionar etapa" : "Editar etapa", [
      { name: "type", label: "Tipo", type: "select", options: FLOW_TYPES, required: true },
      { name: "message", label: "Mensagem", type: "textarea" },
      { name: "field", label: "Campo coletado (nome amigável)", help: "O painel gera a chave interna a partir deste nome.", showFor: [...inputTypes, "single_choice"], required: true },
      { name: "required", label: "Resposta obrigatória", type: "checkbox", showFor: [...inputTypes, "single_choice"] },
      { name: "nextStepId", label: "Próxima etapa", type: "select", options: destinations, showFor: nextTypes, required: true },
      { name: "choiceLabels", label: "Opções da escolha (uma por linha)", type: "textarea", help: "Cada opção recebe a transição selecionada abaixo.", showFor: ["single_choice"], required: true },
      { name: "choiceTargetStepId", label: "Destino das opções", type: "select", options: destinations, showFor: ["single_choice"], required: true },
      { name: "conditionField", label: "Campo que será avaliado", type: "select", options: collectedFields, showFor: ["condition"], required: true },
      { name: "conditionOperator", label: "Condição", type: "select", options: [["present", "Campo presente"], ["absent", "Campo ausente"], ["equals", "Campo igual ao valor"]], showFor: ["condition"] },
      { name: "conditionValue", label: "Valor da condição", showFor: ["condition"] },
      { name: "whenTrueStepId", label: "Destino quando verdadeiro", type: "select", options: destinations, showFor: ["condition"], required: true },
      { name: "whenFalseStepId", label: "Destino quando falso", type: "select", options: destinations, showFor: ["condition"], required: true },
    ], { ...current, conditionField: current?.condition?.field || "", choiceLabels: current?.options?.map((option) => option.label).join("\n") || "", choiceTargetStepId: current?.options?.[0]?.nextStepId || "", conditionOperator: current?.condition?.operator || "present", conditionValue: current?.condition?.value ?? "" }, async (values) => {
      const next = buildFlowStep(values, current);
      const previousFlow = clone(flow);
      await persistCollectionMutation(
        () => {
          if (index == null) flow.steps.push(next); else flow.steps[index] = next;
          if (!flow.steps.some((step) => step.id === flow.startStepId)) flow.startStepId = flow.steps[0]?.id;
        },
        () => { for (const key of Object.keys(flow)) delete flow[key]; Object.assign(flow, previousFlow); },
      );
    });
  }

  function renderFlows(root) {
    const card = section("6. Fluxos", "Construa triagens sem JavaScript, SQL, HTTP livre ou expressões arbitrárias.");
    if (!state.configuration.modules.includes("flows")) {
      card.append(element("p", "wizard-empty", "Habilite o módulo Fluxos para usar o construtor."));
      root.append(card);
      return;
    }
    for (const [flowIndex, flow] of state.configuration.flows.definitions.entries()) {
      const flowCard = element("article", "flow-builder");
      const heading = element("div", "wizard-item");
      const copy = element("div");
      copy.append(element("h3", "", flow.name), element("small", "muted", `Versão ${flow.version} · início: ${flow.steps.find((step) => step.id === flow.startStepId)?.message || "não definido"}`));
      const edit = button("Editar fluxo", "button button-secondary button-small");
      edit.addEventListener("click", () => editFlow(flow, flowIndex));
      const remove = button("Remover fluxo", "button button-danger button-small");
      remove.addEventListener("click", async () => {
        if (!await confirmAction(`Remover o fluxo “${flow.name}”?`, "Remover fluxo")) return;
        try {
          await persistCollectionMutation(() => state.configuration.flows.definitions.splice(flowIndex, 1));
        } catch (error) {
          toast(error.message || "Não foi possível remover o fluxo.");
        }
      });
      const actions = element("div", "row-actions"); actions.append(edit, remove); heading.append(copy, actions); flowCard.append(heading);
      const path = element("ol", "flow-path");
      flow.steps.forEach((step, stepIndex) => {
        const row = element("li");
        row.append(element("span", "flow-type", FLOW_TYPES.find(([key]) => key === step.type)?.[1] || step.type), element("strong", "", step.message || step.field || "Etapa sem mensagem"));
        const stepEdit = button("Editar", "button button-quiet button-small");
        stepEdit.addEventListener("click", () => editFlowStep(flowIndex, step, stepIndex));
        const stepRemove = button("Remover", "button button-danger button-small");
        stepRemove.disabled = flow.steps.length <= 2;
        stepRemove.addEventListener("click", async () => {
          if (!await confirmAction("Remover esta etapa do fluxo?", "Remover etapa")) return;
          try {
            await persistCollectionMutation(() => {
              const removedId = flow.steps[stepIndex].id;
              flow.steps.splice(stepIndex, 1);
              if (flow.startStepId === removedId) flow.startStepId = flow.steps[0]?.id;
              for (const remaining of flow.steps) {
                if (remaining.nextStepId === removedId) delete remaining.nextStepId;
                if (remaining.whenTrueStepId === removedId) delete remaining.whenTrueStepId;
                if (remaining.whenFalseStepId === removedId) delete remaining.whenFalseStepId;
                remaining.options = (remaining.options || []).filter((option) => option.nextStepId !== removedId);
              }
            });
          } catch (error) {
            toast(error.message || "Não foi possível remover a etapa.");
          }
        });
        const controls = element("div", "row-actions"); controls.append(stepEdit, stepRemove); row.append(controls); path.append(row);
      });
      const addStep = button("Adicionar etapa", "button button-secondary");
      addStep.addEventListener("click", () => editFlowStep(flowIndex, null, null));
      flowCard.append(path, addStep); card.append(flowCard);
    }
    const addFlow = button("Adicionar fluxo", "button button-primary");
    addFlow.addEventListener("click", () => editFlow(null, null));
    card.append(addFlow);
    root.append(card);
  }

  async function createCredential({ provider, purpose, secret }) {
    const result = await apiFetch(endpoint("/credentials"), { method: "POST", body: { provider, purpose, secret } });
    state.credentials.push(result);
    return result.id || result.credentialId;
  }

  async function revokeCredential(credentialId) {
    if (!credentialId) return;
    await apiFetch(endpoint(`/credentials/${encoded(credentialId)}/revoke`), { method: "POST", body: {} });
    state.credentials = state.credentials.filter((item) => item.id !== credentialId && item.credentialId !== credentialId);
  }

  function renderAi(root) {
    const card = section("7. IA", "A chave é enviada diretamente ao cofre e nunca reaparece no rascunho ou na tela.");
    if (!state.configuration.modules.includes("ai_freeform")) {
      card.append(element("p", "wizard-empty", "Habilite IA para texto livre na etapa Módulos.")); root.append(card); return;
    }
    const ai = state.configuration.ai;
    const schema = [
      { name: "enabled", path: "ai.enabled", label: "IA habilitada", type: "checkbox", value: ai.enabled },
      { name: "provider", path: "ai.provider", label: "Provedor", value: ai.provider || "openai", type: "select", options: [["openai", "OpenAI"], ["simulated", "Simulado (sem chamada externa)"]] },
      { name: "model", path: "ai.model", label: "Modelo", value: ai.model || "", required: true },
      { name: "personality", path: "ai.personality", label: "Personalidade", value: ai.personality || "", type: "textarea" },
      { name: "prompt", path: "ai.prompt", label: "Instruções públicas", value: ai.prompt || "", type: "textarea", rows: 6, required: true },
      { name: "maxOutputTokens", path: "ai.maxOutputTokens", label: "Máximo de tokens por resposta", value: ai.maxOutputTokens, type: "number", valueType: "number", min: 1, max: 16384 },
      { name: "monthlyTokenLimit", path: "ai.monthlyTokenLimit", label: "Limite mensal de tokens", value: ai.monthlyTokenLimit, type: "number", valueType: "number", min: 1 },
      { name: "monthlyCostLimit", path: "ai.monthlyCostLimit", label: "Limite mensal de custo", value: ai.monthlyCostLimit, type: "number", valueType: "number", min: 0 },
      { name: "keyMode", path: "ai.keyMode", label: "Origem da chave", value: ai.keyMode, type: "select", options: [["shared", "Compartilhada pela plataforma"], ["own", "Própria da empresa"], ["simulated", "Simulada"]] },
      { name: "credentialRef", path: "ai.credentialRef", label: "Credencial própria", value: ai.credentialRef || "", type: "select", optional: true, options: [["", "Selecionar"], ...state.credentials.filter((item) => item.provider === "openai").map((item) => [`credential:${item.id}`, `${item.purpose} · ${item.maskedSecret || "mascarada"}`])] },
      { name: "fallbackMessage", path: "ai.fallbackMessage", label: "Mensagem de contingência", value: ai.fallbackMessage || "", type: "textarea" },
    ];
    const form = stepForm(schema, (values) => {
      state.configuration.ai = { ...state.configuration.ai, ...values };
      if (values.keyMode !== "own") delete state.configuration.ai.credentialRef;
    });
    form.addEventListener("change", () => renderStep());
    card.append(form);
    if (ai.keyMode === "own") {
      const addKey = button("Cadastrar nova chave no cofre", "button button-secondary");
      addKey.addEventListener("click", () => makeDialog("Cadastrar chave própria", [{ name: "secret", label: "Chave da IA", type: "password", required: true }], {}, async (values) => { const id = await createCredential({ provider: "openai", purpose: "responses", secret: values.secret }); state.configuration.ai.credentialRef = `credential:${id}`; scheduleSave(); renderStep(); toast("Credencial cadastrada e selecionada."); }));
      card.append(addKey);
    }
    const testAi = button("Validar IA sem revelar a chave", "button button-secondary");
    testAi.addEventListener("click", async () => {
      try { await flushDraft(); const result = await apiFetch(endpoint("/configuration/validate"), { method: "POST", body: {} }); toast(result.valid ? "Configuração de IA válida. Nenhuma chamada ao provedor foi realizada." : "Revise as pendências da configuração."); } catch (error) { showIssues(error); toast(error.message); }
    });
    card.append(testAi);
    root.append(card);
  }

  function rotateMetaSecretDialog(app) {
    makeDialog("Rotacionar App Secret", [
      { name: "appSecret", label: "Novo App Secret", type: "password", required: true },
      { name: "rotationWindowSeconds", label: "Janela do segredo anterior (segundos)", type: "number", valueType: "number", min: 60, max: 3600, value: 900 },
    ], {}, async (values) => {
      const newAppSecretCredentialId = await createCredential({ provider: "meta", purpose: "meta-app-secret", secret: values.appSecret });
      try {
        await apiFetch(endpoint(`/meta-applications/${encoded(app.id)}/rotate-secret`), { method: "POST", body: { expectedRevision: app.revision, newAppSecretCredentialId, rotationWindowSeconds: values.rotationWindowSeconds } });
      } catch (error) {
        await revokeCredential(newAppSecretCredentialId).catch(() => {});
        throw error;
      }
      await reloadMeta(); renderStep(); toast("App Secret rotacionado. O segredo anterior permanece válido somente durante a janela configurada.");
    });
  }

  function rotateVerifyTokenDialog(app) {
    makeDialog("Rotacionar verify token", [
      { name: "verifyToken", label: "Novo verify token", type: "password", required: true },
    ], {}, async (values) => {
      if (!app.verifyTokenCredentialId) throw new Error("Este aplicativo ainda não possui uma referência de verify token.");
      await apiFetch(endpoint(`/credentials/${encoded(app.verifyTokenCredentialId)}/rotate`), { method: "POST", body: { secret: values.verifyToken } });
      await reloadMeta(); renderStep(); toast("Verify token rotacionado.");
    });
  }

  function metaAppDialog(current) {
    makeDialog(current ? "Editar aplicativo Meta" : "Adicionar aplicativo Meta", [
      { name: "name", label: "Nome da conexão", required: true },
      { name: "metaAppId", label: "App ID fornecido pela Meta", required: true },
      { name: "mode", label: "Tipo", type: "select", disabled: Boolean(current), help: current ? "Para trocar entre compartilhado e próprio, crie uma nova conexão com as credenciais correspondentes." : "", options: [["shared", "Compartilhado pela plataforma"], ["own", "Próprio da empresa"]] },
      ...(!current ? [{ name: "appSecret", label: "App Secret (somente aplicativo próprio)", type: "password" }, { name: "verifyToken", label: "Verify token (somente aplicativo próprio)", type: "password" }] : []),
    ], { ...current, metaAppId: current?.metaAppId || "" }, async (values) => {
      if (current) {
        await apiFetch(endpoint(`/meta-applications/${encoded(current.id)}`), { method: "PATCH", body: { expectedRevision: current.revision, name: values.name, metaAppId: values.metaAppId, mode: values.mode } });
      } else {
        let appSecretCredentialId = null; let verifyTokenCredentialId = null;
        try {
          if (values.mode === "own") {
            if (!values.appSecret || !values.verifyToken) throw new Error("Aplicativo próprio exige App Secret e verify token.");
            appSecretCredentialId = await createCredential({ provider: "meta", purpose: "meta-app-secret", secret: values.appSecret });
            verifyTokenCredentialId = await createCredential({ provider: "meta", purpose: "meta-verify-token", secret: values.verifyToken });
          }
          await apiFetch(endpoint("/meta-applications"), { method: "POST", body: { name: values.name, metaAppId: values.metaAppId, mode: values.mode, appSecretCredentialId, verifyTokenCredentialId } });
        } catch (error) {
          await Promise.allSettled([revokeCredential(appSecretCredentialId), revokeCredential(verifyTokenCredentialId)]);
          throw error;
        }
      }
      await reloadMeta(); renderStep(); toast("Aplicativo Meta salvo.");
    });
  }

  async function reloadMeta() {
    const [apps, numbers] = await Promise.all([apiFetch(endpoint("/meta-applications")), apiFetch(endpoint("/numbers?page=1&pageSize=100"))]);
    state.metaApps = list(apps); state.numbers = list(numbers);
  }

  function bindNumberDialog(numberRecord) {
    makeDialog("Vincular número à conexão Meta", [
      { name: "metaAppId", label: "Aplicativo Meta", type: "select", required: true, options: state.metaApps.map((app) => [app.id, `${app.name} · ${app.state}`]) },
      { name: "accessToken", label: "Access token deste número", type: "password", required: true },
    ], {}, async (values) => {
      const replacingBinding = Boolean(numberRecord.metaAppId);
      if (replacingBinding && !await confirmAction("Substituir o token e a conexão deste número? A credencial anterior permanecerá no cofre para revogação auditada.", "Confirmar novo vínculo")) return false;
      const accessTokenCredentialId = await createCredential({ provider: "meta", purpose: `whatsapp:${numberRecord.id}`, secret: values.accessToken });
      try {
        await apiFetch(endpoint(`/numbers/${encoded(numberRecord.id)}/meta-binding`), { method: "PUT", body: { metaAppId: values.metaAppId, accessTokenCredentialId, expectedRevision: number(numberRecord.bindingRevision, 1) } });
      } catch (error) {
        await revokeCredential(accessTokenCredentialId).catch(() => {});
        throw error;
      }
      toast(replacingBinding ? "Novo vínculo salvo. A credencial anterior permanece no cofre para revogação auditada." : "Número vinculado à conexão Meta.");
      await reloadMeta(); renderStep();
    });
  }

  function numberDialog(current) {
    makeDialog(current ? "Editar número WhatsApp" : "Adicionar número WhatsApp", [
      { name: "phoneNumberId", label: "Phone number ID fornecido pela Meta", required: true },
      { name: "wabaId", label: "WABA ID fornecido pela Meta", required: true },
      { name: "numeroE164", label: "Número internacional", type: "tel", required: true, help: "Exemplo: +5511999999999" },
      { name: "nomeVerificado", label: "Nome verificado" },
      ...(current ? [{ name: "status", label: "Estado", type: "select", options: [["pendente", "Pendente"], ["ativo", "Ativo"], ["inativo", "Inativo"]] }, { name: "principal", label: "Número principal", type: "checkbox" }] : []),
    ], current, async (values) => {
      const body = current ? values : { ...values, status: "pendente", principal: false };
      await apiFetch(endpoint(`/numbers${current ? `/${encoded(current.id)}` : ""}`), { method: current ? "PATCH" : "POST", body });
      await reloadMeta(); renderStep(); toast("Número WhatsApp salvo.");
    });
  }

  function renderMeta(root) {
    const card = section("8. WhatsApp e Meta", "Os identificadores desta etapa são fornecidos pelo Meta Business. Segredos são guardados no cofre.");
    for (const app of state.metaApps) {
      const edit = button("Editar", "button button-secondary button-small"); edit.addEventListener("click", () => metaAppDialog(app));
      const health = button("Testar saúde", "button button-primary button-small"); health.addEventListener("click", async () => {
        const linkedNumbers = state.numbers.filter((item) => item.metaAppId === app.id);
        const numberRecord = linkedNumbers.find((item) => item.principal) || linkedNumbers[0];
        if (!numberRecord) return toast("Vincule um número a esta conexão antes do teste de saúde.");
        try { const result = await apiFetch(endpoint(`/meta-applications/${encoded(app.id)}/preflight`), { method: "POST", body: { numberId: numberRecord.id } }); toast(result.success ? "Conexão Meta validada." : result.message || "A conexão ainda não está pronta."); await reloadMeta(); renderStep(); } catch (error) { toast(error.message); }
      });
      const suspend = button("Suspender", "button button-danger button-small"); suspend.disabled = app.state === "inactive"; suspend.addEventListener("click", async () => { if (!await confirmAction(`Suspender “${app.name}”?`, "Suspender conexão")) return; await apiFetch(endpoint(`/meta-applications/${encoded(app.id)}`), { method: "PATCH", body: { expectedRevision: app.revision, state: "inactive" } }); await reloadMeta(); renderStep(); });
      const rotate = button("Rotacionar App Secret", "button button-secondary button-small"); rotate.disabled = app.mode !== "own"; rotate.addEventListener("click", () => rotateMetaSecretDialog(app));
      const rotateVerify = button("Rotacionar verify token", "button button-secondary button-small"); rotateVerify.disabled = app.mode !== "own" || !app.verifyTokenCredentialId; rotateVerify.addEventListener("click", () => rotateVerifyTokenDialog(app));
      const callback = `${location.origin}/webhook/meta/${app.webhookPublicId}`;
      card.append(collectionCard(app.name, `${app.mode === "own" ? "Próprio" : "Compartilhado"} · ${app.state} · callback: ${callback}`, [edit, rotate, rotateVerify, health, suspend]));
    }
    if (!state.metaApps.length) card.append(element("p", "wizard-empty", "Nenhum aplicativo Meta configurado."));
    const addApp = button("Adicionar aplicativo Meta", "button button-primary"); addApp.addEventListener("click", () => metaAppDialog(null)); card.append(addApp);
    const numbers = section("Números", "Selecione a conexão pelo nome; o vínculo interno é criado pelo painel.");
    for (const numberRecord of state.numbers) {
      const editNumber = button("Editar", "button button-secondary button-small"); editNumber.addEventListener("click", () => numberDialog(numberRecord));
      const bind = button("Vincular conexão", "button button-secondary button-small"); bind.disabled = !state.metaApps.length; bind.addEventListener("click", () => bindNumberDialog(numberRecord));
      const removeNumber = button("Remover", "button button-danger button-small"); removeNumber.addEventListener("click", async () => { if (!await confirmAction(`Remover ${numberRecord.numeroMascarado || "este número"}?`, "Remover número")) return; await apiFetch(endpoint(`/numbers/${encoded(numberRecord.id)}`), { method: "DELETE" }); await reloadMeta(); renderStep(); toast("Número removido com segurança."); });
      const linkedApp = state.metaApps.find((app) => app.id === numberRecord.metaAppId);
      const binding = linkedApp ? `Conexão: ${linkedApp.name} (${numberRecord.metaApplicationState || linkedApp.state})` : "Sem conexão Meta";
      numbers.append(collectionCard(numberRecord.nomeVerificado || numberRecord.numeroMascarado || "Número WhatsApp", `${numberRecord.numeroMascarado || "Número protegido"} · ${numberRecord.principal ? "Principal" : "Secundário"} · ${numberRecord.status} · ${binding}`, [editNumber, bind, removeNumber]));
    }
    if (!state.numbers.length) numbers.append(element("p", "wizard-empty", "Cadastre o número WhatsApp pela área Números para vinculá-lo aqui."));
    const addNumber = button("Adicionar número WhatsApp", "button button-primary"); addNumber.addEventListener("click", () => numberDialog(null)); numbers.append(addNumber);
    root.append(card, numbers);
  }

  async function reloadUsers() { state.users = list(await apiFetch(endpoint("/users?page=1&pageSize=100"))); }

  const permissionChoices = [
    { name: "canServe", label: "Atender contatos e conversas", permissions: ["contacts.read", "contacts.update", "conversations.read", "conversations.update"] },
    { name: "canManageOrders", label: "Consultar e atualizar pedidos", permissions: ["orders.read", "orders.update"] },
    { name: "canManageAppointments", label: "Consultar e atualizar agendamentos", permissions: ["appointments.read", "appointments.update"] },
  ];

  function permissionsFrom(values) {
    return permissionChoices.flatMap((choice) => values[choice.name] ? choice.permissions : []);
  }

  function permissionInitial(user = {}) {
    const assigned = new Set(user.permissions || []);
    return Object.fromEntries(permissionChoices.map((choice) => [choice.name, choice.permissions.every((permission) => assigned.has(permission))]));
  }

  function userDialog(current) {
    makeDialog(current ? `Editar vínculo de ${current.name}` : "Criar integrante", [
      ...(!current ? [{ name: "name", label: "Nome", required: true }, { name: "email", label: "E-mail", type: "email", required: true }] : []),
      { name: "role", label: "Papel", type: "select", options: [["tenant_admin", "Administrador da empresa"], ["tenant_operator", "Operador"]] },
      ...(current ? [{ name: "status", label: "Estado do vínculo", type: "select", options: [["active", "Ativo"], ["suspended", "Suspenso"]] }] : []),
      ...(!current ? [{ name: "initialPassword", label: "Senha inicial", type: "password", required: true, min: 12, help: "Use entre 12 e 256 caracteres." }] : []),
      ...permissionChoices.map((choice) => ({ name: choice.name, label: choice.label, type: "checkbox" })),
    ], { ...current, status: current?.membershipStatus || "active", ...permissionInitial(current) }, async (values) => {
      const permissions = permissionsFrom(values);
      const body = Object.fromEntries(Object.entries(values).filter(([key]) => !permissionChoices.some((choice) => choice.name === key)));
      if (current) await apiFetch(endpoint(`/memberships/${encoded(current.id)}`), { method: "PATCH", body: { role: body.role, status: body.status, permissions } });
      else await apiFetch(endpoint("/users"), { method: "POST", body: { ...body, permissions, status: "active" } });
      await reloadUsers(); renderStep(); toast("Integrante salvo.");
    });
  }

  function linkExistingUserDialog() {
    makeDialog("Vincular usuário existente", [
      { name: "email", label: "E-mail exato do usuário", type: "email", required: true, help: "A busca exata evita enumeração de contas." },
      { name: "role", label: "Papel nesta empresa", type: "select", options: [["tenant_admin", "Administrador da empresa"], ["tenant_operator", "Operador"]] },
      ...permissionChoices.map((choice) => ({ name: choice.name, label: choice.label, type: "checkbox" })),
    ], {}, async (values) => {
      const found = await apiFetch(`/users/lookup?email=${encoded(values.email)}`);
      if (!await confirmAction(`Vincular ${found.name} (${found.email}) como ${values.role === "tenant_admin" ? "administrador" : "operador"}?`, "Confirmar vínculo")) return;
      await apiFetch(endpoint("/memberships"), { method: "POST", body: { userId: found.id, role: values.role, status: "active", permissions: permissionsFrom(values) } });
      await reloadUsers(); renderStep(); toast("Usuário existente vinculado.");
    });
  }

  function renderTeam(root) {
    const card = section("9. Equipe", "Defina ao menos um administrador. Operadores podem receber o atendimento humano.");
    for (const user of state.users) {
      const edit = button("Editar papel", "button button-secondary button-small"); edit.addEventListener("click", () => userDialog(user));
      const remove = button("Desvincular", "button button-danger button-small"); remove.addEventListener("click", async () => { if (!await confirmAction(`Desvincular ${user.name} desta empresa?`, "Desvincular integrante")) return; await apiFetch(endpoint(`/users/${encoded(user.id)}`), { method: "DELETE" }); await reloadUsers(); renderStep(); });
      card.append(collectionCard(user.name, `${user.email} · ${user.role === "tenant_admin" ? "Administrador" : "Operador"} · ${user.membershipStatus === "suspended" ? "Suspenso" : "Ativo"}`, [edit, remove]));
    }
    if (!state.users.length) card.append(element("p", "wizard-empty", "Nenhum integrante vinculado."));
    const controls = element("div", "row-actions");
    const add = button("Criar integrante", "button button-primary"); add.addEventListener("click", () => userDialog(null)); controls.append(add);
    const link = button("Vincular usuário existente", "button button-secondary"); link.disabled = !canActivate(); link.title = canActivate() ? "" : "Somente administradores da plataforma podem buscar usuários globais."; link.addEventListener("click", linkExistingUserDialog); controls.append(link);
    card.append(controls);
    root.append(card);
  }

  function checkCard(check) {
    const item = element("li", `readiness-check readiness-${check.state || "unknown"}`);
    item.append(element("strong", "", check.message || check.code), element("small", "muted", check.correctiveAction || "Nenhuma ação adicional."));
    if (check.step && check.state === "failed") {
      const go = button(`Ir para etapa ${check.step}`, "button button-quiet button-small");
      go.addEventListener("click", () => goToStep(number(check.step, 10)));
      item.append(go);
    }
    return item;
  }

  async function renderReview(root) {
    const card = section("10. Revisão", "O backend é a fonte única do checklist e impede publicação ou ativação incompleta.");
    const actions = element("div", "wizard-review-actions");
    const validate = button("Validar configuração", "button button-secondary");
    const readiness = button("Recalcular prontidão", "button button-secondary");
    const simulate = button("Abrir simulador", "button button-secondary");
    const publish = button("Publicar revisão", "button button-primary");
    const activate = button("Publicar e ativar", "button button-primary");
    activate.disabled = !canActivate();
    activate.title = canActivate() ? "" : "Somente um administrador da plataforma pode ativar.";
    actions.append(validate, readiness, simulate, publish, activate); card.append(actions);
    const results = element("div", "wizard-review-results"); card.append(results); root.append(card);

    async function loadReadiness() {
      results.replaceChildren(element("p", "muted", "Calculando prontidão…"));
      try {
        await flushDraft();
        const payload = await apiFetch(endpoint("/readiness"));
        const summary = element("div", `readiness-summary ${payload.ready ? "is-ready" : "has-blockers"}`);
        summary.append(element("strong", "", payload.ready ? "Pronta para publicar" : "Existem pendências"), element("span", "", `Modo: ${payload.mode || "diagnóstico"} · revisão ${payload.draftVersion}`));
        const checks = element("ul", "readiness-list");
        for (const check of payload.checks || []) checks.append(checkCard(check));
        results.replaceChildren(summary, checks);
        return payload;
      } catch (error) { results.replaceChildren(element("p", "alert alert-error", error.message)); return null; }
    }
    readiness.addEventListener("click", loadReadiness);
    validate.addEventListener("click", async () => {
      results.replaceChildren(element("p", "muted", "Validando configuração…"));
      try {
        await flushDraft();
        const payload = await apiFetch(endpoint("/configuration/validate"), { method: "POST", body: {} });
        if (payload.valid) results.replaceChildren(element("p", "alert alert-success", "Configuração válida."));
        else { const issues = element("ul", "readiness-list"); for (const issue of payload.issues || []) issues.append(checkCard({ ...issue, state: "failed", correctiveAction: issue.path })); results.replaceChildren(issues); }
      } catch (error) { showIssues(error); results.replaceChildren(element("p", "alert alert-error", error.message)); }
    });
    simulate.addEventListener("click", () => toast("O runtime isolado do simulador será habilitado na Fase 7. Nenhuma chamada externa foi realizada."));
    publish.addEventListener("click", async () => release("publish"));
    activate.addEventListener("click", async () => release("activate"));
    await loadReadiness();
  }

  async function release(action) {
    if (state.conflict) return toast("Recarregue o rascunho atual antes de publicar.");
    try {
      await flushDraft();
    } catch (error) {
      showIssues(error);
      toast(error.message || "Não foi possível salvar o rascunho antes da publicação.");
      return;
    }
    if (state.conflict) return toast("Recarregue o rascunho atual antes de publicar.");
    const label = action === "activate" ? "publicar e ativar" : "publicar esta revisão";
    if (!await confirmAction(`Deseja ${label}? O runtime passará a usar uma revisão imutável.`, action === "activate" ? "Ativar empresa" : "Publicar configuração")) return;
    try {
      const result = await apiFetch(endpoint(action === "activate" ? "/activate" : "/configuration/publish"), { method: "POST", body: { draftVersion: state.draftVersion } });
      toast(action === "activate" ? "Empresa publicada e ativada." : `Revisão ${result.configVersion} publicada.`);
      renderStep();
    } catch (error) { toast(error.message || "A publicação foi bloqueada."); }
  }

  async function saveTenantIfNeeded({ configuration = state.configuration, tenant = state.tenant, generation = state.generation } = {}) {
    if (state.currentStep !== 1 || !state.tenantDirty) return;
    const body = { slug: tenant.slug, name: configuration.identity.name, displayName: configuration.identity.displayName, identity: configuration.identity.publicIdentity || null, timezone: configuration.identity.timezone, locale: configuration.identity.locale, messageRetentionDays: configuration.retention.messagesDays, logRetentionDays: configuration.retention.logsDays };
    const savedTenant = await apiFetch(endpoint(), { method: "PATCH", body });
    if (state.generation === generation) {
      state.tenant = savedTenant;
      state.tenantDirty = false;
    }
  }

  async function saveProgress(nextStep, completeCurrent = false) {
    const completed = [...(state.progress.completedSteps || [])];
    if (completeCurrent && !completed.some((item) => item.step === state.currentStep)) completed.push({ step: state.currentStep, completedAt: new Date().toISOString() });
    try {
      state.progress = await apiFetch(endpoint(`/onboarding/${nextStep}`), { method: "PATCH", body: { revision: state.progress.revision, completedSteps: completed } });
    } catch (error) {
      if (error.status === 409 || /CONFLICT/u.test(error.code || "")) error.onboardingConcurrencyConflict = true;
      throw error;
    }
  }

  async function goToStep(step, completeCurrent = false) {
    if (state.conflict) return toast("Recarregue o rascunho atual antes de mudar de etapa.");
    try {
      const form = state.mount?.querySelector("[data-wizard-stage] form");
      if (completeCurrent && form && !form.reportValidity()) return;
      await flushDraft();
      await saveProgress(step, completeCurrent);
      state.currentStep = step;
      renderShell();
      const heading = state.mount?.querySelector("[data-wizard-stage] h2");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    } catch (error) {
      if (error.status === 401) return onSessionExpired?.();
      if (error.onboardingConcurrencyConflict || state.conflict) {
        state.conflict = error;
        renderConflict();
      }
      showIssues(error);
      toast(error.message || "Não foi possível avançar.");
    }
  }

  function renderStep() {
    const root = state.mount?.querySelector("[data-wizard-stage]");
    if (!root) return;
    root.replaceChildren();
    const renderers = [null, renderCompany, renderModules, renderService, renderRouting, renderOperation, renderFlows, renderAi, renderMeta, renderTeam];
    if (state.currentStep === 10) renderReview(root); else renderers[state.currentStep](root);
  }

  function renderShell() {
    state.mount.replaceChildren();
    const shell = element("div", "onboarding-wizard");
    const alertRegion = element("div"); alertRegion.dataset.wizardAlert = "true";
    const header = element("header", "wizard-header");
    const heading = element("div");
    heading.append(element("p", "eyebrow", `Empresa · ${state.tenant.displayName || state.tenant.name || "sem nome"}`), element("h2", "", "Configuração guiada"));
    state.statusNode = element("p", "autosave-status", `Rascunho carregado · revisão ${state.draftVersion}`);
    state.statusNode.setAttribute("role", "status"); state.statusNode.setAttribute("aria-live", "polite");
    header.append(heading, state.statusNode);
    const layout = element("div", "wizard-layout");
    const nav = element("nav", "wizard-steps"); nav.setAttribute("aria-label", "Etapas do onboarding");
    const completed = new Set((state.progress.completedSteps || []).map((item) => item.step));
    for (const [step, label, description] of STEPS) {
      const item = button(`${step}. ${label}`, "wizard-step");
      item.dataset.state = step === state.currentStep ? "current" : completed.has(step) ? "complete" : "pending";
      item.setAttribute("aria-current", step === state.currentStep ? "step" : "false");
      item.append(element("small", "", description));
      item.addEventListener("click", () => goToStep(step));
      nav.append(item);
    }
    const main = element("div", "wizard-stage"); main.dataset.wizardStage = "true"; main.setAttribute("aria-live", "polite");
    layout.append(nav, main);
    const footer = element("footer", "wizard-footer");
    const previous = button("Voltar", "button button-secondary"); previous.disabled = state.currentStep === 1; previous.addEventListener("click", () => goToStep(state.currentStep - 1));
    const position = element("span", "muted", `Etapa ${state.currentStep} de ${STEPS.length}`);
    const next = button(state.currentStep === 10 ? "Salvar progresso" : "Salvar e continuar", "button button-primary"); next.addEventListener("click", () => goToStep(Math.min(10, state.currentStep + 1), true));
    footer.append(previous, position, next);
    shell.append(alertRegion, header, layout, footer); state.mount.append(shell);
    renderConflict(); renderStep();
  }

  async function render({ empresaId, mount, signal } = {}) {
    state.disposed = false; state.empresaId = empresaId; state.mount = mount;
    const tenant = await apiFetch(endpoint(), { signal });
    const [progress, draft, capabilities, credentials, numbers, metaApps, users] = await Promise.all([
      apiFetch(endpoint("/onboarding"), { signal }), optional(endpoint("/configuration/draft"), signal, { allowNotFound: true }),
      apiFetch(endpoint("/action-catalog"), { signal }), apiFetch(endpoint("/credentials?page=1&pageSize=100"), { signal }),
      apiFetch(endpoint("/numbers?page=1&pageSize=100"), { signal }), apiFetch(endpoint("/meta-applications"), { signal }),
      apiFetch(endpoint("/users?page=1&pageSize=100"), { signal }),
    ]);
    state.tenant = tenant; state.progress = progress; state.currentStep = number(progress.currentStep, 1);
    state.draftVersion = number(draft?.draftVersion, 0); state.configuration = normalizeDraft(draft?.configuration, tenant);
    state.capabilities = Array.isArray(capabilities) ? capabilities : list(capabilities);
    state.credentials = list(credentials); state.numbers = list(numbers); state.metaApps = list(metaApps); state.users = list(users);
    state.generation = draft ? 0 : 1; state.savedGeneration = 0; state.conflict = null; state.tenantDirty = false;
    renderShell();
  }

  async function flushForTransition() {
    if (document.querySelector("dialog.wizard-dialog[open]")) throw new Error("Conclua ou cancele a edição aberta antes de sair do onboarding.");
    if (state.conflict) throw new Error("Recarregue o rascunho atual antes de sair do onboarding.");
    await flushDraft();
    if (state.conflict) throw new Error("Recarregue o rascunho atual antes de sair do onboarding.");
  }

  async function dispose() {
    await flushForTransition();
    abort();
  }

  function abort() {
    state.disposed = true; clearTimeout(state.saveTimer); state.mount = null;
    for (const dialog of document.querySelectorAll("dialog.wizard-dialog")) dialog.close();
  }

  return Object.freeze({ render, flush: flushForTransition, dispose, abort });
}

export { STEPS as ONBOARDING_STEPS, buildFlowStep as createOnboardingFlowStep, emptyDraft as createEmptyOnboardingDraft };
