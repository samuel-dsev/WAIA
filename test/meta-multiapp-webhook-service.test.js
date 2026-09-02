import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  createMetaMultiAppWebhookService,
  MetaMultiAppWebhookError,
} from "../src/modules/meta/multiapp-webhook-service.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const CURRENT_SECRET = "synthetic-current-app-secret";
const PREVIOUS_SECRET = "synthetic-previous-app-secret";
const PUBLIC_ID = "R4ndom_Webhook_Public_Id_A";

function payload({ wabaId = "waba-a", phoneNumberId = "phone-a" } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: wabaId,
      changes: [{
        field: "messages",
        value: {
          metadata: {
            display_phone_number: "5511999999999",
            phone_number_id: phoneNumberId,
          },
          messages: [{
            id: "wamid.synthetic-a",
            from: "5511888888888",
            timestamp: "1788350400",
            type: "text",
            text: { body: "Olá" },
          }],
        },
      }],
    }],
  };
}

function signature(secret, rawBody) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function baseConnection(overrides = {}) {
  return {
    id: "meta-app-a",
    empresaId: "tenant-a",
    status: "active",
    wabaId: "waba-a",
    numbers: [{ numeroWhatsappId: "number-a", phoneNumberId: "phone-a", status: "active" }],
    appSecretCredentialId: "credential-app-current",
    previousAppSecretCredentialId: null,
    previousAppSecretValidFrom: null,
    previousAppSecretValidUntil: null,
    verifyTokenCredentialId: "credential-verify",
    ...overrides,
  };
}

function setup({ connection = baseConnection(), vaultSecrets = {}, now = NOW } = {}) {
  const calls = { resolved: [], credentials: [], ingested: [], logs: [] };
  const secrets = {
    "credential-app-current": CURRENT_SECRET,
    "credential-app-previous": PREVIOUS_SECRET,
    "credential-verify": "synthetic-verify-token",
    ...vaultSecrets,
  };
  const service = createMetaMultiAppWebhookService({
    connectionResolver: {
      async resolveByWebhookPublicId(webhookPublicId) {
        calls.resolved.push(webhookPublicId);
        return connection;
      },
    },
    credentialVault: {
      async getCredentialForUse(input) {
        calls.credentials.push(input);
        if (!Object.hasOwn(secrets, input.credentialId)) {
          throw new Error("detalhe interno indisponível");
        }
        return secrets[input.credentialId];
      },
    },
    ingestionService: {
      async ingestEvents(events, context) {
        calls.ingested.push({ events, context });
      },
    },
    logger: {
      warn(event, details) { calls.logs.push({ level: "warn", event, details }); },
      error(event, details) { calls.logs.push({ level: "error", event, details }); },
    },
    clock: () => new Date(now),
  });
  return { service, calls };
}

async function ingestSigned(service, { body = payload(), secret = CURRENT_SECRET, rawBody } = {}) {
  const bytes = rawBody ?? Buffer.from(JSON.stringify(body));
  return service.ingest({
    webhookPublicId: PUBLIC_ID,
    rawBody: bytes,
    signature: signature(secret, bytes),
    correlationId: "correlation-meta-a",
  });
}

test("resolve identificador opaco, valida bytes brutos e só então delega ingestão", async () => {
  const { service, calls } = setup();
  const result = await ingestSigned(service);

  assert.deepEqual(result, { accepted: true, eventCount: 1 });
  assert.deepEqual(calls.resolved, [PUBLIC_ID]);
  assert.equal(calls.ingested.length, 1);
  assert.equal(calls.ingested[0].events[0].wabaId, "waba-a");
  assert.equal(calls.ingested[0].events[0].phoneNumberId, "phone-a");
  assert.equal(calls.ingested[0].context.metaContext.empresaId, "tenant-a");
  assert.deepEqual(calls.ingested[0].context.metaContext.numbers, [{
    phoneNumberId: "phone-a",
    numeroWhatsappId: "number-a",
  }]);
});

test("assinatura não autentica corpo com bytes diferentes", async () => {
  const { service, calls } = setup();
  const original = Buffer.from(JSON.stringify(payload()));
  const altered = Buffer.from(`${JSON.stringify(payload())} `);

  await assert.rejects(
    service.ingest({
      webhookPublicId: PUBLIC_ID,
      rawBody: altered,
      signature: signature(CURRENT_SECRET, original),
    }),
    (error) => error instanceof MetaMultiAppWebhookError
      && error.code === "META_WEBHOOK_SIGNATURE_INVALID"
      && error.statusCode === 401,
  );
  assert.equal(calls.ingested.length, 0);
});

test("aceita segredo anterior somente dentro da janela curta de rotação", async () => {
  const connection = baseConnection({
    previousAppSecretCredentialId: "credential-app-previous",
    previousAppSecretValidFrom: "2026-09-02T11:55:00.000Z",
    previousAppSecretValidUntil: "2026-09-02T12:10:00.000Z",
  });
  const { service, calls } = setup({ connection });

  await ingestSigned(service, { secret: PREVIOUS_SECRET });
  assert.deepEqual(calls.credentials.map(({ credentialId }) => credentialId), [
    "credential-app-current",
    "credential-app-previous",
  ]);
  assert.equal(calls.ingested.length, 1);
});

test("não carrega nem aceita segredo anterior expirado", async () => {
  const connection = baseConnection({
    previousAppSecretCredentialId: "credential-app-previous",
    previousAppSecretValidFrom: "2026-09-02T11:30:00.000Z",
    previousAppSecretValidUntil: "2026-09-02T11:45:00.000Z",
  });
  const { service, calls } = setup({ connection });

  await assert.rejects(
    ingestSigned(service, { secret: PREVIOUS_SECRET }),
    { code: "META_WEBHOOK_SIGNATURE_INVALID" },
  );
  assert.deepEqual(calls.credentials.map(({ credentialId }) => credentialId), [
    "credential-app-current",
  ]);
});

