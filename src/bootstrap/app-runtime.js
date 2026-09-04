import { randomUUID } from "node:crypto";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from "node:url";
import { assertMetricsConfiguration, assertRuntimeConfiguration, config as defaultConfig } from "../config.js";
import { createStructuredLogger } from "../operations/logger.js";
import { createHealthService } from "../operations/health.js";
import { createPostgresPool } from "../infra/postgres/pool.js";
import { withTenantTransaction } from "../infra/postgres/transaction.js";
import {
  BullMqJobQueue,
  RedisConversationLockManager,
  RedisTenantConcurrencyLimiter,
  RedisTenantRateLimiter,
  createBullMqWorker,
  createRedisConnection,
} from "../infra/redis/index.js";
import {
  PostgresOutboxRepository,
  PostgresTenantResolver,
  PostgresWebhookRepository,
} from "../infra/postgres/repositories/webhook-repository.js";
import { PostgresConversationRepository } from "../modules/conversations/index.js";
import { PostgresAuthRepository, createSessionTokenCodec, MemoryAuthRateLimiter } from "../modules/auth/index.js";
import { AuthService, authErrorMiddleware, createAuthMiddleware, createAuthRouter, requireCsrf } from "../modules/auth/index.js";
import { AdminService, PostgresAdminRepository, adminErrorMiddleware, createAdminRouter } from "../modules/admin/index.js";
import {
  CAPABILITY_CATALOG_V2,
  PostgresVersionedConfigurationRepository,
  VersionedConfigurationService,
  actionOwnerV2,
  compileTenantRuntimeConfigV2,
  validateActionParamsV2,
} from "../modules/configuration/index.js";
import {
  OnboardingService,
  PostgresOnboardingRepository,
  PreflightService,
  PreviewService,
  ReadinessService,
} from "../modules/onboarding/index.js";
import {
  CredentialVaultService,
  PostgresCredentialRepository,
} from "../modules/secrets/credential-vault-service.js";
import { keyringFromSerialized } from "../security/keyring-config.js";
import {
  PostgresAiConfigResolver,
  PostgresAiLedger,
  AiSecretResolver,
  ResponsesClientFactory,
  VersionedPricingCatalog,
} from "../modules/ai/postgres-adapters.js";
import { MultiTenantAiService } from "../modules/ai/index.js";
import { PostgresTenantDefinitionRepository } from "../tenants/postgres-config-loader.js";
import { ConversationService } from "../modules/conversations/index.js";
import { PostgresFlowRepository } from "../modules/flows/index.js";
import {
  MetaHealthService,
  MetaWebhookConnectionResolver,
  MetaWebhookCredentialResolver,
  PostgresMetaAppRepository,
  createMetaMultiAppIngestionHandler,
  createMetaMultiAppVerificationHandler,
  createMetaMultiAppWebhookService,
} from "../modules/meta/index.js";
import {
  ConversationHandoffRepository,
  PostgresAppointmentRepository,
  PostgresOrderRepository,
} from "../modules/business/repositories.js";
import { PostgresPaymentResolver } from "../modules/business/payment-resolver.js";
import {
  PostgresJobHandlerRepository,
  createWorkerHandlers,
} from "../modules/jobs/handlers.js";
import {
  PostgresJobRepository,
  PostgresOutboxDispatchRepository,
  createJobProcessor,
  createOutboxDispatcher,
  startOutboxDispatcher,
} from "../modules/jobs/index.js";
import {
  createMetaSignatureVerifier,
  createWebhookHandler,
  createWebhookIngestionService,
  createWebhookVerificationHandler,
} from "../modules/webhook/index.js";
import {
  GoogleSheetsCredentialResolver,
  PostgresGoogleSheetsCacheRepository,
  PostgresGoogleSheetsConfigurationResolver,
  PostgresGoogleSheetsSnapshotMapper,
  PostgresIntegrationOperationRepository,
  createGoogleSheetsIntegration,
  createGoogleSheetsSyncRunner,
  createMetaGateway,
  MetaGraphHealthClient,
  legacyCapitaoMorOrderRow,
  startGoogleSheetsSyncScheduler,
} from "../integrations/index.js";
import { GoogleSheetsClient } from "../google-sheets.js";
import { createRetentionRunner, startRetentionScheduler } from "../operations/retention.js";
import { startWorkerHeartbeat } from "../operations/worker-heartbeat.js";
import { createPostgresOperationalLogSink } from "../operations/postgres-log-sink.js";
import { PrivateMediaStore } from "../infra/media/private-media-store.js";
import {
  RedisMetricsRegistry,
  createMetricsHandler,
  createOperationalMetricsCollector,
  recordMetric,
} from "../operations/metrics.js";

