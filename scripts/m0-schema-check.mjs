import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations } from '../src/infra/postgres/migrations.js';
import { readSqlDirectory } from '../src/infra/postgres/sql-runner.js';
import { withIdentityTransaction, withTenantTransaction } from '../src/infra/postgres/transaction.js';

// This harness never resets a target. Accept only two empty databases or two
// completely migrated, checksum-verified databases without business data.
const databaseNames = ['waia_v2_empty', 'waia_v2_upgrade'];
const directory = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;
const pools = [];
let temporary;
let stage = 'target-validation';

function checkedUrls() {
  assert.equal(process.env.NODE_ENV, 'test', 'NODE_ENV must be test');
  const owner = new URL(process.env.DATABASE_MIGRATOR_URL);
  const app = new URL(process.env.DATABASE_URL);
  for (const url of [owner, app]) {
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
    assert.equal(url.pathname, '/waia_v2_empty');
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    assert.match(decodeURIComponent(url.username), /^waia_v2_[a-z0-9_]+$/);
  }
  assert.equal(owner.host, app.host);
  assert.notEqual(owner.username, app.username);
  return { owner, app };
}

function poolFor(url, database) {
  const target = new URL(url);
  target.pathname = `/${database}`;
  const pool = new pg.Pool({ connectionString: target.href, max: 1,
    connectionTimeoutMillis: 5000, statement_timeout: 15000, application_name: 'waia-m0-schema-check' });
  pools.push(pool);
  return pool;
}

async function preflight(target, files) {
  stage = `${target.name}:role-preflight`;
  for (const [kind, pool] of [['owner', target.owner], ['app', target.app]]) {
    const row = (await pool.query(`SELECT current_database() AS database, current_user AS role,
      rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
      FROM pg_roles WHERE rolname=current_user`)).rows[0];
    assert.equal(row.database, target.name);
    assert.match(row.role, /^waia_v2_[a-z0-9_]+$/);
    for (const flag of ['rolsuper', 'rolbypassrls', 'rolcreatedb', 'rolcreaterole']) assert.equal(row[flag], false, `${kind}: ${flag}`);
  }
  stage = `${target.name}:schema-preflight`;
  const relations = (await target.owner.query(`SELECT count(*)::int AS n FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    AND c.relkind IN ('r','p','v','m','S','f')`)).rows[0].n;
  assert.equal((await target.owner.query(`SELECT pg_get_userbyid(datdba)=current_user AS owned
    FROM pg_database WHERE datname=current_database()`)).rows[0].owned, true);
  if (relations === 0) return 'empty';
  stage = `${target.name}:existing-ledger-preflight`;
  assert.ok((await target.owner.query("SELECT to_regclass('public.schema_migrations') AS ledger")).rows[0].ledger,
    'Non-empty target has no migration ledger');
  const applied = (await target.owner.query('SELECT filename,checksum FROM schema_migrations ORDER BY filename')).rows;
  assert.ok(applied.length>=26 && applied.length<=files.length);
  await ledger(target.owner, files.slice(0,applied.length));
  const pending=applied.length<files.length;
  stage = `${target.name}:existing-schema-preflight`;
  await schemaSnapshot(target.owner);
  return pending ? `upgrade-pending:${applied.length}` : 'complete';
}

async function ledger(pool, files) {
  const rows = (await pool.query('SELECT filename,checksum FROM schema_migrations ORDER BY filename')).rows;
  assert.equal(rows.length, files.length);
  const expected = new Map(files.map((file) => [file.filename, file]));
  for (const row of rows) {
    assert.ok(expected.has(row.filename), 'Unexpected migration in ledger');
    assert.ok(expected.get(row.filename).acceptedChecksums.has(row.checksum.trim()), 'Migration checksum mismatch');
  }
}

