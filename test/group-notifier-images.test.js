import test from "node:test";
import assert from "node:assert/strict";
import { createGroupNotifierWorker } from "../src/modules/group-notifier/worker.js";

function fixture(images = 2) {
  let status = "pending", allowed = true, failImage = false, deferred = 0;
  const parts = [{ id: "summary", kind: "summary", status: "pending" }, ...Array.from({ length: images }, (_, i) => ({
    id: "image-" + i, kind: "image", storage_key: "tenant/image-" + i, sha256: "a".repeat(64), mime_type: "image/png", status: "pending",
  }))];
  const sent = [], reads = [], logs = [];
  const repository = {
    async lease() { return { epoch: 1, desired: true, phone: "+5511000000001" }; }, async publish() {}, async release() {},
    authStore() { return {}; }, async cacheGroups() {},
    async recover() { if (status === "sending") status = parts.some((part) => ["sending", "unconfirmed"].includes(part.status)) ? "unconfirmed" : "pending"; },
    async candidate() { return status === "pending" ? { id: "delivery", group_id: "123@g.us", multipart: true } : null; },
    async deferCandidate() { deferred++; },
    async beginSend() { status = "sending"; return { multipart: true, empresa_id: "tenant", group_id: "123@g.us", company_name: "Loja sintética",
      name: "Ana", summary: "Enviou fotos para avaliação.", qualification: "Aguarda avaliação.", phone: "5511000000002" }; },
    async beginPart() { const part = parts.find((part) => part.status === "pending"); if (part) part.status = "sending"; return part; },
    async canSendPart() { return allowed; },
    async completePart(_owner, _epoch, _delivery, id, result) { const part = parts.find((part) => part.id === id); part.status = result.messageId ? "accepted" : "unconfirmed"; },
    async complete() { status = parts.some((part) => part.status === "unconfirmed") ? "unconfirmed" : parts.some((part) => part.status === "pending") ? "pending" : "accepted"; },
  };
  const mediaStore = { async read(input) { reads.push(input); return Buffer.from(input.storageKey); } };
  const session = { snapshot: () => ({ phase: "connected" }), async connect() {}, close() {}, async flushAuth() {},
    async listGroups() { return []; }, async groupMetadata(id) { assert.equal(id, "123@g.us"); },
    async sendText(group, text) { sent.push({ group, text }); return { messageId: "text" }; },
    async sendImage(group, image) { sent.push({ group, ...image }); if (failImage) throw new Error("private provider uncertainty"); return { messageId: "image." + sent.length }; },
  };
  const create = (store = mediaStore) => createGroupNotifierWorker({ repository, mediaStore: store, sessionFactory: () => session,
    logger: { warn(event, value) { logs.push({ event, ...value }); } } });
  return { repository, session, mediaStore, parts, sent, reads, logs, create,
    state: () => ({ status, deferred }), deny() { allowed = false; }, fail() { failImage = true; } };
}

test("resumo e imagens seguem na ordem, com bytes privados e identificação do lead", async () => {
  const f = fixture(), worker = f.create(); await worker.tick();
  assert.equal(f.state().status, "accepted"); assert.equal(f.sent.length, 3);
  assert.match(f.sent[0].text, /Nome: Ana/u); assert.deepEqual(f.sent[1].data, Buffer.from("tenant/image-0"));
  assert.match(f.sent[2].caption, /Ana/u);
  assert.deepEqual(f.reads[0], { empresaId: "tenant", storageKey: "tenant/image-0", expectedSha256: "a".repeat(64) });
  await worker.tick(); assert.equal(f.sent.length, 3); await worker.close();
});

test("resultado incerto após upload interrompe as próximas imagens e não repete após restart", async () => {
  const f = fixture(); f.fail(); const first = f.create(); await first.tick();
  assert.equal(f.sent.length, 2); assert.equal(f.state().status, "unconfirmed");
  assert.deepEqual(f.parts.map((part) => part.status), ["accepted", "unconfirmed", "pending"]);
  await first.close(); const second = f.create(); await second.tick(); assert.equal(f.sent.length, 2); await second.close();
  assert.doesNotMatch(JSON.stringify(f.logs), /private|provider uncertainty|Ana|tenant\/image/u);
});

test("política revogada depois da leitura impede a imagem e falta de armazenamento adia sem iniciar envio", async () => {
  const f = fixture(); const worker = f.create({ async read(input) { const data = await f.mediaStore.read(input); f.deny(); return data; } });
  await worker.tick(); assert.equal(f.sent.length, 1); assert.equal(f.state().status, "unconfirmed"); await worker.close();
  const unavailable = fixture(); const paused = unavailable.create(null); await paused.tick();
  assert.equal(unavailable.state().status, "pending"); assert.equal(unavailable.state().deferred, 1); assert.equal(unavailable.sent.length, 0); await paused.close();
});

test("lote grande retoma as partes pendentes sem repetir resumo nem imagens aceitas", async () => {
  const f = fixture(25), first = f.create(); await first.tick();
  assert.equal(f.sent.length, 20); assert.equal(f.state().status, "pending");
  await first.close(); const second = f.create(); await second.tick();
  assert.equal(f.sent.length, 26); assert.equal(f.state().status, "accepted");
  assert.equal(f.sent.filter((part) => part.text).length, 1);
  assert.equal(new Set(f.sent.filter((part) => part.data).map((part) => part.data.toString())).size, 25); await second.close();
});
