import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  decryptCredentialSecret,
  encryptCredentialSecret,
  maskSecret,
  SecretIntegrityError,
} from "../src/security/credential-crypto.js";
import { REDACTED, redactSensitive } from "../src/security/redaction.js";
import { VersionedKeyring } from "../src/security/versioned-keyring.js";
import {
  CredentialVaultService,
  InMemoryCredentialRepository,
} from "../src/modules/secrets/credential-vault-service.js";

const binding = Object.freeze({
  empresaId: "tenant-a",
  credentialId: "credential-meta",
  provider: "meta",
  purpose: "whatsapp-access-token",
});

function keyring(activeVersion = "v1", keys = { v1: randomBytes(32) }) {
  return new VersionedKeyring({ activeVersion, keys });
}

function serviceFixture({ ring = keyring() } = {}) {
  const repository = new InMemoryCredentialRepository();
  const auditEvents = [];
  const service = new CredentialVaultService({
    repository,
    keyring: ring,
    auditWriter: async (event) => auditEvents.push(event),
    clock: () => new Date("2026-08-27T12:00:00.000Z"),
    idGenerator: () => "credential-generated",
  });
  return { service, repository, auditEvents };
}

test("AES-256-GCM cifra a credencial e permite decifrar somente com o vínculo correto", () => {
  const ring = keyring();
  const secret = "synthetic-test-token-A1B2";
  const envelope = encryptCredentialSecret({ secret, keyring: ring, binding });

  assert.equal(envelope.algorithm, "aes-256-gcm");
  assert.equal(Buffer.from(envelope.iv, "base64url").length, 12);
  assert.equal(Buffer.from(envelope.authTag, "base64url").length, 16);
  assert.doesNotMatch(JSON.stringify(envelope), new RegExp(secret));
  assert.equal(decryptCredentialSecret({ envelope, keyring: ring, binding }), secret);
});

test("AAD impede reutilizar ciphertext em outra empresa, credencial, provedor ou finalidade", () => {
  const ring = keyring();
  const envelope = encryptCredentialSecret({ secret: "synthetic-bound-secret", keyring: ring, binding });

  for (const changed of [
    { ...binding, empresaId: "tenant-b" },
    { ...binding, credentialId: "other-credential" },
    { ...binding, provider: "openai" },
    { ...binding, purpose: "different-purpose" },
  ]) {
    assert.throws(
      () => decryptCredentialSecret({ envelope, keyring: ring, binding: changed }),
      (error) => error instanceof SecretIntegrityError && error.code === "SECRET_INTEGRITY_ERROR",
    );
  }
});

test("chave mestra incorreta não decifra a credencial", () => {
  const original = keyring();
  const wrong = keyring();
  const envelope = encryptCredentialSecret({ secret: "synthetic-key-bound-secret", keyring: original, binding });
  assert.throws(
    () => decryptCredentialSecret({ envelope, keyring: wrong, binding }),
    (error) => error.code === "SECRET_INTEGRITY_ERROR",
  );
});

test("mascaramento revela no máximo o sufixo configurado", () => {
  assert.equal(maskSecret("synthetic-token-9876"), "••••9876");
  assert.equal(maskSecret("abc"), "••••");
  assert.equal(maskSecret("synthetic-token-9876", { visibleSuffix: 2 }), "••••76");
});

test("serviço persiste somente envelope e API retorna apenas metadados mascarados", async () => {
  const { service, repository, auditEvents } = serviceFixture();
  const secret = "synthetic-meta-token-4455";
  const metadata = await service.createCredential({
    empresaId: "tenant-a",
    credentialId: "meta-primary",
    provider: "meta",
    purpose: "whatsapp-access-token",
    secret,
    actorId: "admin-a",
  });
  const stored = await repository.findById({ empresaId: "tenant-a", credentialId: "meta-primary" });

  assert.equal(metadata.maskedSecret, "••••4455");
  assert.equal(metadata.configured, true);
  assert.equal("encryptedSecret" in metadata, false);
  assert.equal("secret" in metadata, false);
  assert.doesNotMatch(JSON.stringify(metadata), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(stored.encryptedSecret), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(auditEvents), new RegExp(secret));
  assert.equal(await service.getCredentialForUse({ empresaId: "tenant-a", credentialId: "meta-primary" }), secret);
});

