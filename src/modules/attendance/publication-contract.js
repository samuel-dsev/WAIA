import { z } from 'zod';
import { AccountError } from '../accounts/errors.js';
import { compileTenantRuntimeConfigV2, verifyCompiledTenantRuntimeConfigV2 } from '../configuration/compiler.js';
import { configurationChecksum, stableJson } from '../configuration/stable-json.js';
import { FIELD_DEFINITIONS, projectAttendance } from './contract.js';

const versionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const publicationSchema = z.object({
  draftVersion: versionSchema,
  reviewToken: z.string().regex(/^[a-f0-9]{64}$/u),
  idempotencyKey: z.string().uuid().refine((id) => /^[1-5]$/u.test(id[14])),
  confirmed: z.literal(true),
}).strict();
const simulationSchema = z.object({
  draftVersion: versionSchema,
  message: z.string().min(1).max(2000).refine((value) => value.trim().length > 0
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)),
}).strict();

const invalid = () => new AccountError('ATTENDANCE_VALIDATION_ERROR', 422,
  'Confira os dados e confirme a versão do atendimento antes de continuar.');

function parseInput(schema, body) {
  // Reject accessors, prototype tricks and non-JSON values before schema parsing.
  try { stableJson(body); } catch { throw invalid(); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

export function parsePublication(body) { return parseInput(publicationSchema, body); }
export function parseSimulation(body) { return parseInput(simulationSchema, body); }

function technicalProjection(configuration, baseline) {
  const projected = structuredClone(configuration);
  const allowed = new Set(projectAttendance(baseline).editableFields);
  for (const definition of FIELD_DEFINITIONS) {
    if (!allowed.has(definition.key)) continue;
    const [section, leaf] = definition.path;
    if (projected[section]) delete projected[section][leaf];
  }
  const replyActions = new Set(projectAttendance(baseline).replies.map(({ key }) => key));
  for (const [index, reply] of (baseline.publicReplies || []).entries()) {
    if (replyActions.has(reply.action) && projected.publicReplies?.[index]) {
      delete projected.publicReplies[index].text;
    }
  }
  return projected;
}

function unavailable(reason) {
  return { ready: false, reason, changes: [], reviewToken: null };
}

/** A review authorizes only business content over an already approved technical base. */
export function publicationReview({ configuration, activeRevision, empresaId, draftVersion, activeVersion }) {
  const baseRequired = 'A administração WAIA precisa preparar a publicação deste atendimento.';
  const administrativePending = 'Existe uma atualização administrativa pendente. Solicite orientação à administração WAIA.';
  try {
    if (!versionSchema.safeParse(draftVersion).success || !versionSchema.safeParse(activeVersion).success) {
      return unavailable(baseRequired);
    }
    const active = activeRevision?.configuracao_compilada ?? activeRevision;
    if (!verifyCompiledTenantRuntimeConfigV2(active) || active.empresaId !== empresaId
      || active.configVersion !== activeVersion) return unavailable(baseRequired);
    if (activeRevision?.configuracao_compilada && (Number(activeRevision.config_version) !== activeVersion
      || activeRevision.checksum !== active.checksum)) return unavailable(baseRequired);

    // Compare canonical compiler output, including every technical default, rather
    // than requiring a raw draft to contain defaults inserted by the compiler.
    const candidate = compileTenantRuntimeConfigV2(configuration, {
      empresaId, configVersion: activeVersion + 1, draftVersion,
    });
    const baseline = active.configuration;
    if (stableJson(technicalProjection(candidate.configuration, baseline))
      !== stableJson(technicalProjection(baseline, baseline))) return unavailable(administrativePending);

    const before = projectAttendance(baseline);
    const after = projectAttendance(candidate.configuration);
    const changes = [];
    for (const definition of FIELD_DEFINITIONS) {
      if (!before.editableFields.includes(definition.key)) continue;
      if (stableJson(before.fields[definition.key]) !== stableJson(after.fields[definition.key])) {
        changes.push({ key: definition.key, label: definition.label,
          before: before.fields[definition.key], after: after.fields[definition.key] });
      }
    }
    for (const previous of before.replies) {
      const next = after.replies.find(({ key }) => key === previous.key);
      if (next && previous.text !== next.text) changes.push({
        key: `replies.${previous.key}`, label: previous.label, before: previous.text, after: next.text,
      });
    }
    const reviewToken = configurationChecksum({
      domain: 'WAIA:CUSTOMER_ATTENDANCE_PUBLICATION:M5', empresaId, draftVersion, activeVersion,
      configuration, activeChecksum: active.checksum, candidateChecksum: candidate.checksum,
    });
    return { ready: true, reason: null, changes, reviewToken };
  } catch {
    return unavailable('Revise os campos do atendimento ou solicite orientação à administração WAIA antes de publicar.');
  }
}