async function checkRoleAndContext(pool) {
  const permissions = (await pool.query(`SELECT
    has_schema_privilege(current_user,'public','CREATE') AS ddl,
    has_database_privilege(current_user,current_database(),'TEMP') AS temp`)).rows[0];
  assert.deepEqual(permissions, { ddl: false, temp: false });
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    await assert.rejects(connection.query('CREATE TABLE m0_forbidden_ddl(id integer)'), { code: '42501' });
  } finally {
    await connection.query('ROLLBACK');
    connection.release();
  }
  const tenantId = randomUUID(), userId = randomUUID();
  const cleanContext = async () => {
    const row = (await pool.query(`SELECT
      coalesce(current_setting('app.empresa_id',true),'') AS tenant,
      coalesce(current_setting('app.usuario_id',true),'') AS identity,
      coalesce(current_setting('app.is_platform_admin',true),'') AS admin`)).rows[0];
    assert.equal(row.tenant, ''); assert.equal(row.identity, '');
    assert.ok(['', 'false'].includes(row.admin));
  };
  await cleanContext();
  await withTenantTransaction(pool, { empresaId: tenantId, usuarioId: userId }, async ({ client }) => {
    assert.equal((await client.query("SELECT current_setting('app.empresa_id') AS id")).rows[0].id, tenantId);
    assert.equal((await client.query('SELECT id FROM empresas')).rowCount, 0);
  });
  await cleanContext();
  const rollback = new Error('synthetic rollback');
  await assert.rejects(withIdentityTransaction(pool, { usuarioId: userId }, async ({ client }) => {
    assert.equal((await client.query("SELECT current_setting('app.usuario_id') AS id")).rows[0].id, userId);
    assert.equal((await client.query('SELECT id FROM usuarios')).rowCount, 0);
    throw rollback;
  }), (error) => error === rollback);
  await cleanContext();
}

