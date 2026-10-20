import "dotenv/config";
import { config } from "./config.js";
import { createPostgresPool } from "./infra/postgres/pool.js";
import { keyringFromSerialized } from "./security/keyring-config.js";
import { PostgresGroupNotifierRepository } from "./modules/group-notifier/postgres-repository.js";
import { createGroupNotifierWorker } from "./modules/group-notifier/worker.js";

// Isolated process: libsignal may otherwise print cryptographic sessions directly.
const report = console.error.bind(console);
for (const key of ["log", "info", "warn", "error", "debug", "trace", "dir"]) console[key] = () => {};
if (!config.security.masterKeyring) throw new Error("MASTER_KEYRING obrigatório para o remetente central.");
const pool = createPostgresPool({ connectionString: config.database.url, max: config.database.poolMax, statement_timeout: config.database.statementTimeoutMs });
const repository = new PostgresGroupNotifierRepository(pool, keyringFromSerialized(config.security.masterKeyring));
const worker = createGroupNotifierWorker({ repository, logger: {
  warn(eventCode, metadata) { report(JSON.stringify({ timestamp: new Date().toISOString(), eventCode, ...metadata })); },
} });
let closing = false;
const stop = async () => {
  if (closing) return; closing = true;
  clearInterval(loop); clearInterval(heartbeat);
  try { await worker.close(); } finally { await pool.end(); }
};
const run = () => { if (!closing) void worker.tick().catch(() => {}); }; // Worker reports allowlisted stage/code only.
const loop = setInterval(run, 2000);
const heartbeat = setInterval(() => { if (!closing) void worker.pulse().catch(() => { void stop(); }); }, 5000);
process.once("SIGTERM", () => void stop()); process.once("SIGINT", () => void stop());
const fatal = () => { report("Remetente central interrompido. Diagnóstico disponível somente por estado sanitizado."); void stop(); };
process.once("uncaughtException", fatal); process.once("unhandledRejection", fatal);
run();
