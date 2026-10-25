import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';
import { runMigrations } from '../src/infra/postgres/migrations.js';
import { withPlatformTransaction, withTenantTransaction } from '../src/infra/postgres/transaction.js';
import { hashPassword, verifyPassword } from '../src/modules/auth/password.js';
import { VersionedKeyring } from '../src/security/versioned-keyring.js';
import { CredentialVaultService, PostgresCredentialRepository } from '../src/modules/secrets/credential-vault-service.js';
import { PrivateMediaStore } from '../src/infra/media/private-media-store.js';
import { PostgresOutboxDispatchRepository, PostgresJobRepository } from '../src/modules/jobs/postgres-repository.js';
import { normalizeJobReference } from '../src/modules/jobs/job-reference.js';

// Technical fixture only. Not a tenant provisioning path or a production restore.
assert.equal(process.env.M9_SYNTHETIC_CONFIRM, 'tmpfs-only');
assert.equal(process.env.NODE_ENV, 'test');
const url = new URL(process.env.DATABASE_MIGRATOR_URL);
const appUrl = new URL(process.env.DATABASE_URL);
assert.match(url.hostname, /^waia-test-m9-(source|restore)-[a-f0-9]{8}$/);
assert.equal(url.pathname, '/waia_v2_empty');
assert.equal(url.username, 'waia_v2_owner');
assert.equal(appUrl.username, 'waia_v2_app');
assert.equal(url.host, appUrl.host); assert.equal(url.pathname, appUrl.pathname);
const owner = new pg.Pool({ connectionString: url.href, max: 2 });
const app = new pg.Pool({ connectionString: appUrl.href, max: 2 });
const mode = process.argv[2];
let stage = mode;
const keyring = VersionedKeyring.fromBase64(JSON.parse(process.env.M9_KEYRING));
const media = new PrivateMediaStore({ root: '/drill/media' });
const vault = new CredentialVaultService({ repository: new PostgresCredentialRepository(owner), keyring,
  auditWriter: async () => {} }); // Synthetic crypto canary, no product mutation claim.
