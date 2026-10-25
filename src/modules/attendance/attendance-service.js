import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { withCustomerTransaction } from '../../infra/postgres/transaction.js';
import { effectiveCustomerCapabilities } from '../auth/permissions.js';
import { AccountError } from '../accounts/errors.js';
import { PostgresVersionedConfigurationRepository } from '../configuration/postgres-versioned-configuration-repository.js';
import { VersionedConfigurationService } from '../configuration/versioned-configuration-service.js';
import { FIELD_DEFINITIONS, projectAttendance, parseAttendancePatch, mergeAttendance } from './contract.js';
import { publicationReview, parsePublication, parseSimulation } from './publication-contract.js';
import { stableJson } from '../configuration/stable-json.js';
import { PostgresOnboardingRepository } from '../onboarding/postgres-onboarding-repository.js';
import { OnboardingService } from '../onboarding/onboarding-service.js';
import { PreviewService } from '../onboarding/preview-service.js';
import { verifyCompiledTenantRuntimeConfigV2 } from '../configuration/compiler.js';
import { projectAttendanceResources } from './feature-catalog.js';
import { loadGoogleSheetsProducts } from '../../tenants/postgres-config-loader.js';

const missing = () => new AccountError('COMPANY_NOT_FOUND', 404, 'Empresa não encontrada.');
const conflict = () => new AccountError('DRAFT_VERSION_CONFLICT', 409, 'O atendimento mudou em outra sessão. Recarregue e revise suas alterações antes de salvar.');
const baseRequired = () => new AccountError('ATTENDANCE_BASE_REQUIRED', 409, 'A administração WAIA precisa preparar este atendimento antes da edição.');
const denied = () => new AccountError('ACCESS_DENIED', 403, 'Você não tem permissão para esta operação.');
const invalid = () => new AccountError('ATTENDANCE_VALIDATION_ERROR', 422, 'Confira os campos do atendimento antes de salvar.');

