export function createFollowUpHandler({ repository, aiService, metaGateway }) {
  return async function processFollowUp(reference, record, execution = {}) {
    const actionId = record?.payload?.actionId;
    if (typeof actionId !== 'string') return { skipped: true };
    const snapshot = await repository.snapshot(reference.empresaId, actionId);
    if (snapshot.deferUntil) return { deferUntil: snapshot.deferUntil };
    if (!snapshot.row) return { skipped: true, reconciliationRequired: snapshot.uncertain === true };
    const { row, conversation, config, lastInbound } = snapshot;
    const context = { empresaId: reference.empresaId, numeroWhatsappId: conversation.numero_whatsapp_id };
    let template = null;
    if (!row.is_closure && (!snapshot.inWindow || row.state === 'prepared') && snapshot.templateDescriptor && typeof metaGateway.readFollowUpTemplate === 'function') {
      template = await metaGateway.readFollowUpTemplate(context, snapshot.templateDescriptor);
    }
    // Service-window failures are visible, without paying for an unusable draft.
    if (!row.is_closure && !snapshot.inWindow && !template) {
      await repository.prepare(reference.empresaId, actionId, snapshot, { text: '', summary: '' });
      return { skipped: true, reason: 'approved_template_required' };
    }
    if (row.state === 'pending') {
      const draft = row.is_closure && snapshot.inbound.length < 2 ? { text: '', summary: '' } : await aiService.draftFollowUp({
        empresaId: reference.empresaId, conversationId: conversation.id, numeroWhatsappId: conversation.numero_whatsapp_id,
        messageId: lastInbound.id, message: lastInbound.corpo, actionId, correlationId: reference.correlationId,
        slot: row.slot, isClosure: row.is_closure, messageCount: row.periods_hours?.length, messages: snapshot.messages, company: config.compiled.configuration.identity.name,
      }).catch(() => { throw Object.assign(new Error('Não foi possível preparar o follow-up.'), { code: 'FOLLOW_UP_DRAFT_FAILED', retryable: true }); });
      const prepared = await repository.prepare(reference.empresaId, actionId, snapshot, draft, !snapshot.inWindow ? template : null);
      if (prepared.deferUntil) return { deferUntil: prepared.deferUntil };
      if (!prepared.prepared) return { completed: Boolean(prepared.completed), skipped: !prepared.completed };
    }
    if (execution.canContinue && !execution.canContinue()) return { deferUntil: new Date(Date.now() + 30_000).toISOString() };
    if (template) template = await metaGateway.readFollowUpTemplate(context, snapshot.templateDescriptor);
    const claimed = await repository.claim(reference.empresaId, actionId, template);
    if (!claimed.allowed) return { skipped: true, reconciliationRequired: claimed.uncertain === true };
    let externalId = null;
    try {
      const result = claimed.template ? await metaGateway.sendFollowUpTemplate(context, { to: claimed.phone, template: claimed.template, text: claimed.parameter })
        : await metaGateway.sendReply(context, { to: claimed.phone, text: claimed.text });
      externalId = result?.messages?.[0]?.id || null;
    } catch { /* Once started, an ambiguous external outcome is never retried. */ }
    await repository.finish(reference.empresaId, actionId, claimed.messageId, externalId);
    return { replied: Boolean(externalId), reconciliationRequired: !externalId };
  };
}
