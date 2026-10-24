import { z } from 'zod';
import { AccountError } from '../accounts/errors.js';
import { parseTenantRuntimeConfigV2Draft } from '../configuration/tenant-runtime-config-v2.js';
import { stableJson } from '../configuration/stable-json.js';

const field = (key, label, section, leaf, maxLength, group, extra = {}) => Object.freeze({
  key, label, path: Object.freeze([section, leaf]), maxLength, kind: 'text', group, ...extra,
});

// This is the complete customer field allowlist, not a list of section prefixes.
export const FIELD_DEFINITIONS = Object.freeze([
  field('greeting', 'Saudação', 'identity', 'welcomeMessage', 1000, 'messages'),
  field('fallbackMessage', 'Mensagem quando não houver resposta', 'identity', 'fallbackMessage', 1000, 'messages'),
  field('timezone', 'Fuso horário', 'identity', 'timezone', 80, 'operation', { kind: 'timezone' }),
  field('schedules', 'Horários de atendimento', 'identity', 'schedules', 300, 'operation', { kind: 'lines', maxItems: 50 }),
  field('publicRules', 'Regras públicas', 'identity', 'publicRules', 1000, 'operation', { kind: 'lines', maxItems: 100 }),
  field('establishmentRules', 'Orientações do estabelecimento', 'identity', 'establishmentRules', 10000, 'operation'),
  field('script', 'Roteiro completo da IA', 'ai', 'prompt', 20000, 'script'),
  field('tone', 'Tom de atendimento', 'ai', 'personality', 2000, 'script'),
  field('aiFallback', 'Mensagem de indisponibilidade da IA', 'ai', 'fallbackMessage', 1000, 'messages'),
  field('followUp', 'Pergunta para continuar o atendimento', 'ai', 'followUpQuestion', 300, 'messages'),
  field('qualificationCriteria', 'Critérios de qualificação', 'ai', 'leadQualificationCriteria', 2000, 'qualification'),
  field('qualificationClosing', 'Mensagem de encerramento da qualificação', 'ai', 'leadQualificationClosing', 1000, 'qualification'),
  field('handoffMessage', 'Mensagem de encaminhamento humano', 'humanHandoff', 'message', 1000, 'handoff'),
  field('salesInterestMessage', 'Mensagem de interesse comercial', 'humanHandoff', 'salesInterestMessage', 1000, 'handoff'),
]);

const REPLIES = Object.freeze({
  'catalog.address': Object.freeze({ module: 'catalog', label: 'Endereço' }),
  'catalog.menu': Object.freeze({ module: 'catalog', label: 'Cardápio' }),
  'events.birthday_rule': Object.freeze({ module: 'events', label: 'Regra de aniversariante' }),
});
const validation = (message = 'Confira os campos de atendimento e seus limites antes de salvar.') =>
  new AccountError('ATTENDANCE_VALIDATION_ERROR', 422, message);
const unavailable = () => new AccountError('ATTENDANCE_FIELD_UNAVAILABLE', 403,
  'Este recurso de atendimento não está liberado. Solicite orientação à administração WAIA.');

function safeInput(value) {
  try { stableJson(value); }
  catch { throw validation('Informe somente os campos e valores de atendimento permitidos.'); }
}
function isEnabled(configuration, definition) {
  const modules = Array.isArray(configuration.modules) ? configuration.modules : [];
  if (definition.path[0] === 'ai') {
    return modules.includes('ai_freeform') && configuration.ai?.enabled === true
      && (definition.group !== 'qualification' || configuration.ai?.leadQualificationEnabled === true);
  }
  return definition.path[0] !== 'humanHandoff' || modules.includes('human_handoff');
}
const timezone = (value) => {
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: value }).format(); return true; }
  catch { return false; }
};
const fieldSchema = (definition) => {
  const text = z.string().max(definition.maxLength);
  if (definition.kind === 'lines') return z.array(text.refine((value) => value.trim().length > 0)).max(definition.maxItems);
  if (definition.kind === 'timezone') return text.min(1).refine(timezone);
  if (['script', 'qualificationCriteria'].includes(definition.key)) return text.refine((value) => value.trim().length > 0);
  return text;
};
const replySchema = z.object({
  key: z.enum(Object.keys(REPLIES)), text: z.string().min(1).max(2000).refine((value) => value.trim().length > 0),
}).strict();
const changesSchema = z.object({
  ...Object.fromEntries(FIELD_DEFINITIONS.map((definition) => [definition.key, fieldSchema(definition).optional()])),
  replies: z.array(replySchema).max(Object.keys(REPLIES).length)
    .refine((values) => new Set(values.map((entry) => entry.key)).size === values.length).optional(),
}).strict().refine((value) => Object.keys(value).length > 0
  && (Object.keys(value).some((key) => key !== 'replies') || value.replies?.length > 0));
