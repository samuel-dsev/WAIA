const API_BASE = "/api/admin";
const REFRESH_INTERVAL_MS = 30_000;
const ROLE_LABELS = {
  platform_admin: "Administrador da plataforma",
  tenant_admin: "Administrador da empresa",
  tenant_operator: "Operador da empresa",
};

const VIEW_DEFINITIONS = {
  dashboard: {
    title: "Visão geral",
    eyebrow: "Operações",
    description: "Indicadores, saúde e alertas do contexto selecionado.",
    resource: "dashboard",
    filters: false,
    permission: "dashboard",
  },
  companies: {
    title: "Empresas",
    eyebrow: "Plataforma",
    description: "Cadastre, publique, suspenda e acompanhe as empresas da plataforma.",
    resource: "tenants",
    permission: "platform",
    columns: [
      ["name", "Empresa"], ["status", "Estado"], ["numbersCount", "Números"],
      ["configurationVersion", "Versão"], ["updatedAt", "Atualização"],
    ],
  },
  numbers: {
    title: "Números WhatsApp",
    eyebrow: "Canal",
    description: "Vínculos com a Meta e estado das credenciais, sempre mascaradas.",
    resource: "numbers",
    permission: "numbers",
    columns: [
      ["numeroMascarado", "Número"], ["phoneNumberId", "Phone number ID"],
      ["nomeVerificado", "Nome verificado"], ["status", "Estado"], ["updatedAt", "Atualização"],
    ],
  },
  settings: {
    title: "Módulos e configurações",
    eyebrow: "Comportamento",
    description: "Identidade, módulos, IA e integrações carregados dinamicamente.",
    permission: "settings",
    filters: false,
  },
  catalog: {
    title: "Catálogo e serviços", eyebrow: "Configuração", description: "Produtos, convites e serviços publicados pela empresa.",
    resource: "catalog", permission: "settings",
    columns: [["name", "Nome"], ["type", "Tipo"], ["sku", "SKU"], ["price", "Preço"], ["active", "Ativo"], ["updatedAt", "Atualização"]],
  },
  events: {
    title: "Eventos", eyebrow: "Configuração", description: "Agenda de eventos e regras publicadas.",
    resource: "events", permission: "settings",
    columns: [["name", "Evento"], ["startsAt", "Início"], ["location", "Local"], ["status", "Estado"], ["updatedAt", "Atualização"]],
  },
  menus: {
    title: "Menus", eyebrow: "Configuração", description: "Mensagens de menu versionadas da empresa.",
    resource: "menus", permission: "settings",
    columns: [["title", "Título"], ["menuKey", "Chave"], ["message", "Mensagem"], ["active", "Ativo"], ["version", "Versão"]],
  },
  menuItems: {
    title: "Itens de menu", eyebrow: "Configuração", description: "Ações ligadas aos módulos habilitados.",
    resource: "menu-items", permission: "settings",
    columns: [["title", "Título"], ["menuId", "Menu"], ["position", "Posição"], ["actionKey", "Ação"], ["enabled", "Ativo"]],
  },
  payments: {
    title: "Pagamentos", eyebrow: "Configuração", description: "Formas de pagamento; valores recuperáveis ficam no cofre.",
    resource: "payments", permission: "settings",
    columns: [["name", "Nome"], ["type", "Tipo"], ["maskedIdentifier", "Identificador"], ["recipient", "Favorecido"], ["enabled", "Ativo"]],
  },
  availability: {
    title: "Disponibilidades", eyebrow: "Configuração", description: "Horários e capacidade dos serviços.",
    resource: "availability", permission: "settings",
    columns: [["productServiceId", "Serviço"], ["startsAt", "Início"], ["endsAt", "Fim"], ["capacity", "Capacidade"], ["status", "Estado"]],
  },
  integrations: {
    title: "Integrações", eyebrow: "Configuração", description: "Provedores externos e seu estado operacional.",
    resource: "integrations", permission: "settings",
    columns: [["name", "Nome"], ["type", "Tipo"], ["status", "Estado"], ["enabled", "Ativa"], ["updatedAt", "Atualização"]],
  },
  contacts: {
    title: "Contatos",
    eyebrow: "Relacionamento",
    description: "Histórico, consentimento, etiquetas e controles de automação.",
    resource: "contacts",
    permission: "operations",
    columns: [
      ["name", "Contato"], ["phoneMasked", "Telefone"], ["firstInteractionAt", "Primeira interação"],
      ["lastInteractionAt", "Última interação"], ["automationStatus", "Automação"], ["tags", "Etiquetas"],
    ],
  },
  conversations: {
    title: "Conversas e mensagens",
    eyebrow: "Atendimento",
    description: "Mensagens, estados, origem da resposta e transições para atendimento humano.",
    resource: "conversations",
    permission: "operations",
    columns: [
      ["contactId", "Contato"], ["numberId", "Número"], ["status", "Estado"],
      ["mode", "Modo"], ["operatorId", "Responsável"], ["lastMessageAt", "Última mensagem"],
    ],
  },
  orders: {
    title: "Pedidos",
    eyebrow: "Operações",
    description: "Pedidos e pagamentos pendentes de conferência humana.",
    resource: "orders",
    permission: "operations",
    columns: [
      ["id", "Pedido"], ["buyerName", "Cliente"], ["paymentStatus", "Pagamento"],
      ["total", "Valor"], ["status", "Estado"], ["createdAt", "Criação"],
    ],
  },
  appointments: {
    title: "Agendamentos",
    eyebrow: "Operações",
    description: "Solicitações, horários e responsáveis por confirmação.",
    resource: "appointments",
    permission: "operations",
    columns: [
      ["id", "Agendamento"], ["contactId", "Contato"], ["conversationId", "Conversa"],
      ["startsAt", "Horário"], ["status", "Estado"], ["updatedAt", "Atualização"],
    ],
  },
  usage: {
    title: "Consumo de IA",
    eyebrow: "Custos e limites",
    description: "Tokens, custo estimado, tipo de chave e aproximação do limite mensal.",
    resource: "ai-usage",
    permission: "usage",
    columns: [
      ["occurredAt", "Data"], ["model", "Modelo"], ["keyType", "Tipo de chave"],
      ["inputTokens", "Entrada"], ["outputTokens", "Saída"], ["estimatedCost", "Custo estimado"], ["success", "Sucesso"],
    ],
  },
  logs: {
    title: "Logs e falhas",
    eyebrow: "Observabilidade",
    description: "Eventos sanitizados, jobs falhos, retries e IDs de correlação.",
    resource: "logs",
    permission: "logs",
    columns: [
      ["occurredAt", "Data"], ["severity", "Severidade"], ["category", "Categoria"],
      ["eventCode", "Evento"], ["summary", "Resumo"], ["correlationId", "Correlação"],
    ],
  },
  failedJobs: {
    title: "Jobs falhos",
    eyebrow: "Recuperação operacional",
    description: "Falhas finais sanitizadas, com retentativa segura ou resolução administrativa auditada.",
    resource: "failed-jobs",
    permission: "logs",
    defaultFilters: { status: "open" },
    statusOptions: [["open", "Em aberto"], ["resolved", "Resolvidos"], ["all", "Todos"]],
    columns: [
      ["jobType", "Tipo"], ["attempts", "Tentativas"], ["errorCode", "Código"],
      ["error", "Erro sanitizado"], ["lastFailureAt", "Última falha"], ["status", "Estado"],
    ],
  },
  audit: {
    title: "Auditoria",
    eyebrow: "Segurança",
    description: "Ações administrativas, acessos sensíveis e mudanças sem valores secretos.",
    resource: "audit",
    permission: "logs",
    columns: [
      ["occurredAt", "Data"], ["action", "Ação"], ["resource", "Recurso"],
      ["result", "Resultado"], ["actorId", "Responsável"], ["correlationId", "Correlação"],
    ],
  },
  users: {
    title: "Usuários e permissões",
    eyebrow: "Acesso",
    description: "Vínculos, papéis e permissões efetivas da empresa.",
    resource: "users",
    permission: "users",
    columns: [
      ["name", "Nome"], ["email", "E-mail"], ["role", "Papel"],
      ["status", "Estado"], ["lastLoginAt", "Último acesso"], ["updatedAt", "Atualização"],
    ],
  },
  diagnostics: {
    title: "Diagnósticos",
    eyebrow: "Saúde da plataforma",
    description: "Estado detalhado dos serviços e integrações, protegido por autorização.",
    resource: "diagnostics",
    permission: "diagnostics",
    filters: false,
  },
};

