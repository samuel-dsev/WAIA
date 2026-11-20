import test from "node:test";
import assert from "node:assert/strict";
import { ambiguousChoiceReply, acceptsAllChoices, lastChoiceQuestion, lastPendingQuestion, parseChoiceClarification, contextualContingencyReply, CONTEXTUAL_CONTINGENCY } from "../src/modules/ai/choice-clarification.js";
import { hasWebsiteFinancingConsent, hasWebsitePhotoConsent, pendingWebsiteFinancingSession } from "../src/modules/business/website-catalog-interaction.js";

const offer = "O Jeep custa R$ 139.900,00.\n\nGostaria que eu enviasse algumas fotos dele? Ou deseja simular um financiamento para esse modelo?";
const history = [{ role: "assistant", content: offer }];
const question = "Gostaria que eu enviasse algumas fotos dele? Ou deseja simular um financiamento para esse modelo?";

test("aceite vago preserva as alternativas reais, sem depender de cenário comercial", () => {
  for (const message of ["Sim", "pode sim", "Sim, por favor", "Entendi\nPode ser", "👍", "não sei", "quero"]) {
    assert.equal(ambiguousChoiceReply(message, history), question, message);
  }
  for (const content of ["Prefere avaliar por fotos ou visitar a loja?", "Quer falar sobre garantia ou agendar uma visita?",
    "Qual destas cores prefere: azul, preto?", "Qual você quer: café, chá ou suco?"]) {
    assert.equal(ambiguousChoiceReply("sim", [{ role: "assistant", content }]), content);
  }
  assert.equal(lastChoiceQuestion([{ role: "user", content: offer }]), null);
  assert.equal(lastChoiceQuestion([{ role: "assistant", content: "O carro custa R$ 139.900,00.\n\nQuer fotos dele?\n\nOu prefere uma simulação?" }]), "Quer fotos dele? Ou prefere uma simulação?");
  assert.equal(ambiguousChoiceReply("sim", [...history, { role: "assistant", content: CONTEXTUAL_CONTINGENCY }]), question);
  assert.equal(ambiguousChoiceReply("sim", [{ role: "assistant", content: question + " Por favor, me informe a sua opção." }]), question);
  assert.equal(lastChoiceQuestion([...history, { role: "assistant", content: "Como posso te chamar?" }]), null);
});

test("contingência não vira pergunta pendente nem acumula as confirmações legadas", () => {
  const proposal = "Se desejar, posso ajudar com a simulação de financiamento para algum deles. Gostaria?";
  const entries = [{ role: "assistant", content: proposal },
    { role: "user", content: "É possível financiar valor inteiro" },
    { role: "assistant", content: "Pode confirmar sua resposta para eu continuar?\n\nGostaria?" },
    { role: "user", content: "Poderia fazer branco" },
    { role: "assistant", content: "Pode confirmar sua resposta para eu continuar?\n\nPode confirmar sua resposta para eu continuar? Gostaria?" }];
  assert.equal(lastPendingQuestion(entries), proposal);
  assert.deepEqual(contextualContingencyReply(entries), { text: "", code: "AI_CONTINGENCY_ALREADY_SENT" });
  assert.equal(lastPendingQuestion([...entries, { role: "assistant", content: CONTEXTUAL_CONTINGENCY }]), proposal);
  assert.equal(lastPendingQuestion([{ role: "assistant", content: "Pode confirmar sua resposta para eu continuar?\n\nInforme seu nome?" }]), "Informe seu nome?");
});

test("contingência usa apenas o histórico entregue da empresa e volta a ser elegível após resposta útil", () => {
  assert.deepEqual(contextualContingencyReply([]), { text: CONTEXTUAL_CONTINGENCY });
  const entries = [{ role: "assistant", content: CONTEXTUAL_CONTINGENCY }, { role: "user", content: "asdfg" }];
  assert.equal(contextualContingencyReply(entries).code, "AI_CONTINGENCY_ALREADY_SENT");
  assert.deepEqual(contextualContingencyReply([{ role: "user", content: CONTEXTUAL_CONTINGENCY }]), { text: CONTEXTUAL_CONTINGENCY });
  assert.deepEqual(contextualContingencyReply([...entries, { role: "assistant", content: "Financiamento sujeito à análise do banco." }]), { text: CONTEXTUAL_CONTINGENCY });
  assert.equal(lastPendingQuestion([...entries, { role: "assistant", content: "Financiamento sujeito à análise do banco." }]), null);
});

test("escolha explícita, ambas, recusa, nova pergunta e mensagens complementares não repetem escolha", () => {
  for (const message of ["Fotos", "Simulação", "as duas", "Quero as duas", "a primeira", "Não", "Nenhuma",
    "Qual o endereço?", "Meu nome é Samuel", "sim\nquero fotos", "prefiro simulação"]) {
    assert.equal(ambiguousChoiceReply(message, history), null, message);
  }
  for (const message of ["as duas", "Quero ambas", "os dois", "Sim, quero as duas"]) assert.equal(acceptsAllChoices(message, history), true);
  for (const message of ["sim", "não quero ambas", "sim, mas só as fotos"]) assert.equal(acceptsAllChoices(message, history), false);
  assert.equal(ambiguousChoiceReply("sim", [{ role: "assistant", content: "Posso enviar fotos?" }]), null);
  assert.equal(ambiguousChoiceReply("sim", [{ role: "assistant", content: "Quer fotos e simulação?" }]), null);
});

test("aceite ambíguo não autoriza fotos ou financiamento; escolha e ambas são resolvidas pelo contexto", () => {
  for (const message of ["sim", "pode ser", "entendi"]) {
    assert.equal(hasWebsitePhotoConsent(message, history), false);
    assert.equal(hasWebsiteFinancingConsent({}, message, "turim:1", history), false);
  }
  assert.equal(hasWebsitePhotoConsent("as duas", history), true);
  assert.equal(hasWebsiteFinancingConsent({}, "as duas", "turim:1", history), true);
  assert.equal(hasWebsitePhotoConsent("Fotos", history), true);
  assert.equal(hasWebsiteFinancingConsent({}, "Fotos", "turim:1", history), false);
  assert.equal(hasWebsiteFinancingConsent({}, "Simulação", "turim:1", history), true);
  assert.equal(hasWebsitePhotoConsent("Simulação", history), false);
  assert.deepEqual(pendingWebsiteFinancingSession([{ step: "finance_accepted", productIds: ["turim:1"] }]).productIds, ["turim:1"]);
});

test("esclarecimento rejeita efeitos extras, JSON inválido ou texto sem pergunta", () => {
  for (const value of [{ text: "Obrigado." }, { text: "Qual opção?", catalogAction: "finance" }, null]) {
    assert.throws(() => parseChoiceClarification(JSON.stringify(value)));
  }
  assert.deepEqual(parseChoiceClarification(JSON.stringify({ text: "Fotos, simulação ou as duas?" })), { text: "Fotos, simulação ou as duas?" });
});

test("pergunta de coleta continua pendente quando escrita como frase sem interrogação", () => {
  const history = [{ role: "assistant", content: "Recebi as fotos. Para continuar, só preciso saber como posso te chamar, por favor." }];
  assert.equal(lastChoiceQuestion(history), null);
  assert.equal(ambiguousChoiceReply("Caio, desculpe não me apresentei.", history), null);
});