const platform = (callback) => withPlatformTransaction(owner, {}, callback);
function edgeRequest(url, { method = 'GET', headers = {}, body } = {}) {
  // fetch/Undici rewrites Host to the connection URL. A raw HTTP client is
  // required to probe a virtual HTTPS origin through this local HTTP harness.
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      const parts = []; response.on('data', (part) => parts.push(part)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode,
        headers: { get(name) { const value = response.headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value; } },
        async json() { return JSON.parse(Buffer.concat(parts).toString('utf8')); } }));
    });
    request.on('error', reject); request.end(body);
  });
}
async function snapshot() {
  return platform(async ({ client }) => {
    const names = (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows;
    const result = {};
    for (const { tablename } of names) {
      assert.match(tablename, /^[a-z_]+$/);
      const rows = (await client.query(`SELECT row_to_json(t) AS value FROM "${tablename}" t`)).rows
        .map((r) => JSON.stringify(r.value)).sort();
      result[tablename] = { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
    }
    return result;
  });
}
try {
  if (mode === 'install') {
    assert.equal((await owner.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
    assert.equal((await runMigrations(owner)).applied.length, 30);
    console.log(JSON.stringify({ status: 'passed', stage: 'empty-install', migrations: 30, productSeed: false }));
  } else if (mode === 'prepare') {
    assert.equal((await runMigrations(owner)).applied.length, 0);
    const state = { customerId: randomUUID(), companyId: randomUUID(), credentialId: randomUUID(), mediaId: randomUUID(),
      pendingId: randomUUID(), completedId: randomUUID(), correlationId: randomUUID() };
    stage = 'bootstrap';
    const password = process.env.M9_ADMIN_PASSWORD;
    assert.ok(password?.length >= 32);
    const passwordHash = await hashPassword(password);
    await platform(async ({ client }) => {
      assert.equal((await client.query('SELECT count(*)::int n FROM usuarios')).rows[0].n, 1);
      const admin = (await client.query("SELECT * FROM usuarios WHERE email='admin.drill@waia.example'")).rows[0];
      assert.equal(admin.papel_plataforma, 'administrador');
      assert.ok(await verifyPassword(password, admin.password_hash)); state.adminId = admin.id;
      // Independent technical customer for Secure-cookie smoke, not a real access.
      await client.query(`INSERT INTO usuarios(id,email,nome,password_hash,papel_plataforma,email_verified_at)
        VALUES($1,'customer.drill@waia.example','Cliente sintético M9',$2,'nenhum',now())`, [state.customerId, passwordHash]);
      await client.query(`INSERT INTO empresas(id,slug,nome,nome_exibicao,status)
        VALUES($1,'m9-recovery-synthetic','Empresa sintética M9','Empresa sintética M9','suspensa')`, [state.companyId]);
    });
    stage = 'synthetic-canaries';
    await vault.createCredential({ empresaId: state.companyId, credentialId: state.credentialId,
      provider: 'synthetic', purpose: 'restore-canary', secret: process.env.M9_CREDENTIAL_CANARY, actorId: state.adminId });
    state.media = await media.put({ empresaId: state.companyId, messageId: state.mediaId,
      data: Buffer.from('M9 synthetic private media; no personal data.\n'), mimeType: 'application/pdf' });
    await platform(async ({ client }) => {
      for (const [id, status] of [[state.pendingId, 'pendente'], [state.completedId, 'concluido']]) {
        await client.query(`INSERT INTO outbox_jobs(id,empresa_id,job_type,dedup_key,payload,status,correlation_id)
          VALUES($1::uuid,$2,'m9_synthetic_noop',$1::text,'{"payloadVersion":1}',$3,$4)`, [id, state.companyId, status, state.correlationId]);
      }
    });
    state.snapshot = await snapshot();
    await mkdir('/drill', { recursive: true });
    await writeFile('/drill/state.json', JSON.stringify(state), { mode: 0o600 });
    console.log(JSON.stringify({ status: 'passed', stage: 'fresh-install-bootstrap-canaries', migrations: 30,
      companies: 1, administrators: 1, technicalCustomers: 1, credentials: 1, media: 1, jobs: 2, productSeed: false }));
  } else {
    const state = JSON.parse(await readFile('/drill/state.json', 'utf8'));
    if (mode === 'verify') {
      stage = 'restored-state';
      assert.equal((await runMigrations(owner)).applied.length, 0);
      assert.deepEqual(await snapshot(), state.snapshot);
      const admin = await platform(async ({ client }) => (await client.query('SELECT * FROM usuarios WHERE id=$1', [state.adminId])).rows[0]);
      assert.equal(admin.papel_plataforma, 'administrador');
      assert.ok(await verifyPassword(process.env.M9_ADMIN_PASSWORD, admin.password_hash));
      assert.equal(await vault.getCredentialForUse({ empresaId: state.companyId, credentialId: state.credentialId }), process.env.M9_CREDENTIAL_CANARY);
      assert.ok((await media.read({ empresaId: state.companyId, storageKey: state.media.storageKey, expectedSha256: state.media.sha256 })).length > 0);
      const role = (await app.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
      assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
      assert.equal((await app.query('SELECT * FROM empresas')).rowCount, 0);
      assert.equal((await withTenantTransaction(app, { empresaId: randomUUID() }, ({ client }) => client.query('SELECT * FROM credenciais_empresa'))).rowCount, 0);
      await platform(async ({ client }) => {
        const missing = (await client.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'schema_migrations'
          AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`)).rows[0].n;
        assert.equal(missing, 0);
      });
      console.log(JSON.stringify({ status: 'passed', stage: 'restore-verified', tables: Object.keys(state.snapshot).length,
        rowsAndHashesEqual: true, ledgerAndSchema: 'compatible-30', migrationReapply: 0,
        administratorPassword: 'verified', vaultDecryption: 'verified', mediaChecksum: 'matched', rls: 'forced-and-denied' }));
    } else if (mode === 'jobs-verify') {
      stage = 'rc-jobs-after-rollback';
      const jobs = new PostgresJobRepository(app);
      for (const jobId of [state.pendingId, state.completedId]) {
        assert.equal((await jobs.claim(normalizeJobReference({ jobId, empresaId: state.companyId,
          type: 'm9_synthetic_noop', correlationId: state.correlationId, payloadVersion: 1 }))).outcome, 'completed');
      }
      assert.equal((await new PostgresOutboxDispatchRepository(app).claimBatch({ limit: 10 })).length, 0);
      console.log(JSON.stringify({ status: 'passed', stage, completedReplaysDenied: 2, pending: 0, outboundCalls: 0 }));
    } else if (mode === 'jobs') {
      stage = 'rollback-jobs';
      const reference = normalizeJobReference({ jobId: state.completedId, empresaId: state.companyId,
        type: 'm9_synthetic_noop', correlationId: state.correlationId, payloadVersion: 1 });
      const jobs = new PostgresJobRepository(app);
      assert.equal((await jobs.claim(reference)).outcome, 'completed');
      const dispatch = new PostgresOutboxDispatchRepository(app);
      const claimed = await dispatch.claimBatch({ limit: 10 });
      assert.equal(claimed.length, 1); assert.equal(claimed[0].jobId, state.pendingId);
      const pending = normalizeJobReference(claimed[0]); assert.equal(pending.payloadVersion, 1);
      await dispatch.markPublished(pending);
      assert.equal((await jobs.claim(pending)).outcome, 'claimed');
      await jobs.complete(pending);
      assert.equal((await jobs.claim(pending)).outcome, 'completed');
      assert.equal((await dispatch.claimBatch({ limit: 10 })).length, 0);
      console.log(JSON.stringify({ status: 'passed', stage: 'compatible-jobs', payloadVersion: 1,
        completedReplay: 'denied', pendingReconciled: 1, outboundCalls: 0 }));
    } else if (mode === 'api' || mode === 'gateway') {
      stage = 'release-api-smoke';
      // Actual application and repositories; no email/attendance worker is started.
      const { config } = await import('../src/config.js');
      config.environment = 'test'; config.infrastructureMode = 'postgres';
      config.database.url = appUrl.href; config.redis.url = process.env.REDIS_URL;
      config.accounts.enabled = true; config.accounts.emailMode = 'fake';
      config.accounts.origin = 'https://portal.waia.example';
      config.security.masterKeyring = process.env.M9_KEYRING;
      config.security.sessionPepper = process.env.M9_SESSION_PEPPER;
      config.security.cookieSecure = true; config.security.allowedPanelOrigin = 'https://admin.waia.example';
      config.security.adminNetworkAllowlist = '192.0.2.1/32'; config.media.storageRoot = '/drill/media';
      const { createPostgresRuntime, createApiApp } = await import('../src/bootstrap/app-runtime.js');
      const runtime = createPostgresRuntime({ config });
      const server = createServer(createApiApp({ runtime, config, logger: { error() {} } }));
      let gateway;
      try {
        await runtime.redis.ping();
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;
        for (const path of ['/portal/', '/portal/app.js', '/panel/attendance-script.js', '/health/ready']) {
          const response = await fetch(base + path); assert.equal(response.status, 200); await response.arrayBuffer();
        }
        const account = await fetch(base + '/api/account/v1/session'); assert.equal(account.status, 401);
        const denied = await fetch(base + '/api/admin/companies', { headers: { 'x-forwarded-for': '203.0.113.5' } });
        assert.equal(denied.status, 403);
        if (mode === 'gateway') {
          const { createV2Ingress } = await import('../src/operations/v2-ingress.js');
          gateway = createV2Ingress({ surface: 'public', origin: config.accounts.origin, upstream: base });
          gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
          const edge = `http://127.0.0.1:${gateway.address().port}`;
          const headers = { host: 'portal.waia.example', origin: config.accounts.origin, 'content-type': 'application/json' };
          stage = 'gateway-login';
          const login = await edgeRequest(edge + '/api/account/v1/login', { method: 'POST', headers,
            body: JSON.stringify({ email: 'customer.drill@waia.example', password: process.env.M9_ADMIN_PASSWORD }) });
          assert.equal(login.status, 200);
          stage = 'gateway-cookie';
          const cookie = login.headers.get('set-cookie');
          assert.match(cookie, /HttpOnly/i); assert.match(cookie, /Secure/i); assert.match(cookie, /SameSite=Lax/i);
          assert.doesNotMatch(cookie, /Domain=/i);
          const issued = await login.json();
          const customerHeaders = { ...headers, cookie: cookie.split(';')[0], 'x-csrf-token': issued.csrfToken,
            'x-forwarded-for': '127.0.0.1', 'x-original-url': '/api/admin' };
          const companies = await edgeRequest(edge + '/api/app/v1/companies', { headers: customerHeaders });
          stage = 'gateway-companies';
          assert.equal(companies.status, 200);
          for (const path of ['/api/admin/companies', '/metrics', '/panel/']) {
            stage = 'gateway-denial';
            assert.equal((await edgeRequest(edge + path, { headers: customerHeaders })).status, 404);
          }
          assert.equal((await edgeRequest(edge + '/portal/', { headers })).status, 200);
        }
        console.log(JSON.stringify({ status: 'passed', stage: 'api-smoke', apiAndAssets: true,
          unauthorizedCustomer: 401, deniedAdmin: 403, gatewayRealLoginAndCookie: mode === 'gateway',
          email: 'fake-not-sent', worker: 'not-started' }));
      } finally {
        if (gateway) { gateway.closeAllConnections(); await new Promise((resolve) => gateway.close(resolve)); }
        server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
        await runtime.queue.close(); await runtime.redis.quit(); await runtime.pool.end();
      }
    } else throw new Error('Unknown fixture mode');
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', stage, actual: typeof error?.actual === 'number' ? error.actual : undefined,
    code: /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'CHECK_FAILED' }));
  process.exitCode = 1;
} finally { keyring.destroy(); await owner.end(); await app.end(); }