const MODULES = [
  ["catalog", "Catálogo"], ["orders", "Pedidos"], ["events", "Agenda de eventos"],
  ["appointments", "Agendamentos"], ["payments", "Pagamentos"],
  ["human_handoff", "Atendimento humano"], ["ai_freeform", "IA para perguntas livres"],
  ["external_integrations", "Integrações externas"],
];

const state = {
  session: null,
  csrfToken: "",
  tenants: [],
  selectedEmpresaId: "",
  currentView: "dashboard",
  page: 1,
  pageSize: 20,
  filters: {},
  refreshEnabled: true,
  refreshTimer: null,
  requestController: null,
  receiptObjectUrl: null,
};

const elements = Object.fromEntries([
  "loginView", "loginForm", "loginEmail", "loginPassword", "loginEmailError", "loginPasswordError", "loginError",
  "appShell", "sidebar", "primaryNav", "menuToggle", "tenantSelect", "sessionUser", "logoutButton", "refreshToggle",
  "mainContent", "viewEyebrow", "viewTitle", "viewDescription", "viewActions", "filterForm", "clearFilters",
  "contentState", "viewContent", "pagination", "previousPage", "nextPage", "pageSummary", "pageSize",
  "confirmDialog", "confirmTitle", "confirmMessage", "confirmCancel", "confirmAccept",
  "detailDialog", "detailTitle", "detailContent", "detailClose", "toastRegion",
].map((id) => [id, document.getElementById(id)]));

function roleForCurrentContext() {
  if (state.session?.platformRole === "platform_admin") return "platform_admin";
  return state.session?.memberships?.find((membership) => membership.empresaId === state.selectedEmpresaId)?.role || null;
}

function allowed(permission) {
  const role = roleForCurrentContext();
  if (role === "platform_admin") return true;
  if (role === "tenant_admin") return permission !== "platform";
  if (role === "tenant_operator") return new Set(["dashboard", "operations"]).has(permission);
  return false;
}

function readCsrf(payload, response) {
  const token = payload?.csrfToken || response?.headers?.get?.("x-csrf-token");
  if (token) state.csrfToken = String(token);
}

