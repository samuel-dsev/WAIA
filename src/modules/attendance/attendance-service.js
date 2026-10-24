import { z } from 'zod';
import { withCustomerTransaction } from '../../infra/postgres/transaction.js';
import { effectiveCustomerCapabilities } from '../auth/permissions.js';
import { AccountError } from '../accounts/errors.js';
import { PostgresVersionedConfigurationRepository } from '../configuration/postgres-versioned-configuration-repository.js';
import { VersionedConfigurationService } from '../configuration/versioned-configuration-service.js';
import { FIELD_DEFINITIONS, projectAttendance, parseAttendancePatch, mergeAttendance } from './contract.js';

const missing = () => new AccountError('COMPANY_NOT_FOUND', 404, 'Empresa não encontrada.');
const conflict = () => new AccountError('DRAFT_VERSION_CONFLICT', 409, 'O atendimento mudou em outra sessão. Recarregue e revise suas alterações antes de salvar.');
const baseRequired = () => new AccountError('ATTENDANCE_BASE_REQUIRED', 409, 'A administração WAIA precisa preparar este atendimento antes da edição.');
const denied = () => new AccountError('ACCESS_DENIED', 403, 'Você não tem permissão para esta operação.');
const invalid = () => new AccountError('ATTENDANCE_VALIDATION_ERROR', 422, 'Confira os campos do atendimento antes de salvar.');

export class AttendanceService {
  constructor({ pool, clock = () => new Date(), idleMs = 3600_000 }) {
    if (!pool?.connect) throw new TypeError('Atendimento exige PostgreSQL.');
    Object.assign(this, { pool, clock, idleMs });
  }
  async #run(auth, empresaId, permission, work) {
    if (auth?.audience !== 'customer' || !auth.user?.id || !auth.sessionId) throw denied();
    // Keep the same UUID versions accepted by transactional tenant contexts.
    if (!z.string().uuid().refine((id) => /^[1-5]$/.test(id[14])).safeParse(empresaId).success) throw missing();
    try {
      return await withCustomerTransaction(this.pool, { usuarioId: auth.user.id, sessionId: auth.sessionId,
        empresaId, permission, now: this.clock(), idleMs: this.idleMs }, async (tx) => {
        await tx.client.query("SELECT set_config('app.attendance_session_id',$1,true)", [auth.sessionId]);
        const tenant = (await tx.client.query(`SELECT e.id,e.nome AS name,e.status,e.configuracao_ativa_versao AS active_version,
          e.publicada_at,m.status membership_status,m.permissoes
          FROM empresas e JOIN usuarios_empresas m ON m.empresa_id=e.id AND m.usuario_id=$2
          WHERE e.id=$1 AND e.deleted_at IS NULL`, [empresaId, auth.user.id])).rows[0];
        if (!tenant) throw missing();
        const capabilities = effectiveCustomerCapabilities({ status: tenant.membership_status, permissions: tenant.permissoes, companyStatus: tenant.status });
        if (!capabilities.includes('attendance.read') || !capabilities.includes(permission)) throw denied();
        const draft = (await tx.client.query(`SELECT empresa_id,draft_version,schema_version,configuracao,updated_by,updated_at
          FROM configuracoes_rascunho WHERE empresa_id=$1${permission === 'attendance.edit' ? ' FOR UPDATE' : ''}`, [empresaId])).rows[0];
        if (!draft) throw baseRequired();
        const ownName = (await tx.client.query('SELECT nome FROM usuarios WHERE id=$1', [auth.user.id])).rows[0]?.nome || auth.user.name;
        return work({ tx, tenant, draft, ownName, canEdit: capabilities.includes('attendance.edit') });
      });
    } catch (error) {
      if (error instanceof AccountError) throw error;
      if (error?.code === 'DRAFT_VERSION_CONFLICT') throw conflict();
      if (error?.status === 422 || error?.code === 'CONFIGURATION_INVALID') throw invalid();
      // Accounts HTTP masks this generic operational failure, never raw PG/config errors.
      throw new Error('Attendance operation unavailable.');
    }
  }
  #dto({ tenant, draft, ownName, canEdit }, auth) {
    return {
      company: { id: tenant.id, name: tenant.name, status: tenant.status },
      draftVersion: Number(draft.draft_version), activeVersion: tenant.active_version == null ? null : Number(tenant.active_version),
      publishedAt: tenant.publicada_at || null, publishedBy: tenant.publicada_at ? 'Acesso autorizado' : null,
      savedAt: draft.updated_at || null, savedBy: draft.updated_by ? draft.updated_by === auth.user.id ? ownName : 'Outro acesso autorizado' : null,
      canEdit, ...projectAttendance(draft.configuracao),
    };
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
