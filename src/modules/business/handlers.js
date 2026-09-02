import { paginateInteractiveOptions, withPageIndicator } from "../runtime/interactive-pagination.js";
import { executeFlowAction } from "../flows/index.js";

const MONEY = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function reply(text, buttons = []) {
  return { text, buttons };
}

function menuButton(id, label, description) {
  return { id, label, ...(description ? { description } : {}) };
}

function active(items) {
  return items.filter((item) => item.active !== false);
}

function eventDateParts(event) {
  const instant = new Date(event.startsAt);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: event.timezone || "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  if (!["weekday", "day", "month", "hour", "minute"].every((type) => value(type))) return null;
  return { weekday: value("weekday"), day: value("day"), month: value("month"), hour: value("hour"), minute: value("minute") };
}

function eventChoiceLabel(event) {
  const date = eventDateParts(event);
  if (!date) return event.name;
  const weekday = date.weekday.replace(/-feira$/u, "");
  return `${weekday.charAt(0).toLocaleUpperCase("pt-BR")}${weekday.slice(1)} ${date.day}/${date.month}`;
}

function detailedOrderReply(event, pix, orders) {
  const hasPublicDetails = Boolean(event.attractions || event.vipRule || event.birthdayRule || event.location);
  if (!hasPublicDetails) {
    return `${event.name} — ${MONEY.format(event.price)}.\nPIX: ${pix.key}\nFavorecido: ${pix.recipient}\n${pix.instructions || orders.receiptPrompt || "Envie o comprovante por aqui."}`;
  }
  const date = eventDateParts(event);
  const heading = date
    ? `🌒 ${date.weekday.toLocaleUpperCase("pt-BR")} ${date.day}/${date.month} • ${date.hour}:${date.minute}`
    : `🌒 ${event.startsAt}`;
  const attractions = String(event.attractions || event.name)
    .split(/\s*\|\s*/u)
    .filter(Boolean)
    .join("\n");
  return [
    heading,
    attractions,
    event.description,
    "",
    `Convite unissex: ${MONEY.format(event.price)}`,
    event.vipRule,
    "",
    `💳 PIX: ${pix.key}`,
    `Favorecida: ${pix.recipient}`,
    "",
    orders.paymentPrompt || "Após o pagamento, envie aqui o comprovante e o nome completo.",
    event.birthdayRule ? `\n🎂 ${event.birthdayRule}` : null,
    event.location ? `\n📍 ${event.location}` : null,
  ].filter((line) => line != null).join("\n").replace(/\n{3,}/gu, "\n\n");
}

function requireRepositoryMethod(repository, method, name) {
  if (typeof repository?.[method] !== "function") throw new TypeError(`${name}.${method} é obrigatório para esta operação.`);
}

function catalogHandler() {
  return {
    key: "catalog",
    actions: ["catalog.list"],
    async handle({ config }) {
      const items = active(config.catalog.items);
      if (items.length === 0) return { reply: reply("O catálogo ainda não possui itens disponíveis.") };
      const lines = items.map((item) => {
        const price = item.price == null ? "" : ` — ${MONEY.format(item.price)}`;
        const description = item.description ? `\n${item.description}` : "";
        return `• ${item.name}${price}${description}`;
      });
      return { reply: reply(lines.join("\n")) };
    },
  };
}

function eventsHandler() {
  return {
    key: "events",
    actions: ["events.list"],
    async handle({ config, payload }) {
      const events = active(config.events.items);
      if (events.length === 0) return { reply: reply("Não há eventos disponíveis no momento.") };
      const pagination = paginateInteractiveOptions(events, {
        page: payload?.page,
        scope: "events",
        toButton: (event) => menuButton(
          `event:${event.id}`,
          `Comprar: ${event.name}`,
          `${event.startsAt} — ${MONEY.format(event.price)}`,
        ),
      });
      const lines = pagination.items.map((event) => `• ${event.name} — ${event.startsAt} — ${MONEY.format(event.price)}`);
      return { reply: reply(withPageIndicator(lines.join("\n"), pagination), pagination.buttons) };
    },
  };
}