async function apiFetch(path, { method = "GET", body, signal, headers = {} } = {}) {
  const upperMethod = method.toUpperCase();
  const mutating = !new Set(["GET", "HEAD", "OPTIONS"]).has(upperMethod);
  const response = await fetch(`${API_BASE}${path}`, {
    method: upperMethod,
    credentials: "include",
    signal,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(mutating && state.csrfToken ? { "X-CSRF-Token": state.csrfToken } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  readCsrf(payload, response);
  if (!response.ok) {
    const nestedError = payload?.error && typeof payload.error === "object" ? payload.error : null;
    const error = new Error(payload?.message || nestedError?.message
      || (typeof payload?.error === "string" ? payload.error : "Não foi possível concluir a solicitação."));
    error.status = response.status;
    error.code = payload?.code || nestedError?.code || "ADMIN_API_ERROR";
    throw error;
  }
  return payload;
}

function normalizedSession(payload) {
  const source = payload?.session || payload || {};
  const user = source.user || {};
  return {
    user: {
      id: user.id,
      name: user.name || user.email || "Usuário",
      email: user.email || "",
    },
    platformRole: source.platformRole === "platform_admin" ? "platform_admin" : null,
    memberships: Array.isArray(source.memberships) ? source.memberships.map((membership) => ({
      empresaId: String(membership.empresaId),
      empresaName: membership.empresaName || membership.name,
      role: membership.role,
      permissions: Array.isArray(membership.permissions) ? membership.permissions : [],
    })) : [],
  };
}

function showLogin(message = "") {
  stopRefresh();
  state.session = null;
  state.csrfToken = "";
  elements.appShell.hidden = true;
  elements.loginView.hidden = false;
  elements.loginError.hidden = !message;
  elements.loginError.textContent = message;
  elements.loginPassword.value = "";
  elements.loginEmail.focus();
}

function showApp() {
  elements.loginView.hidden = true;
  elements.appShell.hidden = false;
  elements.sessionUser.textContent = `${state.session.user.name} · ${ROLE_LABELS[roleForCurrentContext()] || "Sem acesso"}`;
  renderNavigation();
  startRefresh();
}

async function loadSession() {
  try {
    const csrfCookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("waia_csrf="));
    if (csrfCookie) state.csrfToken = decodeURIComponent(csrfCookie.slice("waia_csrf=".length));
    const payload = await apiFetch("/auth/session");
    state.session = normalizedSession(payload);
    await loadTenants(payload?.tenants);
    showApp();
    await navigate(location.hash.slice(1) || "dashboard", { updateHash: false });
  } catch (error) {
    showLogin(error.status && error.status !== 401 ? "O painel está temporariamente indisponível." : "");
  }
}

async function loadTenants(initialTenants) {
  if (Array.isArray(initialTenants)) {
    state.tenants = initialTenants;
  } else if (state.session.platformRole === "platform_admin") {
    const payload = await apiFetch("/tenants?page=1&pageSize=100");
    state.tenants = listFrom(payload);
  } else {
    state.tenants = state.session.memberships.map((membership) => ({
      id: membership.empresaId,
      name: membership.empresaName || `Empresa ${membership.empresaId.slice(0, 8)}`,
    }));
  }
  elements.tenantSelect.replaceChildren();
  if (state.session.platformRole === "platform_admin") {
    elements.tenantSelect.append(new Option("Visão global da plataforma", ""));
  }
  for (const tenant of state.tenants) {
    elements.tenantSelect.append(new Option(tenant.name || tenant.displayName || "Empresa", tenant.id || tenant.empresaId));
  }
  state.selectedEmpresaId = state.session.platformRole === "platform_admin"
    ? ""
    : elements.tenantSelect.options[0]?.value || "";
  elements.tenantSelect.value = state.selectedEmpresaId;
}

function renderNavigation() {
  for (const button of elements.primaryNav.querySelectorAll("button[data-view]")) {
    const definition = VIEW_DEFINITIONS[button.dataset.view];
    button.hidden = !allowed(definition.permission);
    button.setAttribute("aria-current", button.dataset.view === state.currentView ? "page" : "false");
  }
}

function resetViewFilters(definition) {
  const statusSelect = elements.filterForm.elements.status;
  const options = definition.statusOptions || [
    ["", "Todos"], ["active", "Ativo"], ["pending", "Pendente"],
    ["failed", "Falhou"], ["suspended", "Suspenso"],
  ];
  statusSelect.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  elements.filterForm.reset();
  state.filters = { ...(definition.defaultFilters || {}) };
  for (const [name, value] of Object.entries(state.filters)) {
    if (elements.filterForm.elements[name]) elements.filterForm.elements[name].value = value;
  }
}

function endpointFor(definition, suffix = "") {
  if (definition.resource === "tenants") return `/tenants${suffix}`;
  if (!state.selectedEmpresaId) {
    if (definition.resource === "dashboard" || definition.resource === "diagnostics") return `/${definition.resource}${suffix}`;
    return null;
  }
  return `/tenants/${encodeURIComponent(state.selectedEmpresaId)}/${definition.resource}${suffix}`;
}

function queryString() {
  const params = new URLSearchParams({ page: String(state.page), pageSize: String(state.pageSize) });
  for (const [key, value] of Object.entries(state.filters)) if (value) params.set(key, value);
  return params.toString();
}

function setContentState(type, message, { retry = false } = {}) {
  elements.contentState.replaceChildren();
  if (!type) return;
  const card = document.createElement("div");
  card.className = "state-card";
  if (type === "loading") {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    card.setAttribute("role", "status");
    card.append(spinner, paragraph(message || "Carregando…"));
  } else {
    card.append(paragraph(message));
    if (retry) card.append(button("Tentar novamente", () => loadCurrentView(), "button button-primary"));
  }
  elements.contentState.append(card);
}

function listFrom(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function paginationFrom(payload, count) {
  const source = payload?.pagination || payload?.meta || {};
  const page = Number(source.page || payload?.page || state.page);
  const pageSize = Number(source.pageSize || payload?.pageSize || state.pageSize);
  const total = Number(source.total ?? payload?.total ?? count);
  const totalPages = Number(source.totalPages || Math.max(1, Math.ceil(total / pageSize)));
  return { page, pageSize, total, totalPages };
}

async function navigate(view, { updateHash = true } = {}) {
  const next = VIEW_DEFINITIONS[view] ? view : "dashboard";
  const definition = VIEW_DEFINITIONS[next];
  if (!allowed(definition.permission)) {
    toast("Você não possui permissão para essa área.");
    return;
  }
  state.currentView = next;
  state.page = 1;
  resetViewFilters(definition);
  if (updateHash) history.replaceState(null, "", `#${next}`);
  elements.viewEyebrow.textContent = definition.eyebrow;
  elements.viewTitle.textContent = definition.title;
  elements.viewDescription.textContent = definition.description;
  elements.filterForm.hidden = definition.filters === false;
  elements.viewActions.replaceChildren();
  elements.pagination.hidden = true;
  elements.sidebar.classList.remove("is-open");
  elements.menuToggle.setAttribute("aria-expanded", "false");
  renderNavigation();
  addViewActions(next);
  await loadCurrentView();
  elements.mainContent.focus({ preventScroll: true });
}

function addViewActions(view) {
  if (view === "companies" && allowed("platform")) {
    elements.viewActions.append(button("Nova empresa", () => openCreateTenant(), "button button-primary"));
  }
  if (view === "numbers" && allowed("settings") && state.selectedEmpresaId) {
    elements.viewActions.append(button("Vincular número", () => openNumberForm(), "button button-primary"));
  }
  if (view === "users" && allowed("users") && state.selectedEmpresaId) {
    elements.viewActions.append(button("Adicionar usuário", () => openUserForm(), "button button-primary"));
  }
  if (["catalog", "events", "menus", "menuItems", "payments", "availability", "integrations"].includes(view)
    && allowed("settings") && state.selectedEmpresaId) {
    elements.viewActions.append(button("Adicionar", () => openResourceCreate(view), "button button-primary"));
  }
  elements.viewActions.append(button("Atualizar", () => loadCurrentView(), "button button-secondary"));
}

async function loadCurrentView({ silent = false } = {}) {
  const definition = VIEW_DEFINITIONS[state.currentView];
  state.requestController?.abort();
  state.requestController = new AbortController();
  if (!silent) {
    elements.viewContent.replaceChildren();
    setContentState("loading", `Carregando ${definition.title.toLocaleLowerCase("pt-BR")}…`);
  }
  try {
    if (state.currentView === "settings") return await loadSettings(state.requestController.signal);
    const endpoint = endpointFor(definition);
    if (!endpoint) {
      elements.viewContent.replaceChildren();
      elements.pagination.hidden = true;
      setContentState("empty", "Selecione uma empresa para consultar esta área.");
      return;
    }
    const usesPagination = definition.filters !== false || state.currentView === "companies";
    const payload = await apiFetch(`${endpoint}${usesPagination ? `?${queryString()}` : ""}`, { signal: state.requestController.signal });
    if (state.currentView === "dashboard") renderDashboard(payload);
    else if (state.currentView === "diagnostics") renderDiagnostics(payload);
    else renderList(definition, payload);
    setContentState(null);
  } catch (error) {
    if (error.name === "AbortError") return;
    if (error.status === 401) return showLogin("Sua sessão expirou. Entre novamente.");
    elements.viewContent.replaceChildren();
    elements.pagination.hidden = true;
    setContentState("error", error.message || "Não foi possível carregar os dados.", { retry: true });
  }
}

function renderDashboard(payload = {}) {
  elements.viewContent.replaceChildren();
  const data = payload.data || payload;
  const metrics = state.selectedEmpresaId
    ? [
      ["Mensagens recebidas", data.messagesReceived], ["Mensagens enviadas", data.messagesSent],
      ["Pendentes", data.pendingMessages, "warning"], ["Falhas", data.failedMessages ?? data.failedJobs, "danger"],
      ["Novos contatos", data.newContacts], ["Pedidos", data.orders], ["Agendamentos", data.appointments],
      ["Custo estimado de IA", data.aiEstimatedCost],
    ]
    : [
      ["Empresas cadastradas", data.companiesTotal ?? data.companies], ["Empresas ativas", data.activeCompanies, "success"],
      ["Empresas suspensas", data.suspendedCompanies, "warning"], ["Empresas com falhas", data.companiesWithFailures, "danger"],
      ["Números vinculados", data.whatsappNumbers ?? data.numbers], ["Jobs pendentes", data.pendingJobs, "warning"],
      ["Jobs falhos", data.failedJobs, "danger"], ["Custo estimado de IA", data.aiEstimatedCost ?? data.estimatedAiCost],
    ];
  const grid = node("div", "metric-grid");
  for (const [label, value, tone] of metrics) {
    const card = node("article", "metric-card");
    if (tone) card.dataset.tone = tone;
    card.append(nodeWithText("small", label), nodeWithText("strong", displayValue(value)));
    grid.append(card);
  }
  const panels = node("div", "panel-grid");
  panels.append(summaryPanel("Saúde dos serviços", data.health || data.services || {}), summaryPanel("Alertas operacionais", data.alerts || []));
  elements.viewContent.append(grid, panels);
}

function renderDiagnostics(payload = {}) {
  elements.viewContent.replaceChildren();
  const services = payload.services || payload.health || payload.data || payload;
  const panel = node("div", "panel-card");
  panel.append(nodeWithText("h2", "Serviços e integrações"));
  const list = node("dl", "detail-list");
  for (const [name, value] of Object.entries(services || {})) {
    list.append(nodeWithText("dt", humanize(name)), valueNode(value));
  }
  panel.append(list);
  elements.viewContent.append(panel);
}

function renderList(definition, payload) {
  elements.viewContent.replaceChildren();
  const items = listFrom(payload);
  if (items.length === 0) {
    elements.pagination.hidden = true;
    setContentState("empty", "Nenhum resultado encontrado para os filtros atuais.");
    return;
  }
  const wrap = node("div", "table-wrap");
  const table = node("table", "data-table");
  const caption = nodeWithText("caption", definition.title);
  caption.className = "visually-hidden";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const [, label] of definition.columns) headRow.append(nodeWithText("th", label));
  headRow.append(nodeWithText("th", "Ações"));
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const item of items) {
    const row = document.createElement("tr");
    for (const [key, label] of definition.columns) {
      const cell = document.createElement("td");
      cell.dataset.label = label;
      cell.append(valueNode(item[key], key));
      row.append(cell);
    }
    const actions = document.createElement("td");
    actions.dataset.label = "Ações";
    actions.append(rowActions(state.currentView, item));
    row.append(actions);
    body.append(row);
  }
  table.append(caption, head, body);
  wrap.append(table);
  elements.viewContent.append(wrap);
  renderPagination(paginationFrom(payload, items.length));
}

function rowActions(view, item) {
  const group = node("div", "row-actions");
  const id = item.id || item.empresaId;
  if (view === "conversations") {
    group.append(button("Abrir", () => openConversation(id), "button button-secondary button-small"));
  } else if (view === "failedJobs") {
    group.append(button("Analisar", () => openFailedJob(id), "button button-secondary button-small"));
  } else {
    group.append(button("Detalhes", () => openRecord(view, item), "button button-secondary button-small"));
  }
  if (view === "companies" && allowed("platform")) {
    const suspended = ["suspended", "suspensa", "suspenso"].includes(String(item.status).toLocaleLowerCase("pt-BR"));
    group.append(button(suspended ? "Ativar" : "Suspender", () => changeTenantStatus(id, suspended ? "active" : "suspended", item.name), `button ${suspended ? "button-primary" : "button-danger"} button-small`));
  }
  if (view === "numbers" && allowed("settings")) {
    group.append(button("Rotacionar credencial", () => openCredentialRotation(id), "button button-quiet button-small"));
  }
  return group;
}

async function openFailedJob(id) {
  const base = endpointFor(VIEW_DEFINITIONS.failedJobs);
  if (!base) return;
  elements.detailTitle.textContent = "Job falho";
  elements.detailContent.replaceChildren(paragraph("Carregando incidente…"));
  if (!elements.detailDialog.open) elements.detailDialog.showModal();
  try {
    const job = await apiFetch(`${base}/${encodeURIComponent(id)}`);
    const details = node("dl", "detail-list");
    for (const [label, key] of [
      ["Tipo", "jobType"], ["Estado", "status"], ["Tentativas", "attempts"],
      ["Máximo de tentativas", "maxAttempts"], ["Código do erro", "errorCode"],
      ["Erro sanitizado", "error"], ["Conversa", "conversationId"], ["Mensagem", "messageId"],
      ["Correlação", "correlationId"], ["Job original", "originalJobId"],
      ["Estado original", "originalJobStatus"], ["Primeira falha", "firstFailureAt"],
      ["Última falha", "lastFailureAt"], ["Resolução", "resolutionKind"],
      ["Motivo", "resolutionNote"], ["Novo job", "retryJobId"], ["Estado do novo job", "retryJobStatus"],
    ]) details.append(nodeWithText("dt", label), valueNode(job[key], key));
    const content = [details];
    if (!job.resolvedAt) content.push(failedJobActions(id));
    elements.detailContent.replaceChildren(...content);
  } catch (error) {
    if (error.status === 401) return showLogin("Sua sessão expirou. Entre novamente.");
    elements.detailContent.replaceChildren(paragraph(error.message || "Não foi possível abrir o job falho."));
  }
}

function failedJobActions(id) {
  const section = node("section", "failed-job-actions");
  section.append(
    nodeWithText("h3", "Decisão operacional"),
    paragraph("Reenfileirar cria um novo job; resolver apenas encerra o alerta e não altera o resultado da mensagem."),
  );
  const label = nodeWithText("label", "Motivo da decisão");
  const reason = document.createElement("textarea");
  reason.id = `failed-job-reason-${id}`;
  reason.rows = 3;
  reason.maxLength = 1000;
  reason.required = true;
  label.htmlFor = reason.id;
  const actions = node("div", "dialog-actions");
  const retry = button("Reenfileirar com segurança", () => performFailedJobAction(id, "retry", reason), "button button-primary");
  const resolve = button("Marcar como resolvido", () => performFailedJobAction(id, "resolve", reason), "button button-secondary");
  actions.append(retry, resolve);
  section.append(label, reason, actions);
  return section;
}

async function performFailedJobAction(id, action, reasonInput) {
  const reason = reasonInput.value.trim();
  reasonInput.setCustomValidity(reason ? "" : "Informe o motivo da decisão.");
  if (!reasonInput.reportValidity()) return;
  const retrying = action === "retry";
  const confirmed = await confirmAction(
    retrying
      ? "Um novo job será criado e processado pelo worker. Deseja continuar?"
      : "O alerta será encerrado sem alterar o estado final da mensagem. Deseja continuar?",
    retrying ? "Confirmar retentativa" : "Confirmar resolução",
  );
  if (!confirmed) return;
  try {
    await apiFetch(`/tenants/${encodeURIComponent(state.selectedEmpresaId)}/failed-jobs/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      body: { reason },
    });
    toast(retrying ? "Novo job criado para processamento." : "Job falho marcado como resolvido.");
    elements.detailDialog.close();
    await loadCurrentView();
  } catch (error) {
    if (error.status === 401) return showLogin("Sua sessão expirou. Entre novamente.");
    toast(error.message || "Não foi possível concluir a decisão operacional.");
  }
}

function renderPagination(meta) {
  state.page = meta.page;
  state.pageSize = meta.pageSize;
  elements.pagination.hidden = false;
  elements.previousPage.disabled = meta.page <= 1;
  elements.nextPage.disabled = meta.page >= meta.totalPages;
  elements.pageSummary.textContent = `Página ${meta.page} de ${meta.totalPages} · ${meta.total} itens`;
  elements.pageSize.value = String(meta.pageSize);
}

async function loadSettings(signal) {
  const base = state.selectedEmpresaId ? `/tenants/${encodeURIComponent(state.selectedEmpresaId)}` : null;
  if (!base) {
    elements.viewContent.replaceChildren();
    setContentState("empty", "Selecione uma empresa para configurar módulos e integrações.");
    return;
  }
  const [modules, aiConfig, integrations, runtimeConfig, credentials] = await Promise.all([
    apiFetch(`${base}/modules`, { signal }),
    apiFetch(`${base}/ai-config`, { signal }),
    apiFetch(`${base}/integrations`, { signal }),
    apiFetch(`${base}/runtime-config`, { signal }),
    apiFetch(`${base}/credentials`, { signal }),
  ]);
  elements.viewContent.replaceChildren(settingsForm(modules, aiConfig, integrations, runtimeConfig, credentials));
  elements.pagination.hidden = true;
  setContentState(null);
}

function settingsForm(modulePayload, aiPayload, integrationPayload, runtimePayload, credentialPayload) {
  const wrapper = node("div", "panel-grid");
  const enabledModules = new Set(listFrom(modulePayload).filter((item) => item.enabled !== false).map((item) => item.moduleKey || item.key || item.module));
  const modulesCard = node("section", "panel-card");
  modulesCard.append(nodeWithText("h2", "Módulos habilitados"));
  const form = document.createElement("form");
  form.id = "moduleSettingsForm";
  for (const [key, label] of MODULES) {
    const row = node("label", "check-row");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "modules";
    input.value = key;
    input.checked = enabledModules.has(key);
    row.append(input, document.createTextNode(label));
    form.append(row);
  }
  form.append(button("Salvar módulos", null, "button button-primary", "submit"));
  form.addEventListener("submit", saveModules);
  modulesCard.append(form);

  const runtimeConfig = listFrom(runtimePayload)[0] || runtimePayload?.data || runtimePayload || {};
  const runtimeCard = node("section", "panel-card");
  runtimeCard.append(nodeWithText("h2", "Identidade e atendimento"));
  const runtimeList = node("dl", "detail-list");
  runtimeList.append(
    nodeWithText("dt", "Saudação"), valueNode(runtimeConfig.greeting),
    nodeWithText("dt", "Contingência"), valueNode(runtimeConfig.fallbackMessage),
    nodeWithText("dt", "Endereço"), valueNode(runtimeConfig.address),
    nodeWithText("dt", "Cardápio"), valueNode(runtimeConfig.menuUrl),
  );
  runtimeCard.append(runtimeList, button("Editar atendimento", () => openRuntimeConfig(runtimeConfig), "button button-secondary"));

  const ai = listFrom(aiPayload)[0] || aiPayload?.data || aiPayload || {};
  const aiCard = node("section", "panel-card");
  aiCard.append(nodeWithText("h2", "Configuração da IA"));
  const aiList = node("dl", "detail-list");
  aiList.append(
    nodeWithText("dt", "Modelo"), valueNode(ai.model),
    nodeWithText("dt", "Tipo de chave"), valueNode(ai.keyType),
    nodeWithText("dt", "Limite mensal"), valueNode(ai.monthlyTokenLimit),
    nodeWithText("dt", "Credencial"), valueNode(ai.credentialStatus || "not_configured", "status"),
  );
  aiCard.append(aiList, button("Editar IA", () => openAiConfig(ai), "button button-secondary"));

  const integrationsCard = node("section", "panel-card");
  integrationsCard.append(nodeWithText("h2", "Integrações"));
  const integrationList = node("dl", "detail-list");
  for (const integration of listFrom(integrationPayload)) {
    integrationList.append(nodeWithText("dt", integration.name || integration.provider || "Integração"), valueNode(integration.health || integration.status, "status"));
  }
  if (!integrationList.children.length) integrationList.append(nodeWithText("dt", "Estado"), valueNode("not_configured", "status"));
  integrationsCard.append(integrationList);

  const credentialsCard = node("section", "panel-card");
  credentialsCard.append(nodeWithText("h2", "Credenciais"));
  for (const credential of listFrom(credentialPayload)) {
    const row = node("div", "check-row");
    row.append(
      nodeWithText("span", `${credential.provider} · ${credential.purpose} · ${credential.maskedSecret || "mascarada"}`),
      button("Rotacionar", () => openCredentialUpdate(credential.id), "button button-quiet button-small"),
    );
    credentialsCard.append(row);
  }
  if (!listFrom(credentialPayload).length) credentialsCard.append(paragraph("Nenhuma credencial cadastrada."));
  credentialsCard.append(button("Cadastrar chave OpenAI", openOpenAiCredential, "button button-secondary"));
  credentialsCard.append(button("Cadastrar dado de pagamento", openPaymentCredential, "button button-secondary"));

  wrapper.append(modulesCard, runtimeCard, aiCard, integrationsCard, credentialsCard);
  return wrapper;
}

function openRuntimeConfig(current) {
  openFormDialog("Identidade e atendimento", [
    ["greeting", "Saudação inicial", "text", true],
    ["fallbackMessage", "Mensagem de contingência", "text", true],
    ["address", "Endereço", "text", false], ["menuUrl", "URL do cardápio", "url", false],
    ["birthdayRule", "Regra de aniversariante", "text", false],
  ], async (values) => performMutation(`/tenants/${encodeURIComponent(state.selectedEmpresaId)}/runtime-config/${encodeURIComponent(state.selectedEmpresaId)}`, {
    method: "PATCH", body: nonEmpty(values), success: "Atendimento atualizado.",
  }), current);
}

function openAiConfig(current) {
  openFormDialog("Configuração da IA", [
    ["enabled", "IA habilitada", "select", true, [["false", "Não"], ["true", "Sim"]]],
    ["provider", "Provedor", "select", true, [["openai", "OpenAI"], ["simulado", "Simulado (desenvolvimento)"]]],
    ["model", "Modelo", "text", true], ["prompt", "Prompt", "text", false],
    ["personality", "Personalidade", "text", false],
    ["keyType", "Tipo de chave", "select", true, [["compartilhada", "Compartilhada"], ["propria", "Própria"]]],
    ["ownCredentialId", "ID da credencial própria", "text", false],
    ["monthlyTokenLimit", "Limite mensal de tokens", "number", false],
    ["alertPercent", "Alerta percentual", "number", true],
    ["maxHistoryMessages", "Mensagens no histórico", "number", true],
    ["maxOutputTokens", "Máximo de tokens por resposta", "number", true],
    ["fallbackMessage", "Mensagem de contingência", "text", false],
  ], async (values) => {
    const body = nonEmpty(values);
    body.enabled = body.enabled === "true";
    for (const field of ["monthlyTokenLimit", "alertPercent", "maxHistoryMessages", "maxOutputTokens"]) {
      if (body[field] != null) body[field] = Number(body[field]);
    }
    body.ownCredentialId = body.keyType === "propria" ? body.ownCredentialId : null;
    await performMutation(`/tenants/${encodeURIComponent(state.selectedEmpresaId)}/ai-config/${encodeURIComponent(state.selectedEmpresaId)}`, {
      method: "PATCH", body, success: "Configuração da IA atualizada.",
    });
  }, current);
}

function openOpenAiCredential() {
  openFormDialog("Cadastrar chave OpenAI", [["secret", "Chave OpenAI", "password", true]], async (values) => {
    await performMutation(`/tenants/${encodeURIComponent(state.selectedEmpresaId)}/credentials`, {
      method: "POST", body: { provider: "openai", purpose: "responses", secret: values.secret },
      success: "Chave cadastrada. O valor não será exibido novamente.",
    });
  });
}

function openPaymentCredential() {
  openFormDialog("Cadastrar dado de pagamento", [["purpose", "Finalidade (ex.: pix)", "text", true], ["secret", "Valor recuperável", "password", true]], async (values) => {
    await performMutation(`/tenants/${encodeURIComponent(state.selectedEmpresaId)}/credentials`, {
      method: "POST", body: { provider: "payment", purpose: values.purpose, secret: values.secret },
      success: "Dado cadastrado no cofre. O valor não será exibido novamente.",
    });
  });
}

function openCredentialUpdate(credentialId) {
  openFormDialog("Rotacionar credencial", [["secret", "Novo valor", "password", true]], async (values) => {
    await performMutation(`/tenants/${encodeURIComponent(state.selectedEmpresaId)}/credentials/${encodeURIComponent(credentialId)}/rotate`, {
      method: "POST", body: { secret: values.secret }, success: "Credencial rotacionada.",
    });
  });
}

async function saveModules(event) {
  event.preventDefault();
  if (!allowed("settings")) return;
  const confirmed = await confirmAction("Alterar módulos pode interromper fluxos em andamento. Deseja continuar?", "Salvar módulos");
  if (!confirmed) return;
  const enabledModules = [...event.currentTarget.elements.modules].filter((input) => input.checked).map((input) => input.value);
  await performMutation(`/tenants/${encodeURIComponent(state.selectedEmpresaId)}/modules`, {
    method: "PUT",
    body: { enabledModules },
    success: "Módulos atualizados.",
  });
}

async function openConversation(id) {
  const base = endpointFor(VIEW_DEFINITIONS.conversations);
  if (!base) return;
  elements.detailTitle.textContent = "Conversa";
  elements.detailContent.replaceChildren(paragraph("Carregando conversa…"));
  if (!elements.detailDialog.open) elements.detailDialog.showModal();
  try {
    const payload = await apiFetch(`${base}/${encodeURIComponent(id)}`);
    const conversation = payload.conversation || payload.data || payload;
    elements.detailTitle.textContent = conversation.contactName || "Conversa";
    const details = node("dl", "detail-list");
    for (const [label, value, key] of [
      ["Contato", conversation.contactId], ["Número", conversation.numberId], ["Estado", conversation.status, "status"],
      ["Modo", conversation.mode], ["Responsável", conversation.operatorId], ["Correlação", conversation.correlationId],
    ]) details.append(nodeWithText("dt", label), valueNode(value, key));
    const messages = node("div", "message-list");
    messages.setAttribute("aria-label", "Mensagens da conversa");
    for (const message of listFrom(payload.messages || conversation.messages || [])) {
      const item = node("article", "message");
      const direction = message.direction || message.direcao || "inbound";
      item.dataset.direction = ({ entrada: "inbound", saida: "outbound" })[direction] || direction;
      item.append(paragraph(message.text || message.body || "Mensagem sem conteúdo exibível."));
      if (message.mediaMimeType) {
        item.append(button("Ver mídia privada", () => openReceiptPreview(message.id), "button button-secondary button-small"));
      }
      item.append(nodeWithText("small", `${message.responseOrigin || message.origin || message.source || "Origem não informada"} · ${message.status || "Estado não informado"} · ${formatDate(message.createdAt)}`));
      messages.append(item);
    }
    if (!messages.children.length) messages.append(paragraph("Nenhuma mensagem disponível."));
    const tools = node("div", "handoff-tools");
    tools.append(
      button("Assumir conversa", () => conversationAction(id, "assume"), "button button-primary button-small"),
      button("Pausar bot", () => conversationAction(id, "pause"), "button button-secondary button-small"),
      button("Devolver ao bot", () => conversationAction(id, "resume"), "button button-secondary button-small"),
    );
    elements.detailContent.replaceChildren(details, messages, tools, humanMessageComposer(id, conversation));
  } catch (error) {
    elements.detailContent.replaceChildren(paragraph(error.message || "Não foi possível abrir a conversa."));
  }
}

function humanMessageComposer(conversationId, conversation) {
  const section = node("section", "human-composer");
  section.append(nodeWithText("h3", "Resposta humana"));
  const mode = String(conversation.mode || "").toLocaleLowerCase("pt-BR");
  const status = String(conversation.status || "").toLocaleLowerCase("pt-BR");
  const assignedToCurrentUser = String(conversation.operatorId || "") === String(state.session?.user?.id || "");
  if (!["human", "humano"].includes(mode) || !["open", "aberta"].includes(status) || !assignedToCurrentUser) {
    section.append(nodeWithText("p", "Assuma esta conversa com seu usuário para habilitar o envio. O bot continuará sem responder enquanto o atendimento estiver humano ou pausado.", "handoff-note"));
    return section;
  }

  const form = document.createElement("form");
  form.className = "human-composer-form";
  const label = nodeWithText("label", "Mensagem ao cliente");
  const textarea = document.createElement("textarea");
  textarea.name = "text";
  textarea.required = true;
  textarea.maxLength = 4096;
  textarea.rows = 4;
  textarea.placeholder = "Digite a resposta que será enviada pelo WhatsApp desta empresa.";
  label.htmlFor = `human-message-${conversationId}`;
  textarea.id = label.htmlFor;
  const counter = nodeWithText("small", "0 / 4096", "muted");
  textarea.addEventListener("input", () => { counter.textContent = `${textarea.value.length} / 4096`; });
  const submit = button("Enviar pelo WhatsApp", null, "button button-primary", "submit");
  let idempotencyKey = crypto.randomUUID();
  form.append(label, textarea, counter, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    submit.disabled = true;
    textarea.disabled = true;
    try {
      await apiFetch(`/tenants/${encodeURIComponent(state.selectedEmpresaId)}/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: "POST",
        body: { text: textarea.value, idempotencyKey },
      });
    } catch (error) {
      if (error.status === 401) return showLogin("Sua sessão expirou. Entre novamente.");
      toast(error.message || "Não foi possível enviar a mensagem.");
      submit.disabled = false;
      textarea.disabled = false;
      textarea.focus();
      return;
    }
    toast("Mensagem registrada para envio.");
    idempotencyKey = crypto.randomUUID();
    await Promise.allSettled([loadCurrentView({ silent: true }), openConversation(conversationId)]);
  });
  section.append(form);
  return section;
}

