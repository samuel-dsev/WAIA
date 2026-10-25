import { FIELD_DEFINITIONS, projectAttendance } from './contract.js';
import { aiIsReady, metaApplicationIsValid, requiredIntegrationsAreAvailable,
  paymentIsReady, whatsappNumberIsComplete, whatsappTokenIsConfigured } from '../onboarding/onboarding-validator.js';

// This is a customer business catalog, never the technical module/action catalog.
export const ATTENDANCE_FEATURES = Object.freeze([
  { id: 'messages', label: 'Mensagens de atendimento', description: 'Saudação de reserva e resposta padrão.', fields: ['greeting', 'fallbackMessage'] },
  { id: 'information', label: 'Horários e informações públicas', description: 'Informações para orientar as respostas. Horários não fecham o atendimento automaticamente.', fields: ['timezone', 'schedules', 'publicRules', 'establishmentRules'] },
  { id: 'script', label: 'Roteiro e estilo', description: 'Roteiro completo, tom, resposta de indisponibilidade e complemento de atendimento.', fields: ['script', 'tone', 'aiFallback', 'followUp'] },
  { id: 'replies', label: 'Respostas predefinidas', description: 'Textos das respostas já liberadas pela administração, usados antes da IA.', fields: [] },
  { id: 'handoff', label: 'Encaminhamento humano', description: 'Mensagem usada ao encaminhar o atendimento à equipe.', fields: ['handoffMessage'] },
  { id: 'qualification', label: 'Qualificação do atendimento', description: 'Critérios e encerramento de uma ficha validada para a equipe.', fields: ['qualificationCriteria', 'qualificationClosing'] },
  { id: 'sales', label: 'Confirmação de interesse', description: 'Mensagem de interesse comercial, quando este comportamento está liberado no atendimento.', fields: ['salesInterestMessage'] },
].map((definition) => Object.freeze({ ...definition, fields: Object.freeze(definition.fields) })));

export const ATTENDANCE_GUIDANCE = Object.freeze({
  greeting: 'O texto do menu tem prioridade na saudação. Esta mensagem é usada como reserva quando não há texto de menu.',
  schedules: 'Informe os horários como texto público. Eles orientam a IA; não criam agenda nem encerram o atendimento fora do horário.',
  publicRules: 'Regras públicas entram no contexto da IA e permanecem subordinadas às proteções da plataforma.',
  tone: 'O estilo complementa o roteiro e não substitui suas orientações.',
  followUp: 'Com roteiro completo, as perguntas seguem o próprio roteiro. Este complemento só se aplica aos atendimentos que permitem pergunta adicional.',
  qualificationCriteria: 'A conclusão depende de uma ficha válida e da liberação administrativa do encaminhamento à equipe.',
  salesInterestMessage: 'Usada no atendimento comercial liberado, com catálogo disponível e sem qualificação estruturada. Editar o texto não habilita esse comportamento.',
});

const aiEnabled = (value) => value?.modules?.includes('ai_freeform') === true && value.ai?.enabled === true;
const handoffEnabled = (value) => value?.modules?.includes('human_handoff') === true;
const salesEnabled = (value) => aiEnabled(value) && value.modules.includes('catalog') && handoffEnabled(value) && value.ai.catalogSalesEnabled === true
  && value.ai.leadIntakeOnlyEnabled !== true && value.ai.leadQualificationEnabled !== true;
const qualificationEnabled = (value) => aiEnabled(value) && value.ai.leadQualificationEnabled === true;

function isInUse(id, configuration) {
  if (!configuration) return false;
  if (id === 'script' || id === 'information') return aiEnabled(configuration);
  if (id === 'qualification') return qualificationEnabled(configuration);
  if (id === 'sales') return salesEnabled(configuration);
  if (id === 'handoff') return handoffEnabled(configuration);
  if (id === 'replies') return projectAttendance(configuration).replies.length > 0;
  return true;
}

function dependencyReady(id, configuration, snapshot) {
  const channelReady = whatsappNumberIsComplete(snapshot) && whatsappTokenIsConfigured(snapshot) && metaApplicationIsValid(snapshot);
  if (snapshot.customerRuntimeReady !== true || !channelReady || !paymentIsReady(configuration, snapshot)
    || !requiredIntegrationsAreAvailable(configuration, snapshot)) return false;
  if (['script', 'information', 'qualification', 'sales'].includes(id) && !aiIsReady(configuration, snapshot)) return false;
  if (id === 'qualification' && snapshot.leadNotifications?.destinationConfigured !== true) return false;
  // The commercial runtime requires a healthy products source. Do not project
  // its type, reference, document or provider into the business status.
  if (id === 'sales' && snapshot.customerCatalogReady !== true) return false;
  return true;
}

const messages = Object.freeze({
  disabled: 'Solicite à administração WAIA a liberação deste recurso.',
  suspended: 'O atendimento precisa de liberação administrativa para voltar a operar. O rascunho autorizado pode ser preparado.',
  draft: 'Este recurso não está em uso na versão publicada. Preparar o conteúdo não o habilita.',
  needs_admin: 'Há uma preparação administrativa pendente para usar este recurso.',
  ready: 'Disponível no atendimento publicado, respeitando as regras e os limites liberados.',
});

export function projectAttendanceResources(configuration, {
  capabilities = [], companyStatus, activeConfiguration = null, snapshot = {},
} = {}) {
  const projection = projectAttendance(configuration);
  const visible = new Set(projection.editableFields);
  const features = ATTENDANCE_FEATURES.map((definition) => {
    const fields = definition.fields.filter((key) => visible.has(key));
    const enabled = definition.id === 'replies' ? projection.replies.length > 0 : fields.length > 0;
    const state = !enabled ? 'disabled' : companyStatus === 'suspensa' ? 'suspended'
      : companyStatus !== 'ativa' ? 'draft'
      : !isInUse(definition.id, activeConfiguration) ? 'draft'
        : dependencyReady(definition.id, activeConfiguration, snapshot) ? 'ready' : 'needs_admin';
    return { ...definition, fields, enabled, canEdit: enabled && capabilities.includes('attendance.edit'), state, message: messages[state] };
  });
  const fieldLimits = Object.fromEntries(FIELD_DEFINITIONS.filter(({ key }) => visible.has(key)).map((definition) => [definition.key,
    { maxCharacters: definition.maxLength, kind: definition.kind, ...(definition.maxItems ? { maxItems: definition.maxItems } : {}) }]));
  if (projection.replies.length) fieldLimits.replies = { maxCharacters: 2000, maxItems: projection.replies.length, kind: 'replies' };
  const behaviors = [
    { id: 'responseDelay', label: 'Espera antes da resposta da IA', check: (value) => aiEnabled(value) && value.ai.responseDelayEnabled !== false },
    { id: 'businessPause', label: 'Pausa ao responder pelo aplicativo', check: (value) => value?.humanHandoff?.pauseOnBusinessAppMessage === true },
    { id: 'commercial', label: 'Atendimento comercial com catálogo', check: salesEnabled },
    { id: 'intake', label: 'Triagem de novos interessados', check: (value) => qualificationEnabled(value) && value.ai.leadIntakeOnlyEnabled === true },
  ].map(({ id, label, check }) => ({ id, label, draftEnabled: check(configuration), activeEnabled: check(activeConfiguration), adminManaged: true }));
  return { features, behaviors, fieldLimits,
    guidance: Object.fromEntries(Object.entries(ATTENDANCE_GUIDANCE).filter(([key]) => visible.has(key))) };
}
