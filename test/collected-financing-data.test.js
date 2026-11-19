import test from "node:test";
import assert from "node:assert/strict";
import { preserveCollectedFinancingData, hasCollectedFinancingDocuments } from "../src/modules/group-notifier/collected-financing-data.js";
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
