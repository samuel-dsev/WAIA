import assert from "node:assert/strict";
import test from "node:test";
import {
  PostgresMetaAppRepository,
  sanitizeExternalError,
} from "../src/modules/meta/postgres-meta-app-repository.js";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "10000000-0000-4000-8000-000000000002";
const APP_ID = "10000000-0000-4000-8000-000000000003";
const WEBHOOK_ID = "10000000-0000-4000-8000-000000000004";
const SECRET_ID = "10000000-0000-4000-8000-000000000005";
const VERIFY_ID = "10000000-0000-4000-8000-000000000006";
const ACCESS_ID = "10000000-0000-4000-8000-000000000007";
const NUMBER_ID = "10000000-0000-4000-8000-000000000008";
const NOW = new Date("2026-09-02T12:00:00.000Z");

function appRow(overrides = {}) {
  return {
    id: APP_ID,
    empresa_id: TENANT_ID,
    nome: "Aplicativo próprio",
    app_id: "123456789",
    modo: "proprio",
    webhook_public_id: WEBHOOK_ID,
    estado: "ativo",
    app_secret_credencial_id: SECRET_ID,
    app_secret_anterior_credencial_id: null,
    app_secret_rotacionado_at: null,
    app_secret_anterior_valido_ate: null,
    verify_token_credencial_id: VERIFY_ID,
    revision: 1,
    ultimo_teste_at: null,
    ultimo_webhook_valido_at: null,
    ultimo_erro_sanitizado: null,
    ultimo_erro_expires_at: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
}

function fixture(handler) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return handler(sql, params, calls);
    },
  };
  const tenantContexts = [];
  const platformContexts = [];
  const tenantTransactionRunner = async (_pool, context, callback) => {
    tenantContexts.push(context);
    return callback({ client, tenantId: context.empresaId, isPlatformAdmin: false });
  };
  const platformTransactionRunner = async (_pool, context, callback) => {
    platformContexts.push(context);
    return callback({ client, tenantId: null, isPlatformAdmin: true });
  };
  const repository = new PostgresMetaAppRepository({ connect() {} }, {
    tenantTransactionRunner,
    platformTransactionRunner,
    idGenerator: () => APP_ID,
    webhookIdGenerator: () => WEBHOOK_ID,
  });
  return { repository, calls, tenantContexts, platformContexts };
}

test("cria app own ativo somente com referências Meta ativas e audita sem valores", async () => {
  const { repository, calls } = fixture(async (sql, params) => {
    if (sql.includes("FROM credenciais_empresa")) {
      return { rows: params[1].map((id) => ({
        id,
        provedor: "meta",
        finalidade: id === VERIFY_ID ? "meta-verify-token" : "meta-app-secret",
        status: "ativa",
      })) };
    }
    if (sql.includes("INSERT INTO aplicativos_meta")) return { rows: [appRow()] };
    return { rows: [] };
  });

  const app = await repository.createApp({
    empresaId: TENANT_ID,
    name: "Aplicativo próprio",
    metaAppId: "123456789",
    mode: "own",
    state: "active",
    appSecretCredentialId: SECRET_ID,
    verifyTokenCredentialId: VERIFY_ID,
    actorId: ACTOR_ID,
    createdAt: NOW,
  });

  assert.equal(app.id, APP_ID);
  assert.equal(app.mode, "own");
  assert.equal(app.webhookPublicId, WEBHOOK_ID);
  const insertion = calls.find(({ sql }) => sql.includes("INSERT INTO aplicativos_meta"));
  assert.deepEqual(insertion.params.slice(0, 12), [
    APP_ID, TENANT_ID, "Aplicativo próprio", "123456789", "proprio", WEBHOOK_ID,
    "ativo", SECRET_ID, null, null, null, VERIFY_ID,
  ]);
  const audit = calls.find(({ sql }) => sql.includes("INSERT INTO logs_auditoria"));
  assert.equal(audit.params[3], "meta.app.create");
  assert.doesNotMatch(JSON.stringify(audit.params), /synthetic-secret/iu);
});

test("permite app shared sem refs e recusa app own ativo incompleto", async () => {
  const { repository } = fixture(async (sql) => {
    if (sql.includes("INSERT INTO aplicativos_meta")) {
      return { rows: [appRow({
        modo: "compartilhado",
        app_secret_credencial_id: null,
        verify_token_credencial_id: null,
      })] };
    }
    return { rows: [] };
  });

  const shared = await repository.createApp({
    empresaId: TENANT_ID,
    name: "Aplicativo compartilhado",
    metaAppId: "987654321",
    mode: "shared",
    state: "active",
  });
  assert.equal(shared.mode, "shared");
  assert.equal(shared.appSecretCredentialId, null);

  await assert.rejects(
    repository.createApp({
      empresaId: TENANT_ID,
      name: "Own incompleto",
      metaAppId: "123",
      mode: "own",
      state: "active",
    }),
    /exige App Secret e verify token/u,
  );
});