const publicDirectory = fileURLToPath(new URL("../../public", import.meta.url));
const panelDirectory = fileURLToPath(new URL("../../panel", import.meta.url));

export async function probeWorkerHeartbeats(redis) {
  let cursor = "0";
  do {
    const result = await redis.scan(cursor, "MATCH", "waia:worker:heartbeat:*", "COUNT", 100);
    cursor = String(result?.[0] ?? "0");
    if (Array.isArray(result?.[1]) && result[1].length > 0) {
      return { state: "healthy" };
    }
  } while (cursor !== "0");
  return { state: "unavailable" };
}

function requiredSecret(value, name) {
  if (!value) throw new Error(`${name} obrigatorio para inicializar a API administrativa.`);
  return value;
}

function jsonParser() {
  return express.json({
    limit: "1mb",
    verify: (request, _response, buffer) => {
      request.rawBody = buffer;
    },
  });
}

function firstMetaMessageId(result) {
  return result?.messages?.[0]?.id || result?.id || null;
}

function referenceId(reference, prefix) {
  const value = String(reference || "").trim();
  return value.startsWith(`${prefix}:`) ? value.slice(prefix.length + 1) : null;
}

function createOnboardingPreflightProbes({
  metaHealthService,
  googleSheetsIntegration,
  credentialVault,
  sharedOpenAiKey,
  environment,
}) {
  const aiClients = new ResponsesClientFactory({ environment });
  const integrationProbe = async ({ empresaId, target, signal }) => {
    if (signal.aborted || target.type !== "google_sheets") return { success: false };
    const result = await googleSheetsIntegration.health({ empresaId, signal });
    return { success: !signal.aborted && result.health === "healthy" };
  };
  return Object.freeze({
    meta: async ({ empresaId, target, signal, actorId, correlationId }) => {
      if (signal.aborted || !metaHealthService) return { success: false };
      const result = await metaHealthService.run({
        empresaId,
        appId: target.applicationId,
        numberId: target.numberId,
        actorId,
        correlationId,
        signal,
      });
      return { success: !signal.aborted && result.success === true };
    },
    ai: async ({ empresaId, target, signal }) => {
      if (signal.aborted || target.provider !== "openai" || !target.model) return { success: false };
      let apiKey = target.keyMode === "shared" ? sharedOpenAiKey : null;
      if (target.keyMode === "own") {
        const credentialId = referenceId(target.credentialRef, "credential");
        if (!credentialVault || !credentialId) return { success: false };
        const metadata = await credentialVault.getCredentialMetadata({ empresaId, credentialId });
        if (metadata?.empresaId !== empresaId || metadata?.provider !== target.provider
            || metadata?.status !== "active" || metadata?.configured !== true) return { success: false };
        apiKey = await credentialVault.getCredentialForUse({ empresaId, credentialId });
      }
      if (!apiKey || signal.aborted) return { success: false };
      try {
        const client = await aiClients.create({ provider: target.provider, apiKey });
        if (typeof client.models?.retrieve !== "function") return { success: false };
        await client.models.retrieve(target.model, { signal });
        return { success: !signal.aborted };
      } finally {
        apiKey = null;
      }
    },
    payments: integrationProbe,
    appointments: integrationProbe,
    integrations: integrationProbe,
  });
}

