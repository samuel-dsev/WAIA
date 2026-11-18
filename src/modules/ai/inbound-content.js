export function inboundMessageContent(part) {
  if (part.type !== "image") return part.text || part.body || "";
  const caption = part.text ?? part.body ?? "";
  const stored = part.mediaStored === true || Boolean(part.mediaStorageKey);
  return "[Imagem recebida do cliente; " + (stored ? "arquivo armazenado" : "armazenamento ainda não confirmado")
    + "; sem análise visual.]" + (caption.trim() ? "\nLegenda escrita pelo cliente: " + caption : "");
}
