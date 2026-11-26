export function formatAiCost(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 8,
  }).format(Number(value));
}
