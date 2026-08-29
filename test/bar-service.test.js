import test from "node:test";
import assert from "node:assert/strict";
import { createBarService, initialBarMenu } from "../src/bar-service.js";

const snapshot = {
  events: [
    { id: "evento_sexta", date: "2026-08-21", weekday: "Sexta-feira", time: "22:00", attractions: "Intimidade SA | Guilherme & Helluan | DJ Alejandro Gutierrez", price: 25, vipRule: "Mulher VIP chegando até 23:30.", notes: "" },
    { id: "evento_sabado", date: "2026-08-22", weekday: "Sábado", time: "20:00", attractions: "PJ Noventa — Pearl Jam | RockWay — Clássicos | DJ Alejandro Gutierrez", price: 35, vipRule: "", notes: "" },
  ],
  settings: {
    chave_pix: "29059551800", favorecida_pix: "Karina Begliomini Maturo", endereco: "Rua Cel. Antonio Monteiro Patto, 152 — Centro — Tremembé/SP",
    regra_aniversariante: "Aniversariante do mês entra VIP, sem acompanhante, chegando até 00h.", telefone_atendimento: "5512981580777",
    link_cardapio: "https://capito-mor.goomer.app/menu", link_mapa: "https://maps.google.com/test", instagram: "https://instagram.com/barcapitaomor",
  },
};

function serviceWithData(overrides = {}) {
  return createBarService({ dataSource: { getSnapshot: () => snapshot, recordOrder: async () => {}, ...overrides } });
}

test("menu inicial oferece compra, endereço e cardápio nessa ordem", () => {
  const reply = initialBarMenu();
  assert.match(reply.text, /Capitão Mor/);
  assert.deepEqual(reply.buttons.map(({ id }) => id), ["convites", "endereco", "cardapio"]);
});

test("saudação inicial sempre apresenta o menu rápido", async () => {
  let aiCalled = false;
  const aiAssistant = { reply: async () => { aiCalled = true; return "IA"; } };
  const service = createBarService({ dataSource: { getSnapshot: () => snapshot, recordOrder: async () => {} }, aiAssistant });
  const reply = await service.reply({ phone: "1", message: "Olá!" });
  assert.match(reply.text, /Bem-vindo ao Bar Capitão Mor/);
  assert.deepEqual(reply.buttons.map(({ id }) => id), ["convites", "endereco", "cardapio"]);
  assert.equal(aiCalled, false);
});

test("agenda escrita mostra o fim de semana completo sem escolher um dia", async () => {
  const service = serviceWithData();
  const agenda = await service.reply({ message: "agenda" });
  assert.match(agenda.text, /Intimidade SA/);
  assert.match(agenda.text, /PJ Noventa/);
  assert.deepEqual(agenda.buttons.map(({ id }) => id), ["convites", "menu"]);
});

test("comprar convites oferece os eventos para vincular a compra", async () => {
  const service = serviceWithData();
  assert.deepEqual((await service.reply({ message: "convites" })).buttons.map(({ id }) => id), ["evento_sexta", "evento_sabado", "menu"]);
  assert.match((await service.reply({ message: "cardápio" })).text, /goomer\.app\/menu/);
});

test("compra informa evento, preço e PIX corretos", async () => {
  const service = serviceWithData();
  const friday = await service.reply({ phone: "1", message: "evento_sexta" });
  const saturday = await service.reply({ phone: "2", message: "evento_sabado" });
  assert.match(friday.text, /Intimidade SA/);
  assert.match(friday.text, /R\$\s*25,00/);
  assert.match(friday.text, /Mulher VIP chegando até 23:30/);
  assert.match(saturday.text, /PJ Noventa/);
  assert.match(saturday.text, /R\$\s*35,00/);
  assert.match(saturday.text, /29059551800/);
  assert.match(saturday.text, /Karina Begliomini Maturo/);
});