export class AttendanceService {
  constructor({ pool, clock = () => new Date(), idleMs = 3600_000, readinessService = null,
    flowPublisher = null, limiter = null, preflight = null, environment = 'production', platformAiCredentialConfigured = false }) {
    if (!pool?.connect) throw new TypeError('Atendimento exige PostgreSQL.');
    Object.assign(this, { pool, clock, idleMs, readinessService, flowPublisher, limiter, preflight, environment, platformAiCredentialConfigured });
    this.preview = new PreviewService({ maxSessions: 5, maxTotalSessions: 100 });
  }
  async #run(auth, empresaId, permission, work) {
    if (auth?.audience !== 'customer' || !auth.user?.id || !auth.sessionId) throw denied();
    // Keep the same UUID versions accepted by transactional tenant contexts.
    if (!z.string().uuid().refine((id) => /^[1-5]$/.test(id[14])).safeParse(empresaId).success) throw missing();
    try {
      return await withCustomerTransaction(this.pool, { usuarioId: auth.user.id, sessionId: auth.sessionId,
        empresaId, permission, now: this.clock(), idleMs: this.idleMs, lockCompany: permission === 'attendance.publish' }, async (tx) => {
        await tx.client.query("SELECT set_config('app.attendance_session_id',$1,true)", [auth.sessionId]);
        const tenant = (await tx.client.query(`SELECT e.id,e.nome AS name,e.status,e.configuracao_ativa_versao AS active_version,
          e.publicada_at,e.configuracao_runtime_modo AS runtime_mode,e.versao_configuracao AS configuration_version,m.status membership_status,m.permissoes
          FROM empresas e JOIN usuarios_empresas m ON m.empresa_id=e.id AND m.usuario_id=$2
          WHERE e.id=$1 AND e.deleted_at IS NULL`, [empresaId, auth.user.id])).rows[0];
        if (!tenant) throw missing();
        const capabilities = effectiveCustomerCapabilities({ status: tenant.membership_status, permissions: tenant.permissoes, companyStatus: tenant.status });
        if (!capabilities.includes('attendance.read') || !capabilities.includes(permission)) throw denied();
        const draft = (await tx.client.query(`SELECT empresa_id,draft_version,schema_version,configuracao,updated_by,updated_at
          FROM configuracoes_rascunho WHERE empresa_id=$1${permission === 'attendance.read' ? '' : ' FOR UPDATE'}`, [empresaId])).rows[0];
        if (!draft) throw baseRequired();
        const ownName = (await tx.client.query('SELECT nome FROM usuarios WHERE id=$1', [auth.user.id])).rows[0]?.nome || auth.user.name;
        const result = await work({ tx, tenant, draft, ownName, capabilities, canEdit: capabilities.includes('attendance.edit') });
        await tx.client.query("SELECT set_config('app.is_platform_admin','false',true),set_config('app.audience','customer',true)");
        return result;
      });
    } catch (error) {
      if (error instanceof AccountError) throw error;
      if (error?.code === 'DRAFT_VERSION_CONFLICT') throw conflict();
      if (error?.status === 422 || error?.code === 'CONFIGURATION_INVALID') throw invalid();
      // Accounts HTTP masks this generic operational failure, never raw PG/config errors.
      throw new Error('Attendance operation unavailable.');
    }
  }
  async #dto(state, auth) {
    const { tenant, draft, ownName, canEdit, capabilities } = state;
    const publication = await this.#review(state);
    return {
      company: { id: tenant.id, name: tenant.name, status: tenant.status },
      draftVersion: Number(draft.draft_version), activeVersion: tenant.active_version == null ? null : Number(tenant.active_version),
      publishedAt: tenant.publicada_at || null, publishedBy: tenant.publicada_at ? 'Acesso autorizado' : null,
      savedAt: draft.updated_at || null, savedBy: draft.updated_by ? draft.updated_by === auth.user.id ? ownName : 'Outro acesso autorizado' : null,
      canEdit, canSimulate: capabilities.includes('attendance.simulate'), canPublish: capabilities.includes('attendance.publish'),
      publication, ...projectAttendance(draft.configuracao),
      resources: await this.#resources(state),
    };
  }
  async #resources(state) {
    await state.tx.client.query("SELECT set_config('app.is_platform_admin','true',true),set_config('app.audience','',true)");
    try {
      const row = (await state.tx.client.query(`SELECT configuracao_compilada,checksum FROM configuracoes_revisoes
        WHERE empresa_id=$1 AND config_version=$2`, [state.tenant.id, state.tenant.active_version])).rows[0];
      const active = row?.configuracao_compilada;
      const activeConfiguration = active?.empresaId === state.tenant.id && Number(active.configVersion) === Number(state.tenant.active_version)
        && row.checksum === active.checksum && verifyCompiledTenantRuntimeConfigV2(active) ? active.configuration : null;
      const repository = new PostgresOnboardingRepository(this.pool, { environment: this.environment,
        platformAiCredentialConfigured: this.platformAiCredentialConfigured });
      let snapshot = await repository.readReadinessSnapshot({ empresaId: state.tenant.id, transaction: state.tx });
      snapshot = { ...snapshot, customerRuntimeReady: state.tenant.runtime_mode === 'versionado'
        && Number(state.tenant.configuration_version) === Number(state.tenant.active_version) && activeConfiguration != null };
      if (snapshot && activeConfiguration?.ai?.catalogSalesEnabled === true) {
        const catalog = await loadGoogleSheetsProducts(state.tx.client, state.tenant.id, activeConfiguration.integrations);
        // Reuse the runtime's published binding, profile, cache version and
        // freshness checks; only a boolean becomes customer business status.
        snapshot = { ...snapshot, customerCatalogReady: catalog?.source?.status === 'healthy' };
      }
      return projectAttendanceResources(state.draft.configuracao, { capabilities: state.capabilities,
        companyStatus: state.tenant.status, activeConfiguration, snapshot: snapshot || {} });
    } finally {
      await state.tx.client.query("SELECT set_config('app.is_platform_admin','false',true),set_config('app.audience','customer',true)");
    }
  }
  capabilities(auth, empresaId) {
    return this.#run(auth, empresaId, 'attendance.read', async (state) => ({ companyId: state.tenant.id,
      effectiveCapabilities: state.capabilities, ...await this.#resources(state) }));
  }
  // Fixed internal read: customer RLS continues denying full revisions and all
  // technical resources. No request controls SQL, context flags or repository.
  async #review(state) {
    await state.tx.client.query("SELECT set_config('app.is_platform_admin','true',true),set_config('app.audience','',true)");
    try {
      const revision = (await state.tx.client.query(`SELECT configuracao_compilada,config_version,checksum FROM configuracoes_revisoes
        WHERE empresa_id=$1 AND config_version=$2`, [state.tenant.id, state.tenant.active_version])).rows[0];
      const review = publicationReview({ configuration: state.draft.configuracao, activeRevision: revision,
        empresaId: state.tenant.id, draftVersion: Number(state.draft.draft_version), activeVersion: Number(state.tenant.active_version) });
      if (state.tenant.status !== 'ativa') return { ready: false, reason: 'Este atendimento precisa de liberação administrativa.', changes: [], reviewToken: null };
      if (state.tenant.active_version != null && (state.tenant.runtime_mode !== 'versionado'
        || Number(state.tenant.configuration_version) !== Number(state.tenant.active_version))) {
        return { ready: false, reason: 'Existe uma atualização administrativa pendente. Solicite orientação à administração WAIA.', changes: [], reviewToken: null };
      }
      return review;
    } finally {
      await state.tx.client.query("SELECT set_config('app.is_platform_admin','false',true),set_config('app.audience','customer',true)");
    }
  }
  #pipeline(state) {
    if (!this.readinessService) throw new AccountError('ATTENDANCE_UNAVAILABLE', 503, 'O atendimento está temporariamente indisponível.');
    const repository = new PostgresOnboardingRepository(this.pool, { environment: this.environment,
      platformAiCredentialConfigured: this.platformAiCredentialConfigured,
      transactionRunner: async (_pool, _context, callback) => callback(state.tx) });
    return { repository, service: new OnboardingService({ repository,
      configurationService: { readDraft() {}, saveDraft() {} }, readinessService: this.readinessService,
      flowPublisher: this.flowPublisher, clock: this.clock }) };
  }
  #requireVersion(state, version) {
    if (Number(state.draft.draft_version) !== version) throw conflict();
  }
  async #budget(auth, empresaId, action = 'simulate') {
    if (!this.limiter) throw new AccountError('ATTENDANCE_UNAVAILABLE', 503, 'O simulador está temporariamente indisponível.');
    try {
      for (const [key, max] of [[`attendance-${action}:user:${auth.user.id}`, 20], [`attendance-${action}:company:${empresaId}`, 120]]) {
        if (!(await this.limiter.consume({ key, max })).allowed) throw new AccountError('ATTENDANCE_RATE_LIMITED', 429, 'Limite de simulações atingido. Tente novamente mais tarde.');
      }
    } catch (error) {
      if (error instanceof AccountError) throw error;
      throw new AccountError('ATTENDANCE_UNAVAILABLE', 503, 'O simulador está temporariamente indisponível.');
    }
  }
  simulate(auth, empresaId, body) {
    const input = parseSimulation(body);
    return this.#run(auth, empresaId, 'attendance.simulate', async (state) => {
      empresaId = state.tenant.id;
      this.#requireVersion(state, input.draftVersion);
      const review = await this.#review(state);
      if (!review.ready) throw new AccountError('ATTENDANCE_REVIEW_REQUIRED', 409, review.reason);
      await this.#budget(auth, empresaId);
      // No gateway, real AI handler or persistent business repository enters PreviewService.
      const sessionId = randomUUID();
      let result;
      try {
        result = await this.preview.simulate({ actorId: auth.user.id, empresaId, configuration: state.draft.configuracao,
          draftVersion: input.draftVersion, sessionId, expectedSessionRevision: 0, message: { type: 'text', text: input.message } });
        return { draftVersion: input.draftVersion, reply: String(result.reply.text || '').slice(0, 5000),
          message: 'Simulação isolada. IA e integrações são fictícias; nenhuma mensagem foi enviada.' };
      } finally {
        this.preview.resetSession({ actorId: auth.user.id, empresaId, sessionId, expectedSessionRevision: result?.sessionRevision || 0 });
      }
    });
  }
  async publish(auth, empresaId, body, correlationId = null) {
    const input = parsePublication(body);
    // Provider probes may update their health metadata. Run them outside the
    // release locks, then reauthorize and recheck the entire review in the final
    // transaction. No provider gateway is used by the simulator.
    const prepared = await this.#run(auth, empresaId, 'attendance.publish', async (state) => {
      const id = state.tenant.id;
      await state.tx.client.query("SELECT set_config('app.is_platform_admin','true',true),set_config('app.audience','',true)");
      const receipt = (await state.tx.client.query(`SELECT request_hash,result FROM attendance_publications
        WHERE empresa_id=$1 AND actor_id=$2 AND request_key=$3`, [id, auth.user.id, input.idempotencyKey])).rows[0];
      if (receipt) {
        if (receipt.request_hash !== createHash('sha256').update(stableJson(input)).digest('hex')) throw new AccountError('ATTENDANCE_PUBLICATION_CONFLICT', 409, 'Esta confirmação já foi usada para outra publicação. Recarregue e revise.');
        return { receipt: receipt.result };
      }
      this.#requireVersion(state, input.draftVersion);
      const review = await this.#review(state);
      if (!review.ready) throw new AccountError('ATTENDANCE_REVIEW_REQUIRED', 409, review.reason);
      if (review.reviewToken !== input.reviewToken) throw conflict();
      await this.#budget(auth, id, 'publish');
      return { empresaId: id };
    });
    if (prepared.receipt) return prepared.receipt;
    if (!this.preflight) throw new AccountError('ATTENDANCE_UNAVAILABLE', 503, 'A publicação está temporariamente indisponível.');
    try {
      const report = await this.preflight({ empresaId: prepared.empresaId, expectedDraftVersion: input.draftVersion, actorId: auth.user.id, correlationId });
      if (report?.state !== 'passed' || report?.summary?.failedCount !== 0) throw new AccountError('ATTENDANCE_NOT_READY', 409, 'Há uma pendência administrativa. Solicite orientação à administração WAIA.');
    } catch (error) {
      if (error instanceof AccountError) throw error;
      if (error?.code === 'DRAFT_VERSION_CONFLICT') throw conflict();
      throw new AccountError('ATTENDANCE_UNAVAILABLE', 503, 'Não foi possível verificar a disponibilidade do atendimento. Tente novamente mais tarde.');
    }
    return this.#run(auth, empresaId, 'attendance.publish', async (state) => {
      empresaId = state.tenant.id;
      // Authorization and company lock precede receipt lookup, including retries.
      await state.tx.client.query("SELECT set_config('app.is_platform_admin','true',true),set_config('app.audience','',true)");
      const requestHash = createHash('sha256').update(stableJson(input)).digest('hex');
      const receipt = (await state.tx.client.query(`SELECT request_hash,result FROM attendance_publications
        WHERE empresa_id=$1 AND actor_id=$2 AND request_key=$3`, [empresaId, auth.user.id, input.idempotencyKey])).rows[0];
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw new AccountError('ATTENDANCE_PUBLICATION_CONFLICT', 409, 'Esta confirmação já foi usada para outra publicação. Recarregue e revise.');
        return receipt.result;
      }
      this.#requireVersion(state, input.draftVersion);
      const review = await this.#review(state);
      if (!review.ready) throw new AccountError('ATTENDANCE_REVIEW_REQUIRED', 409, review.reason);
      if (review.reviewToken !== input.reviewToken) throw conflict();
      await state.tx.client.query("SELECT set_config('app.is_platform_admin','true',true),set_config('app.audience','',true)");
      try {
        // These existing dependency rows cannot be revoked during the readiness
        // check and publication commit. No credential value is selected.
        for (const table of ['credenciais_empresa', 'integracoes', 'numeros_whatsapp', 'aplicativos_meta', 'group_notifier_routes']) {
          await state.tx.client.query(`SELECT empresa_id FROM ${table} WHERE empresa_id=$1 FOR SHARE`, [empresaId]);
        }
        const { service } = this.#pipeline(state);
        const published = await service.publish({ empresaId, expectedDraftVersion: input.draftVersion, actorId: auth.user.id, correlationId });
        const result = { draftVersion: input.draftVersion, activeVersion: published.configVersion, publishedAt: published.publishedAt };
        await state.tx.client.query(`INSERT INTO attendance_publications(empresa_id,actor_id,request_key,request_hash,result)
          VALUES($1,$2,$3,$4,$5::jsonb)`, [empresaId, auth.user.id, input.idempotencyKey, requestHash, JSON.stringify(result)]);
        return result;
      } catch (error) {
        if (error?.code === 'TENANT_NOT_READY') throw new AccountError('ATTENDANCE_NOT_READY', 409, 'Há uma pendência administrativa. Solicite orientação à administração WAIA.');
        throw error;
      }
    });
  }
  read(auth, empresaId) { return this.#run(auth, empresaId, 'attendance.read', async (state) => this.#dto(state, auth)); }
  save(auth, empresaId, body, correlationId = null) {
    if (auth?.audience !== 'customer') throw denied();
    const input = parseAttendancePatch(body);
    return this.#run(auth, empresaId, 'attendance.edit', async (state) => {
      if (Number(state.draft.draft_version) !== input.draftVersion) throw conflict();
      const configuration = mergeAttendance(state.draft.configuracao, input.changes);
      for (const definition of FIELD_DEFINITIONS) {
        if (!Object.hasOwn(input.changes, definition.key)) continue;
        const section = state.draft.configuracao[definition.path[0]];
        if (!section || typeof section !== 'object' || Array.isArray(section)) throw baseRequired();
      }
      const repository = new PostgresVersionedConfigurationRepository(this.pool, { transactionRunner: async (_pool, _context, callback) => callback(state.tx) });
      const service = new VersionedConfigurationService(repository, { clock: this.clock, preserveDraftValues: true });
      const saved = await service.saveDraft({ empresaId, configuration, expectedDraftVersion: input.draftVersion,
        actorId: auth.user.id, correlationId });
      return this.#dto({ ...state, draft: { ...state.draft, draft_version: saved.draftVersion,
        updated_by: saved.updatedBy, updated_at: saved.updatedAt, configuracao: saved.configuration } }, auth);
    });
  }
}