export function createPostgresRuntime({
  config = defaultConfig,
  pool = createPostgresPool({
    connectionString: config.database.url,
    max: config.database.poolMax,
    statement_timeout: config.database.statementTimeoutMs,
  }),
  redis = createRedisConnection({ url: config.redis.url }),
  logger = null,
  metaHealthClient = null,
} = {}) {
  const logSink = logger ? null : createPostgresOperationalLogSink(pool);
  const runtimeLogger = logger || createStructuredLogger({ level: config.logLevel, service: "waia", sink: logSink });
  const metrics = new RedisMetricsRegistry(redis);
  const conversationRepository = new PostgresConversationRepository(pool);
  const conversationService = new ConversationService({ repository: conversationRepository });
  const mediaStore = new PrivateMediaStore({ root: config.media.storageRoot, maxBytes: config.media.maxBytes });
  const keyring = config.security.masterKeyring
    ? keyringFromSerialized(config.security.masterKeyring)
    : null;
  const credentialRepository = new PostgresCredentialRepository(pool);
  const adminRepository = new PostgresAdminRepository(pool);
  const configurationRepository = new PostgresVersionedConfigurationRepository(pool);
  const configurationService = new VersionedConfigurationService(configurationRepository);
  const flowRepository = new PostgresFlowRepository(pool);
  const metaAppRepository = new PostgresMetaAppRepository(pool);
  const onboardingRepository = new PostgresOnboardingRepository(pool, {
    environment: config.environment,
    platformAiCredentialConfigured: Boolean(config.openai.apiKey),
  });
  const readinessService = new ReadinessService({
    compiler: compileTenantRuntimeConfigV2,
    capabilityCatalog: CAPABILITY_CATALOG_V2,
    actionOwner: actionOwnerV2,
    validateActionParams: validateActionParamsV2,
    flowRuntimeAvailable: true,
  });
  const health = createHealthService({
    database: { health: () => pool.query("SELECT 1").then(() => ({ state: "healthy" })) },
    redis: { health: () => redis.ping().then(() => ({ state: "healthy" })) },
    worker: { health: () => probeWorkerHeartbeats(redis) },
    integrations: {},
  });
  const credentialVault = keyring
    ? new CredentialVaultService({
      repository: credentialRepository,
      keyring,
      auditWriter: { write: (event, { transaction } = {}) => adminRepository.writeAudit({
        id: randomUUID(),
        empresaId: event.empresaId,
        actorId: event.actorId === "system" ? null : event.actorId,
        action: event.action,
        resource: "credentials",
        resourceId: event.credentialId,
        result: "success",
        changedFields: [],
        occurredAt: event.occurredAt,
      }, { transaction }) },
    })
    : null;
  const googleSheetsConfigurationResolver = new PostgresGoogleSheetsConfigurationResolver(pool);
  const googleSheetsSnapshotMapper = new PostgresGoogleSheetsSnapshotMapper(pool);
  const googleSheetsIntegration = createGoogleSheetsIntegration({
    configurationResolver: googleSheetsConfigurationResolver,
    credentialResolver: new GoogleSheetsCredentialResolver(pool, credentialVault),
    clientFactory: ({ spreadsheetId, credentials }) => new GoogleSheetsClient({ spreadsheetId, ...credentials }),
    cacheRepository: new PostgresGoogleSheetsCacheRepository(pool),
    idempotencyRepository: new PostgresIntegrationOperationRepository(pool),
    snapshotMapper: googleSheetsSnapshotMapper.map.bind(googleSheetsSnapshotMapper),
    orderRowMapper: legacyCapitaoMorOrderRow,
    logger: runtimeLogger,
  });
  const metaHealthService = credentialVault
    ? new MetaHealthService({
      repository: metaAppRepository,
      credentialVault,
      client: metaHealthClient || new MetaGraphHealthClient({
        apiVersion: config.whatsapp.apiVersion,
        timeoutMs: config.whatsapp.requestTimeoutMs,
      }),
    })
    : null;
  const previewService = new PreviewService({
    configurationVersionResolver: async ({ empresaId }) => {
      const snapshot = await onboardingRepository.readReadinessSnapshot({ empresaId });
      if (!snapshot) throw new Error("Empresa não encontrada para simulação.");
      return snapshot.nextConfigurationVersion;
    },
  });
  const preflightService = new PreflightService({
    probes: createOnboardingPreflightProbes({
      metaHealthService,
      googleSheetsIntegration,
      credentialVault,
      sharedOpenAiKey: config.openai.apiKey,
      environment: config.environment,
    }),
    timeoutMs: Math.min(60_000, Math.max(10_000, Number(config.whatsapp.requestTimeoutMs || 10_000) + 2_000)),
    auditWriter: (event) => adminRepository.writeAudit({
      id: randomUUID(),
      empresaId: event.empresaId,
      actorId: event.actorId,
      action: event.action,
      resource: event.resource,
      resourceId: event.resourceId,
      result: event.result,
      changedFields: (event.details?.checks || []).map((check) => check.code),
      correlationId: event.correlationId,
      occurredAt: event.occurredAt,
    }),
  });
  const onboardingService = new OnboardingService({
    repository: onboardingRepository,
    configurationService,
    readinessService,
    flowPublisher: flowRepository,
    previewService,
    preflightService,
  });
  const authRepository = new PostgresAuthRepository(pool);
  const tokenCodec = createSessionTokenCodec({
    pepper: requiredSecret(config.security.sessionPepper, "SESSION_PEPPER"),
  });
  const authService = new AuthService({
    repository: authRepository,
    tokenCodec,
    rateLimiter: config.environment === "production"
      ? new RedisAuthRateLimiter(runtimeRedis(redis))
      : new MemoryAuthRateLimiter({ environment: config.environment }),
    audit: { write: (event) => adminRepository.writeAudit({
      id: randomUUID(),
      empresaId: event.empresaId,
      actorId: event.actorUserId,
      action: event.action,
      resource: "auth",
      result: event.result,
      changedFields: [],
      occurredAt: event.occurredAt,
    }) },
  });
  const adminService = new AdminService({
    repository: adminRepository,
    onboardingService,
    credentialVault,
    conversationService,
    flowRepository,
    healthService: health,
    mediaStore,
    googleSheetsIntegration,
    metaAppRepository,
    metaHealthService,
  });
  const aiService = new MultiTenantAiService({
    configResolver: new PostgresAiConfigResolver(pool),
    conversationService,
    clientFactory: new ResponsesClientFactory({ environment: config.environment }),
    secretResolver: new AiSecretResolver({
      sharedApiKey: config.openai.apiKey,
      credentialVault,
    }),
    ledger: new PostgresAiLedger(pool),
    pricingCatalog: new VersionedPricingCatalog(),
    logger: runtimeLogger,
  });
  const tenantDefinitionRepository = new PostgresTenantDefinitionRepository(pool, {
    paymentResolver: new PostgresPaymentResolver(pool, { credentialVault }),
  });
  const metaGateway = createMetaGateway({
    credentialResolver: new PostgresMetaCredentialResolver({
      pool,
      credentialVault,
      apiVersion: config.whatsapp.apiVersion,
    }),
    timeoutMs: config.whatsapp.requestTimeoutMs,
    logger: runtimeLogger,
  });
  const webhookIngestionService = createWebhookIngestionService({
    tenantResolver: new PostgresTenantResolver(pool),
    repository: new PostgresWebhookRepository(pool),
    outbox: new PostgresOutboxRepository(),
    logger: runtimeLogger,
    metrics,
  });
  const metaWebhookService = createMetaMultiAppWebhookService({
    connectionResolver: new MetaWebhookConnectionResolver({ repository: metaAppRepository }),
    credentialVault: new MetaWebhookCredentialResolver({
      credentialVault,
      sharedAppSecret: config.whatsapp.appSecret,
      sharedVerifyToken: config.whatsapp.verifyToken,
    }),
    ingestionService: {
      async ingestEvents(events, context) {
        const results = await webhookIngestionService.ingestEvents(events, {
          correlationId: context?.correlationId,
        });
        await metaAppRepository.recordValidWebhook({
          empresaId: context.metaContext.empresaId,
          appId: context.metaContext.metaApplicationId,
        });
        return results;
      },
    },
    logger: runtimeLogger,
  });
  const queue = new BullMqJobQueue({
    connection: redis,
    queueName: config.redis.queueName,
  });
  return Object.freeze({
    pool,
    redis,
    logger: runtimeLogger,
    logSink,
    conversationService,
    flowRepository,
    mediaStore,
    adminService,
    onboardingService,
    authService,
    aiService,
    tenantDefinitionRepository,
    metaGateway,
    metaAppRepository,
    metaHealthService,
    metaWebhookService,
    queue,
    health,
    metrics,
    googleSheetsIntegration,
    googleSheetsConfigurationResolver,
  });
}

