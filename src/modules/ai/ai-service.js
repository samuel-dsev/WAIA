import { sanitizeError } from "../../security/redaction.js";
import { assertAiDependencies, normalizeAiConfig, requireAiRequest } from "./contracts.js";
import {
  allowlistedTenantContext,
  buildInstructions,
  isPromptInjectionAttempt,
  serializeTenantContext,
} from "./guardrails.js";
import { calculateCost, estimateTokens, normalizePricing } from "./pricing.js";
import { catalogSelectionFormat, parseCatalogSelection, CATALOG_SELECTION_INSTRUCTIONS } from "../business/catalog-messages.js";
import { asksForWebsiteVehicleDetails, catalogSalesFormat, parseCatalogSalesReply, CATALOG_SALES_INSTRUCTIONS, WEBSITE_CATALOG_SALES_INSTRUCTIONS } from "../business/catalog-sales.js";
import { loadConversationContext } from "./conversation-context.js";
import { preserveCollectedFinancingData } from "../group-notifier/collected-financing-data.js";
import { hasWebsiteFinancingConsent, websiteReferenceClarification, acceptsWebsiteAlternativesOffer, websitePhotoHistoryLine } from "../business/website-catalog-interaction.js";
import { normalizeTradeInEvaluation, tradeInEvaluationFormat, TRADE_IN_EVALUATION_INSTRUCTIONS, tradeInTurnInstructions, tradeInOfferFromAnswer, reconcileTradeInEvaluation, hasTradeInEvaluationConsent,
  mayQualifyTradeInEvaluation, evaluationLeadCard, evaluationClosing, evaluationAnswerWithoutFollowUp, declinesTradeInEvaluation, announcesEvaluationBooking, announcesEvaluationDelivery, EVALUATION_CLOSING } from "../business/trade-in-evaluation.js";
import { qualificationFormat, qualificationInstructions, parseQualification, qualificationContinuation, announcesQualificationClosing, QUALIFICATION_CLOSING, QUALIFICATION_RECHECK_INSTRUCTIONS } from "../group-notifier/qualification.js";
import { leadIntakeFormat, parseLeadIntake, intakeQuestion, LEAD_INTAKE_INSTRUCTIONS, LEAD_INTAKE_RECHECK_INSTRUCTIONS } from "../group-notifier/lead-intake.js";