async function conversationAction(id, action) {
  const labels = { assume: "assumir esta conversa", pause: "pausar o bot", resume: "devolver a conversa ao bot" };
  if (!await confirmAction(`Deseja ${labels[action]}? Esta transição será auditada.`, "Confirmar transição")) return;
  const endpoint = endpointFor(VIEW_DEFINITIONS.conversations, `/${encodeURIComponent(id)}/${action}`);
  await performMutation(endpoint, { method: "POST", body: {}, success: "Estado da conversa atualizado." });
  elements.detailDialog.close();
}

function openRecord(view, item) {
  elements.detailTitle.textContent = VIEW_DEFINITIONS[view]?.title || "Detalhes";
  const list = node("dl", "detail-list");
  for (const [key, value] of Object.entries(item)) {
    if (/secret|token|password|credentialValue|authorization/iu.test(key)) continue;
    list.append(nodeWithText("dt", humanize(key)), valueNode(value, key));
  }
  const content = [list];
  if (view === "orders" && item.receiptMessageId) {
    content.push(button("Visualizar comprovante", () => openReceiptPreview(item.receiptMessageId), "button button-primary"));
  }
  elements.detailContent.replaceChildren(...content);
  elements.detailDialog.showModal();
}

async function openReceiptPreview(messageId) {
  if (!state.selectedEmpresaId) return;
  elements.detailTitle.textContent = "Comprovante privado";
  elements.detailContent.replaceChildren(paragraph("Carregando comprovante…"));
  if (!elements.detailDialog.open) elements.detailDialog.showModal();
  try {
    const response = await fetch(`${API_BASE}/tenants/${encodeURIComponent(state.selectedEmpresaId)}/messages/${encodeURIComponent(messageId)}/media`, {
      credentials: "include",
      headers: { Accept: "image/jpeg,image/png,image/webp,application/pdf" },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const error = new Error(payload?.message || "Não foi possível carregar o comprovante.");
      error.status = response.status;
      throw error;
    }
    if (state.receiptObjectUrl) URL.revokeObjectURL(state.receiptObjectUrl);
    state.receiptObjectUrl = URL.createObjectURL(await response.blob());
    const mimeType = response.headers.get("content-type") || "";
    const preview = mimeType === "application/pdf" ? node("iframe", "receipt-preview") : node("img", "receipt-preview");
    preview.src = state.receiptObjectUrl;
    preview.title = "Comprovante recebido";
    if (preview.tagName === "IMG") preview.alt = "Comprovante recebido para conferência humana";
    elements.detailContent.replaceChildren(preview, paragraph("Arquivo privado carregado somente nesta sessão autenticada."));
  } catch (error) {
    if (error.status === 401) return showLogin("Sua sessão expirou. Entre novamente.");
    elements.detailContent.replaceChildren(paragraph(error.message || "Não foi possível abrir o comprovante."));
  }
}

function openCreateTenant() {
  openFormDialog("Nova empresa", [
    ["name", "Nome da empresa", "text", true], ["identity", "Identidade pública", "text", true],
  ], async (values) => {
    const tenant = await performMutation("/tenants", { method: "POST", body: values, success: "Empresa criada em modo rascunho." });
    await loadTenants();
    state.selectedEmpresaId = tenant.id;
    elements.tenantSelect.value = tenant.id;
  });
}

function openResourceCreate(view) {
  const definitions = {
    catalog: [
      ["type", "Tipo", "select", true, [["produto", "Produto"], ["servico", "Serviço"], ["convite", "Convite"]]],
      ["sku", "SKU", "text", false], ["name", "Nome", "text", true], ["description", "Descrição", "text", false],
      ["price", "Preço", "number", true], ["currency", "Moeda", "text", true],
      ["stockControl", "Controle de estoque", "select", true, [["nao_controlado", "Sem controle"], ["limitado", "Quantidade limitada"], ["sob_consulta", "Sob consulta"]]],
      ["availableQuantity", "Quantidade disponível", "number", false], ["active", "Ativo", "select", true, [["true", "Sim"], ["false", "Não"]]],
    ],
    events: [
      ["name", "Nome", "text", true], ["attractions", "Atrações", "text", false],
      ["startsAt", "Início", "datetime-local", true], ["endsAt", "Fim", "datetime-local", false],
      ["timezone", "Fuso horário", "text", true], ["location", "Local", "text", false],
      ["birthdayRule", "Regra de aniversariante", "text", false], ["notes", "Observações", "text", false],
      ["capacity", "Capacidade", "number", false], ["status", "Estado", "select", true, [["rascunho", "Rascunho"], ["publicado", "Publicado"], ["cancelado", "Cancelado"]]],
    ],
    menus: [["menuKey", "Chave", "text", true], ["title", "Título", "text", true], ["message", "Mensagem", "text", true], ["active", "Ativo", "select", true, [["true", "Sim"], ["false", "Não"]]], ["version", "Versão", "number", true]],
    menuItems: [["menuId", "ID do menu", "text", true], ["position", "Posição", "number", true], ["title", "Título", "text", true], ["actionType", "Tipo de ação", "select", true, [["fluxo", "Fluxo"], ["menu", "Menu"], ["url", "URL"], ["atendimento_humano", "Atendimento humano"]]], ["actionKey", "Ação (ex.: catalog.list)", "text", true], ["enabled", "Ativo", "select", true, [["true", "Sim"], ["false", "Não"]]]],
    payments: [["type", "Tipo", "select", true, [["pix", "PIX"], ["dinheiro", "Dinheiro"], ["cartao", "Cartão"], ["outro", "Outro"]]], ["name", "Nome", "text", true], ["maskedIdentifier", "Identificador mascarado", "text", false], ["recipient", "Favorecido", "text", false], ["instructions", "Instruções", "text", false], ["credentialId", "ID da credencial no cofre", "text", false], ["enabled", "Ativo", "select", true, [["true", "Sim"], ["false", "Não"]]]],
    availability: [["productServiceId", "ID do serviço", "text", true], ["startsAt", "Início", "datetime-local", true], ["endsAt", "Fim", "datetime-local", true], ["capacity", "Capacidade", "number", true], ["reserved", "Reservados", "number", true], ["status", "Estado", "select", true, [["disponivel", "Disponível"], ["indisponivel", "Indisponível"], ["encerrado", "Encerrado"]]]],
    integrations: [["type", "Tipo", "select", true, [["google_sheets", "Google Sheets"], ["meta", "Meta"], ["openai", "OpenAI"], ["webhook", "Webhook"], ["outro", "Outro"]]], ["name", "Nome", "text", true], ["enabled", "Ativa", "select", true, [["false", "Não"], ["true", "Sim"]]], ["requiredForConfirmation", "Obrigatória para confirmação", "select", true, [["false", "Não"], ["true", "Sim"]]], ["status", "Estado", "select", true, [["nao_configurada", "Não configurada"], ["saudavel", "Saudável"], ["indisponivel", "Indisponível"], ["desabilitada", "Desabilitada"]]]],
  };
  const defaults = { currency: "BRL", stockControl: "nao_controlado", active: "true", enabled: "true", version: 1, timezone: "America/Sao_Paulo", reserved: 0, configuration: {} };
  openFormDialog(`Adicionar em ${VIEW_DEFINITIONS[view].title}`, definitions[view], async (values) => {
    const body = nonEmpty(values);
    for (const field of ["price", "availableQuantity", "capacity", "version", "position", "reserved"]) if (body[field] != null) body[field] = Number(body[field]);
    for (const field of ["active", "enabled", "requiredForConfirmation"]) if (body[field] != null) body[field] = body[field] === "true";
    if (["menuItems", "integrations"].includes(view)) body.configuration = {};
    await performMutation(`/tenants/${encodeURIComponent(state.selectedEmpresaId)}/${VIEW_DEFINITIONS[view].resource}`, { method: "POST", body, success: "Registro adicionado." });
  }, defaults);
}

function openNumberForm() {
  openFormDialog("Vincular número WhatsApp", [
    ["phoneNumberId", "Phone number ID", "text", true], ["numeroE164", "Número em formato +5511...", "tel", false],
    ["nomeVerificado", "Nome verificado", "text", false],
  ], async (values) => performMutation(`/tenants/${encodeURIComponent(state.selectedEmpresaId)}/numbers`, {
    method: "POST", body: { ...nonEmpty(values), status: "pendente", principal: false }, success: "Número vinculado.",
  }));
}

function openUserForm() {
  openFormDialog("Adicionar usuário", [
    ["name", "Nome", "text", true], ["email", "E-mail", "email", true],
    ["role", "Papel", "select", true, [["tenant_operator", "Operador"], ["tenant_admin", "Administrador da empresa"]]],
    ["initialPassword", "Senha inicial", "password", true],
  ], async (values) => performMutation(`/tenants/${encodeURIComponent(state.selectedEmpresaId)}/users`, {
    method: "POST", body: { ...values, status: "active" }, success: "Usuário adicionado.",
  }));
}

function openCredentialRotation(numberId) {
  openFormDialog("Cadastrar credencial Meta", [
    ["secret", "Token Meta", "password", true],
  ], async (values) => {
    await performMutation(`/tenants/${encodeURIComponent(state.selectedEmpresaId)}/credentials`, {
      method: "POST", body: { provider: "meta", purpose: `whatsapp:${numberId}`, secret: values.secret }, success: "Credencial cadastrada. O valor não será exibido novamente.",
    });
    values.secret = "";
  });
}

function openFormDialog(title, fields, onSubmit, initialValues = {}) {
  elements.detailTitle.textContent = title;
  const form = document.createElement("form");
  for (const [name, label, type, required] of fields) {
    const wrapper = node("div", "field");
    const id = `dynamic-${name}`;
    const labelNode = nodeWithText("label", label);
    labelNode.htmlFor = id;
    const options = fields.find((item) => item[0] === name)?.[4];
    const input = type === "select" ? document.createElement("select") : document.createElement("input");
    if (type === "select") {
      for (const [value, text] of options || []) input.append(new Option(text, value));
      Object.assign(input, { id, name, required });
    } else Object.assign(input, { id, name, type, required, maxLength: 500 });
    if (initialValues[name] != null) input.value = String(initialValues[name]);
    if (type === "password") input.autocomplete = "new-password";
    wrapper.append(labelNode, input);
    form.append(wrapper);
  }
  const actions = node("div", "dialog-actions");
  actions.append(button("Cancelar", () => elements.detailDialog.close(), "button button-secondary"), button("Salvar", null, "button button-primary", "submit"));
  form.append(actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form));
    try {
      await onSubmit(values);
      form.reset();
      elements.detailDialog.close();
    } catch (error) {
      toast(error.message || "Não foi possível salvar.");
    }
  });
  elements.detailContent.replaceChildren(form);
  elements.detailDialog.showModal();
}