function runtimeRedis(redis) {
  return redis;
}

class RedisAuthRateLimiter {
  constructor(redis, { maxAttempts = 5, windowMs = 15 * 60_000, prefix = "waia:auth-rate:" } = {}) {
    if (typeof redis?.multi !== "function") throw new TypeError("Cliente Redis invalido.");
    this.redis = redis;
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.prefix = prefix;
  }

  async consume({ key }) {
    const bucket = Math.floor(Date.now() / this.windowMs);
    const redisKey = `${this.prefix}${key}:${bucket}`;
    const result = await this.redis.multi().incr(redisKey).pexpire(redisKey, this.windowMs).pttl(redisKey).exec();
    const current = Number(result?.[0]?.[1] || 0);
    const ttl = Number(result?.[2]?.[1] || this.windowMs);
    return {
      allowed: current <= this.maxAttempts,
      retryAfterMs: Math.max(1, ttl),
      remaining: Math.max(0, this.maxAttempts - current),
    };
  }
}

export class PostgresMetaCredentialResolver {
  constructor({ pool, credentialVault, apiVersion, transactionRunner = withTenantTransaction }) {
    this.pool = pool;
    this.credentialVault = credentialVault;
    this.apiVersion = apiVersion;
    this.transactionRunner = transactionRunner;
  }

