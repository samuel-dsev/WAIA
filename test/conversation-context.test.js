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