const patchSchema = z.object({ draftVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), changes: changesSchema }).strict();

function validationFor(result) {
  const first = result.error.issues[0];
  if (!first || first.code === 'unrecognized_keys') return validation();
  const path = first.path[0] === 'changes' ? first.path.slice(1) : first.path;
  const definition = FIELD_DEFINITIONS.find(({ key }) => key === path[0]);
  if (definition) {
    if (definition.kind === 'lines') return validation(`${definition.label}: informe até ${definition.maxItems} linhas não vazias, com até ${definition.maxLength} caracteres em cada uma.`);
    if (definition.kind === 'timezone') return validation(`${definition.label}: informe um identificador IANA válido, como America/Sao_Paulo, com até ${definition.maxLength} caracteres.`);
    const required = ['script', 'qualificationCriteria'].includes(definition.key) ? ' não vazio' : '';
    return validation(`${definition.label}: informe um texto${required} com até ${definition.maxLength} caracteres.`);
  }
  if (path[0] === 'replies') return validation('Respostas predefinidas: edite somente os textos já liberados, com 1 a 2000 caracteres e sem repetir uma resposta.');
  return validation();
}

export function parseAttendancePatch(body) {
  safeInput(body);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) throw validationFor(parsed);
  return parsed.data;
}

function allowedReplies(configuration) {
  const modules = Array.isArray(configuration.modules) ? configuration.modules : [];
  return (Array.isArray(configuration.publicReplies) ? configuration.publicReplies : [])
    .filter((reply) => reply && typeof reply.action === 'string' && Object.hasOwn(REPLIES, reply.action)
      && modules.includes(REPLIES[reply.action].module));
}

export function projectAttendance(configuration) {
  const editable = FIELD_DEFINITIONS.filter((definition) => isEnabled(configuration, definition));
  const fields = Object.fromEntries(editable.map((definition) => {
    const value = configuration[definition.path[0]]?.[definition.path[1]];
    const parsed = fieldSchema(definition).safeParse(value);
    const fallback = definition.kind === 'lines' ? [] : '';
    return [definition.key, parsed.success ? structuredClone(parsed.data) : fallback];
  }));
  return {
    fields,
    editableFields: editable.map(({ key }) => key),
    replies: allowedReplies(configuration).map((reply) => ({
      key: reply.action, label: REPLIES[reply.action].label,
      text: typeof reply.text === 'string' && reply.text.length <= 2000 ? reply.text : '',
    })),
  };
}

export function mergeAttendance(configuration, changes) {
  safeInput(changes);
  const parsed = changesSchema.safeParse(changes);
  if (!parsed.success) throw validationFor(parsed);
  const availableReplies = new Set(allowedReplies(configuration).map((reply) => reply.action));
  const merged = structuredClone(configuration);
  for (const definition of FIELD_DEFINITIONS) {
    if (!Object.hasOwn(parsed.data, definition.key)) continue;
    if (!isEnabled(configuration, definition)) throw unavailable();
    const [section, leaf] = definition.path;
    merged[section] ??= {};
    merged[section][leaf] = structuredClone(parsed.data[definition.key]);
  }
  if (parsed.data.replies) {
    for (const update of parsed.data.replies) {
      if (!availableReplies.has(update.key)) throw unavailable();
      const index = merged.publicReplies.findIndex((reply) => reply.action === update.key);
      merged.publicReplies[index].text = update.text;
    }
  }
  try { parseTenantRuntimeConfigV2Draft(merged); }
  catch { throw validation('O atendimento contém conteúdo inválido ou material de acesso. Revise os textos antes de salvar.'); }
  // Do not persist parser/compiler output: unrelated technical strings/defaults stay exact.
  return merged;
}