  async resolveMeta({ empresaId, numeroWhatsappId }) {
    if (!this.credentialVault) return null;
    const number = await this.transactionRunner(this.pool, { empresaId }, async ({ client }) => (
      await client.query(
        `SELECT nw.phone_number_id, nw.aplicativo_meta_id, nw.access_token_credencial_id,
                am.estado AS aplicativo_estado
           FROM numeros_whatsapp nw
           LEFT JOIN aplicativos_meta am
             ON am.empresa_id = nw.empresa_id
            AND am.id = nw.aplicativo_meta_id
            AND am.deleted_at IS NULL
          WHERE nw.empresa_id = $1 AND nw.id = $2 AND nw.deleted_at IS NULL`,
        [empresaId, numeroWhatsappId],
      )
    ).rows[0]);
    if (!number) return null;
    if (number.aplicativo_meta_id || number.access_token_credencial_id) {
      if (number.aplicativo_estado !== "ativo" || !number.access_token_credencial_id) return null;
      const accessToken = await this.credentialVault.getCredentialForUse({
        empresaId,
        credentialId: number.access_token_credencial_id,
      });
      return { accessToken, phoneNumberId: number.phone_number_id, apiVersion: this.apiVersion };
    }
    const legacyCredential = await this.transactionRunner(this.pool, { empresaId }, async ({ client }) => (
      await client.query(
        `SELECT id
           FROM credenciais_empresa
          WHERE empresa_id = $1
            AND provedor = 'meta'
            AND status = 'ativa'
            AND finalidade IN ($2, 'whatsapp')
          ORDER BY CASE WHEN finalidade = $2 THEN 0 ELSE 1 END, created_at DESC
          LIMIT 1`,
        [empresaId, `whatsapp:${numeroWhatsappId}`],
      )
    ).rows[0]);
    if (!legacyCredential) return null;
    const accessToken = await this.credentialVault.getCredentialForUse({
      empresaId,
      credentialId: legacyCredential.id,
    });
    return {
      accessToken,
      phoneNumberId: number.phone_number_id,
      apiVersion: this.apiVersion,
    };
  }
}

