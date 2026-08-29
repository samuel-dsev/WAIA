import test from "node:test";
import assert from "node:assert/strict";
import { MODULE_KEYS } from "../src/core/contracts.js";
import {
  createCanonicalModuleDefinitions,
  createModuleRegistry,
  createTenantRuntimeRouter,
  parseTenantRuntimeConfig,
} from "../src/modules/runtime/index.js";

function memoryStateRepository() {
  const states = new Map();
  const key = ({ empresaId, conversationId }) => `${empresaId}:${conversationId}`;
  return {
    async load(context) {
      return states.get(key(context)) || null;
    },
    async save(context, state) {
      if (state == null) states.delete(key(context));
      else states.set(key(context), structuredClone(state));
    },
    inspect(empresaId, conversationId) {
      return states.get(`${empresaId}:${conversationId}`) || null;
    },
  };
}

function runtime(config, dependencies = {}) {
  return createTenantRuntimeRouter({
    config,
    stateRepository: dependencies.stateRepository || memoryStateRepository(),
    orderRepository: dependencies.orderRepository,
    appointmentRepository: dependencies.appointmentRepository,
    handoffRepository: dependencies.handoffRepository,
    logger: dependencies.logger || { error() {} },
  });
}

const barConfig = {
  empresaId: "empresa-bar",
  identity: { name: "Bar da Praça", welcomeMessage: "Bem-vindo ao Bar da Praça" },
  enabledModules: ["catalog", "orders", "events", "payments", "human_handoff"],
  menu: {
    text: "Escolha uma opção do Bar da Praça:",
    options: [
      { id: "agenda", label: "Agenda", module: "events", action: "events.list" },
      { id: "convites", label: "Comprar convites", module: "orders", action: "orders.start" },
      { id: "cardapio", label: "Cardápio", module: "catalog", action: "catalog.list" },
      { id: "atendente", label: "Atendimento humano", module: "human_handoff", action: "human_handoff.request" },
    ],
  },
  catalog: { items: [{ id: "porcao", name: "Porção da casa", price: 32 }] },
  events: {
    items: [{ id: "rock-sexta", name: "Rock de Sexta", startsAt: "sexta, 22h", price: 25 }],
  },
  payments: { pix: { key: "pix-sintetico", recipient: "Bar da Praça", instructions: "Envie o comprovante." } },
  orders: { pendingStatus: "Aguardando conferência" },
  humanHandoff: { message: "A automação foi pausada para atendimento humano." },
};

const clinicConfig = {
  empresaId: "empresa-clinica",
  identity: { name: "Clínica Exemplo" },
  enabledModules: ["appointments"],
  menu: {
    text: "Como podemos ajudar?",
    options: [{ id: "agendar", label: "Agendar consulta", module: "appointments", action: "appointments.start" }],
  },
  appointments: {
    services: [{
      id: "consulta",
      name: "Consulta inicial",
      slots: [{ id: "seg-09", label: "Segunda às 09h", startsAt: "2026-09-07T09:00:00-03:00" }],
    }],
  },
};

const storeConfig = {
  empresaId: "empresa-loja",
  identity: { name: "Loja Exemplo" },
  enabledModules: ["catalog"],
  menu: {
    text: "Conheça nossos produtos:",
    options: [{ id: "produtos", label: "Produtos", module: "catalog", action: "catalog.list" }],
  },
  catalog: {
    items: [
      { id: "camiseta", name: "Camiseta", description: "Algodão", price: 59.9 },
      { id: "inativo", name: "Produto fora de linha", price: 1, active: false },
    ],
  },
};

test("registro contém exatamente as oito capacidades canônicas", () => {
  const registry = createModuleRegistry(createCanonicalModuleDefinitions());
  assert.deepEqual(registry.keys(), MODULE_KEYS);
  assert.equal(registry.resolveAction("catalog.list").key, "catalog");
  assert.equal(registry.resolveAction("human_handoff.request").key, "human_handoff");
});

test("TenantRuntimeConfig rejeita módulo desconhecido, menu desabilitado e ação de outro módulo", () => {
  assert.throws(
    () => parseTenantRuntimeConfig({ ...storeConfig, enabledModules: ["catalog", "inventado"] }),
    /capacidade canônica/i,
  );
  assert.throws(
    () => parseTenantRuntimeConfig({ ...storeConfig, enabledModules: [], menu: storeConfig.menu }),
    /módulo desabilitado/i,
  );
  assert.throws(
    () => runtime({
      ...storeConfig,
      menu: { ...storeConfig.menu, options: [{ ...storeConfig.menu.options[0], action: "events.list" }] },
    }),
    /não pertence ao módulo catalog/i,
  );
});

