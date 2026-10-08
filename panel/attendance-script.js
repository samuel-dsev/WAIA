export const SCRIPT_HELP = "Defina como a IA deve atender: tom de voz, informações da empresa, perguntas necessárias, o que deve dizer e o que não pode dizer. As predefinições são respondidas sem IA; nas demais mensagens, o roteiro completo é enviado a cada resposta. Não inclua senhas ou chaves.";

// O roteiro continua no mesmo contrato de IA, inclusive para revisões antigas.
export function scriptSaveRequest({ base, draft, value }) {
  if (draft?.configuration) {
    const configuration = structuredClone(draft.configuration);
    configuration.ai = { ...configuration.ai, prompt: value };
    return { path: `${base}/configuration/draft`, method: "PUT", body: { draftVersion: draft.draftVersion, configuration } };
  }
  return { path: `${base}/ai-config/${base.split("/").at(-1)}`, method: "PATCH", body: { prompt: value || null } };
}

export function createAttendanceScriptEditor({ value = "", onInput = () => {} } = {}) {
  const root = document.createElement("div");
  root.className = "attendance-script wizard-field";
  const id = `attendance-script-${crypto.randomUUID()}`;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = "Roteiro completo da IA";
  const textarea = document.createElement("textarea");
  Object.assign(textarea, { id, name: "attendanceScript", rows: 12, maxLength: 20_000, value });
  const help = document.createElement("small");
  help.className = "muted";
  help.id = `${id}-help`;
  help.textContent = SCRIPT_HELP;
  textarea.setAttribute("aria-describedby", help.id);
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "button button-secondary button-small";
  expand.textContent = "Tela cheia";
  expand.setAttribute("aria-haspopup", "dialog");
  const heading = document.createElement("div");
  heading.className = "attendance-script-heading";
  heading.append(label, expand);
  textarea.addEventListener("input", () => onInput(textarea.value));
  let dialog = null;
  expand.addEventListener("click", () => {
    dialog = document.createElement("dialog");
    dialog.className = "attendance-script-dialog";
    dialog.setAttribute("aria-labelledby", `${id}-title`);
    const title = document.createElement("h2");
    title.id = `${id}-title`;
    title.textContent = "Roteiro completo da IA";
    const expanded = document.createElement("textarea");
    Object.assign(expanded, { value: textarea.value, maxLength: textarea.maxLength });
    expanded.setAttribute("aria-label", title.textContent);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "button button-primary";
    close.textContent = "Voltar à configuração";
    close.addEventListener("click", () => dialog.close());
    expanded.addEventListener("input", () => {
      textarea.value = expanded.value;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    dialog.append(title, expanded, close);
    dialog.addEventListener("close", () => {
      dialog.remove();
      dialog = null;
      expand.focus();
    }, { once: true });
    root.append(dialog);
    dialog.showModal();
    expanded.focus();
  });
  root.append(heading, textarea, help);
  return { root, textarea };
}
