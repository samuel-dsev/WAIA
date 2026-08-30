const LIMITS = Object.freeze({
  text: 4_096,
  interactiveBody: 1_024,
  optionId: 256,
  optionInput: 500,
  buttonTitle: 20,
  listTitle: 24,
  listDescription: 72,
  options: 10,
  recipient: 32,
});

function requiredText(value, field, max) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${field} é obrigatório.`);
  if (text.length > max) throw new TypeError(`${field} excede ${max} caracteres.`);
  return text;
}

function compact(value, maximum) {
  const characters = [...String(value || "").trim()];
  if (characters.length <= maximum) return characters.join("");
  return `${characters.slice(0, maximum - 1).join("").trimEnd()}…`;
}

function options(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError("buttons deve ser um array.");
  if (value.length > LIMITS.options) {
    throw new RangeError("Uma mensagem interativa do WhatsApp aceita no máximo dez opções; pagine antes do envio.");
  }
  return value.map((button, index) => {
    const title = requiredText(button?.title || button?.label, `buttons[${index}].title`, LIMITS.optionInput);
    const description = button?.description == null || button.description === ""
      ? null
      : requiredText(button.description, `buttons[${index}].description`, LIMITS.optionInput);
    return {
      id: requiredText(button?.id, `buttons[${index}].id`, LIMITS.optionId),
      title,
      description,
    };
  });
}

export function createWhatsAppReplyPayload({ to, text, buttons = [] } = {}) {
  const recipient = requiredText(to, "to", LIMITS.recipient);
  const body = requiredText(text, "text", LIMITS.text);
  const choices = options(buttons);
  const base = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
  };
  if (choices.length === 0) {
    return { ...base, type: "text", text: { preview_url: false, body } };
  }
  const interactiveBody = compact(body, LIMITS.interactiveBody);
  if (choices.length <= 3) {
    return {
      ...base,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: interactiveBody },
        action: {
          buttons: choices.map((choice) => ({
            type: "reply",
            reply: { id: choice.id, title: compact(choice.title, LIMITS.buttonTitle) },
          })),
        },
      },
    };
  }
  return {
    ...base,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: interactiveBody },
      action: {
        button: "Ver opções",
        sections: [{
          title: "Opções disponíveis",
          rows: choices.map((choice) => ({
            id: choice.id,
            title: compact(choice.title, LIMITS.listTitle),
            ...(choice.description ? { description: compact(choice.description, LIMITS.listDescription) } : {}),
          })),
        }],
      },
    },
  };
}

export { LIMITS as WHATSAPP_OUTBOUND_LIMITS };
