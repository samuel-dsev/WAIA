const MAIN_BUTTONS = [
  { id: "convites", title: "Comprar convites" }, { id: "endereco", title: "Endereço" }, { id: "cardapio", title: "Cardápio" },
];
const normalized = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
const displayDate = (value) => { const [year, month, day] = value.split("-"); void year; return `${day}/${month}`; };
const menu = () => ({ text: "Olá! 🍻 Bem-vindo ao Bar Capitão Mor. Como podemos ajudar?", buttons: MAIN_BUTTONS });
const unavailable = () => ({ text: "A agenda está sendo atualizada. Tente novamente em alguns instantes ou fale com a equipe.", buttons: [{ id: "menu", title: "Menu inicial" }] });

function eventMenu(events) {
  if (!events.length) return unavailable();
  if (events.length <= 2) return {
    text: "Escolha a noite para consultar a programação e comprar seu convite:",
    buttons: [...events.map((event) => ({ id: event.id, title: `${event.weekday.replace("-feira", "")} ${displayDate(event.date)}`.slice(0, 20) })), { id: "menu", title: "Menu inicial" }],
  };
  return { text: `Próximos eventos:\n${events.map((event, index) => `${index + 1}. *${event.weekday} ${displayDate(event.date)}*, às ${event.time}`).join("\n")}\n\nDigite o número do evento para ver os detalhes.`, buttons: [{ id: "menu", title: "Menu inicial" }] };
}

function agendaSummary(events) {
  if (!events.length) return unavailable();
  return {
    text: `📅 *AGENDA DO CAPITÃO MOR*\n\n${events.map((event) => {
      const extra = [event.vipRule, event.notes].filter(Boolean).join("\n");
      return `🌒 *${event.weekday.toUpperCase()} ${displayDate(event.date)} • ${event.time}*\n${event.attractions.split("|").map((item) => item.trim()).join("\n")}\nConvite: *${money(event.price)}*${extra ? `\n${extra}` : ""}`;
    }).join("\n\n")}\n\nPara comprar, toque em *Comprar convites*.` ,
    buttons: [{ id: "convites", title: "Comprar convites" }, { id: "menu", title: "Menu inicial" }],
  };
}

function eventDetails(event, settings) {
  const extra = [event.vipRule, event.notes].filter(Boolean).join("\n");
  return {
    text: `🌒 *${event.weekday.toUpperCase()} ${displayDate(event.date)} • ${event.time}*\n${event.attractions.split("|").map((item) => item.trim()).join("\n")}\n\nConvite unissex: *${money(event.price)}*${extra ? `\n${extra}` : ""}\n\n💳 *PIX:* ${settings.chave_pix}\n*Favorecida:* ${settings.favorecida_pix}\n\nApós o pagamento, envie aqui o comprovante e o nome completo.\n\n${settings.regra_aniversariante ? `🎂 ${settings.regra_aniversariante}\n\n` : ""}📍 ${settings.endereco}`,
    buttons: [{ id: "pix_pago", title: "Já fiz o PIX" }, { id: "menu", title: "Menu inicial" }],
  };
}

