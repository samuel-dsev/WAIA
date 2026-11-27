import { isPromptInjectionAttempt } from "./guardrails.js";
import { inboundMessageContent } from "./inbound-content.js";

/** Read every retained page. Gallery parts and unsent checkpoints must never
 * displace the beginning of the conversation or masquerade as delivered replies. */
export async function loadConversationContext(service, request, now, { includeIncomingImages = false, includeIncomingAudio = false } = {}) {
  const history = [];
  let beforeSequence;
  for (;;) {
    const page = await service.getHistory({ empresaId: request.empresaId, conversationId: request.conversationId,
      limit: 100, ...(beforeSequence ? { beforeSequence } : {}) });
    history.unshift(...page);
    const first = page[0]?.sequence;
    if (page.length < 100 || !Number.isSafeInteger(first) || first < 1 || beforeSequence && first >= beforeSequence) break;
    beforeSequence = first;
  }
  const ids = new Set(request.turnMessages?.map((part) => part.id) || [request.messageId]);
  const anchor = history.find((item) => item.id === request.messageId)?.sequence;
  const retained = history.filter((item) => !item.redactedAt && (!item.expiresAt || new Date(item.expiresAt) > now)
    && (!anchor || !item.sequence || item.sequence <= anchor))
    .map(item => includeIncomingAudio && item.direction === 'inbound' && item.type === 'audio' && item.audioTranscriptionStatus === 'completed'
      ? { ...item, body: item.audioTranscription } : item);
  const byExternalId = new Map(retained.filter((item) => item.externalMessageId)
    .filter(item => item.type !== 'audio' || includeIncomingAudio && item.audioTranscriptionStatus === 'completed' && !isPromptInjectionAttempt(item.body))
    .map((item) => [item.externalMessageId, item]));
  const input = retained.filter((item) => !ids.has(item.id))
    .filter((item) => (["text", "image", "interactive"].includes(item.type) || includeIncomingImages && item.direction === "inbound" && item.type === "video" || includeIncomingAudio && item.type === "audio" && item.audioTranscriptionStatus === "completed") && (typeof item.body === "string" && item.body.trim()
      || includeIncomingImages && item.direction === "inbound" && item.type === "video"
      || includeIncomingImages && item.direction === "inbound" && item.type === "image" && (item.mediaExternalId || item.mediaStorageKey)))
    .filter((item) => item.type !== "image" || item.direction === "outbound" || includeIncomingImages)
    .filter((item) => item.direction === "inbound" || item.direction === "outbound"
      && (!item.status || ["sent", "delivered", "read"].includes(item.status)))
    .filter((item) => item.direction !== "inbound" || !isPromptInjectionAttempt(item.body))
    .map((item) => ["image", "video"].includes(item.type) && item.direction === "inbound" ? { ...item, body: inboundMessageContent(item) } : item)
    .map((item) => {
      const quoted = byExternalId.get(item.replyToExternalMessageId);
      return { role: item.direction === "inbound" ? "user" : "assistant",
        content: quoted?.body ? `${item.body}\n[Em resposta à mensagem: ${quoted.body}]` : item.body };
    });
  // Resolve quotations in the current burst as well as the earlier transcript.
  const current = (request.turnMessages || [{ id: request.messageId, text: request.message }]).map((part) => ({ ...part, text: inboundMessageContent(part) }));
  const incomingImages = retained.filter((item) => item.direction === "inbound" && item.type === "image");
  const currentImages = (request.turnMessages || []).filter((part) => part.type === "image" && !retained.some((item) => item.id === part.id));
  return { input, receivedPhotos: incomingImages.length + currentImages.length,
    storedPhotos: incomingImages.filter((item) => item.mediaStorageKey).length + currentImages.filter((part) => part.mediaStored === true).length,
    evidence: retained.filter((item) => item.direction === "inbound" && (item.type === "text" || includeIncomingImages && item.type === "image"
      || includeIncomingAudio && item.type === "audio" && item.audioTranscriptionStatus === "completed")
    && typeof item.body === "string" && !isPromptInjectionAttempt(item.body)).map((item) => item.body), current: current.map((part) => {
    const record = retained.find((item) => item.id === part.id);
    const quoted = byExternalId.get(record?.replyToExternalMessageId);
    return { role: "user", content: quoted?.body ? `${part.text}\n[Em resposta à mensagem: ${quoted.body}]` : part.text };
  }) };
}