async function schemaSnapshot(pool) {
  const definitions = {};
  for (const [name, query] of Object.entries({
    columns: `SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`,
    relations: `SELECT c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname`,
    constraints: `SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k
      JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' ORDER BY c.relname,k.conname`,
    indexes: `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`,
    policies: `SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies
      WHERE schemaname='public' ORDER BY tablename,policyname`,
    functions: `SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
      pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prokind<>'a' ORDER BY p.proname,arguments`,
    aggregates: `SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
      a.aggkind,a.aggtransfn::regproc::text AS transition_function,
      a.aggfinalfn::regproc::text AS final_function,a.aggcombinefn::regproc::text AS combine_function,
      a.aggtranstype::regtype::text AS transition_type,a.agginitval
      FROM pg_aggregate a JOIN pg_proc p ON p.oid=a.aggfnoid
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname,arguments`,
    triggers: `SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
  })) definitions[name] = (await pool.query(query)).rows;
  for (const table of ['empresas', 'usuarios', 'usuarios_empresas', 'auth_sessions',
    'identity_challenges', 'mfa_recovery_codes', 'team_invitations', 'ownership_transfers']) {
    const relation = definitions.relations.find((row) => row.relname === table);
    assert.ok(relation?.relrowsecurity && relation.relforcerowsecurity, `RLS missing: ${table}`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.is_platform_admin','true',true)");
    for (const table of definitions.relations.filter((row) => ['r', 'p'].includes(row.relkind))) {
      if (table.relname === 'schema_migrations') continue;
      const n = (await client.query(`SELECT count(*)::int AS n FROM ${quote(table.relname)}`)).rows[0].n;
      assert.equal(n, table.relname === 'group_notifier_connection' ? 1 : 0, `Unexpected data: ${table.relname}`);
    }
    await client.query('ROLLBACK');
  } finally { client.release(); }
  return definitions;
}

try {
  const urls = checkedUrls();
  const targets = databaseNames.map((name) => ({ name, owner: poolFor(urls.owner, name), app: poolFor(urls.app, name) }));
  const files = await readSqlDirectory(directory);
  assert.ok([26,27,28,29].includes(files.length));
  const team = files.find((file) => file.filename === '023_team_and_mfa.sql');
  assert.ok(team);
  // Reproduce the previous release (001–022 + 024–026). New boundaries must
  // be applied AFTER late 023, just as the real migrator orders missing files.
  const baseline = files.filter((file) => file !== team && Number(file.filename.slice(0,3)) <= 26);
  const upgradeFiles = files.filter((file) => !baseline.includes(file)).map((file) => file.filename);
  // Validate both databases before the first migration writes anything.
  const states = [];
  for (const target of targets) states.push(await preflight(target, files));
  stage = 'matching-target-states';
  assert.equal(states[0], states[1], 'Mixed/partial target states are refused');
  const mode = states[0] === 'empty' ? 'fresh-and-upgrade'
    : states[0].startsWith('upgrade-pending:') ? 'incremental-upgrade' : 'existing-verified';
  const incrementalFiles=mode==='incremental-upgrade'?files.slice(Number(states[0].split(':')[1])).map(file=>file.filename):[];
  if (mode === 'fresh-and-upgrade') {
    temporary = await mkdtemp(path.join(tmpdir(), 'waia-m0-migrations-'));
    for (const file of baseline) await cp(path.join(directory, file.filename), path.join(temporary, file.filename));
    stage = 'waia_v2_empty:apply-all';
    assert.equal((await runMigrations(targets[0].owner)).applied.length, files.length);
    stage = 'waia_v2_empty:ledger';
    await ledger(targets[0].owner, files);
    stage = 'waia_v2_upgrade:apply-without-023';
    assert.equal((await runMigrations(targets[1].owner, { directory: temporary })).applied.length, baseline.length);
    stage = 'waia_v2_upgrade:baseline-ledger';
    await ledger(targets[1].owner, baseline);
    stage = 'waia_v2_upgrade:apply-023-and-new-boundaries';
    assert.deepEqual((await runMigrations(targets[1].owner)).applied, upgradeFiles);
    stage = 'waia_v2_upgrade:complete-ledger';
    await ledger(targets[1].owner, files);
  }
  if (mode === 'incremental-upgrade') for (const target of targets) {
    stage = `${target.name}:apply-authorized-boundaries`;
    assert.deepEqual((await runMigrations(target.owner)).applied, incrementalFiles);
    await ledger(target.owner, files);
  }
  for (const target of targets) {
    stage = `${target.name}:reapply-zero`;
    assert.equal((await runMigrations(target.owner)).applied.length, 0);
  }

  stage = 'roles-rls-schema-comparison';
  const snapshots = [];
  for (const target of targets) {
    stage = `${target.name}:app-role-and-pool-context`;
    await checkRoleAndContext(target.app);
    stage = `${target.name}:schema-and-business-data`;
    snapshots.push(await schemaSnapshot(target.owner));
  }
  stage = 'compare-final-schemas';
  assert.deepEqual(snapshots[0], snapshots[1]);
  console.log(JSON.stringify({ status: 'passed', mode, databases: databaseNames,
    ...(mode === 'fresh-and-upgrade' ? { emptyApplied: files.length, upgradeBaselineApplied: baseline.length, upgradeApplied: upgradeFiles } : {}),
    ...(mode === 'incremental-upgrade' ? { upgradeApplied: incrementalFiles } : {}), reapply: 0,
    ledgerChecksums: 'matched', role: 'restricted', rls: 'forced', poolContext: 'clean',
    businessRows: 0, schemaEqual: true,
    schemaSha256: createHash('sha256').update(JSON.stringify(snapshots[0])).digest('hex') }));
} catch (error) {
  // Deliberately omit connection strings, SQL parameters and database error details.
  console.error(JSON.stringify({ status: 'failed', stage, code: /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'CHECK_FAILED' }));
  process.exitCode = 1;
} finally {
  await Promise.allSettled(pools.map((pool) => pool.end()));
  if (temporary) {
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('waia-m0-migrations-'));
    await rm(resolved, { recursive: true, force: true });
  }
}