test("não aceita access token no lugar de App Secret ou verify token", async () => {
  const { repository } = fixture(async (sql, params) => {
    if (sql.includes("FROM credenciais_empresa")) {
      return { rows: params[1].map((id) => ({
        id,
        provedor: "meta",
        finalidade: "whatsapp-access-token",
        status: "ativa",
      })) };
    }
    return { rows: [] };
  });

  await assert.rejects(
    repository.createApp({
      empresaId: TENANT_ID,
      name: "Credenciais trocadas",
      metaAppId: "123456789",
      mode: "own",
      state: "active",
      appSecretCredentialId: SECRET_ID,
      verifyTokenCredentialId: VERIFY_ID,
    }),
    (error) => error.code === "META_CREDENTIAL_INVALID",
  );
});

test("atualização otimista rejeita revisão obsoleta antes de gravar", async () => {
  const { repository, calls } = fixture(async (sql) => {
    if (sql.includes("SELECT * FROM aplicativos_meta") && sql.includes("FOR UPDATE")) {
      return { rows: [appRow({ revision: 3 })] };
    }
    return { rows: [] };
  });

  await assert.rejects(
    repository.updateApp({
      empresaId: TENANT_ID,
      id: APP_ID,
      expectedRevision: 2,
      name: "Nome concorrente",
    }),
    (error) => error.code === "META_APP_CONFLICT",
  );
  assert.equal(calls.some(({ sql }) => sql.includes("UPDATE aplicativos_meta")), false);
});

test("rotação persiste início explícito e janela da credencial anterior", async () => {
  const validUntil = new Date("2026-09-02T12:15:00.000Z");
  const { repository, calls } = fixture(async (sql, params) => {
    if (sql.includes("SELECT * FROM aplicativos_meta") && sql.includes("FOR UPDATE")) {
      return { rows: [appRow()] };
    }
    if (sql.includes("FROM credenciais_empresa")) {
      return { rows: params[1].map((id) => ({
        id,
        provedor: "meta",
        finalidade: id === VERIFY_ID ? "meta-verify-token" : "meta-app-secret",
        status: "ativa",
      })) };
    }
    if (sql.includes("UPDATE aplicativos_meta")) {
      return { rows: [appRow({
        app_secret_credencial_id: ACCESS_ID,
        app_secret_anterior_credencial_id: SECRET_ID,
        app_secret_rotacionado_at: NOW,
        app_secret_anterior_valido_ate: validUntil,
        revision: 2,
      })] };
    }
    return { rows: [] };
  });

  const rotated = await repository.updateApp({
    empresaId: TENANT_ID,
    id: APP_ID,
    expectedRevision: 1,
    appSecretCredentialId: ACCESS_ID,
    previousAppSecretCredentialId: SECRET_ID,
    appSecretRotatedAt: NOW,
    previousAppSecretValidUntil: validUntil,
  });

  assert.equal(rotated.appSecretRotatedAt, NOW);
  assert.equal(rotated.previousAppSecretValidUntil, validUntil);
  const update = calls.find(({ sql }) => sql.includes("UPDATE aplicativos_meta"));
  assert.equal(update.params[7], ACCESS_ID);
  assert.equal(update.params[8], SECRET_ID);
  assert.equal(update.params[9], NOW);
  assert.equal(update.params[10], validUntil);
});

test("vincula número explicitamente ao app e access token com revisão otimista", async () => {
  const { repository, calls } = fixture(async (sql, params) => {
    if (sql.includes("SELECT id, modo FROM aplicativos_meta")) return { rows: [{ id: APP_ID, modo: "proprio" }] };
    if (sql.includes("FROM credenciais_empresa")) {
      return { rows: [{
        id: ACCESS_ID,
        provedor: "meta",
        finalidade: `whatsapp:${NUMBER_ID}`,
        status: "ativa",
      }] };
    }
    if (sql.includes("UPDATE numeros_whatsapp")) {
      return { rows: [{
        id: NUMBER_ID,
        empresa_id: TENANT_ID,
        phone_number_id: "phone-123",
        waba_id: "waba-123",
        aplicativo_meta_id: APP_ID,
        access_token_credencial_id: ACCESS_ID,
        meta_binding_revision: 2,
        status: "ativo",
        principal: true,
        updated_at: NOW,
      }] };
    }
    return { rows: [] };
  });

  const binding = await repository.bindNumber({
    empresaId: TENANT_ID,
    numberId: NUMBER_ID,
    metaAppId: APP_ID,
    accessTokenCredentialId: ACCESS_ID,
    expectedRevision: 1,
    actorId: ACTOR_ID,
    updatedAt: NOW,
  });

  assert.equal(binding.metaAppId, APP_ID);
  assert.equal(binding.accessTokenCredentialId, ACCESS_ID);
  assert.equal(binding.bindingRevision, 2);
  const update = calls.find(({ sql }) => sql.includes("UPDATE numeros_whatsapp"));
  assert.deepEqual(update.params.slice(0, 5), [TENANT_ID, NUMBER_ID, 1, APP_ID, ACCESS_ID]);
});

