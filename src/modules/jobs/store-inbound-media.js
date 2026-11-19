/** Store each image in a coalesced turn before it can be acknowledged or attached.
 * The same provider/storage policy applies to a lone message and a whole burst. */
export async function storeInboundMedia({ empresaId, message, metaGateway, mediaStore, repository }) {
  if (!["image", "document"].includes(message.type) || !message.mediaId || message.mediaStorageKey) return message;
  if (typeof metaGateway?.downloadMedia !== "function" || typeof mediaStore?.put !== "function" || typeof repository.markMediaStored !== "function") {
    throw Object.assign(new Error("Armazenamento privado de mídia não configurado."), { code: "MEDIA_STORAGE_NOT_CONFIGURED", retryable: false });
  }
  const downloaded = await metaGateway.downloadMedia({ empresaId, numeroWhatsappId: message.numeroWhatsappId }, {
    mediaId: message.mediaId, ...(message.providerMedia ? { providerMedia: message.providerMedia } : {}),
    maxBytes: mediaStore.maxBytes, allowedMimeTypes: [...mediaStore.allowedMimeTypes],
  });
  const stored = await mediaStore.put({ empresaId, messageId: message.id, data: downloaded.data, mimeType: downloaded.mimeType });
  try { await repository.markMediaStored({ empresaId, messageId: message.id, mediaId: message.mediaId, stored }); }
  catch (error) { await mediaStore.delete({ empresaId, storageKey: stored.storageKey }).catch(() => {}); throw error; }
  return { ...message, mediaStorageKey: stored.storageKey, mediaMimeType: stored.mimeType, mediaSizeBytes: stored.sizeBytes, mediaSha256: stored.sha256 };
}