export function createApiApp({
  runtime,
  config = defaultConfig,
  logger = runtime?.logger || console,
} = {}) {
  if (!runtime) throw new TypeError("runtime e obrigatorio.");
  const app = express();
  const metricsCollector = runtime.metrics && runtime.pool
    ? createOperationalMetricsCollector({ metrics: runtime.metrics, pool: runtime.pool, queue: runtime.queue, redis: runtime.redis })
    : null;
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({
    contentSecurityPolicy: false,
  }));
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 1_200,
    standardHeaders: true,
    legacyHeaders: false,
  }));
  app.use((request, _response, next) => {
    request.context = { correlationId: request.get("x-correlation-id") || randomUUID() };
    next();
  });
  app.use((request, response, next) => {
    const started = process.hrtime.bigint();
    response.once("finish", () => {
      void recordMetric(runtime.metrics, "increment", "waia_http_requests_total");
      if (response.statusCode >= 400 && response.statusCode < 500) void recordMetric(runtime.metrics, "increment", "waia_http_client_errors_total");
      if (response.statusCode >= 500) void recordMetric(runtime.metrics, "increment", "waia_http_server_errors_total");
      void recordMetric(runtime.metrics, "observe", "waia_http_request_duration_seconds", Number(process.hrtime.bigint() - started) / 1e9);
    });
    next();
  });
  app.use(jsonParser());
  app.get("/health/live", (_request, response) => response.json(runtime.health.live()));
  app.get("/health/ready", async (request, response, next) => {
    try {
      const ready = await runtime.health.ready();
      response.status(ready.status === "ready" ? 200 : 503).json(ready);
    } catch (error) {
      next(error);
    }
  });
  app.get("/metrics", metricsCollector
    ? createMetricsHandler({ collector: metricsCollector, token: config.metrics?.bearerToken })
    : (_request, response) => response.status(404).end());
  app.get("/privacy", (_request, response) => response.sendFile("privacy.html", { root: publicDirectory }));
  app.get("/data-deletion", (_request, response) => response.sendFile("data-deletion.html", { root: publicDirectory }));
  app.use("/panel", express.static(panelDirectory, { index: "index.html" }));
  if (runtime.metaWebhookService) {
    app.get("/webhook/meta/:webhookPublicId", createMetaMultiAppVerificationHandler({ service: runtime.metaWebhookService }));
    app.post("/webhook/meta/:webhookPublicId", createMetaMultiAppIngestionHandler({ service: runtime.metaWebhookService }));
  }
  app.get("/webhook", createWebhookVerificationHandler({ verifyToken: config.whatsapp.verifyToken }));
  app.post("/webhook", createWebhookHandler({
    signatureVerifier: createMetaSignatureVerifier({
      appSecret: config.whatsapp.appSecret,
      allowUnsigned: config.environment !== "production",
    }),
    ingestionService: createWebhookIngestionService({
      tenantResolver: new PostgresTenantResolver(runtime.pool),
      repository: new PostgresWebhookRepository(runtime.pool),
      outbox: new PostgresOutboxRepository(),
      logger,
      metrics: runtime.metrics,
    }),
    logger,
  }));
  const authRouter = createAuthRouter({
    authService: runtime.authService,
    secureCookies: config.security.cookieSecure,
    sessionTtlMs: config.security.sessionTtlHours * 60 * 60_000,
  });
  app.use("/api/admin/auth", authRouter);
  app.use("/api/admin", createAdminRouter({
    adminService: runtime.adminService,
    authenticate: createAuthMiddleware({ authService: runtime.authService }),
    csrf: requireCsrf({ authService: runtime.authService }),
    sensitiveRateLimit: rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  }));
  app.use((error, _request, response, next) => {
    if (error?.status === 400 && error?.type === "entity.parse.failed") {
      return response.status(400).json({
        error: "INVALID_JSON",
        message: "O corpo da solicitacao deve conter JSON valido.",
      });
    }
    return next(error);
  });
  app.use(authErrorMiddleware);
  app.use(adminErrorMiddleware);
  app.use((error, request, response, _next) => {
    logger.error?.("api_request_failed", {
      correlationId: request.context?.correlationId,
      error,
    });
    response.status(500).json({ error: "INTERNAL_ERROR", message: "Nao foi possivel concluir a solicitacao." });
  });
  return app;
}

