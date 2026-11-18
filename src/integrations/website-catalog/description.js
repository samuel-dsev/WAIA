const normalize = (value) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim();
const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", bull: "•" };

function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (original, entity) => {
    if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? original;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}

const footer = (text) => /^(?:entre em contato|fale conosco|contato|localizacao|endereco|whatsapp|telefone|avenida|av|rua|rodovia|alameda|venha (?:conhecer|nos visitar)|turim autos seu proximo)\b/u.test(normalize(text))
  || /^gostou\b.*\b(?:whatsapp|direct|chama)\b/u.test(normalize(text));
const equipment = (text) => /^(?:principais|equipamentos|opcionais|diferenciais|destaques|caracteristicas|observacoes|valor|preco)\b/u.test(normalize(text))
  || /^(?:[-•🔹✅👉✔]|💰)/u.test(text.trim());
const titleText = (text) => text.replace(/\*/gu, "").trim();

/** Render only the advert's description as WhatsApp text. No HTML is executed,
 * and the commercial contact/address footer is not part of vehicle details. */
export function websiteVehicleDescription(html, name) {
  const text = decodeEntities(String(html || "")
    .replace(/<!--[\s\S]*?-->|<(script|style|iframe|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "")
    .replace(/<br\b[^>]*>/giu, "\n")
    .replace(/<li\b[^>]*>/giu, "\n- ").replace(/<\/li\s*>/giu, "\n")
    .replace(/<\/?(?:ul|ol)\b[^>]*>/giu, "\n\n")
    .replace(/<\/(?:p|div|pre|h[1-6])\s*>/giu, "\n\n")
    .replace(/<\/?(?:strong|b)\b[^>]*>/giu, "*")
    .replace(/<[^>]*>/gu, ""))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\r/gu, "").replace(/[ \t]+/gu, " ").replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n").trim();
  const lines = text.split("\n");
  const footerIndex = lines.findIndex(footer);
  const blocks = (footerIndex < 0 ? text : lines.slice(0, footerIndex).join("\n"))
    .replace(/(^- [^\n]+)\n\n(?=- )/gmu, "$1\n").trim().split(/\n\s*\n/u).filter(Boolean);
  // Some older adverts start with the dealer name and then only a checklist.
  // A missing introductory paragraph must not be fabricated from that checklist.
  if (normalize(blocks[0] || "") === "turim autos") blocks.shift();
  const hasTitle = Boolean(blocks[0] && !equipment(blocks[0]) && [...blocks[0]].length <= 220);
  const title = hasTitle ? blocks.shift() : `🚗 *${name}*`;
  const styledTitle = title.includes("*") ? title : title.replace(/^(\p{Extended_Pictographic}\uFE0F?\s*)?(.+)$/u,
    (_, emoji = "", body) => `${emoji}*${titleText(body)}*`);
  const firstParagraph = blocks[0] && !equipment(blocks[0]) && !footer(blocks[0]) ? blocks.shift() : "";
  const introduction = [styledTitle, firstParagraph].filter(Boolean).join("\n\n");
  const details = blocks.join("\n\n");
  return { description: [introduction, details].filter(Boolean).join("\n\n"), introduction, details };
}
