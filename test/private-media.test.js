import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PrivateMediaStore } from "../src/infra/media/private-media-store.js";

test("armazenamento privado isola tenant, valida integridade e é idempotente", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "waia-media-"));
  const store = new PrivateMediaStore({ root, maxBytes: 1024 });
  const data = Buffer.from("comprovante-sintetico");
  try {
    const stored = await store.put({ empresaId: "tenant-a", messageId: "message-1", data, mimeType: "image/jpeg" });
    assert.equal(stored.storageKey, "tenant-a/message-1");
    assert.equal(stored.sizeBytes, data.length);
    assert.match(stored.sha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(await store.read({ empresaId: "tenant-a", storageKey: stored.storageKey, expectedSha256: stored.sha256 }), data);
    assert.deepEqual(await store.put({ empresaId: "tenant-a", messageId: "message-1", data, mimeType: "image/jpeg" }), stored);
    await assert.rejects(
      store.read({ empresaId: "tenant-b", storageKey: stored.storageKey }),
      /tenant/u,
    );
    await assert.rejects(
      store.read({ empresaId: "tenant-a", storageKey: stored.storageKey, expectedSha256: "0".repeat(64) }),
      (error) => error.code === "MEDIA_INTEGRITY_FAILED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("armazenamento privado rejeita MIME e tamanho fora da política", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "waia-media-"));
  const store = new PrivateMediaStore({ root, maxBytes: 8 });
  try {
    await assert.rejects(
      store.put({ empresaId: "tenant-a", messageId: "message-1", data: Buffer.from("texto"), mimeType: "text/plain" }),
      (error) => error.code === "MEDIA_MIME_NOT_ALLOWED" && error.retryable === false,
    );
    await assert.rejects(
      store.put({ empresaId: "tenant-a", messageId: "message-2", data: Buffer.alloc(9), mimeType: "image/png" }),
      (error) => error.code === "MEDIA_SIZE_INVALID" && error.retryable === false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