async function changeTenantStatus(id, status, name) {
  const verb = status === "suspended" ? "suspender" : "ativar";
  if (!await confirmAction(`Deseja ${verb} ${name || "esta empresa"}? A ação será auditada e afetará somente este tenant.`, `${verb[0].toUpperCase()}${verb.slice(1)} empresa`)) return;
  const action = status === "suspended" ? "suspend" : "activate";
  await performMutation(`/tenants/${encodeURIComponent(id)}/${action}`, { method: "POST", body: {}, success: "Estado da empresa atualizado." });
}

function nonEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== ""));
}

async function performMutation(path, { method, body, success }) {
  try {
    const result = await apiFetch(path, { method, body });
    toast(success);
    await loadCurrentView();
    return result;
  } catch (error) {
    if (error.status === 401) return showLogin("Sua sessão expirou. Entre novamente.");
    toast(error.message || "Não foi possível concluir a operação.");
    throw error;
  }
}

function confirmAction(message, title = "Confirmar ação") {
  return new Promise((resolve) => {
    elements.confirmTitle.textContent = title;
    elements.confirmMessage.textContent = message;
    const onClose = () => resolve(elements.confirmDialog.returnValue === "confirm");
    elements.confirmDialog.addEventListener("close", onClose, { once: true });
    elements.confirmDialog.showModal();
  });
}

