import assert from "node:assert/strict";
import test from "node:test";
import {
  capitaoMorDemoDefinition,
  createCapitaoMorRuntime,
  createConfiguredTenantRuntime,
  loadCapitaoMorTenantConfig,
} from "../src/tenants/index.js";

function memoryStateRepository() {
  const states = new Map();
  const key = ({ empresaId, conversationId }) => `${empresaId}:${conversationId}`;
  return {
    async load(context) {
      return structuredClone(states.get(key(context)) || null);
    },
    async save(context, state) {
      if (state == null) states.delete(key(context));
      else states.set(key(context), structuredClone(state));
    },
    inspect(empresaId, conversationId) {
      return structuredClone(states.get(`${empresaId}:${conversationId}`) || null);
    },
  };
}

function conversation(suffix) {
  return {
    conversationId: `conversa-phase8-${suffix}`,
    contactId: `contato-phase8-${suffix}`,
  };
}

function createRuntime(dependencies = {}) {
  return createCapitaoMorRuntime({
    stateRepository: dependencies.stateRepository || memoryStateRepository(),
    orderRepository: dependencies.orderRepository,
    handoffRepository: dependencies.handoffRepository,
    aiHandler: dependencies.aiHandler,
    logger: dependencies.logger || { error() {} },
  });
}

function paginatedDefinition() {
  const definition = structuredClone(capitaoMorDemoDefinition);
  const additionalEvents = Array.from({ length: 9 }, (_, index) => ({
    id: `evento-demo-extra-${index + 1}`,
    name: `Evento Extra Demo ${index + 1}`,
    startsAt: `dia demonstrativo ${index + 1}, 21h`,
    description: "Evento sintético exclusivo da regressão de paginação.",
    price: 30 + index,
    active: true,
  }));
  definition.runtime.events.items = [
    ...definition.runtime.events.items,
    ...additionalEvents,
  ];
  return definition;
}

test("Fase 8: saudação, menu, cardápio e regras públicas permanecem configurados", async () => {
  const runtime = createRuntime();
  const input = conversation("menu");

  const greeting = await runtime.handle({ ...input, text: "Boa noite" });
  assert.deepEqual(greeting.buttons.map(({ id }) => id), ["convites", "endereco", "cardapio"]);
  assert.match(greeting.text, /Escolha uma opção/u);

  const menu = await runtime.handle({ ...input, text: "cardápio" });
  assert.match(menu.text, /example\.invalid\/capitao-mor\/cardapio/u);

  const address = await runtime.handle({ ...input, text: "onde fica?" });
  assert.match(address.text, /Rua Demonstração, 100/u);

  const birthday = await runtime.handle({ ...input, text: "regra de aniversariante" });
  assert.match(birthday.text, /consulte elegibilidade, prazo e disponibilidade/u);
  assert.match(birthday.text, /Nenhum benefício é confirmado automaticamente/u);
});

test("Fase 8: agenda e compra paginam sem perder sexta, sábado ou seleção", async () => {
  const runtime = createConfiguredTenantRuntime({
    definition: paginatedDefinition(),
    stateRepository: memoryStateRepository(),
    logger: { error() {} },
  });
  const input = conversation("pagination");

  const firstAgendaPage = await runtime.handle({ ...input, text: "programação" });
  assert.match(firstAgendaPage.text, /Sexta Rock Demo/u);
  assert.match(firstAgendaPage.text, /Sábado Acústico Demo/u);
  assert.match(firstAgendaPage.text, /Página 1 de 2/u);
  assert.equal(firstAgendaPage.buttons.length, 9);
  assert.equal(firstAgendaPage.buttons.at(-1).id, "_waia_page:events:2");

  const secondAgendaPage = await runtime.handle({ ...input, selectionId: "_waia_page:events:2" });
  assert.match(secondAgendaPage.text, /Evento Extra Demo 7/u);
  assert.match(secondAgendaPage.text, /Evento Extra Demo 9/u);
  assert.match(secondAgendaPage.text, /Página 2 de 2/u);
  assert.equal(secondAgendaPage.buttons[0].id, "_waia_page:events:1");
  assert.equal(secondAgendaPage.buttons.length, 4);

  const firstOrderPage = await runtime.handle({ ...input, selectionId: "convites" });
  assert.match(firstOrderPage.text, /Página 1 de 2/u);
  assert.equal(firstOrderPage.buttons.at(-1).id, "_waia_page:orders:2");

  const secondOrderPage = await runtime.handle({ ...input, selectionId: "_waia_page:orders:2" });
  assert.match(secondOrderPage.text, /Página 2 de 2/u);
  assert.equal(secondOrderPage.buttons[0].id, "_waia_page:orders:1");
  assert.equal(secondOrderPage.buttons.at(-1).id, "event:evento-demo-extra-9");

  const selected = await runtime.handle({ ...input, selectionId: "event:evento-demo-extra-9" });
  assert.match(selected.text, /Evento Extra Demo 9/u);
  assert.match(selected.text, /R\$\s*38,00/u);
});

