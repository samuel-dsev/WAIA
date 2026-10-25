import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import Redis from 'ioredis';
import { createM1Fixture, fixturePassword } from '../test/support/m1-fixtures.js';
import { AttendanceService } from '../src/modules/attendance/attendance-service.js';
import { AccountRateLimiter } from '../src/modules/accounts/rate-limiter.js';
import { PostgresVersionedConfigurationRepository, VersionedConfigurationService,
  CAPABILITY_CATALOG_V2, actionOwnerV2, compileTenantRuntimeConfigV2, validateActionParamsV2 } from '../src/modules/configuration/index.js';
import { OnboardingService, PostgresOnboardingRepository, ReadinessService } from '../src/modules/onboarding/index.js';

// Repository fixtures only, in the previously verified synthetic upgrade DB.
// This never provisions product customers, reaches a provider or starts a worker.
const arg = process.argv.find((value) => value.startsWith('--duration-seconds='));
const seconds = arg ? Number(arg.split('=')[1]) : 600;
assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600);
assert.equal(process.env.NODE_ENV, 'test');
for (const key of ['DATABASE_URL', 'DATABASE_MIGRATOR_URL']) {
  const url = new URL(process.env[key]);
  assert.equal(url.hostname, 'v2-postgres'); assert.equal(url.port, '5432');
  assert.equal(url.pathname, '/waia_v2_empty'); assert.equal(url.search, ''); assert.equal(url.hash, '');
  assert.match(url.username, /^waia_v2_/);
  url.pathname = '/waia_v2_upgrade'; process.env[key] = url.href;
}
const redisUrl = new URL(process.env.REDIS_URL);
assert.equal(redisUrl.hostname, 'v2-redis'); assert.equal(redisUrl.port, '6379'); assert.equal(redisUrl.pathname, '/0');
assert.equal(redisUrl.search, ''); assert.equal(redisUrl.hash, '');
const permissions = ['attendance.read', 'attendance.edit', 'attendance.simulate', 'attendance.publish'];
const config = (company, index) => ({ schemaVersion: 2,
  identity: { name: company.name, displayName: company.name, locale: 'pt-BR', timezone: 'America/Sao_Paulo',
    welcomeMessage: `Saudação sintética ${index}`, fallbackMessage: 'Como posso ajudar?' },
  retention: { messagesDays: 30, logsDays: 30 },
  modules: ['catalog', 'ai_freeform', 'human_handoff'],
  menu: { text: `Menu sintético ${index}`, options: [{ id: 'catalogo', label: 'Catálogo', action: 'catalog.list', params: {} }] },
  routing: { greetings: ['oi'], aliases: [{ terms: ['endereço'], action: 'catalog.address', params: {} }], fallbackAction: 'ai_freeform.reply' },
  publicReplies: [{ action: 'catalog.address', text: `Endereço fictício ${index}.` }],
  ai: { enabled: true, provider: 'simulated', model: 'm8-private-model', keyMode: 'simulated', prompt: `M8 roteiro exclusivo ${index}` },
  humanHandoff: { channel: 'manual', message: 'Aguarde a equipe.', cooldownSeconds: 30 }, integrations: [],
});
async function technical(f, company, actor) {
  const suffix = randomUUID();
  const number = (await f.owner.query(`INSERT INTO numeros_whatsapp
    (empresa_id,phone_number_id,waba_id,numero_e164,numero_mascarado,status,principal)
    VALUES($1,$2,$3,'+551100000001','••••0001','ativo',true) RETURNING id`,
  [company.id, `m8-synthetic-phone-${suffix}`, `m8-synthetic-waba-${suffix}`])).rows[0].id;
  const credentials = (await f.owner.query(`INSERT INTO credenciais_empresa
    (empresa_id,provedor,finalidade,secret_ciphertext,secret_kdf_salt,secret_nonce,secret_tag,key_version,valor_mascarado,created_by)
    SELECT $1,'meta',purpose,decode(repeat('11',32),'hex'),decode(repeat('22',16),'hex'),
      decode(repeat('33',12),'hex'),decode(repeat('44',16),'hex'),'v1','••••synthetic',$2
    FROM unnest(ARRAY['whatsapp:'||$3::text,'meta-app-secret','meta-verify-token']) AS purpose RETURNING id,finalidade`,
  [company.id, actor.id, number])).rows;
  const byPurpose = Object.fromEntries(credentials.map((row) => [row.finalidade, row.id]));
  const app = (await f.owner.query(`INSERT INTO aplicativos_meta
    (empresa_id,nome,app_id,modo,estado,app_secret_credencial_id,verify_token_credencial_id,created_by,updated_by)
    VALUES($1,'Aplicativo sintético M8',$2,'proprio','ativo',$3,$4,$5,$5) RETURNING id`,
  [company.id, `m8-synthetic-app-${suffix}`, byPurpose['meta-app-secret'], byPurpose['meta-verify-token'], actor.id])).rows[0].id;
  await f.owner.query('UPDATE numeros_whatsapp SET aplicativo_meta_id=$2,access_token_credencial_id=$3 WHERE id=$1',
    [number, app, byPurpose[`whatsapp:${number}`]]);
}