test("limita internamente uma janela anterior configurada por tempo excessivo", async () => {
  const connection = baseConnection({
    previousAppSecretCredentialId: "credential-app-previous",
    previousAppSecretValidFrom: "2026-09-02T11:30:00.000Z",
    previousAppSecretValidUntil: "2026-09-03T11:30:00.000Z",
  });
  const { service, calls } = setup({ connection });

  await assert.rejects(
    ingestSigned(service, { secret: PREVIOUS_SECRET }),
    { code: "META_WEBHOOK_SIGNATURE_INVALID" },
  );
  assert.deepEqual(calls.credentials.map(({ credentialId }) => credentialId), [
    "credential-app-current",
  ]);
});

test("duas conexões não compartilham assinatura, WABA ou número", async () => {
  const rawBody = Buffer.from(JSON.stringify(payload({ wabaId: "waba-b", phoneNumberId: "phone-b" })));
  const { service, calls } = setup();

  await assert.rejects(
    service.ingest({
      webhookPublicId: PUBLIC_ID,
      rawBody,
      signature: signature(CURRENT_SECRET, rawBody),
    }),
    { code: "META_WEBHOOK_CONNECTION_MISMATCH" },
  );
  assert.equal(calls.ingested.length, 0);

  const tenantB = setup({
    connection: baseConnection({
      id: "meta-app-b",
      empresaId: "tenant-b",
      wabaId: "waba-b",
      phoneNumberId: "phone-b",
      numbers: [],
      appSecretCredentialId: "credential-b",
    }),
    vaultSecrets: { "credential-b": "synthetic-app-secret-b" },
  });
  await assert.rejects(
    tenantB.service.ingest({
      webhookPublicId: "R4ndom_Webhook_Public_Id_B",
      rawBody,
      signature: signature(CURRENT_SECRET, rawBody),
    }),
    { code: "META_WEBHOOK_SIGNATURE_INVALID" },
  );
  assert.equal(tenantB.calls.ingested.length, 0);
});

test("confere WABA e número mesmo quando o change ainda não contém eventos", async () => {
  const { service, calls } = setup();
  const body = payload({ wabaId: "waba-b", phoneNumberId: "phone-b" });
  body.entry[0].changes[0].value.messages = [];

  await assert.rejects(
    ingestSigned(service, { body }),
    { code: "META_WEBHOOK_CONNECTION_MISMATCH" },
  );
  assert.equal(calls.ingested.length, 0);
});

test("identificador inválido falha sem consultar repositório", async () => {
  const { service, calls } = setup();
  await assert.rejects(
    service.ingest({ webhookPublicId: "tenant-a", rawBody: Buffer.from("{}") }),
    { code: "META_WEBHOOK_NOT_FOUND", statusCode: 404 },
  );
  assert.equal(calls.resolved.length, 0);
});

test("erros públicos e logs nunca expõem segredo nem detalhe interno", async () => {
  const { service, calls } = setup({ vaultSecrets: { "credential-app-current": undefined } });
  let captured;
  try {
    await ingestSigned(service);
  } catch (error) {
    captured = error;
  }

  assert.ok(captured instanceof MetaMultiAppWebhookError);
  assert.deepEqual(captured.toJSON(), {
    code: "META_WEBHOOK_UNAVAILABLE",
    message: "Webhook Meta temporariamente indisponível.",
    statusCode: 503,
  });
  const publicOutput = JSON.stringify({ error: captured, logs: calls.logs });
  assert.doesNotMatch(publicOutput, /synthetic-current-app-secret|detalhe interno/u);
  assert.match(publicOutput, /META_WEBHOOK_UNAVAILABLE/u);
});

test("validação do callback GET usa verify token tenant-scoped e comparação constante", async () => {
  const { service, calls } = setup();
  assert.equal(await service.verifySubscription({
    webhookPublicId: PUBLIC_ID,
    mode: "subscribe",
    verifyToken: "synthetic-verify-token",
    challenge: "challenge-a",
  }), "challenge-a");

  await assert.rejects(
    service.verifySubscription({
      webhookPublicId: PUBLIC_ID,
      mode: "subscribe",
      verifyToken: "wrong-token",
      challenge: "challenge-a",
    }),
    { code: "META_WEBHOOK_VERIFICATION_FAILED", statusCode: 403 },
  );
  assert.equal(calls.ingested.length, 0);
});

test("callback GET pode validar aplicativo pendente antes da ativação", async () => {
  const { service } = setup({ connection: baseConnection({ status: undefined, state: "pendente" }) });
  assert.equal(await service.verifySubscription({
    webhookPublicId: PUBLIC_ID,
    mode: "subscribe",
    verifyToken: "synthetic-verify-token",
    challenge: "challenge-pending",
  }), "challenge-pending");
});

test("callback GET não exige número ativo nem App Secret antes da assinatura", async () => {
  const { service } = setup({
    connection: baseConnection({
      state: "pending",
      status: undefined,
      appSecretCredentialId: null,
      numbers: [],
      wabaId: null,
    }),
  });
  assert.equal(await service.verifySubscription({
    webhookPublicId: PUBLIC_ID,
    mode: "subscribe",
    verifyToken: "synthetic-verify-token",
    challenge: "challenge-setup",
  }), "challenge-setup");
});