function summaryPanel(title, source) {
  const panel = node("section", "panel-card");
  panel.append(nodeWithText("h2", title));
  if (Array.isArray(source)) {
    if (!source.length) panel.append(paragraph("Nenhum alerta aberto."));
    else {
      const list = document.createElement("ul");
      for (const item of source.slice(0, 8)) list.append(nodeWithText("li", item.summary || item.message || displayValue(item)));
      panel.append(list);
    }
  } else {
    const list = node("dl", "detail-list");
    for (const [key, value] of Object.entries(source || {})) list.append(nodeWithText("dt", humanize(key)), valueNode(value, "status"));
    if (!list.children.length) list.append(nodeWithText("dt", "Estado"), nodeWithText("dd", "Sem dados disponíveis"));
    panel.append(list);
  }
  return panel;
}

function valueNode(value, key = "") {
  if (/status|state|health|severity|mode|role/iu.test(key)) {
    const badge = nodeWithText("span", displayValue(value), `badge ${badgeClass(value)}`);
    return badge;
  }
  return nodeWithText("span", formatValue(value, key));
}

function formatValue(value, key = "") {
  if (value == null || value === "") return "—";
  if (Array.isArray(value)) return value.map(displayValue).join(", ") || "—";
  if (typeof value === "object") return Object.entries(value).map(([name, item]) => `${humanize(name)}: ${displayValue(item)}`).join(" · ");
  if (/at$|date|data|horario|scheduled/iu.test(key)) return formatDate(value);
  if (/amount|cost|custo|valor/iu.test(key) && Number.isFinite(Number(value))) return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value));
  if (/tokens|count|total|messages|jobs/iu.test(key) && Number.isFinite(Number(value))) return new Intl.NumberFormat("pt-BR").format(Number(value));
  return String(value);
}