function normalizeUsage(response) {
  const inputTokens = Math.max(0, Number(response?.usage?.input_tokens ?? response?.usage?.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(response?.usage?.output_tokens ?? response?.usage?.outputTokens) || 0);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function timeoutError() {
  const error = new Error("Tempo limite da IA excedido.");
  error.name = "AiTimeoutError";
  error.code = "AI_TIMEOUT";
  error.retryable = true;
  return error;
}

async function responseWithTimeout(client, request, timeoutMs, requestOptions = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      client.responses.create(request, { ...requestOptions, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fallback(config, reason, extra = {}) {
  return Object.freeze({
    text: config?.contingencyMessage
      || "O atendimento inteligente está temporariamente indisponível. Consulte o menu ou fale com a equipe.",
    source: "fallback",
    reason,
    ...extra,
  });
}

export class MultiTenantAiService {
  constructor({
    configResolver,
    conversationService,
    clientFactory,
    secretResolver,
    ledger,
    pricingCatalog,
    alertSink = null,
    timeoutMs = 15_000,
    clock = () => new Date(),
    logger = console,
  } = {}) {
    assertAiDependencies({ configResolver, conversationService, clientFactory, secretResolver, ledger, pricingCatalog });
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs inválido.");
    this.configResolver = configResolver;
    this.conversationService = conversationService;
    this.clientFactory = clientFactory;
    this.secretResolver = secretResolver;
    this.ledger = ledger;
    this.pricingCatalog = pricingCatalog;
    this.alertSink = alertSink;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
    this.logger = logger;
  }

  async reply(input) {
    const request = requireAiRequest(input);
    let config;
    try {
      config = normalizeAiConfig(
        await this.configResolver.getAiConfig({ empresaId: request.empresaId }),
        request.empresaId,
      );
    } catch (error) {
      this.#logFailure(request, error, "AI_CONFIG_UNAVAILABLE");
      return fallback(null, "not_configured");
    }
    if (!config.enabled) return fallback(config, "disabled");
    if (isPromptInjectionAttempt(request.message)) {
      this.logger.warn?.("ai_prompt_injection_blocked", {
        empresaId: request.empresaId,
        conversationId: request.conversationId,
        correlationId: request.correlationId,
      });
      return Object.freeze({ text: config.guardrailMessage, source: "guardrail", reason: "prompt_injection" });
    }

    let reservation;
    let pricing;
    let providerUsage;
    let keyType = config.keyType;
    const occurredAt = this.clock();
    try {
      const qualifies = config.leadQualificationEnabled && Boolean(config.leadQualificationCriteria);
      const intakeOnly = config.leadIntakeOnlyEnabled;
      const suppliedContext = allowlistedTenantContext(request.context, config.allowedContextKeys);
      if (intakeOnly) {
        // Stale tenant/catalog configuration must never reactivate product sales in triage mode.
        delete suppliedContext.catalog;
        delete suppliedContext.events;
        delete suppliedContext.services;
        delete suppliedContext.knowledgeBase;
      }
      // Structured qualification owns closing/pause when enabled, including tenants
      // whose older product-only closing is still configured.
      const safeContext = qualifies && suppliedContext.catalog?.salesMode === true
        ? { ...suppliedContext, catalog: { ...suppliedContext.catalog, interestHandoff: { enabled: false, message: "" } } }
        : suppliedContext;
      const websiteCatalog = safeContext.catalog?.source?.type === "website_catalog" ? safeContext.catalog : null;
      const websiteDetails = websiteCatalog && asksForWebsiteVehicleDetails(request.message);
      let financingVehicles = [];
      const evaluationEnabled = config.tradeInEvaluationEnabled && qualifies && !intakeOnly;
      const transcript = await loadConversationContext(this.conversationService, request, occurredAt, { includeIncomingImages: evaluationEnabled });
      const qualificationEvidence = [...transcript.evidence, ...(request.turnMessages ? request.turnMessages.map((part) => part.text) : [request.message])];
      const promptHistory = transcript.input;
      const alternativesAccepted = websiteCatalog && acceptsWebsiteAlternativesOffer(request.message, promptHistory);
      const photoHistoryLine = websiteCatalog ? websitePhotoHistoryLine(websiteCatalog) : "";
      // The model selects an exact ID. Only the runtime needs the gallery URLs.
      const modelContext = websiteCatalog ? { ...safeContext, catalog: { ...websiteCatalog,
        items: websiteCatalog.items.map(({ imageUrl, imageUrls, introduction, details, ...item }) => item),
      } } : safeContext;
      const contextContent = `TENANT_DATA_START\n${serializeTenantContext(modelContext)}\nTENANT_DATA_END`;
      const salesMode = safeContext.catalog?.salesMode === true;
      const catalogFormat = salesMode ? catalogSalesFormat(safeContext.catalog) : catalogSelectionFormat(safeContext.catalog);
      const baseFormat = intakeOnly ? leadIntakeFormat() : qualifies ? qualificationFormat(catalogFormat) : catalogFormat;
      const selectionFormat = evaluationEnabled ? tradeInEvaluationFormat(baseFormat) : baseFormat;
      const paragraphReply = evaluationEnabled && /\b(?:troca|avalia[cç][aã]o)\b/iu.test(request.message)
        && (request.message.match(/\?/gu) || []).length > 1;
      if (paragraphReply && selectionFormat?.schema?.properties?.text) {
        selectionFormat.schema.properties.text.pattern = "[\\s\\S]*\\S\\n\\n[\\s\\S]*\\S\\n\\n[\\s\\S]*\\S[\\s\\S]*";
      }
      const turnGuidance = [
        alternativesAccepted ? "OFERTA ATUAL ACEITA: a última pergunta enviada ofereceu modelos/opções semelhantes e o cliente aceitou. Use browse para apresentar somente a lista do estoque, com filtros coerentes com o histórico. Não use finance/products, não pergunte para qual modelo quer simulação e não peça dados de financiamento. Uma oferta antiga de simulação não muda esse aceite." : "",
        paragraphReply ? "FORMATAÇÃO DESTE TURNO: responda a cada pergunta realmente feita em seu próprio parágrafo. Separe os parágrafos por uma linha em branco (\\n\\n), mantendo uma única mensagem e um último parágrafo para o convite. Não crie um assunto nem inclua localização para preencher parágrafos: endereço/cidade somente quando solicitado pelo cliente." : "",
        photoHistoryLine ? "Na ficha de simulação, preserve os dados coletados e demais solicitações. Diferencie os modelos com fotos no histórico dos modelos que o cliente escolheu simular. O sistema acrescenta dados literais conferidos nas mensagens e a linha dos últimos modelos com fotos; redija o relato de summary em até 750 caracteres para reservar espaço, sem apagar os dados fornecidos." : "",
      ].filter(Boolean).join("\n");
      const evaluationTurnInstructions = evaluationEnabled ? tradeInTurnInstructions(safeContext.tradeInEvaluation, request.turnMessages) : "";
      const recheckInstructions = (intakeOnly ? LEAD_INTAKE_RECHECK_INSTRUCTIONS : QUALIFICATION_RECHECK_INSTRUCTIONS)
        + (websiteCatalog ? "\nReavalie o pedido no histórico: simulação explícita dos dois modelos e aceite após uma oferta atual de simulação usam finance com ambos os IDs. O recebimento de dados para uma simulação já aceita continua usando finance com os IDs da pendência, mesmo sem repetir o pedido na mensagem atual. Se o aceite curto responde à oferta de lista ou fotos, não use finance, não colete CPF/nascimento e não conclua financiamento. Responda ao pedido atual e mantenha collecting enquanto faltarem dados." : "")
        + (evaluationEnabled ? "\nNa avaliação, nome informado e pedido/aceite presencial permitem concluir no mesmo turno, sem nova confirmação de cadastro. text responde às perguntas atuais e pode agradecer e informar contato futuro de um vendedor. Encerre sem pergunta de continuidade ou confirmação de cadastro, interesse ou telefone. Se apenas recebeu fotos e uma dúvida de localização, mantenha collect_photos e collecting, sem anunciar contato de vendedor. Sempre preencha tradeInEvaluation ao tratar de avaliação. Não afirme reserva de horário, envio da ficha ou notificação ao grupo/equipe, nem repita CPF/nascimento. Preserve os dados da ficha em summary com no máximo 1600 caracteres." : "")
        + (evaluationTurnInstructions ? "\n" + evaluationTurnInstructions : "")
        + (turnGuidance ? "\n" + turnGuidance : "");
      const instructions = [buildInstructions(config), catalogFormat ? salesMode ? CATALOG_SALES_INSTRUCTIONS : CATALOG_SELECTION_INSTRUCTIONS : "" ,
        intakeOnly ? `${LEAD_INTAKE_INSTRUCTIONS}\nCritérios publicados: ${config.leadQualificationCriteria}`
          : qualifies ? qualificationInstructions(config.leadQualificationCriteria) : "",
        catalogFormat && salesMode && safeContext.catalog.source?.type === "website_catalog" ? WEBSITE_CATALOG_SALES_INSTRUCTIONS : "",
        evaluationEnabled ? TRADE_IN_EVALUATION_INSTRUCTIONS + "\nReferência para o encerramento: " + (config.tradeInEvaluationClosing || EVALUATION_CLOSING) : "",
        evaluationTurnInstructions,
        turnGuidance,
      ].filter(Boolean).join("\n\n");
      const inputMessages = [
        { role: "developer", content: contextContent },
        ...promptHistory,
        ...transcript.current,
      ];
      pricing = normalizePricing(await this.pricingCatalog.get({
        provider: config.provider,
        model: config.model,
      }), config.model);
      const estimatedInputTokens = estimateTokens(`${instructions}\n${JSON.stringify(inputMessages)}${selectionFormat ? `\n${JSON.stringify(selectionFormat)}` : ""}`);
      // Reserve the bounded repair budget before any provider call. Unused budget
      // is released by the same finalization; actual usage is summed below.
      const repairInputTokens = qualifies ? estimatedInputTokens + estimateTokens(recheckInstructions) : 0;
      const estimatedTokens = estimatedInputTokens + repairInputTokens + config.maxOutputTokens * (qualifies ? 2 : 1);
      const estimatedCost = calculateCost(pricing, {
        inputTokens: estimatedInputTokens + repairInputTokens,
        outputTokens: config.maxOutputTokens * (qualifies ? 2 : 1),
      });
      reservation = await this.ledger.reserve({
        empresaId: request.empresaId,
        occurredAt,
        tokenLimit: config.monthlyTokenLimit,
        costLimit: config.monthlyCostLimit,
        alertPercent: config.alertPercent,
        estimatedTokens,
        estimatedCost,
      });
      if (!reservation?.allowed) return fallback(config, "monthly_limit", { quota: reservation?.usage });

      const credential = await this.secretResolver.resolve({
        empresaId: request.empresaId,
        provider: config.provider,
        keyType: config.keyType,
        credentialId: config.credentialId,
      });
      keyType = credential?.keyType || config.keyType;
      if (config.provider !== "simulated" && !credential?.apiKey) {
        const error = new Error("Credencial de IA indisponível.");
        error.code = "AI_CREDENTIAL_NOT_CONFIGURED";
        throw error;
      }
      const client = await this.clientFactory.create({
        empresaId: request.empresaId,
        provider: config.provider,
        apiKey: credential?.apiKey || null,
      });
      if (typeof client?.responses?.create !== "function") throw new TypeError("Cliente Responses API inválido.");
      const providerRequest = {
        model: config.model,
        store: false,
        max_output_tokens: config.maxOutputTokens,
        instructions,
        input: inputMessages,
        ...(selectionFormat ? { text: { format: selectionFormat } } : {}),
      };
      const startedAt = performance.now();
      const requestResponse = async (repair = false) => {
        const remainingMs = this.timeoutMs - (performance.now() - startedAt);
        if (remainingMs < 1) throw timeoutError();
        const response = await responseWithTimeout(client, repair
          ? { ...providerRequest, instructions: `${instructions}\n\n${recheckInstructions}` } : providerRequest,
        remainingMs, { headers: { "X-Client-Request-Id": repair
          ? `${String(request.correlationId).slice(0, 504)}:recheck` : String(request.correlationId).slice(0, 512) } });
        const usage = normalizeUsage(response);
        providerUsage = { inputTokens: (providerUsage?.inputTokens || 0) + usage.inputTokens,
          outputTokens: (providerUsage?.outputTokens || 0) + usage.outputTokens,
          totalTokens: (providerUsage?.totalTokens || 0) + usage.totalTokens };
        const text = String(response?.output_text || "").trim();
        if (!text) throw Object.assign(new Error("A IA não retornou texto."), { code: "AI_EMPTY_RESPONSE" });
        if (response.status === "incomplete") throw Object.assign(new Error("Resposta incompleta da IA."), { code: "AI_INCOMPLETE_RESPONSE" });
        return { response, text };
      };
      let { response, text } = await requestResponse();
      let parsedText = text, leadQualification, qualificationIssue, nonLeadHandoff, validatedCatalogReply, evaluationState, evaluationAnswer;
      if (intakeOnly) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const structured = JSON.parse(text);
          if (!structured || typeof structured.text !== "string" || structured.text.length > 4096
            || Object.keys(structured).length !== 2) throw Object.assign(new Error("Resposta inválida."), { code: "AI_INVALID_LEAD_INTAKE" });
          let intake;
          try {
            intake = parseLeadIntake(structured.leadQualification, { configVersion: config.version,
              evidence: qualificationEvidence,
              adReferral: safeContext.adContext?.referral });
          } catch (error) {
            if (error.code !== "AI_INVALID_LEAD_INTAKE" || !/^(NAME|CITY|MODEL)(?:_EVIDENCE)?$/u.test(error.validationReason)) throw error;
            qualificationIssue = error.validationReason;
            structured.text = intakeQuestion(qualificationIssue);
          }
          if (intake?.status === "qualified") leadQualification = intake.leadQualification;
          if (intake?.status === "not_qualified") {
            nonLeadHandoff = { configVersion: config.version };
            parsedText = config.nonLeadHandoffMessage;
            break;
          }
          if (!leadQualification && !qualificationIssue && announcesQualificationClosing(structured.text, config.leadQualificationClosing || QUALIFICATION_CLOSING)) {
            if (attempt === 0) {
              this.logger.warn?.("ai_qualification_recheck", { empresaId: request.empresaId, conversationId: request.conversationId,
                correlationId: request.correlationId, code: "AI_QUALIFICATION_RECHECK", validationReason: "UNCONFIRMED_CLOSING" });
              ({ response, text } = await requestResponse(true));
              continue;
            }
            qualificationIssue = "UNCONFIRMED_CLOSING";
            structured.text = intakeQuestion(qualificationIssue);
          }
          if (qualificationIssue) this.logger.warn?.("ai_qualification_deferred", { empresaId: request.empresaId,
            conversationId: request.conversationId, correlationId: request.correlationId,
            code: "AI_QUALIFICATION_DEFERRED", validationReason: qualificationIssue });
          if (!leadQualification && !structured.text.trim()) throw Object.assign(new Error("Resposta inválida."), { code: "AI_INVALID_LEAD_INTAKE" });
          parsedText = structured.text.trim();
          break;
        }
      } else if (qualifies) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const structured = JSON.parse(text);
          if (!structured || typeof structured !== "object" || Array.isArray(structured)
            || typeof structured.text !== "string" || structured.text.length > 4096) throw Object.assign(new Error("Resposta inválida."), { code: "AI_INVALID_LEAD_QUALIFICATION" });
          if (alternativesAccepted) {
            if (structured.catalogAction !== "browse" && attempt === 0) { ({ response, text } = await requestResponse(true)); continue; }
            if (structured.catalogAction !== "browse") {
              structured.catalogAction = "browse";
              structured.filters = { category: null, minPrice: null, maxPrice: null };
            }
            structured.productIds = [];
            structured.leadQualification = { status: "collecting", name: null, summary: null, qualification: null };
          }
          const evaluationProposal = evaluationEnabled ? normalizeTradeInEvaluation(reconcileTradeInEvaluation(declinesTradeInEvaluation(request.message)
            && safeContext.tradeInEvaluation?.session ? { step: "declined", interestName: safeContext.tradeInEvaluation.session.interestName || null,
              interestSource: safeContext.tradeInEvaluation.session.interestSource || "unknown" } : structured.tradeInEvaluation
              ?? tradeInOfferFromAnswer(structured.text, safeContext.tradeInEvaluation?.session), safeContext.tradeInEvaluation,
              request.message, promptHistory, request.turnMessages)) : null;
          delete structured.tradeInEvaluation;
          const evaluationConsent = evaluationEnabled && hasTradeInEvaluationConsent(safeContext.tradeInEvaluation, request.message, promptHistory, request.turnMessages, evaluationProposal?.step);
          evaluationState = evaluationProposal && (!["collect_photos", "visit_requested", "human_review_requested"].includes(evaluationProposal.step) || evaluationConsent)
            ? evaluationProposal : null;
          const currentEvaluation = evaluationState || safeContext.tradeInEvaluation?.session;
          const evaluationQualifies = evaluationEnabled && structured.catalogAction !== "finance" && mayQualifyTradeInEvaluation(currentEvaluation, evaluationConsent);
          const clarification = websiteCatalog && !evaluationProposal && websiteReferenceClarification(websiteCatalog, request.message, structured.productIds);
          if (clarification) {
            structured.text = clarification.text;
            structured.productIds = clarification.websiteInteraction.productIds;
            structured.catalogAction = "none";
            structured.leadQualification = { status: "collecting", name: null, summary: null, qualification: null };
          }
          const websitePresentation = websiteCatalog && ["browse", "more", "products", "choose"].includes(structured.catalogAction);
          const selectedIds = Array.isArray(structured.productIds) ? structured.productIds : [];
          const pendingFinanceIds = websiteCatalog?.financingSession?.status === "pending"
            ? websiteCatalog.financingSession.productIds || (websiteCatalog.financingSession.productId ? [websiteCatalog.financingSession.productId] : []) : [];
          const completesPendingFinance = websiteCatalog && !websiteDetails && !evaluationProposal
            && structured.catalogAction === "none" && structured.leadQualification?.status === "qualified"
            && !request.turnMessages?.some((part) => part.type === "image")
            && pendingFinanceIds.length > 0 && pendingFinanceIds.length <= 3
            && selectedIds.every((id) => pendingFinanceIds.includes(id));
          if (completesPendingFinance) {
            structured.catalogAction = "finance";
            structured.productIds = [...pendingFinanceIds];
          }
          const financingIds = completesPendingFinance ? pendingFinanceIds : selectedIds;
          financingVehicles = websiteCatalog && !websiteDetails && structured.catalogAction === "finance"
            && financingIds.length > 0 && financingIds.length <= 3 && new Set(financingIds).size === financingIds.length
            ? financingIds.map((id) => websiteCatalog.items.find((item) => item.id === id && item.active !== false && item.availability !== "unavailable")) : [];
          if (financingVehicles.some((item) => !item || !hasWebsiteFinancingConsent(websiteCatalog, request.message, item.id, promptHistory))) financingVehicles = [];
          let mayQualify = !websiteCatalog && !currentEvaluation || financingVehicles.length > 0 || evaluationQualifies && !websitePresentation && !websiteDetails;
          const prematureCollection = websiteCatalog && !financingVehicles.length && !websitePresentation
            && (/\b(?:informe|envie|manda?|passe|diga|preciso|me fale|qual(?: é)?)\b[^.!?\n]{0,100}\b(?:cpf|nascimento)\b/iu.test(structured.text)
              || /\b(?:cpf|nascimento)\b[^.!?\n]{0,80}(?:por favor|\?)/iu.test(structured.text));
          if (prematureCollection || websiteCatalog && structured.catalogAction === "finance" && !financingVehicles.length) {
            if (attempt === 0) {
              ({ response, text } = await requestResponse(true));
              continue;
            }
            structured.catalogAction = "none";
            const focusIds = selectedIds.length > 0 && selectedIds.length <= 3 ? selectedIds : websiteCatalog.interaction?.productIds || [];
            const focus = focusIds.length <= 3 ? websiteCatalog.items.filter((item) => focusIds.includes(item.id)) : [];
            structured.productIds = focus.map((item) => item.id);
            structured.text = focus.length
              ? "Sobre " + focus.map((item) => item.name).join(" e ") + ", você quer fazer uma simulação ou tirar outra dúvida?"
              : "Para quais modelos você quer a simulação?";
            if (evaluationEnabled && currentEvaluation) {
              structured.text = "Você prefere enviar fotos para uma análise inicial ou solicitar uma avaliação presencial?";
              evaluationState = null;
            }
            financingVehicles = [];
            mayQualify = false;
          }
          try {
            let card = evaluationQualifies && structured.leadQualification?.status === "qualified"
              ? evaluationLeadCard(structured.leadQualification, currentEvaluation, safeContext, qualificationEvidence) : structured.leadQualification;
            if (financingVehicles.length && card?.status === "qualified") card = preserveCollectedFinancingData(card, qualificationEvidence, [...promptHistory, ...transcript.current]);
            if (financingVehicles.length && card?.status === "qualified" && photoHistoryLine && !String(card.summary || "").includes(photoHistoryLine)) {
              card = { ...card, summary: String(card.summary || "") + "\n" + photoHistoryLine };
            }
            leadQualification = mayQualify ? parseQualification(card, { configVersion: config.version,
              evidence: qualificationEvidence }) : null;
            if (leadQualification && evaluationQualifies) {
              structured.text = evaluationAnswerWithoutFollowUp(structured.text);
              if (announcesEvaluationDelivery(structured.text) || announcesEvaluationBooking(structured.text) || structured.text.includes("?")
                || /\b\d{3}\.?\d{3}\.?\d{3}[- ]?\d{2}\b/u.test(structured.text)) {
                if (attempt === 0) { ({ response, text } = await requestResponse(true)); continue; }
                throw Object.assign(new Error("Texto público de avaliação inválido."), { code: "AI_INVALID_TRADE_EVALUATION" });
              }
              evaluationState = normalizeTradeInEvaluation({ step: currentEvaluation.step, interestName: currentEvaluation.interestName || null, interestSource: currentEvaluation.interestSource || "unknown" });
              evaluationAnswer = structured.text;
            }
          } catch (error) {
            if (error.code !== "AI_INVALID_LEAD_QUALIFICATION" || !["NAME", "SUMMARY", "QUALIFICATION", "NAME_EVIDENCE"].includes(error.validationReason)) throw error;
            if ((evaluationQualifies || financingVehicles.length) && error.validationReason === "SUMMARY" && attempt === 0) {
              ({ response, text } = await requestResponse(true)); continue;
            }
            qualificationIssue = error.validationReason;
            structured.text = financingVehicles.length && ["NAME", "NAME_EVIDENCE"].includes(qualificationIssue)
              ? "Qual é o seu primeiro nome?" : qualificationContinuation(structured.text, qualificationIssue);
          }
          if (!websitePresentation && !leadQualification && !qualificationIssue && announcesQualificationClosing(structured.text, config.leadQualificationClosing || QUALIFICATION_CLOSING)) {
            if (attempt === 0) {
              this.logger.warn?.("ai_qualification_recheck", { empresaId: request.empresaId, conversationId: request.conversationId,
                correlationId: request.correlationId, code: "AI_QUALIFICATION_RECHECK", validationReason: "UNCONFIRMED_CLOSING" });
              ({ response, text } = await requestResponse(true));
              continue;
            }
            qualificationIssue = "UNCONFIRMED_CLOSING";
            structured.text = qualificationContinuation(structured.text, qualificationIssue);
          }
          if (qualificationIssue) {
            this.logger.warn?.("ai_qualification_deferred", { empresaId: request.empresaId, conversationId: request.conversationId,
              correlationId: request.correlationId, code: "AI_QUALIFICATION_DEFERRED", validationReason: qualificationIssue });
          }
          if (!leadQualification && !qualificationIssue && !structured.text.trim() && !catalogFormat) throw Object.assign(new Error("Resposta inválida."), { code: "AI_INVALID_LEAD_QUALIFICATION" });
          delete structured.leadQualification;
          parsedText = catalogFormat && !qualificationIssue ? JSON.stringify(structured) : structured.text.trim();
          if (websiteCatalog && salesMode && !leadQualification && !qualificationIssue) {
            try {
              validatedCatalogReply = parseCatalogSalesReply(parsedText, safeContext.catalog, { leadQualificationEnabled: qualifies, message: request.message });
            } catch (error) {
              if (error.code !== "AI_INVALID_CATALOG_SELECTION" || attempt > 0) throw error;
              this.logger.warn?.("ai_catalog_recheck", { empresaId: request.empresaId, conversationId: request.conversationId,
                correlationId: request.correlationId, code: "AI_CATALOG_RECHECK" });
              ({ response, text } = await requestResponse(true));
              continue;
            }
          }
          break;
        }
      }
      const baseReply = validatedCatalogReply || (!leadQualification && catalogFormat && !qualificationIssue ? salesMode ? parseCatalogSalesReply(parsedText, safeContext.catalog, { leadQualificationEnabled: qualifies, message: request.message })
        : parseCatalogSelection(parsedText, safeContext.catalog, { message: request.message }) : { text: parsedText });
      if (websiteCatalog) baseReply.text = baseReply.text.replace(/^Sim,\s+a Turim Autos trabalha com financiamento\b/iu, "Sim, nós trabalhamos com financiamento");
      // The validated card carries the collected data. Financing state must not
      // replace its summary or operational qualification with generic prose.
      const financingState = qualifies && financingVehicles.length && !baseReply.messages && !baseReply.websiteInteraction
        ? { websiteInteraction: { step: leadQualification ? "closed" : "finance_accepted", productIds: financingVehicles.map((item) => item.id) } } : {};
      const evaluationHandoff = leadQualification && mayQualifyTradeInEvaluation(evaluationState, true);
      const evaluationMetadata = evaluationState ? { tradeInEvaluation: evaluationHandoff ? { ...evaluationState, step: "completed" } : evaluationState } : {};
      if (baseReply.messages && evaluationState) Object.assign(baseReply.messages.at(-1), evaluationMetadata);
      const reply = leadQualification ? { text: evaluationHandoff
        ? evaluationClosing(evaluationAnswer, config.tradeInEvaluationClosing, leadQualification.name)
        : config.leadQualificationClosing || QUALIFICATION_CLOSING, leadQualification, ...financingState, ...evaluationMetadata }
        : nonLeadHandoff ? { text: config.nonLeadHandoffMessage, nonLeadHandoff } : { ...baseReply, ...financingState };
      if (!reply.messages && evaluationState) Object.assign(reply, evaluationMetadata);
      const usage = providerUsage;
      const cost = calculateCost(pricing, usage);
      const finalized = await this.ledger.finalize({
        reservationId: reservation.reservationId,
        empresaId: request.empresaId,
        conversationId: request.conversationId,
        messageId: request.messageId,
        correlationId: request.correlationId,
        provider: config.provider,
        model: config.model,
        keyType,
        ...usage,
        cost,
        pricingVersion: pricing.version,
        configVersion: config.version,
        success: true,
        occurredAt,
      });
      await this.#notifyAlert(config, request, finalized);
      this.logger.info?.("ai_request_completed", {
        empresaId: request.empresaId,
        conversationId: request.conversationId,
        correlationId: request.correlationId,
        openAiRequestId: response?._request_id || null,
        model: config.model,
        pricingVersion: pricing.version,
      });
      return Object.freeze({
        ...reply,
        source: "ai",
        reason: qualificationIssue ? "qualification_needs_information" : "completed",
        usage: Object.freeze({ ...usage, cost, pricingVersion: pricing.version }),
        quota: finalized.usage,
      });
    } catch (error) {
      const sanitized = sanitizeError(error);
      if (reservation?.allowed) {
        try {
          await this.ledger.finalize({
            reservationId: reservation.reservationId,
            empresaId: request.empresaId,
            conversationId: request.conversationId,
            messageId: request.messageId,
            correlationId: request.correlationId,
            provider: config.provider,
            model: config.model,
            keyType,
            inputTokens: providerUsage?.inputTokens || 0,
            outputTokens: providerUsage?.outputTokens || 0,
            cost: providerUsage && pricing ? calculateCost(pricing, providerUsage) : 0,
            pricingVersion: pricing?.version || "unknown",
            configVersion: config.version,
            success: false,
            errorCode: sanitized.code || "AI_REQUEST_FAILED",
            occurredAt,
          });
        } catch (ledgerError) {
          this.#logFailure(request, ledgerError, "AI_LEDGER_FINALIZE_FAILED");
        }
      }
      this.#logFailure(request, error, sanitized.code || "AI_REQUEST_FAILED");
      return fallback(config, sanitized.code === "AI_TIMEOUT" ? "timeout" : "provider_failure");
    }
  }

  async #notifyAlert(config, request, finalized) {
    if (!finalized?.alertTriggered || typeof this.alertSink?.notify !== "function") return;
    try {
      await this.alertSink.notify({
        eventCode: "ai_quota_threshold",
        severity: "warn",
        state: "triggered",
        empresaId: request.empresaId,
        period: finalized.usage.period,
        usage: finalized.usage,
        thresholdPercent: config.alertPercent,
        correlationId: request.correlationId,
      });
    } catch (error) {
      this.#logFailure(request, error, "AI_ALERT_FAILED");
    }
  }

  #logFailure(request, error, fallbackCode) {
    const sanitized = sanitizeError(error);
    this.logger.warn?.("ai_request_failed", {
      empresaId: request.empresaId,
      conversationId: request.conversationId,
      correlationId: request.correlationId,
      code: sanitized.code || fallbackCode,
      openAiRequestId: error?.requestID || error?._request_id || null,
    });
  }
}
