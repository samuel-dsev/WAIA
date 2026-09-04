import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import pg from "pg";
import { config as defaultConfig } from "../src/config.js";
import { createApiApp, createPostgresRuntime } from "../src/bootstrap/app-runtime.js";
import { hashPassword } from "../src/modules/auth/index.js";
import { closePostgresPool } from "../src/infra/postgres/pool.js";
import { closeRedisConnection } from "../src/infra/redis/connection.js";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "true"
  && process.env.RUN_REDIS_INTEGRATION === "true";
const BETA_SLUG = process.env.PHASE10_BETA_SLUG || `empresa-beta-sintetica-${randomUUID()}`;
const ADMIN_PASSWORD = "Synthetic-Fase10-Admin-2026!";
const META_ACCESS_TOKEN = "synthetic-meta-access-token-phase10";

function betaConfiguration() {
  return {
    schemaVersion: 2,
    identity: {
      name: "Empresa Beta Sintética",
      displayName: "Beta Sintética",
      publicIdentity: "Atendimento sintético para validação isolada.",
      segment: "serviços",
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
      welcomeMessage: "Olá! Este é o atendimento da Beta Sintética.",
      fallbackMessage: "Escolha uma opção do menu.",
      publicRules: ["Ambiente exclusivamente sintético."],
    },
    retention: { messagesDays: 30, logsDays: 30 },
    modules: ["appointments", "ai_freeform", "flows"],
    menu: {
      text: "Como podemos ajudar?",
      options: [
        { id: "agendar", label: "Agendar", action: "appointments.start", params: {} },
        { id: "triagem", label: "Iniciar triagem", action: "flows.start", params: { flowRef: "flow:triagem_beta" } },
      ],
    },
    routing: {
      greetings: ["oi", "olá"],
      aliases: [{ terms: ["triagem"], action: "flows.start", params: { flowRef: "flow:triagem_beta" } }],
      fallbackAction: "ai_freeform.reply",
    },
    publicReplies: [{ action: "appointments.start", text: "Selecione um serviço e horário." }],
    appointments: {
      services: [{
        id: "consulta_beta",
        name: "Consulta sintética",
        active: true,
        slots: [{
          id: "slot_beta_09",
          label: "Segunda às 09h",
          startsAt: "2026-09-07T09:00:00-03:00",
          available: true,
        }],
      }],
    },
    ai: {
      enabled: true,
      provider: "simulated",
      model: "waia-synthetic-model",
      personality: "Objetiva e cordial.",
      prompt: "Use somente as informações públicas desta configuração sintética.",
      keyMode: "simulated",
      fallbackMessage: "A IA simulada não encontrou uma resposta.",
    },
    flows: {
      definitions: [{
        key: "triagem_beta",
        name: "Triagem Beta",
        version: 1,
        startStepId: "nome",
        steps: [
          { id: "nome", type: "name", field: "nome", required: true, message: "Qual é o seu nome?", nextStepId: "fim" },
          { id: "fim", type: "completion", message: "Triagem sintética concluída." },
        ],
      }],
    },
    integrations: [],
  };
}

function testConfig(suffix) {
  return {
    ...defaultConfig,
    environment: "test",
    infrastructureMode: "postgres",
    database: { ...defaultConfig.database, url: process.env.DATABASE_URL, poolMax: 4 },
    redis: { ...defaultConfig.redis, url: process.env.REDIS_URL, queueName: `waia-phase10-${suffix}` },
    security: {
      ...defaultConfig.security,
      masterKeyring: process.env.MASTER_KEYRING,
      sessionPepper: process.env.SESSION_PEPPER,
      cookieSecure: false,
    },
    metrics: { bearerToken: "synthetic-metrics-token-phase10-000000000000" },
  };
}

