import assert from "node:assert/strict";
import test from "node:test";
import { createCapitaoMorRuntime, loadCapitaoMorTenantConfig } from "../src/tenants/index.js";

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

const conversation = Object.freeze({
  conversationId: "conversa-golden",
  contactId: "contato-golden",
});

test("respostas douradas do Capitão Mor permanecem idênticas antes do onboarding", async () => {
  const stateRepository = memoryStateRepository();
  const orders = [];
  const runtime = createCapitaoMorRuntime({
    stateRepository,
    orderRepository: {
      async createPending(order) {
        orders.push(structuredClone(order));
      },
    },
    logger: { error() {} },
  });
  const empresaId = loadCapitaoMorTenantConfig().empresaId;

  assert.deepEqual(await runtime.handle({ ...conversation, text: "Olá" }), {
    source: "deterministic",
    module: null,
    text: "Escolha uma opção:",
    buttons: [
      { id: "convites", label: "Comprar convites" },
      { id: "endereco", label: "Endereço" },
      { id: "cardapio", label: "Cardápio" },
    ],
  });

  assert.deepEqual(await runtime.handle({ ...conversation, text: "programação" }), {
    source: "deterministic",
    module: "events",
    text: "Agenda demonstrativa:\n• Sexta Rock Demo — sexta-feira, 22h — R$ 25,00\nAtração demonstrativa. Aniversariante da semana consulta a regra com a equipe.\n• Sábado Acústico Demo — sábado, 20h — R$ 20,00\nAtração demonstrativa. Valores e disponibilidade sujeitos à conferência humana.",
    buttons: [
      {
        id: "event:evento-demo-sexta",
        label: "Comprar: Sexta Rock Demo",
        description: "sexta-feira, 22h — R$ 25,00",
      },
      {
        id: "event:evento-demo-sabado",
        label: "Comprar: Sábado Acústico Demo",
        description: "sábado, 20h — R$ 20,00",
      },
    ],
  });

  assert.deepEqual(await runtime.handle({ ...conversation, selectionId: "event:evento-demo-sexta" }), {
    source: "deterministic",
    module: "orders",
    text: "Sexta Rock Demo — R$ 25,00.\nPIX: pix-demo@exemplo.invalid\nFavorecido: Capitão Mor Demonstração\nChave exclusivamente sintética. Envie a imagem ou o documento do comprovante por aqui.",
    buttons: [],
  });
  assert.deepEqual(stateRepository.inspect(empresaId, conversation.conversationId), {
    module: "orders",
    step: "awaiting_receipt",
    data: { eventId: "evento-demo-sexta" },
  });

  assert.deepEqual(await runtime.handle({ ...conversation, type: "text", text: "paguei" }), {
    source: "deterministic",
    module: "orders",
    text: "Envie a imagem ou o documento do comprovante para continuar.",
    buttons: [],
  });
  assert.deepEqual(await runtime.handle({ ...conversation, type: "image", mediaId: "media-golden" }), {
    source: "deterministic",
    module: "orders",
    text: "Recebi o comprovante. Informe o nome completo para registrar o pedido.",
    buttons: [],
  });
  assert.deepEqual(await runtime.handle({ ...conversation, type: "text", text: "Pessoa Demonstração" }), {
    source: "deterministic",
    module: "orders",
    text: "Pedido registrado como Aguardando conferência. O pagamento será conferido pela equipe e não foi confirmado automaticamente.",
    buttons: [],
  });
  assert.deepEqual(orders, [{
    empresaId,
    conversationId: conversation.conversationId,
    contactId: conversation.contactId,
    customerName: "Pessoa Demonstração",
    eventId: "evento-demo-sexta",
    receiptId: "media-golden",
    amount: 25,
    status: "Aguardando conferência",
    idempotencyKey: "order:conversa-golden:media-golden",
  }]);
  assert.equal(stateRepository.inspect(empresaId, conversation.conversationId), null);
});