function orderHandler({ orderRepository, logger }) {
  return {
    key: "orders",
    actions: ["orders.start", "orders.select_event", "orders.continue"],
    async handle(context) {
      const { action, config, input, state } = context;
      if (action === "orders.start") {
        const events = active(config.events.items);
        if (events.length === 0) return { reply: reply("Não há itens disponíveis para compra no momento.") };
        const pagination = paginateInteractiveOptions(events, {
          page: context.payload?.page,
          scope: "orders",
          toButton: (event) => menuButton(`event:${event.id}`, eventChoiceLabel(event), event.attractions || event.name),
        });
        return {
          reply: reply(
            withPageIndicator(config.orders.selectionPrompt || "Escolha o evento:", pagination),
            pagination.buttons,
          ),
        };
      }

      if (action === "orders.select_event") {
        const event = config.events.items.find((item) => item.id === context.payload.eventId && item.active !== false);
        if (!event) return { reply: reply("O evento selecionado não está disponível.") };
        const pix = config.payments.pix;
        if (!pix) return { reply: reply("O pagamento ainda não está configurado. Fale com a equipe.") };
        return {
          state: { module: "orders", step: "awaiting_receipt", data: { eventId: event.id } },
          reply: reply(detailedOrderReply(event, pix, config.orders)),
        };
      }

      if (state.step === "awaiting_receipt") {
        const supportedReceipt = ["image", "document"].includes(input.type) && input.mediaId;
        if (!supportedReceipt) {
          return { state, reply: reply(config.orders.receiptPrompt || "Envie a imagem ou o documento do comprovante para continuar.") };
        }
        return {
          state: { module: "orders", step: "awaiting_name", data: { ...state.data, receiptId: input.mediaId } },
          reply: reply(config.orders.namePrompt || "Recebi o comprovante. Informe o nome completo para registrar o pedido."),
        };
      }

      if (state.step === "awaiting_name") {
        const name = String(input.text || "").trim();
        if (name.length < 3) return { state, reply: reply("Informe o nome completo para continuar.") };
        try {
          requireRepositoryMethod(orderRepository, "createPending", "orderRepository");
          const event = config.events.items.find((item) => item.id === state.data.eventId);
          await orderRepository.createPending({
            empresaId: config.empresaId,
            conversationId: input.conversationId,
            contactId: input.contactId,
            customerName: name,
            eventId: state.data.eventId,
            receiptId: state.data.receiptId,
            amount: event?.price,
            status: config.orders.pendingStatus,
            idempotencyKey: `order:${input.conversationId}:${state.data.receiptId}`,
          });
          return {
            state: null,
            reply: reply(config.orders.successMessage || `Obrigado, ${name}. Seu pedido foi registrado como ${config.orders.pendingStatus}. O pagamento será conferido pela equipe; ele não foi confirmado automaticamente.`),
          };
        } catch (error) {
          logger?.error?.("pending_order_registration_failed", {
            empresaId: config.empresaId,
            conversationId: input.conversationId,
            errorCode: error?.code || "ORDER_REPOSITORY_ERROR",
          });
          return {
            state,
            reply: reply("Não consegui registrar o pedido agora. Nenhum pagamento foi confirmado. Envie o nome novamente para tentar o registro."),
          };
        }
      }

      return { reply: reply("Escolha uma opção de compra para continuar.") };
    },
  };
}

function paymentsHandler() {
  return {
    key: "payments",
    actions: ["payments.instructions"],
    async handle({ config }) {
      const pix = config.payments.pix;
      if (!pix) return { reply: reply("O pagamento ainda não está configurado.") };
      return { reply: reply(`PIX: ${pix.key}\nFavorecido: ${pix.recipient}${pix.instructions ? `\n${pix.instructions}` : ""}`) };
    },
  };
}

