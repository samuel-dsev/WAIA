import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

function capitaoRuntime(dependencies = {}) {
  return createCapitaoMorRuntime({
    stateRepository: dependencies.stateRepository || memoryStateRepository(),
    orderRepository: dependencies.orderRepository,
    handoffRepository: dependencies.handoffRepository,
    aiHandler: dependencies.aiHandler,
    logger: dependencies.logger || { error() {} },
  });
}

const conversationInput = Object.freeze({
  conversationId: "conversa-demonstracao",
  contactId: "contato-demonstracao",
});

test("loader produz TenantRuntimeConfig imutável sem dados operacionais reais", () => {
  const config = loadCapitaoMorTenantConfig();
  assert.equal(config.identity.name, "Bar Capitão Mor — Demonstração");
  assert.equal(Object.isFrozen(config), true);
  assert.deepEqual(config.menu.options.map(({ label }) => label), [
    "Comprar convites",
    "Endereço",
    "Cardápio",
  ]);
  const serialized = JSON.stringify(capitaoMorDemoDefinition);
  assert.doesNotMatch(serialized, /Antonio Monteiro|goomer\.app|5512\d{8,}|access[_-]?token|private[_-]?key/iu);
  assert.match(serialized, /exemplo\.invalid/u);
  assert.match(serialized, /Demonstração/u);
});

test("menu, agenda completa, endereço, cardápio e aniversariante vêm da configuração", async () => {
  const runtime = capitaoRuntime();
  const menu = await runtime.handle({ ...conversationInput, text: "Olá" });
  assert.deepEqual(menu.buttons.map(({ label }) => label), ["Comprar convites", "Endereço", "Cardápio"]);

  const agenda = await runtime.handle({ ...conversationInput, text: "programação" });
  assert.match(agenda.text, /Agenda demonstrativa/);
  assert.match(agenda.text, /Sexta Rock Demo/);
  assert.match(agenda.text, /Sábado Acústico Demo/);
  assert.deepEqual(agenda.buttons.map(({ id }) => id), ["event:evento-demo-sexta", "event:evento-demo-sabado"]);

  assert.match((await runtime.handle({ ...conversationInput, selectionId: "endereco" })).text, /Rua Demonstração, 100/);
  assert.match((await runtime.handle({ ...conversationInput, text: "cardápio" })).text, /example\.invalid\/capitao-mor\/cardapio/u);
  const birthday = await runtime.handle({ ...conversationInput, text: "aniversariante" });
  assert.match(birthday.text, /elegibilidade/i);
  assert.match(birthday.text, /Nenhum benefício é confirmado automaticamente/i);
});

test("convite preserva seleção, PIX sintético, comprovante e nome completo", async () => {
  const stateRepository = memoryStateRepository();
  const orders = [];
  const runtime = capitaoRuntime({
    stateRepository,
    orderRepository: { async createPending(order) { orders.push(structuredClone(order)); } },
  });

  const choices = await runtime.handle({ ...conversationInput, selectionId: "convites" });
  assert.deepEqual(choices.buttons.map(({ id }) => id), ["event:evento-demo-sexta", "event:evento-demo-sabado"]);
  const selected = await runtime.handle({ ...conversationInput, selectionId: "event:evento-demo-sexta" });
  assert.match(selected.text, /R\$\s*25,00/);
  assert.match(selected.text, /PIX: pix-demo@exemplo\.invalid/u);
  assert.match(selected.text, /exclusivamente sintética/i);

  const invalidReceipt = await runtime.handle({ ...conversationInput, type: "text", text: "paguei" });
  assert.match(invalidReceipt.text, /imagem ou o documento do comprovante/i);
  assert.equal(stateRepository.inspect(loadCapitaoMorTenantConfig().empresaId, conversationInput.conversationId).step, "awaiting_receipt");

  const receipt = await runtime.handle({ ...conversationInput, type: "image", mediaId: "media-demo-1" });
  assert.match(receipt.text, /nome completo/i);
  const shortName = await runtime.handle({ ...conversationInput, type: "text", text: "X" });
  assert.match(shortName.text, /nome completo/i);
  const completed = await runtime.handle({ ...conversationInput, type: "text", text: "Pessoa Demonstração" });
  assert.match(completed.text, /Aguardando conferência/);
  assert.match(completed.text, /não foi confirmado automaticamente/i);
  assert.equal(stateRepository.inspect(loadCapitaoMorTenantConfig().empresaId, conversationInput.conversationId), null);
  assert.deepEqual(orders, [{
    empresaId: loadCapitaoMorTenantConfig().empresaId,
    conversationId: conversationInput.conversationId,
    contactId: conversationInput.contactId,
    customerName: "Pessoa Demonstração",
    eventId: "evento-demo-sexta",
    receiptId: "media-demo-1",
    amount: 25,
    status: "Aguardando conferência",
    idempotencyKey: "order:conversa-demonstracao:media-demo-1",
  }]);
});