test("bar com eventos e convites executa comprovante, nome e pedido sempre pendente", async () => {
  const stateRepository = memoryStateRepository();
  const recorded = [];
  let attempts = 0;
  const router = runtime(barConfig, {
    stateRepository,
    orderRepository: {
      async createPending(order) {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("indisponível"), { code: "TEMPORARY" });
        recorded.push(order);
      },
    },
  });
  const input = { conversationId: "conversa-bar", contactId: "contato-bar" };

  const agenda = await router.handle({ ...input, selectionId: "agenda" });
  assert.match(agenda.text, /Rock de Sexta/);
  assert.deepEqual(agenda.buttons.map(({ id }) => id), ["event:rock-sexta"]);

  const payment = await router.handle({ ...input, selectionId: "event:rock-sexta" });
  assert.match(payment.text, /PIX: pix-sintetico/);
  assert.match(payment.text, /R\$\s*25,00/);

  const receipt = await router.handle({ ...input, type: "image", mediaId: "media-sintetica" });
  assert.match(receipt.text, /nome completo/i);

  const failed = await router.handle({ ...input, type: "text", text: "Maria de Teste" });
  assert.match(failed.text, /não consegui registrar/i);
  assert.match(failed.text, /nenhum pagamento foi confirmado/i);
  assert.equal(stateRepository.inspect("empresa-bar", "conversa-bar").step, "awaiting_name");

  const retried = await router.handle({ ...input, type: "text", text: "Maria de Teste" });
  assert.match(retried.text, /Aguardando conferência/);
  assert.match(retried.text, /não foi confirmado automaticamente/i);
  assert.equal(stateRepository.inspect("empresa-bar", "conversa-bar"), null);
  assert.equal(attempts, 2);
  assert.deepEqual(recorded, [{
    empresaId: "empresa-bar",
    conversationId: "conversa-bar",
    contactId: "contato-bar",
    customerName: "Maria de Teste",
    eventId: "rock-sexta",
    receiptId: "media-sintetica",
    amount: 25,
    status: "Aguardando conferência",
    idempotencyKey: "order:conversa-bar:media-sintetica",
  }]);
});

test("clínica agenda serviço apenas pela configuração do tenant", async () => {
  const appointments = [];
  const router = runtime(clinicConfig, {
    appointmentRepository: { async createPending(value) { appointments.push(value); } },
  });
  const input = { conversationId: "conversa-clinica", contactId: "paciente" };

  assert.deepEqual((await router.handle({ ...input, selectionId: "agendar" })).buttons, [
    { id: "appointment:consulta", label: "Consulta inicial" },
  ]);
  assert.deepEqual((await router.handle({ ...input, selectionId: "appointment:consulta" })).buttons, [
    { id: "slot:seg-09", label: "Segunda às 09h" },
  ]);
  assert.match((await router.handle({ ...input, selectionId: "slot:seg-09" })).text, /nome completo/i);
  assert.match((await router.handle({ ...input, text: "João de Teste" })).text, /Aguarde a confirmação/i);
  assert.deepEqual(appointments, [{
    empresaId: "empresa-clinica",
    conversationId: "conversa-clinica",
    contactId: "paciente",
    customerName: "João de Teste",
    serviceId: "consulta",
    slotId: "seg-09",
    startsAt: "2026-09-07T09:00:00-03:00",
    status: "Pendente",
    idempotencyKey: "appointment:conversa-clinica:consulta:seg-09",
  }]);
});

test("clínica preserva a etapa ao receber horário inválido", async () => {
  const stateRepository = memoryStateRepository();
  const router = runtime(clinicConfig, { stateRepository });
  const input = { conversationId: "conversa-slot-invalido", contactId: "paciente" };
  await router.handle({ ...input, selectionId: "agendar" });
  await router.handle({ ...input, selectionId: "appointment:consulta" });
  const invalid = await router.handle({ ...input, text: "qualquer outro horário" });
  assert.match(invalid.text, /Escolha um dos horários disponíveis/i);
  assert.equal(stateRepository.inspect("empresa-clinica", input.conversationId).step, "awaiting_slot");
});

test("loja usa catálogo configurável e não expõe itens inativos", async () => {
  const router = runtime(storeConfig);
  const response = await router.handle({ conversationId: "conversa-loja", selectionId: "produtos" });
  assert.match(response.text, /Camiseta/);
  assert.match(response.text, /R\$\s*59,90/);
  assert.doesNotMatch(response.text, /fora de linha/i);
});

test("módulo desabilitado não é executado mesmo com ação canônica direta", async () => {
  const router = runtime(storeConfig);
  const response = await router.handle({ conversationId: "conversa-loja", action: "payments.instructions" });
  assert.equal(response.code, "MODULE_DISABLED");
  assert.equal(response.module, "payments");
});

test("segunda empresa entra em operação pela mesma fábrica sem alteração de código", async () => {
  const secondStore = {
    ...storeConfig,
    empresaId: "empresa-loja-dois",
    identity: { name: "Papelaria Dois" },
    catalog: { items: [{ id: "caderno", name: "Caderno", price: 18 }] },
  };
  const first = runtime(storeConfig);
  const second = runtime(secondStore);

  const firstReply = await first.handle({ conversationId: "mesmo-id-local", selectionId: "produtos" });
  const secondReply = await second.handle({ conversationId: "mesmo-id-local", selectionId: "produtos" });
  assert.match(firstReply.text, /Camiseta/);
  assert.doesNotMatch(firstReply.text, /Caderno/);
  assert.match(secondReply.text, /Caderno/);
  assert.doesNotMatch(secondReply.text, /Camiseta/);
});

test("handoff pausa a automação e registra solicitação com escopo da empresa", async () => {
  const requests = [];
  const stateRepository = memoryStateRepository();
  const router = runtime(barConfig, {
    stateRepository,
    handoffRepository: { async request(value) { requests.push(value); } },
  });
  const response = await router.handle({ conversationId: "conversa-handoff", contactId: "contato", selectionId: "atendente" });
  assert.match(response.text, /automação foi pausada/i);
  assert.equal(stateRepository.inspect("empresa-bar", "conversa-handoff").step, "waiting_operator");
  assert.deepEqual(requests, [{
    empresaId: "empresa-bar",
    conversationId: "conversa-handoff",
    contactId: "contato",
    idempotencyKey: "handoff:conversa-handoff",
  }]);
  const paused = await router.handle({ conversationId: "conversa-handoff", selectionId: "cardapio" });
  assert.equal(paused.code, "AUTOMATION_PAUSED");
  assert.doesNotMatch(paused.text, /Porção da casa/);
});
