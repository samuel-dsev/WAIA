import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

export const RECEIPT_MIME_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

function requiredSegment(value, field) {
  const segment = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(segment)) throw new TypeError(`${field} inválido.`);
  return segment;
}

function checksum(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export class PrivateMediaStore {
  constructor({ root, maxBytes = 10 * 1024 * 1024, allowedMimeTypes = RECEIPT_MIME_TYPES } = {}) {
    if (!path.isAbsolute(String(root || ""))) throw new TypeError("MEDIA_STORAGE_ROOT deve ser absoluto.");
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes deve ser inteiro positivo.");
    this.root = path.resolve(root);
    this.maxBytes = maxBytes;
    this.allowedMimeTypes = new Set(allowedMimeTypes);
  }

  #location(empresaId, storageKey) {
    const tenant = requiredSegment(empresaId, "empresaId");
    const parts = String(storageKey || "").split("/");
    if (parts.length !== 2 || parts[0] !== tenant) throw new TypeError("storageKey incompatível com o tenant.");
    const object = requiredSegment(parts[1], "storageKey");
    const location = path.resolve(this.root, tenant, object);
    const tenantRoot = `${path.resolve(this.root, tenant)}${path.sep}`;
    if (!location.startsWith(tenantRoot)) throw new TypeError("storageKey inválida.");
    return location;
  }

  async put({ empresaId, messageId, data, mimeType }) {
    const tenant = requiredSegment(empresaId, "empresaId");
    const object = requiredSegment(messageId, "messageId");
    if (!Buffer.isBuffer(data)) throw new TypeError("data deve ser Buffer.");
    if (data.length < 1 || data.length > this.maxBytes) {
      const error = new Error("Mídia fora do limite permitido.");
      error.code = "MEDIA_SIZE_INVALID";
      error.retryable = false;
      throw error;
    }
    if (!this.allowedMimeTypes.has(mimeType)) {
      const error = new Error("Tipo de mídia não permitido.");
      error.code = "MEDIA_MIME_NOT_ALLOWED";
      error.retryable = false;
      throw error;
    }
    const storageKey = `${tenant}/${object}`;
    const location = this.#location(tenant, storageKey);
    const digest = checksum(data);
    await mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
    const temporary = `${location}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      handle = null;
      await link(temporary, location);
      await rm(temporary, { force: true });
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      const existing = await readFile(location);
      if (checksum(existing) !== digest) {
        const conflict = new Error("Conflito no armazenamento da mídia.");
        conflict.code = "MEDIA_STORAGE_CONFLICT";
        conflict.retryable = false;
        throw conflict;
      }
    }
    return Object.freeze({ storageKey, mimeType, sizeBytes: data.length, sha256: digest });
  }

  async read({ empresaId, storageKey, expectedSha256 }) {
    const data = await readFile(this.#location(empresaId, storageKey));
    if (data.length < 1 || data.length > this.maxBytes) throw new Error("Mídia armazenada fora do limite permitido.");
    const digest = checksum(data);
    if (expectedSha256 && digest !== expectedSha256) {
      const error = new Error("Integridade da mídia inválida.");
      error.code = "MEDIA_INTEGRITY_FAILED";
      throw error;
    }
    return data;
  }

  async delete({ empresaId, storageKey }) {
    await rm(this.#location(empresaId, storageKey), { force: true });
  }
}
