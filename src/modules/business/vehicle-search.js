const normalize = (value) => String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const words = (value) => normalize(value).split(" ").filter(Boolean);
const generic = new Set("carro carros veiculo veiculos modelo modelos opcoes opcao tem teria quero gostaria voces vcs algum alguma mais antigo antigos barata barato baratos barata novo novos usado usados ate mil reais ano anos com sem de da do e ou um uma para por flex turbo automatico manual".split(" "));

export const VEHICLE_SEARCH_INSTRUCTIONS = `BUSCA DIRECIONADA DO ESTOQUE:
- Para browse/more no estoque de veículos, filters.models contém os modelos pedidos (até 5, inclusive nomes ausentes do estoque), minYear/maxYear os anos solicitados e category/minPrice/maxPrice os demais critérios. Sem restrição, use [] e null. Modelos são alternativas entre si; ano, preço e categoria se aplicam a todos. Não troque um modelo ausente por um ID parecido. Polo Track não é Chevrolet Tracker.
- "Onix ou Etios 2017/2018" busca somente esses modelos nesses anos. "Busco Onix, Etios, Polo" preserva o orçamento ainda vigente. Uma mudança explícita de orçamento/modelo substitui a preferência anterior; não apague limites só porque não foram repetidos. Pedido geral explícito pode remover filtros anteriores. more mantém TODOS os filtros da consulta, inclusive modelos e anos.
- "Compass mais antigo", depois de Compass 2023 acima do orçamento, significa buscar Compass anterior a 2023: models=["Compass"], maxYear=2022. Use o ano numérico validado da ficha discutida; se não houver referência inequívoca, pergunte apenas o ano/faixa. Nunca envie contingência genérica para esse pedido compreensível.
- Responda PRIMEIRO se há correspondência ao pedido. Não liste o estoque inteiro antes da resposta e não afrouxe filtros para preencher a lista. Em browse, o sistema apresenta no máximo 3 correspondências. Se não houver, use none/details e explique a ausência de correspondência no estoque atual; pode sugerir até 3 alternativas pertinentes, identificadas por IDs atuais e com suas diferenças de ano/preço explícitas. Não apresente uma alternativa como correspondência exata nem repita fichas já vistas por uma dúvida pontual.`;

export function vehicleSearchFilters(value) {
  if (!Array.isArray(value.models) || value.models.length > 5 || value.models.some((model) => typeof model !== "string"
    || !normalize(model) || model.length > 100 || /[\u0000-\u001f]/u.test(model))
    || [value.minYear, value.maxYear].some((year) => year !== null && (!Number.isInteger(year) || year < 1886 || year > 2200))
    || value.minYear !== null && value.maxYear !== null && value.minYear > value.maxYear) throw new TypeError("Busca de veículos inválida.");
  return { models: [...new Set(value.models.map((model) => model.trim()))], minYear: value.minYear, maxYear: value.maxYear };
}

export function matchesVehicleSearch(item, query) {
  const tokens = words(item.model || item.name), title = words(item.name);
  return (!query.models?.length || query.models.some((model) => words(model).every((word) => tokens.includes(word) || title.includes(word))))
    && (query.minYear == null || Number.isInteger(item.year) && item.year >= query.minYear)
    && (query.maxYear == null || Number.isInteger(item.year) && item.year <= query.maxYear);
}

/** A broad browse must not silently discard a named model or explicit year.
 * This only detects missing constraints; the model still interprets the query. */
export function omittedVehicleSearch(catalog, message, query) {
  const text = words(message), meaningful = text.filter((word) => word.length >= 3 && !generic.has(word) && !/^\d+$/u.test(word));
  const named = catalog.items.some((item) => words(item.name).some((word) => meaningful.includes(word)));
  const searching = /\b(?:tem|teria|busco|procuro|quero|antigo|antigos|barato|baratos|opcoes|modelos)\b/u.test(normalize(message));
  const focusId = catalog.quotedProductId || (catalog.interaction?.productIds?.length === 1 ? catalog.interaction.productIds[0] : null);
  const reference = catalog.items.find((item) => item.id === focusId);
  const older = /\bmais antig[oa]s?\b/u.test(normalize(message));
  const requestedWord = /^(?:(?:vcs|voces|voce) )?(?:tem|teria|busco|procuro) (?:(?:algum|alguma|um|uma) )?(\p{L}+)/u.exec(normalize(message))?.[1];
  const specificUnknown = requestedWord && !generic.has(requestedWord)
    && !["algo", "estoque", "catalogo", "hatch", "sedan", "suv", "picape", "opcao"].includes(requestedWord);
  return named && !query.models?.length && (searching || text.length <= 6)
    || specificUnknown && !query.models?.length && query.category == null
    || older && (query.maxYear == null || Number.isInteger(reference?.year) && query.maxYear >= reference.year)
    || /\b(?:19|20)\d{2}\b/u.test(normalize(message)) && query.minYear == null && query.maxYear == null;
}

export function clearVehicleSearch(catalog, message) {
  return /\b(?:tem|teria|busco|procuro|mais antig[oa]s?|mais barat[oa]s?)\b/u.test(normalize(message))
    && omittedVehicleSearch(catalog, message, {});
}

export function inheritVehicleBudget(query, previous, message) {
  if (!query.models?.length || !previous || query.minPrice !== null || query.maxPrice !== null
    || /\b(?:sem limite|qualquer (?:preco|valor)|acima do (?:orcamento|limite)|nao importa o (?:preco|valor))\b/u.test(normalize(message))) return query;
  return { ...query, minPrice: query.minPrice ?? previous.minPrice, maxPrice: query.maxPrice ?? previous.maxPrice };
}
