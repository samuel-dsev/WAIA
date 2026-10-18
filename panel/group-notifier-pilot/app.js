const $ = (id) => document.getElementById(id);
const csrf = document.querySelector('meta[name="pilot-csrf"]').content;
let current = null, operation = false, refreshing = false, lastQr = null;
const phaseNames = { disconnected: "Desconectado", connecting: "Iniciando conexão…", qr: "Leia o QR pelo celular", qr_expired: "QR expirado. Aguarde o próximo código.", connected: "Conectado", reconnecting: "Reconectando…", failed: "Conexão encerrada" };

async function api(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: { "X-Pilot-CSRF": csrf, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Não foi possível acessar o piloto local.");
  return data;
}
function feedback(message, error = false) { $("feedback").textContent = message; $("feedback").classList.toggle("error", error); }
function controls() {
  const phase = current?.connection.phase, connected = phase === "connected", busy = operation || current?.busy;
  $("connect").disabled = busy || !["disconnected", "failed"].includes(phase);
  $("phone").disabled = $("connect").disabled; $("dedicated").disabled = $("connect").disabled;
  $("disconnect").disabled = busy || phase === "disconnected";
  $("groups-refresh").disabled = busy || !connected;
  $("route-save").disabled = busy || !connected || !$("group").value;
  for (const button of $("routes").querySelectorAll("button")) button.disabled = busy || !connected || button.dataset.sent === "true";
}
function render(data) {
  current = data;
  const c = data.connection;
  $("connection").textContent = `${phaseNames[c.phase] || c.phase}${c.connectedPhone ? ` · número terminado em ${c.connectedPhone.slice(-4)}` : ""}`;
  $("session-note").hidden = !c.message; $("session-note").textContent = c.message || "";
  $("routes").replaceChildren();
  if (!data.routes.length) { const p = document.createElement("p"); p.textContent = "Nenhum destino associado."; $("routes").append(p); }
  for (const route of data.routes) {
    const card = document.createElement("div"); card.className = "route";
    const p = document.createElement("p"); p.textContent = `${route.companyName} → ${route.groupName}`;
    const button = document.createElement("button"); button.type = "button"; button.textContent = "Enviar teste fictício para este grupo";
    // Per-group delivery attempts are controlled again on the server.
    button.dataset.sent = String(data.attempts.some((attempt) => attempt.companyRef === route.companyRef && attempt.groupId === route.groupId));
    button.addEventListener("click", () => act(async () => {
      const result = await api("test", { companyRef: route.companyRef });
      feedback(result.status === "accepted" ? "Teste aceito pelo conector. Confira o recebimento no grupo." : "Envio sem confirmação. Confira o grupo antes de tentar qualquer novo envio.", result.status !== "accepted");
    }));
    card.append(p, button); $("routes").append(card);
  }
  $("attempts").replaceChildren();
  for (const attempt of data.attempts) {
    const p = document.createElement("p");
    p.textContent = `${attempt.companyRef} → ${attempt.groupName}: ${attempt.status === "accepted" ? "aceito pelo conector; entrega a conferir" : attempt.status === "unconfirmed" ? "sem confirmação; conferir no grupo" : "enviando…"}`;
    $("attempts").append(p);
  }
  if (!data.attempts.length) $("attempts").textContent = "Nenhum teste enviado.";
  controls();
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    render(await api("status"));
    const { image } = await api("qr");
    if (image !== lastQr) { lastQr = image; if (image) $("qr").src = image; else $("qr").removeAttribute("src"); }
    $("qr").hidden = !image;
  } catch { feedback("O piloto local não está disponível. Reabra a página após iniciar o serviço.", true); }
  finally { refreshing = false; }
}
async function act(fn) {
  if (operation) return; operation = true; controls();
  try { await fn(); } catch (error) { feedback(error.message, true); }
  finally { operation = false; await refresh(); controls(); }
}
$("connect-form").addEventListener("submit", (event) => {
  event.preventDefault(); void act(async () => {
    await api("connect", { phone: $("phone").value.trim(), dedicated: $("dedicated").checked });
    feedback("Aguardando o QR. Leia pelo aplicativo do número dedicado da WAIA.");
  });
});
$("disconnect").addEventListener("click", () => void act(async () => {
  const result = await api("disconnect", {});
  $("group").replaceChildren(new Option("Conecte o número e consulte os grupos", ""));
  feedback(result.revoked ? "Piloto desconectado e vínculo removido." : "Piloto desconectado. Se necessário, remova o aparelho WAIA nas configurações do celular.");
}));
$("groups-refresh").addEventListener("click", () => void act(async () => {
  const { groups } = await api("groups");
  $("group").replaceChildren(new Option(groups.length ? "Selecione um grupo" : "Nenhum grupo encontrado. Adicione o bot ao grupo pelo celular.", ""));
  for (const group of groups) $("group").append(new Option(group.name, group.id));
  feedback(`${groups.length} grupo(s) encontrado(s). Confira o destino antes de associar.`);
}));
$("group").addEventListener("change", controls);
$("route-form").addEventListener("submit", (event) => {
  event.preventDefault(); void act(async () => {
    await api("routes", { companyRef: $("company-ref").value.trim(), companyName: $("company-name").value.trim(), groupId: $("group").value });
    feedback("Destino de teste associado. Confira a empresa e o grupo antes de enviar.");
  });
});
await refresh(); setInterval(() => void refresh(), 2500);
