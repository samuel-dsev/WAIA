export const WHATSAPP_LIST_MAX_ROWS = 10;
export const INTERACTIVE_PAGE_SIZE = 8;

const NAVIGATION_PATTERN = /^_waia_page:(menu|events|orders|appointment-services|appointment-slots):(\d+)$/u;

function positivePage(value) {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export function parsePageSelection(value) {
  const match = NAVIGATION_PATTERN.exec(String(value || "").trim().toLowerCase());
  if (!match) return null;
  return Object.freeze({ scope: match[1], page: positivePage(match[2]) });
}

export function paginateInteractiveOptions(items, {
  page = 1,
  scope,
  toButton = (item) => item,
} = {}) {
  if (!Array.isArray(items)) throw new TypeError("items deve ser um array.");
  if (!NAVIGATION_PATTERN.test(`_waia_page:${scope}:1`)) throw new TypeError("scope de paginação inválido.");
  const pageCount = items.length > WHATSAPP_LIST_MAX_ROWS
    ? Math.ceil(items.length / INTERACTIVE_PAGE_SIZE)
    : Math.max(1, Math.ceil(items.length / WHATSAPP_LIST_MAX_ROWS));
  const currentPage = Math.min(positivePage(page), pageCount);
  const pageSize = pageCount > 1 ? INTERACTIVE_PAGE_SIZE : WHATSAPP_LIST_MAX_ROWS;
  const visibleItems = items.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const buttons = visibleItems.map(toButton);
  if (currentPage > 1) {
    buttons.unshift({ id: `_waia_page:${scope}:${currentPage - 1}`, label: "Página anterior" });
  }
  if (currentPage < pageCount) {
    buttons.push({ id: `_waia_page:${scope}:${currentPage + 1}`, label: "Próxima página" });
  }
  if (buttons.length > WHATSAPP_LIST_MAX_ROWS) {
    throw new RangeError("A página interativa excedeu dez opções.");
  }
  return Object.freeze({
    items: Object.freeze(visibleItems),
    buttons: Object.freeze(buttons),
    page: currentPage,
    pageCount,
  });
}

export function withPageIndicator(text, { page, pageCount }) {
  const body = String(text || "").trim();
  return pageCount > 1 ? `${body}\n\nPágina ${page} de ${pageCount}.` : body;
}
