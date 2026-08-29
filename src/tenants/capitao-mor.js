import { createConfiguredTenantRuntime, loadConfiguredTenant } from "./configured-runtime.js";

export const CAPITAO_MOR_DEMO_TENANT_ID = "00000000-0000-4000-8000-000000000001";

export const capitaoMorDemoDefinition = Object.freeze({
  runtime: {
    empresaId: CAPITAO_MOR_DEMO_TENANT_ID,
    version: 1,
    identity: {
      name: "Bar Capitão Mor — Demonstração",
      welcomeMessage: "Olá! Bem-vindo ao Bar Capitão Mor. Como podemos ajudar?",
      fallbackMessage: "No momento consigo ajudar apenas com informações validadas do Bar Capitão Mor. Quer ver a agenda, os convites ou falar com a equipe?",
    },
    enabledModules: [
      "catalog",
      "orders",
      "events",
      "payments",
      "human_handoff",
      "ai_freeform",
      "external_integrations",
    ],
    menu: {
      text: "Escolha uma opção:",
      options: [
        { id: "convites", label: "Comprar convites", module: "orders", action: "orders.start" },
        { id: "endereco", label: "Endereço", module: "catalog", action: "catalog.address" },
        { id: "cardapio", label: "Cardápio", module: "catalog", action: "catalog.menu" },
      ],
    },
    catalog: {
      items: [
        {
          id: "cardapio-demo",
          name: "Cardápio demonstrativo",
          description: "Consulte https://example.invalid/capitao-mor/cardapio",
          active: true,
        },
      ],
    },
    events: {
      items: [
        {
          id: "evento-demo-sexta",
          name: "Sexta Rock Demo",
          startsAt: "sexta-feira, 22h",
          description: "Atração demonstrativa. Aniversariante da semana consulta a regra com a equipe.",
          price: 25,
          active: true,
        },
        {
          id: "evento-demo-sabado",
          name: "Sábado Acústico Demo",
          startsAt: "sábado, 20h",
          description: "Atração demonstrativa. Valores e disponibilidade sujeitos à conferência humana.",
          price: 20,
          active: true,
        },
      ],
    },
    payments: {
      pix: {
        key: "pix-demo@exemplo.invalid",
        recipient: "Capitão Mor Demonstração",
        instructions: "Chave exclusivamente sintética. Envie a imagem ou o documento do comprovante por aqui.",
      },
    },
    orders: {
      pendingStatus: "Aguardando conferência",
      receiptPrompt: "Envie a imagem ou o documento do comprovante para continuar.",
      namePrompt: "Recebi o comprovante. Informe o nome completo para registrar o pedido.",
      successMessage: "Pedido registrado como Aguardando conferência. O pagamento será conferido pela equipe e não foi confirmado automaticamente.",
    },
    appointments: { services: [] },
    humanHandoff: {
      message: "A automação foi pausada. A equipe continuará o atendimento humano por esta conversa.",
    },
  },
  publicReplies: [
    {
      module: "catalog",
      action: "catalog.address",
      text: "Endereço demonstrativo: Rua Demonstração, 100 — Centro. Confirme o endereço real com a equipe antes de se deslocar.",
    },
    {
      module: "catalog",
      action: "catalog.menu",
      text: "Cardápio demonstrativo: https://example.invalid/capitao-mor/cardapio",
    },
    {
      module: "events",
      action: "events.birthday_rule",
      text: "Regra demonstrativa de aniversariante: consulte elegibilidade, prazo e disponibilidade com a equipe. Nenhum benefício é confirmado automaticamente.",
    },
  ],
  eventPresentation: {
    intro: "Agenda demonstrativa:",
    emptyMessage: "A agenda está sendo atualizada. Fale com a equipe para confirmar a programação.",
    includeDescription: true,
  },
  routing: {
    greetings: ["oi", "olá", "ola", "opa", "bom dia", "boa tarde", "boa noite", "início", "inicio", "começar"],
    aliases: [
      { terms: ["agenda", "programação", "programacao"], action: "events.list" },
      { terms: ["convites", "comprar convites", "ingresso", "ingressos"], action: "orders.start" },
      { terms: ["endereço", "endereco", "onde fica?", "onde fica"], action: "catalog.address" },
      { terms: ["cardápio", "cardapio", "menu"], action: "catalog.menu" },
      { terms: ["aniversariante", "aniversário", "aniversario"], action: "events.birthday_rule" },
      { terms: ["pix", "qual é o pix?", "qual e o pix?", "pagamento"], action: "payments.instructions" },
      { terms: ["atendente", "atendimento humano", "falar com atendente"], action: "human_handoff.request" },
    ],
    fallbackAction: "ai_freeform.reply",
  },
  ai: {
    fallbackMessage: "No momento consigo ajudar apenas com informações validadas do Bar Capitão Mor. Quer ver a agenda, os convites ou falar com a equipe?",
  },
});

export function loadCapitaoMorTenantConfig({ empresaId = CAPITAO_MOR_DEMO_TENANT_ID } = {}) {
  return loadConfiguredTenant({
    ...capitaoMorDemoDefinition,
    runtime: { ...capitaoMorDemoDefinition.runtime, empresaId },
  });
}

export function createCapitaoMorRuntime({ empresaId = CAPITAO_MOR_DEMO_TENANT_ID, ...dependencies } = {}) {
  return createConfiguredTenantRuntime({
    ...dependencies,
    definition: {
      ...capitaoMorDemoDefinition,
      runtime: { ...capitaoMorDemoDefinition.runtime, empresaId },
    },
  });
}