test("resolve webhook opaco somente em transação de plataforma", async () => {
  const { repository, tenantContexts, platformContexts } = fixture(async (sql, params) => {
    if (sql.includes("webhook_public_id = $1")) {
      assert.deepEqual(params, [WEBHOOK_ID]);
      return { rows: [appRow()] };
    }
    return { rows: [] };
  });

  const app = await repository.findAppByWebhookPublicId({ webhookPublicId: WEBHOOK_ID });
  assert.equal(app.empresaId, TENANT_ID);
  assert.equal(platformContexts.length, 1);
  assert.equal(tenantContexts.length, 0);
});

test("resolver de callback devolve somente números ativos ligados ao app", async () => {
  const { repository, calls } = fixture(async (sql) => {
    if (sql.includes("webhook_public_id = $1")) return { rows: [appRow()] };
    if (sql.includes("FROM numeros_whatsapp")) {
      return { rows: [{
        id: NUMBER_ID,
        empresa_id: TENANT_ID,
        phone_number_id: "phone-123",
        waba_id: "waba-123",
        aplicativo_meta_id: APP_ID,
        access_token_credencial_id: ACCESS_ID,
        meta_binding_revision: 2,
        status: "ativo",
        principal: true,
        updated_at: NOW,
      }] };
    }
    return { rows: [] };
  });

  const resolved = await repository.resolveByWebhookPublicId(WEBHOOK_ID);
  assert.equal(resolved.app.id, APP_ID);
  assert.equal(resolved.empresaId, TENANT_ID);
  assert.equal(resolved.numbers.length, 1);
  assert.equal(resolved.numbers[0].phoneNumberId, "phone-123");
  const numberQuery = calls.find(({ sql }) => sql.includes("FROM numeros_whatsapp"));
  assert.match(numberQuery.sql, /empresa_id = \$1 AND aplicativo_meta_id = \$2/u);
  assert.match(numberQuery.sql, /status = 'ativo'/u);
  assert.deepEqual(numberQuery.params, [TENANT_ID, APP_ID]);
});

test("health persiste somente erro allowlisted e sanitizado com retenção", async () => {
  const leaked = "synthetic-secret-value-that-must-never-be-persisted-123456";
  const { repository, calls } = fixture(async (sql, params) => {
    if (sql.includes("UPDATE aplicativos_meta am")) {
      return { rows: [appRow({
        ultimo_teste_at: NOW,
        ultimo_erro_sanitizado: params[4],
        ultimo_erro_expires_at: new Date("2026-12-01T12:00:00.000Z"),
        estado: "falha",
        revision: 2,
      })] };
    }
    return { rows: [] };
  });

  const app = await repository.recordHealthCheck({
    empresaId: TENANT_ID,
    appId: APP_ID,
    expectedRevision: 1,
    testedAt: NOW,
    success: false,
    state: "failed",
    errorSanitized: {
      code: "META_UNAVAILABLE",
      message: `authorization=Bearer ${leaked}`,
      providerCode: "190",
      ignoredSecret: leaked,
      status: 401,
    },
  });

  assert.deepEqual(app.lastErrorSanitized, {
    code: "META_UNAVAILABLE",
    message: "authorization=[REDACTED] [REDACTED]",
    providerCode: "190",
    status: 401,
  });
  const update = calls.find(({ sql }) => sql.includes("UPDATE aplicativos_meta am"));
  assert.match(update.sql, /make_interval\(days => e\.retencao_logs_dias\)/u);
  assert.match(update.sql, /revision = am\.revision \+ 1/u);
  assert.equal(app.revision, 2);
  assert.doesNotMatch(update.params[4], new RegExp(leaked, "u"));
  assert.doesNotMatch(update.params[4], /ignoredSecret/u);
});

test("health recusa resultado obsoleto pela revisão do aplicativo", async () => {
  const { repository } = fixture(async (sql) => {
    if (sql.includes("UPDATE aplicativos_meta am")) return { rows: [] };
    if (sql.includes("SELECT revision FROM aplicativos_meta")) return { rows: [{ revision: 4 }] };
    return { rows: [] };
  });

  await assert.rejects(
    repository.recordHealthCheck({
      empresaId: TENANT_ID,
      appId: APP_ID,
      expectedRevision: 3,
      testedAt: NOW,
      success: true,
      state: "active",
    }),
    (error) => error.code === "META_APP_CONFLICT" && /revisão atual.*4/u.test(error.message),
  );
});

test("sanitizador aceita texto legado sem preservar token", () => {
  const secret = "long-token-value-abcdefghijklmnopqrstuvwxyz-1234567890";
  const sanitized = sanitizeExternalError(`Falha access_token=${secret}`);
  assert.equal(sanitized.includes(secret), false);
  assert.match(sanitized, /\[REDACTED\]/u);
});
