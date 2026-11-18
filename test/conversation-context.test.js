import test from "node:test";
import assert from "node:assert/strict";
import { loadConversationContext } from "../src/modules/ai/conversation-context.js";
import { requireAiRequest } from "../src/modules/ai/contracts.js";

test("contexto pagina desde o início, conserva ordem, resolve citação e exclui rascunhos, expiração e mensagens futuras", async () => {
  const rows = Array.from({ length: 340 }, (_, index) => ({ id: `m${index + 1}`, sequence: index + 1,
    type: "text", direction: index % 2 ? "outbound" : "inbound", body: `Mensagem ${index + 1}`,
    status: index % 2 ? "sent" : "received", externalMessageId: `external${index + 1}` }));
  rows[1].status = "processing";
  rows[3].status = "duplicate_ignored";
  rows[5].redactedAt = new Date();
  rows[7].expiresAt = new Date("2020-01-01");
  rows[336].replyToExternalMessageId = "external1";
  const reads = [];
  const service = { async getHistory(input) {
    reads.push(input);
    assert.equal(input.empresaId, "tenant-a"); assert.equal(input.conversationId, "chat-a");
    return rows.filter((item) => !input.beforeSequence || item.sequence < input.beforeSequence).slice(-input.limit);
  } };
  const request = requireAiRequest({ empresaId: "tenant-a", conversationId: "chat-a", correlationId: "c",
    messageId: "m339", message: "Esses aqui", turnMessages: [{ id: "m337", text: "Esses" }, { id: "m339", text: "Esses aqui" }] });
  const context = await loadConversationContext(service, request, new Date());
  assert.equal(reads.length, 4);
  assert.equal(context.input[0].content, "Mensagem 1");
  assert.equal(context.input.at(-1).content, "Mensagem 338");
  assert.ok(!context.input.some((item) => [2, 4, 6, 8, 337, 339, 340].some((n) => item.content === `Mensagem ${n}`)));
  assert.deepEqual(context.current, [{ role: "user", content: "Esses\n[Em resposta à mensagem: Mensagem 1]" }, { role: "user", content: "Esses aqui" }]);
});

test("turno comporta muitas mensagens sem reduzir seu número nem cortar o contexto em 8000 caracteres", () => {
  const parts = Array.from({ length: 150 }, (_, index) => ({ id: `m${index}`, text: `Parte ${index}: ${"x".repeat(80)}` }));
  const request = requireAiRequest({ empresaId: "tenant-a", conversationId: "chat-a", correlationId: "c", messageId: "m149", turnMessages: parts });
  assert.equal(request.turnMessages.length, 150);
  assert.ok(request.message.length > 8000);
  assert.ok(request.message.endsWith(parts.at(-1).text));
});

test("retomada após 24 horas e novo serviço mantém os modelos e os dados desde a primeira mensagem", async () => {
  const first = new Date("2026-11-17T01:01:00Z");
  const now = new Date(first.getTime() + 24 * 60 * 60 * 1000);
  const rows = [
    { id: "models", sequence: 1, type: "text", direction: "outbound", status: "sent",
      body: "Quer saber mais sobre ECOSPORT FREESTYLE ou KA SE PLUS 1.5?", createdAt: first },
    { id: "data", sequence: 2, type: "text", direction: "inbound", body: "Meu nome é Ana Teste. Entrada de 10 mil.", createdAt: first },
    { id: "return", sequence: 3, type: "text", direction: "inbound", body: "Quero fazer a simulação dos dois", createdAt: now },
  ];
  const request = requireAiRequest({ empresaId: "tenant-a", conversationId: "chat-a", correlationId: "c",
    messageId: "return", message: rows[2].body });
  for (const at of [new Date(first.getTime() + 6 * 60 * 1000), now, new Date(now.getTime() + 60 * 1000)]) {
    const service = { async getHistory() { return structuredClone(rows); } };
    const context = await loadConversationContext(service, request, at);
    assert.deepEqual(context.input.map((item) => item.content), rows.slice(0, 2).map((item) => item.body));
    assert.ok(context.evidence.includes(rows[1].body));
  }
});