function displayValue(value) {
  if (value == null || value === "") return "—";
  if (typeof value === "number") return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(value);
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function badgeClass(value) {
  const status = String(value || "").toLocaleLowerCase("pt-BR");
  if (/healthy|active|ativa|ativo|sent|delivered|read|success|humano|operator|resolved|resolvido|reenfileirado/iu.test(status)) return "badge-success";
  if (/fail|error|unavailable|suspend|revoked|bloque/iu.test(status)) return "badge-danger";
  if (/pending|pendente|not_configured|not_checked|queued|processing|bot|warning/iu.test(status)) return "badge-warning";
  return "";
}

function humanize(value) {
  return String(value).replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]/gu, " ").replace(/^./u, (letter) => letter.toUpperCase());
}

function node(tag, className = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function nodeWithText(tag, text, className = "") {
  const element = node(tag, className);
  element.textContent = text == null ? "—" : String(text);
  return element;
}

function paragraph(text) { return nodeWithText("p", text); }

function button(label, handler, className = "button", type = "button") {
  const element = nodeWithText("button", label, className);
  element.type = type;
  if (handler) element.addEventListener("click", handler);
  return element;
}

function toast(message) {
  const item = nodeWithText("div", message, "toast");
  elements.toastRegion.append(item);
  setTimeout(() => item.remove(), 4_500);
}

function startRefresh() {
  stopRefresh();
  if (!state.refreshEnabled) return;
  state.refreshTimer = setInterval(() => {
    if (document.visibilityState === "visible" && !elements.appShell.hidden && !elements.detailDialog.open) {
      loadCurrentView({ silent: true });
    }
  }, REFRESH_INTERVAL_MS);
}

function stopRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.loginEmailError.textContent = elements.loginEmail.validity.valid ? "" : "Informe um e-mail válido.";
  elements.loginPasswordError.textContent = elements.loginPassword.validity.valid ? "" : "Informe sua senha.";
  if (!elements.loginForm.reportValidity()) return;
  const submit = elements.loginForm.querySelector("button[type=submit]");
  submit.disabled = true;
  elements.loginError.hidden = true;
  try {
    const payload = await apiFetch("/auth/login", {
      method: "POST",
      body: { email: elements.loginEmail.value.trim(), password: elements.loginPassword.value },
    });
    state.session = normalizedSession(payload);
    elements.loginPassword.value = "";
    await loadTenants(payload?.tenants);
    showApp();
    await navigate("dashboard");
  } catch (error) {
    elements.loginPassword.value = "";
    elements.loginError.textContent = error.status === 429 ? "Muitas tentativas. Aguarde antes de tentar novamente." : "E-mail ou senha inválidos.";
    elements.loginError.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

elements.logoutButton.addEventListener("click", async () => {
  try { await apiFetch("/auth/logout", { method: "POST", body: {} }); } catch { /* sessão local será encerrada */ }
  showLogin("Sessão encerrada com segurança.");
});

elements.primaryNav.addEventListener("click", (event) => {
  const target = event.target.closest("button[data-view]");
  if (target) navigate(target.dataset.view);
});

elements.tenantSelect.addEventListener("change", async () => {
  state.selectedEmpresaId = elements.tenantSelect.value;
  state.page = 1;
  elements.sessionUser.textContent = `${state.session.user.name} · ${ROLE_LABELS[roleForCurrentContext()] || "Sem acesso"}`;
  renderNavigation();
  if (!allowed(VIEW_DEFINITIONS[state.currentView].permission)) return navigate("dashboard");
  elements.viewActions.replaceChildren();
  addViewActions(state.currentView);
  await loadCurrentView();
});

elements.filterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.filters = Object.fromEntries(new FormData(elements.filterForm));
  state.page = 1;
  loadCurrentView();
});

