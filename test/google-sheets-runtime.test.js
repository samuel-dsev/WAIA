import test from "node:test";
import assert from "node:assert/strict";
import { legacyCapitaoMorOrderRow, mapCapitaoMorSnapshot } from "../src/integrations/google-sheets/postgres-adapters.js";
import { createGoogleSheetsSyncRunner } from "../src/integrations/google-sheets/sync-runner.js";
import { normalizeJobReference } from "../src/modules/jobs/job-reference.js";

test("snapshot do Capitão Mor preserva ranges legados, filtra agenda e não importa PIX", () => {
  const snapshot = mapCapitaoMorSnapshot({
    agenda: [
      ["antigo", "2026-08-20", "Quinta", "20:00", "Evento antigo", "10", "", "", "Ativo"],
      ["inativo", "2026-09-05", "Sábado", "20:00", "Evento inativo", "10", "", "", "Inativo"],
      ["sabado", "2026-09-05", "Sábado", "20:00", "Banda A | DJ B", "R$ 35,00", "VIP até 23h", "Portas 19h", "Ativo"],
    ],
    settings: [["endereco", "Rua Teste, 1"], ["link_cardapio", "https://example.test/menu"], ["chave_pix", "segredo-que-nao-deve-virar-configuracao"]],
  }, { now: new Date("2026-08-30T12:00:00-03:00") });
  assert.deepEqual(snapshot.events.map((event) => event.id), ["sabado"]);
  assert.equal(snapshot.events[0].price, 35);
  assert.equal(snapshot.settings.endereco, "Rua Teste, 1");
  assert.equal(Object.hasOwn(snapshot.settings, "chave_pix"), false);
  assert.equal(Object.hasOwn(snapshot.events[0], "pix"), false);
});

test("linha de pedido mantém o contrato A:G anterior", () => {
  const row = legacyCapitaoMorOrderRow({
    createdAt: "2026-08-30T15:00:00.000Z", customerPhone: "5511999999999",
    eventName: "Banda A", customerName: "Maria", receiptId: "media-1",
  });
  assert.deepEqual(row, ["2026-08-30T15:00:00.000Z", "5511999999999", "Banda A", "Maria", "media-1", "Aguardando conferência", ""]);
});

test("runner isola falha de sincronização por empresa", async () => {
  const runner = createGoogleSheetsSyncRunner({
    configurationResolver: { async listEnabledTenants() { return [{ empresaId: "a" }, { empresaId: "b" }]; } },
    integration: { async syncTenant({ empresaId }) { if (empresaId === "a") throw new Error("fora"); return { health: "healthy" }; } },
    logger: { error() {} },
  });
  assert.deepEqual(await runner.runOnce(), [
    { empresaId: "a", health: "unavailable" },
    { empresaId: "b", health: "healthy" },
  ]);
});

test("job de exportação carrega somente referências", () => {
  const reference = normalizeJobReference({
    jobId: "job-1", empresaId: "tenant-1", conversationId: "conversation-1", orderId: "order-1",
    type: "export_google_sheets_order", correlationId: "correlation-1", payloadVersion: 1,
  });
  assert.equal(reference.orderId, "order-1");
  assert.throws(() => normalizeJobReference({ ...reference, customerName: "Maria" }), /somente IDs/u);
});
