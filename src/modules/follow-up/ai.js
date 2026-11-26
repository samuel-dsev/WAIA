import { normalizeAiConfig } from '../ai/contracts.js';
import { normalizePricing, estimateTokens, calculateCost, calculateCacheAdjustedCost } from '../ai/pricing.js';
import { normalizeProviderUsage } from '../ai/usage.js';
import { isPromptInjectionAttempt } from '../ai/guardrails.js';
import { FOLLOW_UP_INSTRUCTIONS, draftFormat, parseDraft } from './policy.js';

export function followUpPrompt(input) {
  const transcript = input.messages.filter(m => !isPromptInjectionAttempt(m.corpo)).map(m => ({ role: m.direcao === 'entrada' ? 'user' : 'assistant',
    content: String(m.corpo || (m.tipo === 'imagem' ? '[imagem recebida]' : '[mensagem sem texto]')), followUp: Boolean(m.outbound_payload?.followUpActionId) }));
  const data = JSON.stringify({ attempt: input.slot + 1, messageCount: input.messageCount, summaryOnly: input.isClosure === true, company: input.company, transcript });
  if (data.length > 200_000) throw new Error('FOLLOW_UP_CONTEXT_LIMIT');
  return { store: false, instructions: FOLLOW_UP_INSTRUCTIONS, input: [{ role: 'user', content: data }], text: { format: draftFormat } };
}

// Same configured provider and quota ledger as normal attendance, separate prompt.
// This function never calls reply(), mutates the script, or qualifies a lead.
export async function draftLegacyFollowUp(service, input) {
  const config = normalizeAiConfig(await service.configResolver.getAiConfig({ empresaId: input.empresaId }), input.empresaId);
  if (!config.enabled) throw new Error('FOLLOW_UP_AI_DISABLED');
  const request = { ...followUpPrompt(input), model: config.model, max_output_tokens: config.maxOutputTokens };
  const pricing = normalizePricing(await service.pricingCatalog.get({ provider: config.provider, model: config.model }), config.model);
  const inputEstimate = estimateTokens(JSON.stringify(request));
  const reservation = await service.ledger.reserve({ empresaId: input.empresaId, occurredAt: new Date(), tokenLimit: config.monthlyTokenLimit,
    costLimit: config.monthlyCostLimit, alertPercent: config.alertPercent, estimatedTokens: inputEstimate + config.maxOutputTokens,
    estimatedCost: calculateCost(pricing, { inputTokens: inputEstimate, outputTokens: config.maxOutputTokens }) });
  if (!reservation?.allowed) throw new Error('FOLLOW_UP_AI_BUDGET');
  let usage = { inputTokens: 0, outputTokens: 0 }, success = false;
  try {
    const credentials = await service.secretResolver.resolve({ empresaId: input.empresaId, provider: config.provider, keyType: config.keyType, credentialId: config.credentialId });
    if (config.provider !== 'simulated' && !credentials?.apiKey) throw new Error('FOLLOW_UP_AI_CREDENTIAL');
    const client = await service.clientFactory.create({ empresaId: input.empresaId, provider: config.provider, apiKey: credentials?.apiKey || null });
    const response = await client.responses.create(request, { signal: AbortSignal.timeout(service.timeoutMs), maxRetries: 0 });
    usage = normalizeProviderUsage(response);
    if (response.status === 'incomplete') throw new Error('FOLLOW_UP_AI_INCOMPLETE');
    const draft = parseDraft(response.output_text, input.isClosure); success = true; return draft;
  } finally {
    await service.ledger.finalize({ empresaId: input.empresaId, reservationId: reservation.reservationId, conversationId: input.conversationId,
      messageId: input.messageId, correlationId: input.correlationId, provider: config.provider, model: config.model, keyType: config.keyType,
      ...usage, cost: calculateCost(pricing, usage), cacheAdjustedCost: calculateCacheAdjustedCost(pricing, usage),
      pricingVersion: pricing.version, configVersion: config.version, success,
      ...(success ? {} : { errorCode: 'FOLLOW_UP_DRAFT_FAILED' }), occurredAt: new Date() });
  }
}