elements.clearFilters.addEventListener("click", () => {
  resetViewFilters(VIEW_DEFINITIONS[state.currentView]);
  state.page = 1;
  loadCurrentView();
});

elements.previousPage.addEventListener("click", () => { state.page = Math.max(1, state.page - 1); loadCurrentView(); });
elements.nextPage.addEventListener("click", () => { state.page += 1; loadCurrentView(); });
elements.pageSize.addEventListener("change", () => { state.pageSize = Number(elements.pageSize.value); state.page = 1; loadCurrentView(); });
elements.menuToggle.addEventListener("click", () => {
  const expanded = elements.menuToggle.getAttribute("aria-expanded") === "true";
  elements.menuToggle.setAttribute("aria-expanded", String(!expanded));
  elements.sidebar.classList.toggle("is-open", !expanded);
});
elements.refreshToggle.addEventListener("click", () => {
  state.refreshEnabled = !state.refreshEnabled;
  elements.refreshToggle.setAttribute("aria-pressed", String(state.refreshEnabled));
  elements.refreshToggle.textContent = state.refreshEnabled ? "Atualização automática" : "Atualização pausada";
  elements.refreshToggle.title = state.refreshEnabled ? "Pausar atualização periódica" : "Retomar atualização periódica";
  startRefresh();
});
elements.detailClose.addEventListener("click", () => elements.detailDialog.close());
elements.detailDialog.addEventListener("close", () => {
  if (state.receiptObjectUrl) URL.revokeObjectURL(state.receiptObjectUrl);
  state.receiptObjectUrl = null;
});
window.addEventListener("hashchange", () => state.session && navigate(location.hash.slice(1), { updateHash: false }));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.refreshEnabled && state.session) loadCurrentView({ silent: true }); });

loadSession();