test("recebe comprovante e solicita nome completo", async () => {
  const service = serviceWithData();
  await service.reply({ phone: "1", message: "evento_sexta" });
  const receipt = await service.reply({ phone: "1", message: "", type: "image" });
  assert.match(receipt.text, /nome completo/i);
  const confirmation = await service.reply({ phone: "1", message: "Maria da Silva" });
  assert.match(confirmation.text, /Maria da Silva/);
  assert.match(confirmation.text, /validação do pagamento não é automática/i);
});

test("atalhos por texto informam endereço e atendimento humano", async () => {
  const service = serviceWithData();
  assert.match((await service.reply({ message: "onde fica?" })).text, /Antonio Monteiro Patto, 152/);
  assert.match((await service.reply({ message: "quero falar com atendente" })).text, /wa\.me\/5512981580777/);
});

test("informa o PIX sem encaminhar dados de pagamento à IA", async () => {
  let aiCalled = false;
  const aiAssistant = { reply: async () => { aiCalled = true; return "não deveria chamar"; } };
  const service = createBarService({ dataSource: { getSnapshot: () => snapshot, recordOrder: async () => {} }, aiAssistant });
  const reply = await service.reply({ message: "qual é o pix para pagamento?" });
  assert.match(reply.text, /29059551800/);
  assert.match(reply.text, /Karina Begliomini Maturo/);
  assert.equal(aiCalled, false);
});

test("registra pedido para conferência humana com o id do comprovante", async () => {
  let recorded;
  const service = serviceWithData({ recordOrder: async (order) => { recorded = order; } });
  await service.reply({ phone: "5512", message: "evento_sexta" });
  await service.reply({ phone: "5512", message: "comprovante", type: "image", mediaId: "media.123" });
  await service.reply({ phone: "5512", message: "Maria da Silva" });
  assert.deepEqual(recorded, { phone: "5512", eventId: "evento_sexta", name: "Maria da Silva", receiptId: "media.123" });
});

test("não confirma o pedido se a gravação na planilha falhar e permite tentar novamente", async () => {
  let attempts = 0;
  const service = serviceWithData({
    recordOrder: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("planilha indisponível");
    },
  });
  await service.reply({ phone: "5512", message: "evento_sexta" });
  await service.reply({ phone: "5512", message: "comprovante", type: "image", mediaId: "media.123" });
  const failure = await service.reply({ phone: "5512", message: "Maria da Silva" });
  assert.match(failure.text, /não consegui registrar/i);
  assert.doesNotMatch(failure.text, /obrigado/i);
  const success = await service.reply({ phone: "5512", message: "Maria da Silva" });
  assert.match(success.text, /obrigado/i);
  assert.equal(attempts, 2);
});

test("responde com segurança antes da primeira sincronização", async () => {
  const service = createBarService();
  assert.match((await service.reply({ message: "agenda" })).text, /sendo atualizada/i);
});

test("encaminha perguntas livres para a IA com o snapshot validado", async () => {
  let received;
  const aiAssistant = { reply: async (input) => { received = input; return "A atração informada está na agenda."; } };
  const service = createBarService({ dataSource: { getSnapshot: () => snapshot, recordOrder: async () => {} }, aiAssistant });
  const reply = await service.reply({ phone: "5512", message: "Vai tocar Pearl Jam?" });
  assert.equal(reply.text, "A atração informada está na agenda.");
  assert.equal(received.phone, "5512");
  assert.equal(received.snapshot, snapshot);
});

test("falha da IA retorna resposta segura e mantém o atendimento", async () => {
  const aiAssistant = { reply: async () => { throw new Error("indisponível"); } };
  const service = createBarService({ dataSource: { getSnapshot: () => snapshot, recordOrder: async () => {} }, aiAssistant, logger: { error() {} } });
  const reply = await service.reply({ message: "pergunta livre" });
  assert.match(reply.text, /agenda.*endereço.*equipe/i);
  assert.equal(reply.buttons.length, 3);
});