async function startApi(app) {
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function createPanelClient(baseUrl) {
  const cookies = new Map();
  let csrfToken = "";
  return {
    async call(path, { method = "GET", body } = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") } : {}),
          ...(!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      for (const header of response.headers.getSetCookie?.() || []) {
        const [pair] = header.split(";");
        const separator = pair.indexOf("=");
        if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
      const payload = response.status === 204 ? null : await response.json().catch(() => null);
      csrfToken = payload?.csrfToken || response.headers.get("x-csrf-token") || csrfToken;
      return { status: response.status, payload };
    },
  };
}

function expectStatus(result, expected, step) {
  assert.equal(result.status, expected, `${step}: ${JSON.stringify(result.payload)}`);
  return result.payload;
}

function items(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.items || payload?.data || [];
}

function simulatedMetaHealthClient() {
  return {
    async checkConnection({ appId, wabaId, phoneNumberId, accessToken, signal }) {
      assert.notEqual(signal?.aborted, true);
      assert.equal(accessToken, META_ACCESS_TOKEN);
      return { appId, wabaId, phoneNumberId, tokenValid: true };
    },
  };
}

async function closeRuntime(runtime) {
  await runtime.queue.close();
  await closeRedisConnection(runtime.redis);
  await closePostgresPool(runtime.pool);
}

test("Fase 10: Beta persistente percorre as rotas do painel com PostgreSQL e Meta simulada", { skip: !enabled, timeout: 60_000 }, async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL é obrigatória");
  assert.ok(process.env.DATABASE_MIGRATOR_URL, "DATABASE_MIGRATOR_URL é obrigatória");
  assert.ok(process.env.REDIS_URL, "REDIS_URL é obrigatória");
  assert.ok(process.env.MASTER_KEYRING, "MASTER_KEYRING é obrigatória");
  assert.ok(process.env.SESSION_PEPPER, "SESSION_PEPPER é obrigatória");

  const suffix = randomUUID();
  const ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  const capitaoStatusBefore = (await ownerPool.query(
    "SELECT status FROM empresas WHERE slug = 'capitao-mor' AND deleted_at IS NULL",
  )).rows[0]?.status;
  assert.ok(capitaoStatusBefore, "Seed canônico do Capitão Mor não encontrado");
  const existing = await ownerPool.query("SELECT id FROM empresas WHERE slug = $1 AND deleted_at IS NULL", [BETA_SLUG]);
  if (existing.rowCount) {
    const betaId = existing.rows[0].id;
    let state = await ownerPool.query(
      `SELECT e.status, e.configuracao_runtime_modo, e.configuracao_ativa_versao,
              (SELECT count(*)::int FROM configuracoes_revisoes r WHERE r.empresa_id = e.id) AS revisions,
              (SELECT count(*)::int FROM logs_auditoria a WHERE a.empresa_id = e.id AND a.acao = 'tenant.activate') AS activations,
              (SELECT count(*)::int FROM logs_auditoria a WHERE a.empresa_id = e.id AND a.acao = 'tenant.suspend') AS suspensions
         FROM empresas e WHERE e.id = $1`,
      [betaId],
    );
    if (state.rows[0].status !== "suspensa" || state.rows[0].activations < 1) {
      const actor = (await ownerPool.query(
        `SELECT u.email::text
           FROM logs_auditoria a
           JOIN usuarios u ON u.id = a.ator_usuario_id
          WHERE a.empresa_id = $1 AND a.acao = 'tenant.create'
          ORDER BY a.occurred_at ASC LIMIT 1`,
        [betaId],
      )).rows[0];
      assert.ok(actor?.email, "Administrador sintético da Beta parcial não encontrado");
      const runtimeConfig = testConfig(suffix);
      const runtime = createPostgresRuntime({
        config: runtimeConfig,
        logger: { info() {}, warn() {}, error() {} },
        metaHealthClient: simulatedMetaHealthClient(),
      });
      const api = await startApi(createApiApp({ runtime, config: runtimeConfig }));
      const client = createPanelClient(api.baseUrl);
      try {
        expectStatus(await client.call("/api/admin/auth/login", {
          method: "POST",
          body: { email: actor.email, password: ADMIN_PASSWORD },
        }), 200, "resume.login");
        const draft = expectStatus(await client.call(`/api/admin/tenants/${betaId}/configuration/draft`), 200, "resume.draft");
        const apps = items(expectStatus(await client.call(`/api/admin/tenants/${betaId}/meta-applications`), 200, "resume.meta-applications"));
        const numbers = items(expectStatus(await client.call(`/api/admin/tenants/${betaId}/numbers?page=1&pageSize=100`), 200, "resume.numbers"));
        assert.equal(apps.length, 1);
        assert.equal(numbers.length, 1);
        const metaPreflight = expectStatus(await client.call(`/api/admin/tenants/${betaId}/meta-applications/${apps[0].id}/preflight`, {
          method: "POST",
          body: { numberId: numbers[0].id },
        }), 200, "resume.meta.preflight");
        assert.equal(metaPreflight.success, true, JSON.stringify(metaPreflight));
        const preflight = expectStatus(await client.call(`/api/admin/tenants/${betaId}/preflight`, {
          method: "POST",
          body: { draftVersion: draft.draftVersion },
        }), 200, "resume.onboarding.preflight");
        assert.equal(preflight.state, "passed", JSON.stringify(preflight));
        expectStatus(await client.call(`/api/admin/tenants/${betaId}/configuration/publish`, {
          method: "POST",
          body: { draftVersion: draft.draftVersion },
        }), 201, "resume.configuration.publish");
        expectStatus(await client.call(`/api/admin/tenants/${betaId}/activate`, {
          method: "POST",
          body: { draftVersion: draft.draftVersion },
        }), 200, "resume.tenant.activate");
        expectStatus(await client.call(`/api/admin/tenants/${betaId}/suspend`, {
          method: "POST",
          body: {},
        }), 200, "resume.tenant.suspend");
      } finally {
        await api.close();
        await closeRuntime(runtime);
      }
      state = await ownerPool.query(
        `SELECT e.status, e.configuracao_runtime_modo, e.configuracao_ativa_versao,
                (SELECT count(*)::int FROM configuracoes_revisoes r WHERE r.empresa_id = e.id) AS revisions,
                (SELECT count(*)::int FROM logs_auditoria a WHERE a.empresa_id = e.id AND a.acao = 'tenant.activate') AS activations,
                (SELECT count(*)::int FROM logs_auditoria a WHERE a.empresa_id = e.id AND a.acao = 'tenant.suspend') AS suspensions
           FROM empresas e WHERE e.id = $1`,
        [betaId],
      );
    }
    assert.equal(state.rows[0].status, "suspensa");
    assert.equal(state.rows[0].configuracao_runtime_modo, "versionado");
    assert.ok(Number(state.rows[0].configuracao_ativa_versao) > 0);
    assert.ok(state.rows[0].revisions >= 2);
    assert.ok(state.rows[0].activations >= 1);
    assert.ok(state.rows[0].suspensions >= 1);
    const capitaoStatusAfter = (await ownerPool.query(
      "SELECT status FROM empresas WHERE slug = 'capitao-mor' AND deleted_at IS NULL",
    )).rows[0]?.status;
    assert.equal(capitaoStatusAfter, capitaoStatusBefore);
    await ownerPool.end();
    return;
  }

  const adminEmail = `fase10-${suffix}@example.invalid`;
  const adminId = randomUUID();
  await ownerPool.query(
    `INSERT INTO usuarios (id, email, nome, password_hash, papel_plataforma, status)
     VALUES ($1,$2,'Administrador Fase 10',$3,'administrador','ativo')`,
    [adminId, adminEmail, await hashPassword(ADMIN_PASSWORD)],
  );

  const runtimeConfig = testConfig(suffix);
  const runtime = createPostgresRuntime({
    config: runtimeConfig,
    logger: { info() {}, warn() {}, error() {} },
    metaHealthClient: simulatedMetaHealthClient(),
  });
  const api = await startApi(createApiApp({ runtime, config: runtimeConfig }));
  const client = createPanelClient(api.baseUrl);

  try {
    const panel = await fetch(`${api.baseUrl}/panel/`);
    assert.equal(panel.status, 200);

    expectStatus(await client.call("/api/admin/auth/login", {
      method: "POST",
      body: { email: adminEmail, password: ADMIN_PASSWORD },
    }), 200, "login");

    const tenant = expectStatus(await client.call("/api/admin/tenants", {
      method: "POST",
      body: {
        slug: BETA_SLUG,
        name: "Empresa Beta Sintética",
        displayName: "Beta Sintética",
        identity: "Atendimento sintético",
        timezone: "America/Sao_Paulo",
        locale: "pt-BR",
        messageRetentionDays: 30,
        logRetentionDays: 30,
      },
    }), 201, "tenant.create");
    assert.equal(tenant.status, "draft");
    const betaId = tenant.id;

    const tenantAdmin = expectStatus(await client.call(`/api/admin/tenants/${betaId}/users`, {
      method: "POST",
      body: {
        email: `admin.beta-${suffix}@example.invalid`,
        name: "Admin Beta",
        role: "tenant_admin",
        status: "active",
        initialPassword: "Synthetic-Beta-Admin-2026!",
        permissions: ["appointments.read", "appointments.update"],
      },
    }), 201, "users.create admin");
    assert.doesNotMatch(JSON.stringify(tenantAdmin), /Synthetic-Beta-Admin-2026/u);

    expectStatus(await client.call(`/api/admin/tenants/${betaId}/users`, {
      method: "POST",
      body: {
        email: `operador.beta-${suffix}@example.invalid`,
        name: "Operador Beta",
        role: "tenant_operator",
        status: "active",
        initialPassword: "Synthetic-Beta-Operator-2026!",
        permissions: ["appointments.read", "appointments.update"],
      },
    }), 201, "users.create operator");

    const draft = expectStatus(await client.call(`/api/admin/tenants/${betaId}/configuration/draft`, {
      method: "PUT",
      body: { draftVersion: 0, configuration: betaConfiguration() },
    }), 200, "configuration.draft");
    assert.equal(draft.draftVersion, 1);

    const simulation = expectStatus(await client.call(`/api/admin/tenants/${betaId}/simulator/messages`, {
      method: "POST",
      body: { draftVersion: 1, message: { type: "text", text: "pergunta sem alias" } },
    }), 200, "simulator.messages");
    assert.equal(simulation.synthetic, true);
    assert.equal(simulation.simulation.ai, "simulated");

    const number = expectStatus(await client.call(`/api/admin/tenants/${betaId}/numbers`, {
      method: "POST",
      body: {
        phoneNumberId: `phone-beta-${suffix}`,
        wabaId: `waba-beta-${suffix}`,
        numeroE164: `+5511${String(Date.now()).slice(-8)}`,
        nomeVerificado: "Beta Sintética",
        status: "pendente",
        principal: false,
      },
    }), 201, "numbers.create");

    const metaApp = expectStatus(await client.call(`/api/admin/tenants/${betaId}/meta-applications`, {
      method: "POST",
      body: { name: "Meta Beta Simulada", metaAppId: `meta-beta-${suffix}`, mode: "shared" },
    }), 201, "meta-applications.create");
    assert.equal(metaApp.state, "pending");

    const credential = expectStatus(await client.call(`/api/admin/tenants/${betaId}/credentials`, {
      method: "POST",
      body: { provider: "meta", purpose: `whatsapp:${number.id}`, secret: META_ACCESS_TOKEN },
    }), 201, "credentials.create");
    assert.doesNotMatch(JSON.stringify(credential), new RegExp(META_ACCESS_TOKEN, "u"));

    const binding = expectStatus(await client.call(`/api/admin/tenants/${betaId}/numbers/${number.id}/meta-binding`, {
      method: "PUT",
      body: {
        metaAppId: metaApp.id,
        accessTokenCredentialId: credential.id || credential.credentialId,
        expectedRevision: number.bindingRevision,
      },
    }), 200, "numbers.meta-binding");

    expectStatus(await client.call(`/api/admin/tenants/${betaId}/numbers/${number.id}`, {
      method: "PATCH",
      body: { status: "ativo", principal: true },
    }), 200, "numbers.activate");

    const metaPreflight = expectStatus(await client.call(`/api/admin/tenants/${betaId}/meta-applications/${metaApp.id}/preflight`, {
      method: "POST",
      body: { numberId: number.id },
    }), 200, "meta.preflight");
    assert.equal(metaPreflight.success, true);
    assert.equal(binding.bindingRevision, number.bindingRevision + 1);

    const preflight = expectStatus(await client.call(`/api/admin/tenants/${betaId}/preflight`, {
      method: "POST",
      body: { draftVersion: 1 },
    }), 200, "onboarding.preflight");
    assert.equal(preflight.state, "passed");

    const published = expectStatus(await client.call(`/api/admin/tenants/${betaId}/configuration/publish`, {
      method: "POST",
      body: { draftVersion: 1 },
    }), 201, "configuration.publish");
    assert.ok(published.configVersion > 0);

    const activated = expectStatus(await client.call(`/api/admin/tenants/${betaId}/activate`, {
      method: "POST",
      body: { draftVersion: 1 },
    }), 200, "tenant.activate");
    assert.equal(activated.status, "active");

    const suspended = expectStatus(await client.call(`/api/admin/tenants/${betaId}/suspend`, {
      method: "POST",
      body: {},
    }), 200, "tenant.suspend");
    assert.equal(suspended.status, "suspended");

    const state = (await ownerPool.query(
      `SELECT e.status, e.configuracao_runtime_modo, e.configuracao_ativa_versao,
              (SELECT count(*)::int FROM configuracoes_revisoes r WHERE r.empresa_id = e.id) AS revisions,
              (SELECT count(*)::int FROM logs_auditoria a WHERE a.empresa_id = e.id AND a.acao = 'tenant.activate') AS activations,
              (SELECT count(*)::int FROM logs_auditoria a WHERE a.empresa_id = e.id AND a.acao = 'tenant.suspend') AS suspensions,
              (SELECT count(*)::int FROM configuracoes_revisoes r WHERE r.empresa_id = e.id AND r.configuracao_compilada::text LIKE '%' || $2 || '%') AS secret_hits
         FROM empresas e WHERE e.id = $1`,
      [betaId, META_ACCESS_TOKEN],
    )).rows[0];
    assert.equal(state.status, "suspensa");
    assert.equal(state.configuracao_runtime_modo, "versionado");
    assert.equal(Number(state.configuracao_ativa_versao), activated.configVersion);
    assert.equal(state.revisions, 2);
    assert.equal(state.activations, 1);
    assert.equal(state.suspensions, 1);
    assert.equal(state.secret_hits, 0);

    const capitao = (await ownerPool.query("SELECT status FROM empresas WHERE slug = 'capitao-mor' AND deleted_at IS NULL")).rows[0];
    assert.equal(capitao?.status, capitaoStatusBefore);
  } finally {
    await api.close();
    await closeRuntime(runtime);
    await ownerPool.end();
  }
});
