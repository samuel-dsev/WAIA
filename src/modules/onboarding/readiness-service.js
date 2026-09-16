import { applyOnboardingPolicy, readinessCheck } from "./onboarding-policy.js";
import {
  aiIsReady,
  appointmentsAreReady,
  flowsAreReady,
  hasTenantAdministrator,
  identityIsComplete,
  menuIsValid,
  metaApplicationIsValid,
  moduleDependenciesAreValid,
  paymentIsReady,
  requiredIntegrationsAreAvailable,
  retentionIsValid,
  selectedModules,
  whatsappNumberIsComplete,
  whatsappTokenIsConfigured,
} from "./onboarding-validator.js";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} é obrigatório.`);
  return value;
}

function positiveVersion(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Snapshot esperado (somente sinais, nunca valores de credencial):
 * tenant, draftVersion, users/administratorCount, whatsapp,
 * credentialReferences/credentials, integrations, environment e
 * platformAiCredentialConfigured.
 */
export class ReadinessService {
  constructor({ compiler, capabilityCatalog, actionOwner, validateActionParams, flowRuntimeAvailable = false } = {}) {
    this.compiler = requiredFunction(compiler, "compiler");
    if (!Array.isArray(capabilityCatalog)) throw new TypeError("capabilityCatalog é obrigatório.");
    this.capabilityCatalog = capabilityCatalog;
    this.actionOwner = requiredFunction(actionOwner, "actionOwner");
    this.validateActionParams = validateActionParams == null
      ? null
      : requiredFunction(validateActionParams, "validateActionParams");
    this.flowRuntimeAvailable = flowRuntimeAvailable === true;
  }

  evaluate({ empresaId, configuration, snapshot = {}, mode } = {}) {
    const tenantId = String(empresaId || snapshot?.tenant?.empresaId || "").trim();
    const draft = configuration;
    const modules = selectedModules(draft);
    let compiles = false;
    if (tenantId && draft && typeof draft === "object") {
      try {
        this.compiler(draft, {
          empresaId: tenantId,
          configVersion: positiveVersion(snapshot?.nextConfigurationVersion, positiveVersion(snapshot?.tenant?.configurationVersion, 1) + 1),
          draftVersion: positiveVersion(snapshot?.draftVersion, 1),
        });
        compiles = true;
      } catch {
        compiles = false;
      }
    }

    const checks = [
      readinessCheck({
        code: "CONFIGURATION_DRAFT_AVAILABLE",
        passed: positiveVersion(snapshot?.draftVersion, 0) > 0,
        step: 10,
        message: "A empresa possui um rascunho de configuração V2.",
        correctiveAction: "Crie e salve o rascunho antes de validar ou publicar.",
      }),
      readinessCheck({
        code: "IDENTITY_COMPLETE",
        passed: identityIsComplete(draft),
        step: 1,
        message: "A identidade pública da empresa está completa.",
        correctiveAction: "Preencha nome, nome de exibição, idioma e fuso horário.",
      }),
      readinessCheck({
        code: "RETENTION_VALID",
        passed: retentionIsValid(draft),
        step: 1,
        message: "As retenções de mensagens e logs são válidas.",
        correctiveAction: "Defina retenções entre 1 e 3650 dias.",
      }),
      readinessCheck({
        code: "MODULES_SELECTED",
        passed: modules.size > 0,
        step: 2,
        message: "A empresa possui ao menos uma capacidade habilitada.",
        correctiveAction: "Selecione ao menos um módulo operacional.",
      }),
      readinessCheck({
        code: "MODULE_DEPENDENCIES_VALID",
        passed: moduleDependenciesAreValid(draft, this.capabilityCatalog),
        step: 2,
        message: "As dependências entre módulos estão satisfeitas.",
        correctiveAction: "Habilite as dependências indicadas para os módulos selecionados.",
      }),
      readinessCheck({
        code: "MENU_ACTIONS_VALID",
        passed: menuIsValid(draft, { actionOwner: this.actionOwner, validateActionParams: this.validateActionParams }),
        step: 4,
        message: "O menu possui ações válidas para os módulos habilitados.",
        correctiveAction: "Configure um menu com opções únicas escolhidas no catálogo de ações.",
      }),
      readinessCheck({
        code: "APPOINTMENT_SERVICE_AVAILABLE",
        passed: appointmentsAreReady(draft),
        step: 5,
        message: "O agendamento possui serviço ativo.",
        correctiveAction: "Cadastre e ative ao menos um serviço para agendamento.",
      }),
      readinessCheck({
        code: "PAYMENT_CREDENTIAL_AVAILABLE",
        passed: paymentIsReady(draft, snapshot),
        step: 5,
        message: "O pagamento possui vínculo operacional disponível.",
        correctiveAction: "Selecione uma credencial ou integração de pagamento válida.",
      }),
      readinessCheck({
        code: "FLOWS_VALID",
        passed: flowsAreReady(draft),
        step: 6,
        message: "Os fluxos possuem início e conclusão válidos.",
        correctiveAction: "Corrija o início, as etapas e a conclusão dos fluxos habilitados.",
      }),
      readinessCheck({
        code: "FLOW_RUNTIME_AVAILABLE",
        passed: !modules.has("flows") || this.flowRuntimeAvailable,
        step: 6,
        message: "O executor de fluxos está disponível no runtime.",
        correctiveAction: "Aguarde a liberação do executor de fluxos antes de publicar esta capacidade.",
      }),
      readinessCheck({
        code: "AI_CONFIGURATION_AVAILABLE",
        passed: aiIsReady(draft, snapshot),
        step: 7,
        message: "A IA está configurada com um vínculo de credencial disponível.",
        correctiveAction: "Complete provedor, modelo, prompt e a estratégia de credencial da IA.",
      }),
      readinessCheck({
        code: "WHATSAPP_PRIMARY_NUMBER_READY",
        passed: whatsappNumberIsComplete(snapshot),
        step: 8,
        message: "O número principal do WhatsApp está completo e ativo.",
        correctiveAction: "Configure WABA, phone_number_id e ative o número principal.",
      }),
      readinessCheck({
        code: "WHATSAPP_TOKEN_AVAILABLE",
        passed: whatsappTokenIsConfigured(snapshot),
        step: 8,
        message: "O token do WhatsApp está disponível no cofre.",
        correctiveAction: "Vincule uma credencial Meta ativa ao número principal.",
      }),
      readinessCheck({
        code: "META_APPLICATION_VALID",
        passed: metaApplicationIsValid(snapshot),
        step: 8,
        message: "O aplicativo Meta passou pela validação operacional.",
        correctiveAction: "Revise o aplicativo Meta e execute novamente o preflight.",
      }),
      readinessCheck({
        code: "TENANT_ADMIN_AVAILABLE",
        passed: hasTenantAdministrator(snapshot),
        step: 9,
        message: "A empresa possui ao menos um administrador ativo.",
        correctiveAction: "Vincule um administrador ativo à empresa.",
      }),
      readinessCheck({
        code: "REQUIRED_INTEGRATIONS_AVAILABLE",
        passed: requiredIntegrationsAreAvailable(draft, snapshot),
        step: 5,
        message: "As integrações obrigatórias estão disponíveis.",
        correctiveAction: "Corrija ou desmarque as integrações obrigatórias indisponíveis.",
      }),
      readinessCheck({
        code: "RUNTIME_CONFIGURATION_COMPILES",
        passed: compiles,
        step: 10,
        message: "A configuração compila para o runtime determinístico.",
        correctiveAction: "Corrija os campos inválidos indicados na revisão da configuração.",
      }),
    ];
    return applyOnboardingPolicy(checks, snapshot, { mode });
  }
}
