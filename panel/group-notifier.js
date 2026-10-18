const labels = { offline: "Serviço indisponível", disconnected: "Desconectado", connecting: "Conectando…", qr: "Leia o QR com o número dedicado", qr_expired: "Aguardando novo QR", connected: "Conectado", reconnecting: "Reconectando…", failed: "É necessário revisar a conexão", disconnecting: "Desconectando…" };
const deliveryLabels = { pending: "Pendente", sending: "Enviando", accepted: "Aceito pelo conector; recebimento a conferir", unconfirmed: "Sem confirmação — conferir no grupo antes de qualquer novo envio", cancelled: "Cancelado por mudança de configuração ou disponibilidade" };
function el(tag, text, className) { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; }
function input(label, type = "text") { const box = el("label", label, "wizard-field"); const field = el("input"); field.type = type; box.append(field); return { box, field }; }

export async function renderGroupNotifier({ root, apiFetch, empresaId, isPlatform, signal, refresh, toast }) {
  const run = async (action, success) => { try { await action(); if (success) toast(success); await refresh(); } catch (error) { toast(error.message || "Não foi possível concluir a operação."); } };
  root.replaceChildren();
  const stage = el("div", null, "wizard-stage"); root.append(stage); root = stage;
  const title = el("section", null, "wizard-section");
  title.append(el("h2", "Remetente central WAIA"), el("p", "Um único número dedicado envia os resumos aos destinos autorizados de cada empresa. O atendimento de cada cliente continua no seu número atual.", "muted"));
  const reload = el("button", "Atualizar dados", "button button-secondary"); reload.type = "button"; reload.addEventListener("click", refresh); title.append(reload); root.append(title);
  if (isPlatform) {
    const connection = el("section", null, "wizard-section"); connection.append(el("h3", "Conexão do número dedicado"));
    const status = el("p"), image = el("img"); image.alt = "QR para conectar o número dedicado da WAIA"; image.width = 320; image.height = 320; image.hidden = true; image.style.maxWidth = "100%";
    connection.append(status, image);
    image.style.height = "auto";
    const form = el("form", null, "wizard-form-grid");
    const phone = input("Número dedicado da WAIA (+55 e DDD)", "tel"); phone.field.required = true; phone.field.placeholder = "+5511999999999";
    const check = input("Confirmo que este é o número dedicado da WAIA", "checkbox"); check.field.required = true;
    const connect = el("button", "Gerar QR", "button button-primary"); connect.type = "submit";
    form.append(phone.box, check.box, connect);
    form.addEventListener("submit", (event) => { event.preventDefault(); connect.disabled = true; void run(() => apiFetch("/group-notifier/connect", { method: "POST", body: { phone: phone.field.value.trim(), dedicated: check.field.checked } }), "Vínculo solicitado. Aguarde o QR.").finally(() => { connect.disabled = false; }); });
    const disconnect = el("button", "Desconectar número central", "button button-secondary"); disconnect.type = "button";
    disconnect.addEventListener("click", () => void run(() => apiFetch("/group-notifier/disconnect", { method: "POST", body: {} }), "Desconexão solicitada. Confira também Aparelhos conectados no celular."));
    connection.append(form, disconnect, el("p", "Leia o QR em Aparelhos conectados → Conectar aparelho. Fechar o processo preserva o vínculo cifrado; Desconectar revoga o acesso local. Confira o celular se a revogação remota não for confirmada.", "muted")); root.append(connection);
    const update = async () => {
      if (signal?.aborted || !root.isConnected) return;
      try {
        const data = await apiFetch("/group-notifier", { signal });
        if (signal?.aborted) return;
        status.textContent = `${labels[data.phase] || data.phase}${data.phone ? ` · ${data.phone}` : ""}${data.error ? " · Conexão requer revisão" : ""}`;
        if (data.qrImage) { image.src = data.qrImage; image.hidden = false; } else { image.hidden = true; image.removeAttribute("src"); }
        connect.disabled = data.desired && ["connected", "connecting", "qr", "reconnecting"].includes(data.phase);
      } catch (error) { if (error.name !== "AbortError") status.textContent = error.message; }
    };
    await update();
    if (signal?.aborted) return;
    const timer = setInterval(() => void update(), 3000);
    signal?.addEventListener("abort", () => clearInterval(timer), { once: true });
  }
  if (!empresaId) { root.append(el("p", "Selecione uma empresa para configurar seu destino e acompanhar os leads.", "muted")); return; }
  const base = `/tenants/${encodeURIComponent(empresaId)}/group-notifier`;
  const [{ route }, { leads }] = await Promise.all([apiFetch(`${base}/route`, { signal }), apiFetch(`${base}/leads`, { signal })]);
  if (signal?.aborted) return;
  const destination = el("section", null, "wizard-section"); destination.append(el("h3", "Destino desta empresa"), el("p", route ? `${route.groupName} · ${route.enabled ? "Habilitado" : "Desabilitado"}` : "Nenhum grupo associado."));
  if (isPlatform) {
    const { groups } = await apiFetch("/group-notifier/groups", { signal });
    const form = el("form", null, "wizard-form-grid"), selectLabel = el("label", "Grupo verificado", "wizard-field"), select = el("select"); select.required = true;
    select.append(new Option("Selecione o grupo desta empresa", ""));
    for (const group of groups) select.append(new Option(group.name, group.id));
    if (route && !groups.some((group) => group.id === route.groupId)) select.append(new Option(`${route.groupName} (validar conexão para habilitar)`, route.groupId));
    if (route) select.value = route.groupId;
    selectLabel.append(select);
    const enabled = input("Habilitar notificações para este destino", "checkbox"); enabled.field.checked = route?.enabled === true;
    const save = el("button", "Salvar destino", "button button-primary"); save.type = "submit";
    form.append(selectLabel, enabled.box, save);
    form.addEventListener("submit", (event) => { event.preventDefault(); save.disabled = true; void run(() => apiFetch(`${base}/route`, { method: "PUT", body: { groupId: select.value, enabled: enabled.field.checked, revision: Number(route?.revision || 0) } }), "Destino atualizado. Configure e publique a triagem no Onboarding → IA.").finally(() => { save.disabled = false; }); });
    destination.append(form, el("p", "A lista é atualizada pelo remetente conectado. Um grupo só pode ser associado a uma empresa. Mudanças de destino cancelam envios pendentes da associação anterior.", "muted"));
  } else destination.append(el("p", "A associação dos grupos é administrada pela plataforma. Você pode configurar os critérios da sua empresa no onboarding.", "muted"));
  root.append(destination);
  const list = el("section", null, "wizard-section"); list.append(el("h3", "Leads qualificados"));
  if (!leads.length) list.append(el("p", "Nenhum lead qualificado registrado.", "muted"));
  for (const lead of leads) {
    const card = el("article", null, "panel-card"); card.style.overflowWrap = "anywhere";
    card.append(el("h4", lead.name), el("p", `WhatsApp: +${lead.phone}`), el("p", `Resumo: ${lead.summary}`), el("p", `Qualificação: ${lead.qualification}`),
      el("p", deliveryLabels[lead.notificationStatus] || "Registrado sem envio: destino indisponível na conclusão da triagem.", "muted"));
    list.append(card);
  }
  list.append(el("p", "Resultados sem confirmação não são reenviados automaticamente. Confira o grupo. Esta lista mostra os 100 registros mais recentes, sujeitos à retenção da empresa.", "muted")); root.append(list);
}
