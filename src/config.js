import "dotenv/config";

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} precisa ser um número.`);
  return value;
}

export const config = {
  environment: process.env.NODE_ENV || "development",
  infrastructureMode: process.env.INFRASTRUCTURE_MODE || "memory",
  logLevel: process.env.LOG_LEVEL || "info",
  webhookPort: numberFromEnv("WEBHOOK_PORT", 3001),
  database: {
    url: process.env.DATABASE_URL,
    poolMax: numberFromEnv("DATABASE_POOL_MAX", 10),
    statementTimeoutMs: numberFromEnv("DATABASE_STATEMENT_TIMEOUT_MS", 15_000),
  },
  redis: {
    url: process.env.REDIS_URL,
    queueName: process.env.REDIS_QUEUE_NAME || "waia-messages",
    workerConcurrency: numberFromEnv("WORKER_CONCURRENCY", 4),
    tenantConcurrency: numberFromEnv("TENANT_CONCURRENCY", 1),
  },
  maintenance: {
    retentionIntervalMs: numberFromEnv("RETENTION_INTERVAL_MS", 3_600_000),
    retentionBatchSize: numberFromEnv("RETENTION_BATCH_SIZE", 500),
    heartbeatIntervalMs: numberFromEnv("WORKER_HEARTBEAT_INTERVAL_MS", 10_000),
    heartbeatTtlMs: numberFromEnv("WORKER_HEARTBEAT_TTL_MS", 30_000),
  },
  security: {
    masterKeyring: process.env.MASTER_KEYRING,
    sessionPepper: process.env.SESSION_PEPPER,
    cookieSecure: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === "true"
      : process.env.NODE_ENV === "production",
    sessionTtlHours: numberFromEnv("SESSION_TTL_HOURS", 12),
    allowedPanelOrigin: process.env.PANEL_ORIGIN || "http://localhost:3000",
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    maxOutputTokens: numberFromEnv("OPENAI_MAX_OUTPUT_TOKENS", 300),
  },
  whatsapp: {
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    apiVersion: process.env.WHATSAPP_API_VERSION || "v26.0",
    appSecret: process.env.META_APP_SECRET,
    requestTimeoutMs: numberFromEnv("WHATSAPP_REQUEST_TIMEOUT_MS", 15_000),
  },
  legacyCapitaoMorWhatsapp: {
    accessToken: process.env.CAPITAO_MOR_WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: process.env.CAPITAO_MOR_WHATSAPP_PHONE_NUMBER_ID,
  },
  googleSheets: {
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
    clientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    credentialsFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE || ".secrets/google-service-account.json",
    syncIntervalMs: numberFromEnv("GOOGLE_SHEETS_SYNC_INTERVAL_MS", 120_000),
  },
};

export function assertRuntimeConfiguration(current = config) {
  if (current.environment !== "production") return;
  const missing = [];
  if (current.infrastructureMode !== "postgres") missing.push("INFRASTRUCTURE_MODE=postgres");
  if (!current.database.url) missing.push("DATABASE_URL");
  if (!current.redis.url) missing.push("REDIS_URL");
  if (!current.security.masterKeyring) missing.push("MASTER_KEYRING");
  if (!current.security.sessionPepper) missing.push("SESSION_PEPPER");
  if (!current.whatsapp.verifyToken) missing.push("WHATSAPP_VERIFY_TOKEN");
  if (!current.whatsapp.appSecret) missing.push("META_APP_SECRET");
  if (missing.length) {
    throw new Error(`Configuração de produção incompleta: ${missing.join(", ")}.`);
  }
}
