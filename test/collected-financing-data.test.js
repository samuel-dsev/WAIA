import test from "node:test";
import assert from "node:assert/strict";
import { preserveCollectedFinancingData, hasCollectedFinancingDocuments, collectedFinancingFields } from "../src/modules/group-notifier/collected-financing-data.js";
const collection = (values) => [{ role: "assistant", content: "Por favor, informe seu CPF e data de nascimento." }, ...values.map((content) => ({ role: "user", content }))];

test("ficha mantém relato e acrescenta CPF, nascimento e cidade literalmente informados", () => {
  const card = { name: "Marina", summary: "Simulação do Onix, entrada 10 mil e Gol 2012 na troca. CPF e nascimento fornecidos.", qualification: "Análise pela equipe." };
  const values = ["Sou Marina Teste, de Taubaté", "000.000.000-00", "01/01/1990"];
  const result = preserveCollectedFinancingData(card, values, collection(values));
  assert.ok(result.summary.startsWith(card.summary));
  assert.match(result.summary, /Cidade informada: Taubaté/u);
  assert.match(result.summary, /CPF informado: 000\.000\.000-00/u);
  assert.match(result.summary, /Data de nascimento informada: 01\/01\/1990/u);
  assert.equal(result.qualification, card.qualification);
  assert.equal(preserveCollectedFinancingData(result, values, collection(values)), result);
});

test("documentos reconhecidos pelo conteúdo em qualquer ordem, juntos ou em mensagens distintas", () => {
  for (const values of [
    ["00011122233\n01/01/01\n15 mil"], ["00011122233 01/01/01 15 mil"], ["15 mil 01/01/01 00011122233"],
    ["01/01/01", "15 mil", "00011122233"], ["00011122233", "01/01/01 15 mil"],
    ["15 mil", "00011122233 01/01/01"], ["000 111 222 33 010101 15 mil"],
    ["entrada 15 mil; nascimento: 010101; CPF: 000.111.222-33"],
    ["CPF: 00011122233\nNascimento:\n010101\nEntrada: 15 mil"],
  ]) {
    const transcript = collection(values), fields = collectedFinancingFields(values, transcript);
    assert.equal(fields.cpf, "00011122233", JSON.stringify(values));
    assert.equal(fields.birthDate, "01/01/01", JSON.stringify(values));
    assert.equal(hasCollectedFinancingDocuments(values, transcript), true);
  }
  for (const value of ["00011122233 01012001 15000", "15000 01-01-2001 00011122233", "01.01.2001 00011122233 R$ 15.000,00"]) {
    assert.equal(collectedFinancingFields([value], collection([value])).birthDate, "01/01/2001");
  }
});

test("não confunde telefone ou valor declarado com CPF/data e preserva campos parciais", () => {
  for (const value of ["Meu telefone é 11999999999", "entrada 12345678901", "R$ 12345678901", "10102001 reais"]) {
    const fields = collectedFinancingFields([value], collection([value]));
    assert.equal(fields.cpf, undefined); assert.equal(fields.birthDate, undefined);
  }
  const partial = collectedFinancingFields(["00011122233 15 mil"], collection(["00011122233 15 mil"]));
  assert.equal(partial.cpf, "00011122233"); assert.equal(partial.birthDate, undefined);
  assert.equal(collectedFinancingFields(["00011122233 010101"]).cpf, undefined);
  assert.equal(collectedFinancingFields(["00011122233 010101"]).birthDate, undefined);
  assert.equal(collectedFinancingFields(["00011122233 020202 010101"], collection(["00011122233 020202 010101"])).birthDate, undefined);
});

test("cópia de dados não transforma telefone, anúncio, pergunta ou exemplo em documento/localidade", () => {
  const card = { name: "Ana", summary: "Cliente pediu análise da equipe.", qualification: "Análise humana." };
  assert.equal(preserveCollectedFinancingData(card, ["Meu telefone é 11999999999", "A loja fica em Taubaté", "Sou Ana, de verdade.", "Exemplo: 000.000.000-00 01/01/1990", "Qual é a cidade?"]), card);
  const explicit = preserveCollectedFinancingData(card, ["CPF: 00000000000. Nascimento: 1/1/1990. Moro em São José dos Campos/SP."]);
  assert.match(explicit.summary, /São José dos Campos/u);
  assert.match(explicit.summary, /01\/01\/1990/u);
  const inline = preserveCollectedFinancingData(card, ["00000000000 01/01/1990"], collection(["00000000000 01/01/1990"]));
  assert.match(inline.summary, /000\.000\.000-00/u);
  assert.match(inline.summary, /01\/01\/1990/u);
  assert.equal(preserveCollectedFinancingData(card, ["20/11/2026", "11999999999"], [{ role: "assistant", content: "Qual dia prefere visitar?" }, { role: "user", content: "20/11/2026" }]), card);
});

test("CPF, nascimento e entrada em linhas separadas são preservados somente após a coleta", () => {
  const card = { name: "Ana", summary: "Simulação solicitada, entrada 15 mil real." };
  for (const separator of ["\n", "\r\n"]) {
    const body = ["00000000000", "01/01/0001", "15 mil real"].join(separator);
    const transcript = collection([body]);
    const result = preserveCollectedFinancingData(card, [body], transcript);
    assert.match(result.summary, /CPF informado: 000\.000\.000-00/u);
    assert.match(result.summary, /Data de nascimento informada: 01\/01\/0001/u);
    assert.equal(hasCollectedFinancingDocuments([body], transcript), true);
    assert.equal(preserveCollectedFinancingData(card, [body]), card, "Sem coleta, números soltos não são documentos.");
  }
});
