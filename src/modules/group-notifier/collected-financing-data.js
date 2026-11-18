const normalized = (value) => String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();

function collectionBodies(evidence, transcript) {
  const allowed = new Set(evidence.map((value) => String(value || "").trim())), answers = new Set();
  let collecting = false;
  for (const part of transcript) {
    if (part.role === "assistant") {
      const text = normalized(part.content);
      collecting = /\b(?:cpf|nascimento)\b/u.test(text) && /\b(?:informe|informar|envie|enviar|preciso|passe|qual|por favor)\b/u.test(text)
        && !/\b(?:nao|nunca) (?:informe|envie|enviar|informar)\b/u.test(text);
    } else if (collecting && part.role === "user") {
      const body = String(part.content || "").split("\n[Em resposta à mensagem:")[0].trim();
      if (allowed.has(body)) answers.add(body);
    }
  }
  return answers;
}

/** Copy only literal customer-supplied values. This is not document validation
 * or a reason to qualify: the existing consent/name/card gates still apply. */
export function preserveCollectedFinancingData(card, evidence = [], transcript = []) {
  const collected = collectionBodies(evidence, transcript);
  let cpf, birthDate, city;
  for (const value of evidence) {
    const body = String(value || "").trim(), text = normalized(body);
    if (/^(?:exemplo\s*:|por exemplo\b|como exemplo\b)/u.test(text)
      || /\bnao (?:e|eh|use|considere|utilize|quero (?:informar|enviar|usar))\b/u.test(text)) continue;
    const labeledCpf = body.match(/\bcpf\s*(?:(?:é|e|eh)\s*)?[:=-]?\s*(\d{3}[. ]?\d{3}[. ]?\d{3}[- ]?\d{2})(?!\d)/iu)?.[1];
    const formattedCpf = body.match(/(?<!\d)(\d{3}\.\d{3}\.\d{3}-\d{2})(?!\d)/u)?.[1];
    const standaloneCpf = collected.has(body) ? body.match(/^\s*(\d{11})(?:\s+\d{1,2}\/\d{1,2}\/\d{4})?\s*$/u)?.[1] : null;
    const suppliedCpf = labeledCpf || formattedCpf || standaloneCpf;
    if (suppliedCpf) cpf = suppliedCpf.replace(/\D/gu, "");
    const date = body.match(/(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/u);
    if (date && Number(date[1]) >= 1 && Number(date[1]) <= 31 && Number(date[2]) >= 1 && Number(date[2]) <= 12
      && (/\b(?:nascimento|nasci|nascido|nascida)\b/u.test(text) || collected.has(body)
        && /^(?:\d{3}[. ]?\d{3}[. ]?\d{3}[- ]?\d{2}\s+)?\d{1,2}\/\d{1,2}\/\d{4}$/u.test(body))) {
      birthDate = date[1].padStart(2, "0") + "/" + date[2].padStart(2, "0") + "/" + date[3];
    }
    const locality = body.match(/\b(?:moro em|resido em|sou de|minha cidade (?:é|e))\s+([\p{L}][\p{L} '-]{1,90}?)(?=\s+(?:e (?:tenho|quero|sou)|mas|com|para)\b|[,.;!?/\n]|$)/iu)?.[1]
      || (text.includes(normalized(card.name)) && /\b(?:sou|me chamo|meu nome)\b/u.test(text)
        ? body.match(/,\s*de\s+([\p{L}][\p{L} '-]{1,90}?)(?=\s+(?:e (?:tenho|quero|sou)|mas|com|para)\b|[,.;!?/\n]|$)/iu)?.[1] : null);
    if (locality && !/^(?:verdade|novo|fato|passagem|acordo|boa)$/u.test(normalized(locality))) city = locality.trim();
  }
  const summary = String(card.summary || ""), compactSummary = normalized(summary);
  const summaryCpfs = [...summary.matchAll(/(?<!\d)\d{3}[. ]?\d{3}[. ]?\d{3}[- ]?\d{2}(?!\d)/gu)].map((match) => match[0].replace(/\D/gu, ""));
  const lines = [];
  if (city && !compactSummary.includes(normalized(city))) lines.push("Cidade informada: " + city);
  if (cpf && !summaryCpfs.includes(cpf)) lines.push("CPF informado: " + cpf.slice(0, 3) + "." + cpf.slice(3, 6) + "." + cpf.slice(6, 9) + "-" + cpf.slice(9));
  if (birthDate && !summary.includes(birthDate)) lines.push("Data de nascimento informada: " + birthDate);
  return lines.length ? { ...card, summary: summary + "\nDados coletados:\n" + lines.join("\n") } : card;
}