export function createWorkerRuntime({
  runtime,
  config = defaultConfig,
  logger = runtime?.logger || console,
} = {}) {
  if (!runtime) throw new TypeError("runtime e obrigatorio.");
  const jobRepository = new PostgresJobRepository(runtime.pool);
  const handlerRepository = new PostgresJobHandlerRepository(runtime.pool);
  const processor = createJobProcessor({
    repository: jobRepository,
    handlers: createWorkerHandlers({
      repository: handlerRepository,
      conversationService: runtime.conversationService,
      tenantDefinitionRepository: runtime.tenantDefinitionRepository,
      metaGateway: runtime.metaGateway,
      aiService: runtime.aiService,
      orderRepository: new PostgresOrderRepository(runtime.pool),
      appointmentRepository: new PostgresAppointmentRepository(runtime.pool),
      handoffRepository: new ConversationHandoffRepository(runtime.conversationService),
      flowRepository: runtime.flowRepository,
      mediaStore: runtime.mediaStore,
      googleSheetsIntegration: runtime.googleSheetsIntegration,
      logger,
      firstMetaMessageId,
    }),
    lockManager: new RedisConversationLockManager(runtime.redis),
    tenantLimiter: new RedisTenantConcurrencyLimiter(runtime.redis, {
      maxPerTenant: config.redis.tenantConcurrency,
    }),
    tenantRateLimiter: new RedisTenantRateLimiter(runtime.redis),
    logger,
    metrics: runtime.metrics,
  });
  const worker = createBullMqWorker({
    connection: runtime.redis,
    queueName: config.redis.queueName,
    concurrency: config.redis.workerConcurrency,
    processor,
    logger,
  });
  const dispatcher = startOutboxDispatcher(createOutboxDispatcher({
    repository: new PostgresOutboxDispatchRepository(runtime.pool),
    queue: runtime.queue,
    logger,
    metrics: runtime.metrics,
  }), { logger });
  const retention = startRetentionScheduler(createRetentionRunner({
    pool: runtime.pool,
    conversationService: runtime.conversationService,
    flowRepository: runtime.flowRepository,
    mediaStore: runtime.mediaStore,
    batchSize: config.maintenance.retentionBatchSize,
    logger,
  }), { intervalMs: config.maintenance.retentionIntervalMs, logger });
  const googleSheets = startGoogleSheetsSyncScheduler(createGoogleSheetsSyncRunner({
    configurationResolver: runtime.googleSheetsConfigurationResolver,
    integration: runtime.googleSheetsIntegration,
    logger,
  }), { intervalMs: config.maintenance.googleSheetsSyncIntervalMs, logger });
  const heartbeat = startWorkerHeartbeat(runtime.redis, {
    intervalMs: config.maintenance.heartbeatIntervalMs,
    ttlMs: config.maintenance.heartbeatTtlMs,
    logger,
  });
  return Object.freeze({
    processor,
    worker,
    dispatcher,
    retention,
    googleSheets,
    heartbeat,
    async close() {
      await dispatcher.close();
      await retention.close();
      await googleSheets.close();
      await heartbeat.close();
      await worker.close();
      await runtime.queue.close();
    },
  });
}

export function assertConfigured(config = defaultConfig, { metrics = false } = {}) {
  assertRuntimeConfiguration(config);
  if (metrics) assertMetricsConfiguration(config);
  if (config.infrastructureMode !== "postgres") {
    throw new Error("API e worker oficiais exigem INFRASTRUCTURE_MODE=postgres.");
  }
  if (!config.database.url) {
    throw new Error("DATABASE_URL obrigatorio em INFRASTRUCTURE_MODE=postgres.");
  }
  if (!config.redis.url) {
    throw new Error("REDIS_URL obrigatorio em INFRASTRUCTURE_MODE=postgres.");
  }
}