function appointmentsHandler({ appointmentRepository, logger }) {
  return {
    key: "appointments",
    actions: ["appointments.start", "appointments.select_service", "appointments.select_slot", "appointments.continue"],
    async handle({ action, config, input, payload, state }) {
      const services = active(config.appointments.services);
      if (action === "appointments.start") {
        if (services.length === 0) return { reply: reply("Não há serviços disponíveis para agendamento.") };
        const pagination = paginateInteractiveOptions(services, {
          page: payload?.page,
          scope: "appointment-services",
          toButton: (service) => menuButton(`appointment:${service.id}`, service.name, service.description),
        });
        return { reply: reply(withPageIndicator("Escolha o serviço:", pagination), pagination.buttons) };
      }
      if (action === "appointments.select_service") {
        const service = services.find((item) => item.id === payload.serviceId);
        if (!service) return { reply: reply("O serviço selecionado não está disponível.") };
        const slots = service.slots.filter((slot) => slot.available);
        if (slots.length === 0) return { reply: reply("Não há horários disponíveis para esse serviço.") };
        const pagination = paginateInteractiveOptions(slots, {
          page: payload?.page,
          scope: "appointment-slots",
          toButton: (slot) => menuButton(`slot:${slot.id}`, slot.label),
        });
        return {
          state: { module: "appointments", step: "awaiting_slot", data: { serviceId: service.id } },
          reply: reply(withPageIndicator("Escolha o horário:", pagination), pagination.buttons),
        };
      }
      if (action === "appointments.select_slot" || state.step === "awaiting_slot") {
        const service = services.find((item) => item.id === state.data.serviceId);
        const slot = service?.slots.find((item) => item.id === payload.slotId && item.available);
        if (!slot) return { state, reply: reply("Escolha um dos horários disponíveis.") };
        return {
          state: { module: "appointments", step: "awaiting_name", data: { serviceId: service.id, slotId: slot.id } },
          reply: reply("Informe o nome completo para concluir a solicitação de agendamento."),
        };
      }
      if (state.step === "awaiting_name") {
        const name = String(input.text || "").trim();
        if (name.length < 3) return { state, reply: reply("Informe o nome completo para continuar.") };
        try {
          requireRepositoryMethod(appointmentRepository, "createPending", "appointmentRepository");
          await appointmentRepository.createPending({
            empresaId: config.empresaId,
            conversationId: input.conversationId,
            contactId: input.contactId,
            customerName: name,
            serviceId: state.data.serviceId,
            slotId: state.data.slotId,
            startsAt: config.appointments.services
              .find((item) => item.id === state.data.serviceId)
              ?.slots.find((item) => item.id === state.data.slotId)?.startsAt,
            status: "Pendente",
            idempotencyKey: `appointment:${input.conversationId}:${state.data.serviceId}:${state.data.slotId}`,
          });
          return { state: null, reply: reply(`Solicitação de agendamento registrada para ${name}. Aguarde a confirmação da equipe.`) };
        } catch (error) {
          logger?.error?.("pending_appointment_registration_failed", {
            empresaId: config.empresaId,
            conversationId: input.conversationId,
            errorCode: error?.code || "APPOINTMENT_REPOSITORY_ERROR",
          });
          return { state, reply: reply("Não consegui registrar o agendamento agora. Envie o nome novamente para tentar.") };
        }
      }
      return { reply: reply("Escolha uma opção de agendamento para continuar.") };
    },
  };
}

function handoffHandler({ handoffRepository }) {
  return {
    key: "human_handoff",
    actions: ["human_handoff.request"],
    async handle({ config, input, state }) {
      if (handoffRepository) {
        requireRepositoryMethod(handoffRepository, "request", "handoffRepository");
        await handoffRepository.request({
          empresaId: config.empresaId,
          conversationId: input.conversationId,
          contactId: input.contactId,
          idempotencyKey: `handoff:${input.conversationId}`,
        });
      }
      return {
        state: { ...state, module: "human_handoff", step: "waiting_operator", data: {} },
        reply: reply(config.humanHandoff.message || `A automação foi pausada. A equipe de ${config.identity.name} continuará o atendimento.${config.humanHandoff.channel ? ` Contato: ${config.humanHandoff.channel}` : ""}`),
      };
    },
  };
}

function delegatedHandler(key, action, delegate) {
  return {
    key,
    actions: [action],
    async handle(context) {
      if (typeof delegate === "function") return delegate(context);
      return { reply: reply("Este recurso está habilitado, mas a integração ainda não foi configurada.") };
    },
  };
}

function flowKeyFromReference(value) {
  const match = /^flow:([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127})$/u.exec(String(value || ""));
  return match?.[1] || null;
}

