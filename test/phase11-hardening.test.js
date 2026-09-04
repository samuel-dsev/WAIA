import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { WebhookAlertSink } from "../src/operations/alert-sink.js";
import { createOperationalMonitor } from "../src/operations/monitor.js";
import { createAdminNetworkMiddleware, parseAdminNetworkAllowlist } from "../src/modules/auth/network-policy.js";
import { renderLegalTemplate } from "../src/legal/legal-pages.js";
import { VersionedKeyring } from "../src/security/versioned-keyring.js";
import { decryptCredentialSecret, encryptCredentialSecret } from "../src/security/credential-crypto.js";

test("páginas legais são parametrizadas, escapam HTML e não citam o Capitão Mor", async () => {
  const template = await readFile(new URL("../public/privacy.html", import.meta.url), "utf8");
  const rendered = renderLegalTemplate(template, {
    platformName: "WAIA <Operadora>",
    privacyEmail: "privacidade@example.invalid",
    controllerNotice: "A empresa atendente controla a conversa.",
  });
  assert.match(rendered, /WAIA &lt;Operadora&gt;/u);
  assert.match(rendered, /privacidade@example.invalid/u);
  assert.doesNotMatch(rendered, /Capitão Mor|promarketing288/u);
  assert.equal(renderLegalTemplate(template, {}), null);
});

test("allowlist administrativa aceita IP e CIDR e bloqueia origem externa", () => {
  const allowlist = parseAdminNetworkAllowlist("127.0.0.1,10.20.0.0/16");
  const middleware = createAdminNetworkMiddleware({ allowlist });
  for (const ip of ["127.0.0.1", "::ffff:10.20.5.8"]) {
    let accepted = false;
    middleware({ ip }, {}, (error) => { assert.equal(error, undefined); accepted = true; });
    assert.equal(accepted, true);
  }
  middleware({ ip: "203.0.113.9" }, {}, (error) => assert.equal(error?.code, "AUTHORIZATION_DENIED"));
  assert.throws(() => parseAdminNetworkAllowlist("10.0.0.0/99"), /CIDR/u);
});

test("alerta por webhook envia somente payload sanitizado", async () => {
  let captured;
  const sink = new WebhookAlertSink({
    url: "http://127.0.0.1/alerts",
    allowInsecure: true,
    fetchImpl: async (_url, options) => { captured = options; return { ok: true, status: 204 }; },
  });
  await sink.notify({ eventCode: "synthetic", fields: { apiKey: "synthetic-secret-key", count: 2 } });
  assert.equal(captured.method, "POST");
  assert.doesNotMatch(captured.body, /synthetic-secret-key/u);
  assert.match(captured.body, /synthetic|count/u);
  assert.throws(() => new WebhookAlertSink({ url: "http://alerts.example.invalid" }), /HTTPS/u);
});

test("monitor alerta na transição, evita duplicata e informa recuperação", async () => {
  const alerts = [];
  let failing = true;
  const metrics = () => failing
    ? "waia_worker_heartbeats 0\nwaia_failed_jobs_open 2\nwaia_outbox_jobs_failed 0\nwaia_bullmq_jobs_failed 0\nwaia_bullmq_jobs_waiting 0\n"
    : "waia_worker_heartbeats 1\nwaia_failed_jobs_open 0\nwaia_outbox_jobs_failed 0\nwaia_bullmq_jobs_failed 0\nwaia_bullmq_jobs_waiting 0\n";
  const monitor = createOperationalMonitor({
    metricsToken: "m".repeat(32),
    alertSink: { async notify(value) { alerts.push(value); } },
    fetchImpl: async (url) => url.endsWith("/metrics")
      ? { ok: true, status: 200, text: async () => metrics() }
      : { ok: true, status: 200 },
  });
  await monitor.check();
  await monitor.check();
  assert.deepEqual(alerts.filter(({ state }) => state === "triggered").map(({ eventCode }) => eventCode).sort(), ["failed_jobs_open", "worker_heartbeat_missing"]);
  failing = false;
  await monitor.check();
  assert.equal(alerts.filter(({ state }) => state === "recovered").length, 2);
});

test("cópia externa sintética do keyring recupera credencial cifrada após perda local", () => {
  const keyV1 = randomBytes(32);
  const serializedCustodyCopy = JSON.stringify({ activeVersion: "v1", keys: { v1: keyV1.toString("base64") } });
  const original = VersionedKeyring.fromBase64(JSON.parse(serializedCustodyCopy));
  const binding = { empresaId: "tenant-a", credentialId: "credential-a", provider: "openai", purpose: "tenant-api-key" };
  const envelope = encryptCredentialSecret({ secret: "synthetic-recovery-secret", keyring: original, binding });
  original.destroy();
  const unrelated = new VersionedKeyring({ activeVersion: "v2", keys: { v2: randomBytes(32) } });
  assert.throws(() => decryptCredentialSecret({ envelope, keyring: unrelated, binding }), /Versão de chave mestra indisponível/u);
  const recovered = VersionedKeyring.fromBase64(JSON.parse(serializedCustodyCopy));
  assert.equal(decryptCredentialSecret({ envelope, keyring: recovered, binding }), "synthetic-recovery-secret");
  assert.doesNotMatch(serializedCustodyCopy, /synthetic-recovery-secret/u);
});

test("scripts de recuperação exigem alvo explícito, checksum, mídia e custódia do keyring", async () => {
  const backup = await readFile(new URL("../scripts/backup-postgres.sh", import.meta.url), "utf8");
  const restore = await readFile(new URL("../scripts/restore-postgres.sh", import.meta.url), "utf8");
  assert.match(backup, /POSTGRES_USER=.*waia_owner/u);
  assert.match(backup, /media\.tar\.gz|KEYRING_CUSTODY_REFERENCE|checksums\.sha256/u);
  assert.match(restore, /RESTORE_ISOLATED|RESTORE:\$PROJECT:\$POSTGRES_DB|sha256sum -c/u);
  assert.match(restore, /media\.tar\.gz|\/app\/\.data\/media/u);
});