test("rotação substitui a credencial, incrementa versão e não audita valores", async () => {
  const { service, auditEvents } = serviceFixture();
  await service.createCredential({
    empresaId: "tenant-a",
    credentialId: "openai-own",
    provider: "openai",
    purpose: "tenant-api-key",
    secret: "synthetic-old-key-1111",
  });
  const rotated = await service.rotateCredential({
    empresaId: "tenant-a",
    credentialId: "openai-own",
    newSecret: "synthetic-new-key-2222",
    actorId: "tenant-admin",
  });

  assert.equal(rotated.secretVersion, 2);
  assert.equal(rotated.maskedSecret, "••••2222");
  assert.equal(await service.getCredentialForUse({ empresaId: "tenant-a", credentialId: "openai-own" }), "synthetic-new-key-2222");
  const auditJson = JSON.stringify(auditEvents);
  assert.doesNotMatch(auditJson, /synthetic-(?:old|new)-key/u);
  assert.equal(auditEvents.at(-1).action, "credential.rotated");
  assert.deepEqual(auditEvents.at(-1).details, {
    previousKeyVersion: "v1",
    keyVersion: "v1",
    previousCredentialVersion: 1,
    credentialVersion: 2,
  });
});

test("rotação da chave mestra recriptografa sem alterar o segredo", async () => {
  const masterV1 = randomBytes(32);
  const masterV2 = randomBytes(32);
  const repository = new InMemoryCredentialRepository();
  const auditEvents = [];
  const firstService = new CredentialVaultService({
    repository,
    keyring: keyring("v1", { v1: masterV1, v2: masterV2 }),
    auditWriter: async (event) => auditEvents.push(event),
  });
  await firstService.createCredential({
    empresaId: "tenant-a",
    credentialId: "meta-key-rotation",
    provider: "meta",
    purpose: "whatsapp-access-token",
    secret: "synthetic-keyring-rotation-3333",
  });
  const secondService = new CredentialVaultService({
    repository,
    keyring: keyring("v2", { v1: masterV1, v2: masterV2 }),
    auditWriter: async (event) => auditEvents.push(event),
  });

  const metadata = await secondService.reencryptCredential({
    empresaId: "tenant-a",
    credentialId: "meta-key-rotation",
    actorId: "platform-admin",
  });
  assert.equal(metadata.keyVersion, "v2");
  assert.equal(metadata.secretVersion, 1);
  assert.equal(
    await secondService.getCredentialForUse({ empresaId: "tenant-a", credentialId: "meta-key-rotation" }),
    "synthetic-keyring-rotation-3333",
  );
  assert.equal(auditEvents.at(-1).action, "credential.reencrypted");
});

test("revogação elimina o ciphertext e impede novo uso", async () => {
  const { service, repository, auditEvents } = serviceFixture();
  await service.createCredential({
    empresaId: "tenant-a",
    credentialId: "revocable",
    provider: "meta",
    purpose: "whatsapp-access-token",
    secret: "synthetic-revocable-5555",
  });
  const revoked = await service.revokeCredential({ empresaId: "tenant-a", credentialId: "revocable" });
  const stored = await repository.findById({ empresaId: "tenant-a", credentialId: "revocable" });

  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.configured, false);
  assert.equal(stored.encryptedSecret, null);
  await assert.rejects(
    service.getCredentialForUse({ empresaId: "tenant-a", credentialId: "revocable" }),
    (error) => error.code === "CREDENTIAL_REVOKED",
  );
  assert.equal(auditEvents.at(-1).action, "credential.revoked");
});

test("falha de auditoria reverte a gravação da credencial", async () => {
  const repository = new InMemoryCredentialRepository();
  const service = new CredentialVaultService({
    repository,
    keyring: keyring(),
    auditWriter: async () => { throw new Error("auditoria indisponível"); },
    idGenerator: () => "credential-rollback",
  });

  await assert.rejects(
    service.createCredential({
      empresaId: "tenant-a",
      provider: "meta",
      purpose: "whatsapp-access-token",
      secret: "synthetic-rollback-token-1234",
    }),
    /auditoria indisponível/u,
  );

  await assert.rejects(
    service.getCredentialMetadata({ empresaId: "tenant-a", credentialId: "credential-rollback" }),
    (error) => error.code === "CREDENTIAL_NOT_FOUND",
  );
});

test("redação recursiva remove cabeçalhos, chaves, buffers, PEM e valores conhecidos sem mutar a entrada", () => {
  const knownSecret = "synthetic-known-value-6666";
  const input = {
    headers: { authorization: "Bearer bearer-value", cookie: "session=value" },
    openaiApiKey: "sk-synthetic123456789",
    nested: [{ message: `provider failed with ${knownSecret}` }],
    privateKey: "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----",
    binary: Buffer.from("synthetic-binary"),
  };
  const sanitized = redactSensitive(input, { additionalSecrets: [knownSecret] });

  assert.equal(sanitized.headers.authorization, REDACTED);
  assert.equal(sanitized.headers.cookie, REDACTED);
  assert.equal(sanitized.openaiApiKey, REDACTED);
  assert.equal(sanitized.privateKey, REDACTED);
  assert.equal(sanitized.binary, REDACTED);
  assert.doesNotMatch(JSON.stringify(sanitized), /bearer-value|synthetic-known-value|synthetic-binary|PRIVATE KEY/u);
  assert.equal(input.nested[0].message.includes(knownSecret), true);
});
