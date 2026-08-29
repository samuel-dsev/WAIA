import test from "node:test";
import assert from "node:assert/strict";
import { BarAiAssistant } from "../src/ai-assistant.js";

test("envia somente contexto validado e regras de escopo à Responses API", async () => {
  let request;
  const client = { responses: { create: async (input) => { request = input; return { output_text: "O endereço está disponível." }; } } };
  const assistant = new BarAiAssistant({ client, model: "modelo-teste" });
  const snapshot = { events: [{ id: "sexta", date: "2026-08-28", weekday: "Sexta", time: "22:00", attractions: "Banda Teste", price: 30, vipRule: "", notes: "" }], settings: { endereco: "Rua Teste, 1" } };
  const answer = await assistant.reply({ phone: "1", message: "Qual o endereço?", snapshot });
  assert.equal(answer, "O endereço está disponível.");
  assert.equal(request.model, "modelo-teste");
  assert.equal(request.store, false);
  assert.match(request.instructions, /somente a assuntos relacionados ao Bar Capitão Mor/i);
  assert.match(request.input[0].content, /Rua Teste, 1/);
  assert.match(request.input.at(-1).content, /Qual o endereço/);
});

test("sem chave retorna contingência restrita ao bar", async () => {
  const assistant = new BarAiAssistant();
  const answer = await assistant.reply({ phone: "1", message: "oi", snapshot: null });
  assert.match(answer, /temporariamente indisponível/i);
  assert.match(answer, /Capitão Mor/i);
});

test("não envia dados de pagamento presentes nas configurações à OpenAI", async () => {
  let request;
  const client = { responses: { create: async (input) => { request = input; return { output_text: "Resposta pública." }; } } };
  const assistant = new BarAiAssistant({ client });
  await assistant.reply({ phone: "1", message: "oi", snapshot: { events: [], settings: { endereco: "Rua Pública", chave_pix: "pix-secreto", favorecida_pix: "Pessoa" } } });
  const context = request.input[0].content;
  assert.match(context, /Rua Pública/);
  assert.doesNotMatch(context, /pix-secreto|favorecida_pix|chave_pix/);
});
