import test from "node:test";
import assert from "node:assert/strict";
import { MemoryBusinessRepository } from "../src/modules/business/repositories.js";

test("repositório em memória mantém idempotência e isolamento por empresa", async () => {
  const repository = new MemoryBusinessRepository();
  const base = { idempotencyKey: "same", eventId: "event", customerName: "Cliente Sintético" };
  await repository.createPending({ ...base, empresaId: "tenant-a" });
  await repository.createPending({ ...base, empresaId: "tenant-a", customerName: "Não substitui" });
  await repository.createPending({ ...base, empresaId: "tenant-b" });
  assert.equal(repository.orders.size, 2);
  assert.equal(repository.orders.get("tenant-a:same").customerName, "Cliente Sintético");
});
