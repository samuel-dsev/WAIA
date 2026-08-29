import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createMetaSignatureVerifier } from "../src/modules/webhook/signature.js";

function signature(secret, body) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("valida assinatura Meta sobre os bytes brutos", () => {
  const body = Buffer.from('{"entry":[]}');
  const verifier = createMetaSignatureVerifier({ appSecret: "segredo-de-teste" });
  assert.equal(verifier.configured, true);
  assert.equal(verifier.verify({ body }), false);
  assert.equal(verifier.verify({ rawBody: body, signature: signature("segredo-de-teste", body) }), true);
  assert.equal(verifier.verify({ rawBody: Buffer.from('{ "entry": [] }'), signature: signature("segredo-de-teste", body) }), false);
  assert.equal(verifier.verify({ rawBody: body, signature: "sha256=inválida" }), false);
});

test("aceita segredo anterior no keyring durante rotação", () => {
  const body = Buffer.from('{"entry":[]}');
  const verifier = createMetaSignatureVerifier({ appSecrets: ["novo", "anterior"] });
  assert.equal(verifier.verify({ rawBody: body, signature: signature("anterior", body) }), true);
});

test("falha fechada sem segredo e só permite unsigned por opção explícita", () => {
  const body = Buffer.from('{"entry":[]}');
  assert.equal(createMetaSignatureVerifier().verify({ rawBody: body }), false);
  assert.equal(createMetaSignatureVerifier({ allowUnsigned: true }).verify({ rawBody: body }), true);
});