export function createBarService({ dataSource = { getSnapshot: () => null, recordOrder: async () => {} }, aiAssistant, logger = console } = {}) {
  const sessions = new Map();
  return {
    async reply({ phone = "unknown", message, type = "text", mediaId }) {
      const option = normalized(message);
      const session = sessions.get(phone) || {};
      const snapshot = dataSource.getSnapshot();
      const events = snapshot?.events || [];
      const settings = snapshot?.settings || {};
      const links = {
        menu: settings.link_cardapio || "https://capito-mor.goomer.app/menu",
        maps: settings.link_mapa || "",
        whatsapp: settings.telefone_atendimento ? `https://wa.me/${settings.telefone_atendimento}` : "",
        instagram: settings.instagram || "",
      };
      const greeting = /^(oi+|ol[aá]+|opa|bom dia|boa tarde|boa noite|in[ií]cio|come[cç]ar)[!,.?\s]*$/i.test(String(message || "").trim());
      if (option === "menu" || option === "inicio") { sessions.delete(phone); return menu(); }
      if (greeting) return menu();
      if (type === "image") {
        if (session.stage === "awaiting_receipt") {
          sessions.set(phone, { ...session, receiptId: mediaId || "", stage: "awaiting_name" });
          return { text: "Comprovante recebido. Agora envie o *nome completo* da pessoa que utilizará o convite." };
        }
        return { text: "Recebi a imagem. Para iniciar uma compra, escolha *Comprar convites* no menu.", buttons: MAIN_BUTTONS };
      }
      if (session.stage === "awaiting_name" && option) {
        const name = String(message).trim();
        try {
          await dataSource.recordOrder({ phone, eventId: session.eventId, name, receiptId: session.receiptId });
          sessions.delete(phone);
          return { text: `Obrigado, *${name}*! Recebemos o comprovante e o nome para conferência da equipe. Guarde esta conversa. A validação do pagamento não é automática.`, buttons: [{ id: "menu", title: "Menu inicial" }] };
        } catch (error) {
          logger.error("Falha ao registrar pedido:", error.message);
          return { text: "Não consegui registrar seu pedido na planilha agora. Seu comprovante foi mantido nesta conversa; envie o nome completo novamente em alguns instantes ou fale com a equipe.", buttons: [{ id: "menu", title: "Menu inicial" }] };
        }
      }
      if (option === "pix_pago") {
        if (!session.eventId) return eventMenu(events);
        sessions.set(phone, { ...session, stage: "awaiting_receipt" });
        return { text: "Envie agora o comprovante do PIX como imagem. Depois, pediremos o nome completo." };
      }
      const event = events.find(({ id }) => normalized(id) === option) || (/^\d+$/.test(option) ? events[Number(option) - 1] : null);
      if (event) { sessions.set(phone, { eventId: event.id, stage: "awaiting_receipt" }); return eventDetails(event, settings); }
      if (option === "agenda" || option.includes("programacao") || option.includes("programação")) return agendaSummary(events);
      if (option === "convites" || option.includes("comprar convite") || option.includes("ingresso")) return eventMenu(events);
      if (option === "cardapio" || option.includes("comida") || option.includes("drink")) return { text: `Veja o cardápio do Capitão Mor aqui:\n${links.menu}\n\nOs itens e a disponibilidade podem mudar sem aviso.` };
      if (option.includes("pix") || option.includes("pagamento")) return settings.chave_pix && settings.favorecida_pix
        ? { text: `💳 *PIX:* ${settings.chave_pix}\n*Favorecida:* ${settings.favorecida_pix}\n\nApós o pagamento, envie aqui o comprovante como imagem. A confirmação é feita pela equipe.` }
        : unavailable();
      if (option === "endereco" || option.includes("local") || option.includes("endereco") || option.includes("chegar") || option.includes("onde") || option.includes("fica")) return settings.endereco ? { text: `📍 ${settings.endereco}.${links.maps ? `\nComo chegar: ${links.maps}` : ""}` } : unavailable();
      if (option.includes("anivers")) return settings.regra_aniversariante ? { text: `🎂 ${settings.regra_aniversariante}` } : unavailable();
      if (option.includes("privativ") || option.includes("reserva") || option.includes("atendente") || option.includes("humano") || option.includes("falar") || option.includes("contato")) return links.whatsapp ? { text: `Fale com a equipe do Capitão Mor pelo WhatsApp oficial:\n${links.whatsapp}` } : unavailable();
      if (option.includes("instagram")) return links.instagram ? { text: `Acompanhe as novidades: ${links.instagram}` } : unavailable();
      if (!aiAssistant) return menu();
      try {
        return { text: await aiAssistant.reply({ phone, message: String(message || ""), snapshot }) };
      } catch (error) {
        logger.error("Falha no atendimento inteligente:", error.message);
        return { text: "Não consegui consultar o atendimento inteligente agora. Você gostaria de ver a agenda, o endereço ou falar com a equipe do Capitão Mor?", buttons: MAIN_BUTTONS };
      }
    },
    reset(phone) { sessions.delete(phone); aiAssistant?.reset(phone); },
  };
}

const defaultService = createBarService();
export const barReply = (message) => defaultService.reply({ message });
export const initialBarMenu = menu;
