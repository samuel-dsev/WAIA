import test from "node:test";
import assert from "node:assert/strict";
import { parseQualification, asksOnlyForCustomerName, notificationText } from "../src/modules/group-notifier/qualification.js";
import { MemoryAiConfigResolver, MemoryAiLedger, MemoryAiSecretResolver, MemoryPricingCatalog,
  MemoryResponsesClientFactory, MultiTenantAiService } from "../src/modules/ai/index.js";

const card = { status: "awaiting_name", name: null, summary: "Solicita orçamento para pintura de dois cômodos em Taubaté.",
  qualification: "Serviço e região atendidos; dados obrigatórios completos, exceto nome." };

test("nome pendente tem ficha completa própria e não qualifica imediatamente", () => {
  assert.equal(parseQualification(card, { configVersion: 1 }), null);
  assert.equal(parseQualification(card, { configVersion: 1, allowMissingName: true }).name, null);
  for (const patch of [{ name: "Cliente" }, { summary: null }, { qualification: "" }]) {
    assert.throws(() => parseQualification({ ...card, ...patch }, { configVersion: 1, allowMissingName: true }));
  }
  assert.equal(parseQualification({ ...card, status: "collecting" }, { configVersion: 1, allowMissingName: true }), null);
});

test("espera exige uma solicitação final de identidade, sem outra coleta ou promessa", () => {
  for (const question of ["Qual é o seu nome?", "Como posso te chamar?", "Pode informar seu nome completo.", "Como você prefere ser chamado?", "Com quem eu falo?", "Poderia me passar o nome?"]) assert.equal(asksOnlyForCustomerName(question), true, question);
  for (const question of ["Qual nome do veículo?", "Qual seu nome e CPF?", "Qual é o seu nome? De qual cidade fala?", "Vou encaminhar ao grupo. Qual seu nome?", "Qual é sua cidade?"]) assert.equal(asksOnlyForCustomerName(question), false, question);
});

test("qualquer empresa prepara a ficha sem nome apenas por estado explícito da triagem", async () => {
  for (const empresaId of ["pintura", "imobiliaria"]) {
    let output = { text: "Para finalizar, qual é o seu nome?", leadQualification: card };
    const service = new MultiTenantAiService({
      configResolver: new MemoryAiConfigResolver([{ empresaId, enabled: true, provider: "openai", model: "test", keyType: "shared",
        version: 1, prompt: "Qualifique conforme o serviço e a região.", leadQualificationEnabled: true,
        leadQualificationCriteria: "Nome, serviço e cidade atendidos." }]),
      conversationService: { async getHistory() { return []; } },
      clientFactory: new MemoryResponsesClientFactory(async () => ({ output_text: JSON.stringify(output), usage: { input_tokens: 10, output_tokens: 20 } })),
      secretResolver: new MemoryAiSecretResolver({ sharedSecret: "synthetic" }), ledger: new MemoryAiLedger(),
      pricingCatalog: new MemoryPricingCatalog({ test: { inputPerMillion: 1, outputPerMillion: 1, version: "test" } }), logger: { warn() {}, info() {} },
    });
    const input = { empresaId, conversationId: "chat", messageId: "message", correlationId: "synthetic", message: "Preciso de pintura de dois cômodos em Taubaté." };
    const reply = await service.reply(input);
    assert.equal(reply.source, "ai"); assert.equal(reply.pendingNameQualification.name, null); assert.equal(reply.leadQualification, undefined);
    for (const value of [{ ...card, status: "collecting", summary: null, qualification: null }, { ...card, status: "not_qualified" }]) {
      output = { ...output, leadQualification: value };
      assert.equal((await service.reply({ ...input, messageId: value.status })).pendingNameQualification, undefined);
    }
  }
});

test("ficha de grupo identifica a ausência do nome sem null nem baixa qualificação por silêncio", () => {
  const text = notificationText({ companyName: "Empresa fictícia", ...card, phone: "5511000000001", followUpRecovered: true });
  assert.match(text, /NOME NÃO INFORMADO/u); assert.ok(text.includes(card.summary)); assert.ok(text.includes(card.qualification));
  assert.match(text, /WhatsApp: \+5511000000001/u); assert.doesNotMatch(text, /Nome: null|BAIXA QUALIFICAÇÃO/u);
});