test("falha ao gravar pedido não confirma pagamento e preserva estado para retry", async () => {
  const stateRepository = memoryStateRepository();
  let attempts = 0;
  const runtime = capitaoRuntime({
    stateRepository,
    orderRepository: {
      async createPending() {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("indisponível"), { code: "SYNTHETIC_FAILURE" });
      },
    },
  });
  await runtime.handle({ ...conversationInput, selectionId: "event:evento-demo-sabado" });
  await runtime.handle({ ...conversationInput, type: "document", mediaId: "documento-demo" });
  const failure = await runtime.handle({ ...conversationInput, text: "Pessoa Demonstração" });
  assert.match(failure.text, /Não consegui registrar/i);
  assert.match(failure.text, /Nenhum pagamento foi confirmado/i);
  assert.equal(stateRepository.inspect(loadCapitaoMorTenantConfig().empresaId, conversationInput.conversationId).step, "awaiting_name");

  const retry = await runtime.handle({ ...conversationInput, text: "Pessoa Demonstração" });
  assert.match(retry.text, /Aguardando conferência/);
  assert.equal(attempts, 2);
  assert.equal(stateRepository.inspect(loadCapitaoMorTenantConfig().empresaId, conversationInput.conversationId), null);
});

test("pagamento é determinístico, atendimento humano pausa e assunto externo é recusado", async () => {
  let aiCalls = 0;
  const handoffs = [];
  const runtime = capitaoRuntime({
    aiHandler: async () => {
      aiCalls += 1;
      return { reply: { text: "resposta isolada da IA", buttons: [] } };
    },
    handoffRepository: { async request(input) { handoffs.push(structuredClone(input)); } },
  });
  const payment = await runtime.handle({ ...conversationInput, text: "qual é o pix?" });
  assert.match(payment.text, /pix-demo@exemplo\.invalid/u);
  assert.equal(aiCalls, 0);

  const freeform = await capitaoRuntime().handle({ ...conversationInput, text: "qual a capital da França?" });
  assert.match(freeform.text, /apenas com informações validadas do Bar Capitão Mor/i);

  const human = await runtime.handle({ ...conversationInput, text: "falar com atendente" });
  assert.match(human.text, /automação foi pausada/i);
  assert.equal(handoffs.length, 1);
  const paused = await runtime.handle({ ...conversationInput, selectionId: "cardapio" });
  assert.equal(paused.code, "AUTOMATION_PAUSED");
});

test("segunda empresa usa a mesma factory apenas com outra configuração", async () => {
  const secondDefinition = {
    runtime: {
      empresaId: "empresa-loja-configurada",
      identity: { name: "Loja Configurada" },
      enabledModules: ["catalog"],
      menu: {
        text: "Produtos da loja:",
        options: [{ id: "produtos", label: "Produtos", module: "catalog", action: "catalog.list" }],
      },
      catalog: { items: [{ id: "caderno-demo", name: "Caderno configurado", price: 18 }] },
      events: { items: [] },
      appointments: { services: [] },
    },
    routing: { greetings: ["oi"], aliases: [{ terms: ["produtos"], action: "catalog.list" }] },
  };
  const first = capitaoRuntime();
  const second = createConfiguredTenantRuntime({
    definition: secondDefinition,
    stateRepository: memoryStateRepository(),
    logger: { error() {} },
  });
  const firstReply = await first.handle({ ...conversationInput, text: "cardápio" });
  const secondReply = await second.handle({ ...conversationInput, text: "produtos" });
  assert.match(firstReply.text, /capitao-mor\/cardapio/u);
  assert.doesNotMatch(firstReply.text, /Caderno configurado/u);
  assert.match(secondReply.text, /Caderno configurado/u);
  assert.doesNotMatch(secondReply.text, /Capitão Mor/u);
  assert.equal(second.config.empresaId, "empresa-loja-configurada");
});

test("seed complementar é idempotente, tipado e contém apenas placeholders sintéticos", async () => {
  const seed = await readFile(new URL("../db/seeds/002_capitao_mor_demo.sql", import.meta.url), "utf8");
  for (const table of ["produtos_servicos", "eventos", "eventos_produtos", "formas_pagamento", "integracoes"]) {
    assert.match(seed, new RegExp(`INSERT INTO ${table}\\b`, "u"));
  }
  assert.match(seed, /ON CONFLICT/gu);
  assert.match(seed, /example\.invalid|exemplo\.invalid/u);
  assert.match(seed, /sint[eé]tic/iu);
  assert.doesNotMatch(seed, /Antonio Monteiro|goomer\.app|5512\d{8,}|BEGIN (?:RSA |EC )?PRIVATE KEY|EAA[A-Za-z0-9]+/iu);
});

