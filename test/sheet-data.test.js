import test from "node:test";
import assert from "node:assert/strict";
import { SheetDataService } from "../src/sheet-data.js";

const agenda = [
  ["antigo", "2026-08-20", "Quinta-feira", "20:00", "Evento antigo", "10", "", "", "Ativo"],
  ["inativo", "2026-08-22", "Sábado", "20:00", "Evento inativo", "10", "", "", "Inativo"],
  ["invalido", "data ruim", "Sábado", "20:00", "Evento inválido", "10", "", "", "Ativo"],
  ["evento_sabado", "2026-08-22", "Sábado", "20:00", "Banda A | DJ B", "35", "VIP até 23h", "", "Ativo"],
];
const settings = [["chave_pix", "123"], ["favorecida_pix", "Capitão Mor"], ["endereco", "Rua Teste, 1"]];

function fakeClient() {
  return {
    configured: true,
    async getValues(range) { return range.startsWith("Agenda") ? agenda : settings; },
    async appendValues(range, row) { this.appended = { range, row }; },
  };
}

test("sincroniza apenas eventos futuros, ativos e válidos", async () => {
  const client = fakeClient();
  const service = new SheetDataService({ client, now: () => new Date(2026, 7, 21, 12), logger: { error() {} } });
  const result = await service.sync();
  assert.deepEqual(result.events.map(({ id }) => id), ["evento_sabado"]);
  assert.equal(service.diagnostics().hasValidData, true);
});

test("mantém o último cache válido quando a planilha falha", async () => {
  const client = fakeClient();
  const service = new SheetDataService({ client, now: () => new Date(2026, 7, 21, 12), logger: { error() {} } });
  const cached = await service.sync();
  client.getValues = async () => { throw new Error("indisponível"); };
  await assert.rejects(service.sync(), /indisponível/);
  assert.equal(service.getSnapshot(), cached);
  assert.equal(service.diagnostics().hasValidData, true);
});

test("registra pedido como Aguardando conferência", async () => {
  const client = fakeClient();
  const service = new SheetDataService({ client, now: () => new Date("2026-08-21T15:00:00.000Z") });
  await service.recordOrder({ phone: "5512", eventId: "evento", name: "Maria", receiptId: "media" });
  assert.equal(client.appended.range, "Pedidos!A:G");
  assert.equal(client.appended.row[5], "Aguardando conferência");
});