let f, pool, redis, stage = 'setup';
const metrics = { completed: 0, successfulReads: 0, expectedDenials: 0, unexpected5xx: 0, errors: 0,
  leakage: 0, droppedSlots: 0, maxInflight: 0, publicationCycles: 0, publicationConflicts: 0, uniquePublications: 0 };
const samples = [], jobs = new Set(), sessions = [], companies = [];
const percentile = (values, p) => values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? null;
let publicationJob = null;
try {
  f = await createM1Fixture('m8-load');
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8, statement_timeout: 15000, connectionTimeoutMillis: 5000 });
  const role = (await pool.query('SELECT current_database() database,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.equal(role.database, 'waia_v2_upgrade'); assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
  const ownerRole = (await f.owner.query('SELECT current_database() database,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.equal(ownerRole.database, 'waia_v2_upgrade'); assert.equal(ownerRole.rolsuper, false); assert.equal(ownerRole.rolbypassrls, false);
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 }); assert.equal(await redis.ping(), 'PONG');
  const readiness = new ReadinessService({ compiler: compileTenantRuntimeConfigV2, capabilityCatalog: CAPABILITY_CATALOG_V2,
    actionOwner: actionOwnerV2, validateActionParams: validateActionParamsV2 });
  const admin = new VersionedConfigurationService(new PostgresVersionedConfigurationRepository(pool), { clock: f.clock });
  const onboarding = new OnboardingService({ repository: new PostgresOnboardingRepository(pool, { environment: 'test' }),
    configurationService: admin, readinessService: readiness, clock: f.clock });
  const service = new AttendanceService({ pool, clock: f.clock, environment: 'test', readinessService: readiness,
    limiter: new AccountRateLimiter({ redis, environment: 'test' }),
    preflight: async () => ({ state: 'passed', summary: { failedCount: 0 } }) });
  f.service.attendance = service;
  const administrator = await f.makeUser('admin', { platform: true, login: false });
  for (let index = 0; index < 10; index++) {
    const company = await f.makeCompany(`tenant-${index}`), user = await f.makeUser(`reader-${index}`);
    const second = await f.service.login({ email: user.email, password: fixturePassword }, `m8-second-${index}`);
    await f.link(user, company, { permissions, role: 'administrador' });
    companies.push(company);
    sessions.push({ company, user, issued: user.issued, auth: user.auth, index },
      { company, user, issued: second, auth: await f.service.authenticate(second.token), index });
    await admin.saveDraft({ empresaId: company.id, actorId: administrator.id, expectedDraftVersion: 0, configuration: config(company, index) });
    await technical(f, company, administrator);
    stage = `readiness-${index}`;
    const readinessReport = await onboarding.readiness({ empresaId: company.id });
    if (!readinessReport.ready) console.error(JSON.stringify({ status: 'diagnostic', stage,
      failedChecks: (readinessReport.checks || []).filter((check) => check.passed === false)
        .map((check) => /^[A-Z0-9_]+$/.test(check.code || '') ? check.code : 'CHECK_FAILED') }));
    assert.equal(readinessReport.ready, true);
    stage = `baseline-${index}`;
    await onboarding.publish({ empresaId: company.id, actorId: administrator.id, expectedDraftVersion: 1 });
  }
  assert.equal(sessions.length, 20);
  const publicationCycle = async (cycle) => {
    const target = sessions[0], other = sessions[1];
    const dto = await service.read(target.auth, target.company.id);
    const saved = await service.save(target.auth, target.company.id, { draftVersion: dto.draftVersion,
      changes: { script: `M8 roteiro exclusivo 0; ciclo de publicação ${cycle}` } });
    const before = Number((await f.owner.query('SELECT count(*)::int n FROM configuracoes_revisoes WHERE empresa_id=$1', [target.company.id])).rows[0].n);
    const body = { draftVersion: saved.draftVersion, reviewToken: saved.publication.reviewToken, idempotencyKey: randomUUID(), confirmed: true };
    const duplicate = await Promise.all([service.publish(target.auth, target.company.id, body), service.publish(other.auth, target.company.id, body)]);
    assert.deepEqual(duplicate[0], duplicate[1]);
    const review = await service.read(target.auth, target.company.id);
    const changed = await service.save(target.auth, target.company.id, { draftVersion: review.draftVersion,
      changes: { script: `M8 roteiro exclusivo 0; disputa de publicação ${cycle}` } });
    const confirmation = { draftVersion: changed.draftVersion, reviewToken: changed.publication.reviewToken, confirmed: true };
    const race = await Promise.allSettled([service.publish(target.auth, target.company.id, { ...confirmation, idempotencyKey: randomUUID() }),
      service.publish(other.auth, target.company.id, { ...confirmation, idempotencyKey: randomUUID() })]);
    assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = race.find((result) => result.status === 'rejected'); assert.equal(rejected.reason.status, 409);
    const after = Number((await f.owner.query('SELECT count(*)::int n FROM configuracoes_revisoes WHERE empresa_id=$1', [target.company.id])).rows[0].n);
    assert.equal(after, before + 2); metrics.publicationCycles++; metrics.publicationConflicts++; metrics.uniquePublications += 2;
  };
  const startPublication = (cycle) => {
    publicationJob = publicationCycle(cycle).catch(() => { metrics.errors++; }).finally(() => { publicationJob = null; });
    return publicationJob;
  };
  stage = 'load';
  const started = performance.now(), total = seconds * 5;
  console.log(JSON.stringify({ status: 'running', stage, durationSeconds: seconds, targetRequestsPerSecond: 5,
    companies: 10, sessions: 20, publicationPreflight: 'fake-only', transport: 'real-local-http/postgresql/redis' }));
  const execute = async (sequence) => {
    const current = sessions[sequence % sessions.length], deny = sequence % 10 === 9;
    const target = deny ? companies[(current.index + 1) % companies.length] : current.company;
    const resource = sequence % 2 ? 'overview' : 'attendance';
    const began = performance.now();
    try {
      const result = await f.request(`/app/companies/${target.id}/${resource}`, { issued: current.issued });
      if (result.status >= 500) metrics.unexpected5xx++;
      assert.equal(result.headers.get('cache-control'), 'no-store');
      if (deny) {
        assert.equal(result.status, 404); assert.equal(JSON.stringify(result.body).includes(target.name), false); metrics.expectedDenials++;
      } else {
        assert.equal(result.status, 200);
        if (result.body.company?.id !== current.company.id || result.body.company?.name !== current.company.name) metrics.leakage++;
        assert.equal(result.body.company.id, current.company.id); assert.equal(result.body.company.name, current.company.name);
        if (resource === 'overview') {
          for (const text of ['m8-private-model', 'M8 roteiro exclusivo', 'm8-synthetic-', 'credentialRef', 'maxOutputTokens']) {
            if (JSON.stringify(result.body).includes(text)) metrics.leakage++;
            assert.equal(JSON.stringify(result.body).includes(text), false);
          }
        } else {
          if (!result.body.fields.script.startsWith(`M8 roteiro exclusivo ${current.index}`)) metrics.leakage++;
          assert.ok(result.body.fields.script.startsWith(`M8 roteiro exclusivo ${current.index}`));
        }
        metrics.successfulReads++;
      }
    } catch { metrics.errors++; }
    finally { samples.push(performance.now() - began); metrics.completed++; }
  };
  let midway = false;
  for (let sequence = 0; sequence < total; sequence++) {
    await delay(Math.max(0, started + sequence * 200 - performance.now()));
    if (sequence === 5) void startPublication(1);
    if (!midway && sequence >= Math.floor(total / 2) && !publicationJob) { midway = true; void startPublication(2); }
    if (jobs.size >= 20) { metrics.droppedSlots++; continue; }
    const job = execute(sequence); jobs.add(job); metrics.maxInflight = Math.max(metrics.maxInflight, jobs.size);
    void job.finally(() => jobs.delete(job));
    if (sequence > 0 && sequence % 300 === 0) console.log(JSON.stringify({ status: 'progress', elapsedSeconds: Math.round((performance.now() - started) / 1000), ...metrics }));
  }
  await Promise.all(jobs); if (publicationJob) await publicationJob;
  const elapsed = (performance.now() - started) / 1000;
  samples.sort((a, b) => a - b);
  const timing = { p50Ms: Number(percentile(samples, .5)?.toFixed(2)), p95Ms: Number(percentile(samples, .95)?.toFixed(2)),
    maxMs: Number(samples.at(-1)?.toFixed(2)), elapsedSeconds: Number(elapsed.toFixed(2)), actualRequestsPerSecond: Number((metrics.completed / elapsed).toFixed(3)) };
  const passed = metrics.errors === 0 && metrics.leakage === 0 && metrics.unexpected5xx === 0 && metrics.droppedSlots === 0
    && metrics.completed === total && metrics.publicationCycles === 2 && timing.p95Ms < 500;
  console.log(JSON.stringify({ status: passed ? 'passed' : 'failed', gateRun: seconds === 600, durationSeconds: seconds,
    companies: 10, sessions: 20, ...metrics, ...timing,
    limits: ['Local HTTP router and repository fixtures, not a public proxy SLA.', 'Publication dependency/readiness is real; provider preflight is fake and no message gateway is used.'] }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', stage, code: /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'LOAD_CHECK_FAILED' }));
  process.exitCode = 1;
} finally {
  if (publicationJob) await publicationJob;
  await Promise.allSettled(jobs);
  if (pool) await pool.end();
  if (f) {
    try {
      await f.owner.query('UPDATE empresas SET configuracao_ativa_versao=NULL WHERE id=ANY($1::uuid[])', [f.companies]);
      for (const table of ['attendance_publications', 'logs_auditoria', 'numeros_whatsapp', 'aplicativos_meta', 'credenciais_empresa']) {
        await f.owner.query(`DELETE FROM ${table} WHERE empresa_id=ANY($1::uuid[])`, [f.companies]);
      }
    } catch (error) {
      console.error(JSON.stringify({ status: 'failed', stage: 'technical-cleanup', code: /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'CLEANUP_FAILED' }));
      process.exitCode = 1;
    }
    try { await f.close(); }
    catch (error) {
      console.error(JSON.stringify({ status: 'failed', stage: 'fixture-cleanup', code: /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'CLEANUP_FAILED' }));
      process.exitCode = 1;
      await Promise.allSettled([f.pool.end(), f.owner.end()]);
    }
  }
  if (redis) await redis.quit();
}