function flowStatus(status) {
  return ({
    waiting_input: "waiting",
    completed: "completed",
    handoff: "handed_off",
    cancelled: "cancelled",
  })[status];
}

function flowInput(input) {
  const selection = String(input.selectionId || "");
  if (selection.startsWith("flow-option:")) return { type: "selection", value: selection.slice(12) };
  if (selection === "flow-consent:true") return { type: "consent", value: true };
  if (selection === "flow-consent:false") return { type: "consent", value: false };
  if (selection === "flow-skip" || String(input.text || "").trim().toLocaleLowerCase("pt-BR") === "pular") {
    return { type: "skip" };
  }
  if (["image", "document"].includes(input.type) && input.messageId) {
    return { type: "document", value: `document:${input.messageId}` };
  }
  const text = String(input.text || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return { type: "date", value: text };
  if (/^(?:sim|aceito|concordo)$/iu.test(text)) return { type: "consent", value: true };
  if (/^(?:não|nao|recuso|discordo)$/iu.test(text)) return { type: "consent", value: false };
  return { type: "text", value: text };
}

function flowReply(effects, config, executionState) {
  const texts = effects.filter((effect) => effect.type === "message" || effect.type === "prompt")
    .map((effect) => effect.text).filter(Boolean);
  if (texts.length === 0) {
    if (effects.some((effect) => effect.type === "cancelled")) texts.push("Fluxo cancelado.");
    else if (effects.some((effect) => effect.type === "completed")) texts.push("Fluxo concluído.");
    else if (effects.some((effect) => effect.type === "handoff")) texts.push("A equipe continuará o atendimento.");
  }
  const prompt = [...effects].reverse().find((effect) => effect.type === "prompt");
  let options = prompt?.input?.options || [];
  if (prompt?.input?.type === "consent") {
    return reply(texts.join("\n\n"), [
      menuButton("flow-consent:true", "Sim"),
      menuButton("flow-consent:false", "Não"),
    ]);
  }
  if (prompt?.input?.type === "selection" && options.length === 0) {
    if (config.appointments?.services?.length > 0 && prompt.stepId) {
      const activeServices = active(config.appointments.services);
      const selectedService = Object.values(executionState.answers || {})
        .map(String)
        .map((id) => activeServices.find((service) => service.id === id))
        .find(Boolean);
      options = selectedService
        ? (selectedService.slots || []).filter((slot) => slot.available !== false)
          .map((slot) => ({ id: slot.id, label: slot.label }))
        : activeServices.map((service) => ({ id: service.id, label: service.name }));
    }
  }
  const buttons = options.map((option) => menuButton(`flow-option:${option.id}`, option.label));
  if (prompt?.input?.required === false) buttons.push(menuButton("flow-skip", "Pular"));
  return reply(texts.join("\n\n"), buttons);
}

function flowHandler({ flowRepository, handoffRepository }) {
  return {
    key: "flows",
    actions: ["flows.start", "flows.continue", "flows.cancel"],
    async handle({ action, config, input, payload }) {
      requireRepositoryMethod(flowRepository, "startSubmission", "flowRepository");
      requireRepositoryMethod(flowRepository, "findPublishedDefinition", "flowRepository");
      requireRepositoryMethod(flowRepository, "findActiveSubmission", "flowRepository");
      requireRepositoryMethod(flowRepository, "saveSubmission", "flowRepository");
      let activeSubmission;
      let result;
      let persisted;
      if (action === "flows.start") {
        const flowKey = flowKeyFromReference(payload?.flowRef);
        if (!flowKey) return { reply: reply("O fluxo selecionado é inválido.") };
        const definition = config.flows.definitions.find((flow) => flow.key === flowKey);
        if (!definition) return { reply: reply("O fluxo selecionado não está disponível nesta revisão.") };
        const previous = await flowRepository.findActiveSubmission({
          empresaId: config.empresaId,
          conversationId: input.conversationId,
        });
        if (previous) {
          const cancelled = executeFlowAction({
            action: "flows.cancel",
            state: previous.submission.data,
          });
          await flowRepository.saveSubmission({
            empresaId: config.empresaId,
            submissionId: previous.submission.id,
            flowVersionId: previous.submission.flowVersionId,
            expectedRevision: previous.submission.revision,
            status: "cancelled",
            currentStepId: cancelled.state.currentStepId,
            data: cancelled.state,
            correlationId: input.correlationId,
          });
        }
        const published = await flowRepository.findPublishedDefinition({
          empresaId: config.empresaId,
          flowKey,
          configurationVersion: config.version,
        });
        if (!published) return { reply: reply("O fluxo selecionado ainda não possui versão publicada.") };
        result = executeFlowAction({
          action,
          definition: published.definition,
          flowVersionId: published.flowVersionId,
        });
        activeSubmission = await flowRepository.startSubmission({
          empresaId: config.empresaId,
          flowKey,
          configurationVersion: config.version,
          conversationId: input.conversationId,
          contactId: input.contactId,
          expectedFlowVersionId: published.flowVersionId,
          initialState: result.state,
          correlationId: input.correlationId,
        });
        persisted = activeSubmission.submission;
      } else {
        activeSubmission = await flowRepository.findActiveSubmission({
          empresaId: config.empresaId,
          conversationId: input.conversationId,
        });
        if (!activeSubmission) return { state: null, reply: reply("Não há fluxo em andamento nesta conversa.") };
        result = executeFlowAction({
          action,
          definition: activeSubmission.version.definition,
          state: activeSubmission.submission.data,
          ...(action === "flows.continue" ? { input: flowInput(input) } : {}),
        });
      }

      const submission = activeSubmission.submission;
      if (action === "flows.continue" && result.state.status !== "cancelled"
        && ["image", "document"].includes(input.type) && input.messageId) {
        requireRepositoryMethod(flowRepository, "attachDocument", "flowRepository");
        const currentStep = activeSubmission.version.definition.steps
          .find((step) => step.id === submission.data.currentStepId);
        await flowRepository.attachDocument({
          empresaId: config.empresaId,
          submissionId: submission.id,
          messageId: input.messageId,
          field: currentStep?.field,
          storageKey: input.mediaStorageKey,
          mimeType: input.mediaMimeType,
          sizeBytes: input.mediaSizeBytes,
          sha256: input.mediaSha256,
          correlationId: input.correlationId,
        });
      }
      if (!persisted) {
        persisted = await flowRepository.saveSubmission({
          empresaId: config.empresaId,
          submissionId: submission.id,
          flowVersionId: submission.flowVersionId,
          expectedRevision: submission.revision,
          status: flowStatus(result.state.status),
          currentStepId: result.state.currentStepId,
          data: result.state,
          correlationId: input.correlationId,
        });
      }
      const rendered = flowReply(result.effects, config, result.state);
      if (result.state.status === "handoff") {
        if (handoffRepository) {
          requireRepositoryMethod(handoffRepository, "request", "handoffRepository");
          await handoffRepository.request({
            empresaId: config.empresaId,
            conversationId: input.conversationId,
            contactId: input.contactId,
            idempotencyKey: `flow-handoff:${persisted.id}`,
          });
        }
        return {
          state: { module: "human_handoff", step: "waiting_operator", data: {} },
          reply: rendered,
        };
      }
      if (["completed", "cancelled"].includes(result.state.status)) return { state: null, reply: rendered };
      return {
        state: {
          module: "flows",
          step: result.state.currentStepId,
          data: { submissionId: persisted.id, flowVersionId: persisted.flowVersionId },
        },
        reply: rendered,
      };
    },
  };
}

export function createCanonicalModuleDefinitions({
  orderRepository,
  appointmentRepository,
  handoffRepository,
  aiHandler,
  integrationsHandler,
  flowRepository,
  logger = console,
} = {}) {
  return [
    catalogHandler(),
    orderHandler({ orderRepository, logger }),
    eventsHandler(),
    appointmentsHandler({ appointmentRepository, logger }),
    paymentsHandler(),
    handoffHandler({ handoffRepository }),
    delegatedHandler("ai_freeform", "ai_freeform.reply", aiHandler),
    delegatedHandler("external_integrations", "external_integrations.run", integrationsHandler),
    flowHandler({ flowRepository, handoffRepository }),
  ];
}