test("Fase 8: sexta e sábado usam preço atual, PIX sintético e pedido pendente idempotente", async () => {
  const orders = [];
  const runtime = createRuntime({
    orderRepository: {
      async createPending(order) {
        orders.push(structuredClone(order));
      },
    },
  });

  for (const scenario of [
    { suffix: "friday", eventId: "evento-demo-sexta", name: "Sexta Rock Demo", price: 25, receiptId: "recibo-phase8-sexta" },
    { suffix: "saturday", eventId: "evento-demo-sabado", name: "Sábado Acústico Demo", price: 20, receiptId: "recibo-phase8-sabado" },
  ]) {
    const input = conversation(scenario.suffix);
    const selected = await runtime.handle({ ...input, selectionId: `event:${scenario.eventId}` });
    assert.match(selected.text, new RegExp(scenario.name, "u"));
    assert.match(selected.text, new RegExp(`R\\$\\s*${scenario.price},00`, "u"));
    assert.match(selected.text, /PIX: pix-demo@exemplo\.invalid/u);
    assert.match(selected.text, /exclusivamente sintética/u);

    const waiting = await runtime.handle({ ...input, text: "já fiz o PIX" });
    assert.match(waiting.text, /comprovante/u);

    const receipt = await runtime.handle({
      ...input,
      type: scenario.suffix === "friday" ? "image" : "document",
      mediaId: scenario.receiptId,
    });
    assert.match(receipt.text, /nome completo/u);

    const completed = await runtime.handle({ ...input, text: `Pessoa ${scenario.suffix}` });
    assert.match(completed.text, /Aguardando conferência/u);
    assert.match(completed.text, /não foi confirmado automaticamente/u);
  }

  assert.deepEqual(orders.map(({ eventId, amount, status, idempotencyKey }) => ({
    eventId,
    amount,
    status,
    idempotencyKey,
  })), [
    {
      eventId: "evento-demo-sexta",
      amount: 25,
      status: "Aguardando conferência",
      idempotencyKey: "order:conversa-phase8-friday:recibo-phase8-sexta",
    },
    {
      eventId: "evento-demo-sabado",
      amount: 20,
      status: "Aguardando conferência",
      idempotencyKey: "order:conversa-phase8-saturday:recibo-phase8-sabado",
    },
  ]);
});

test("Fase 8: PIX não é delegado à IA e nova intenção interrompe comprovante com segurança", async () => {
  const stateRepository = memoryStateRepository();
  const aiCalls = [];
  const runtime = createRuntime({
    stateRepository,
    aiHandler: async ({ input }) => {
      aiCalls.push(structuredClone(input));
      return { reply: { text: "Não há informação pública confirmada sobre estacionamento.", buttons: [] } };
    },
  });
  const input = conversation("intent");
  const empresaId = loadCapitaoMorTenantConfig().empresaId;

  const payment = await runtime.handle({ ...input, text: "qual é o pix?" });
  assert.match(payment.text, /pix-demo@exemplo\.invalid/u);
  assert.equal(aiCalls.length, 0);

  await runtime.handle({ ...input, selectionId: "event:evento-demo-sexta" });
  const switched = await runtime.handle({ ...input, text: "quero a noite de sábado" });
  assert.match(switched.text, /Sábado Acústico Demo/u);
  assert.equal(stateRepository.inspect(empresaId, input.conversationId).data.eventId, "evento-demo-sabado");

  const freeform = await runtime.handle({ ...input, text: "Tem estacionamento?" });
  assert.match(freeform.text, /Não há informação pública confirmada/u);
  assert.match(freeform.text, /O que mais você gostaria de saber\?$/u);
  assert.equal(aiCalls.length, 1);
  assert.equal(stateRepository.inspect(empresaId, input.conversationId), null);

  const reset = await runtime.handle({ ...input, text: "oi" });
  assert.deepEqual(reset.buttons.map(({ id }) => id), ["convites", "endereco", "cardapio"]);
});

test("Fase 8: handoff é solicitado uma vez e pausa respostas automáticas", async () => {
  const stateRepository = memoryStateRepository();
  const handoffs = [];
  const runtime = createRuntime({
    stateRepository,
    handoffRepository: {
      async request(request) {
        handoffs.push(structuredClone(request));
      },
    },
  });
  const input = conversation("handoff");
  const empresaId = loadCapitaoMorTenantConfig().empresaId;

  const requested = await runtime.handle({ ...input, text: "falar com atendente" });
  assert.match(requested.text, /automação foi pausada/u);
  assert.deepEqual(handoffs, [{
    empresaId,
    conversationId: input.conversationId,
    contactId: input.contactId,
    idempotencyKey: `handoff:${input.conversationId}`,
  }]);
  assert.equal(stateRepository.inspect(empresaId, input.conversationId).step, "waiting_operator");

  const paused = await runtime.handle({ ...input, text: "cardápio" });
  assert.equal(paused.code, "AUTOMATION_PAUSED");
  assert.equal(paused.module, "human_handoff");
  assert.equal(handoffs.length, 1);
});
