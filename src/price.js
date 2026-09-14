// A fare is only retained when the public checkout explicitly renders an EUR
// amount. Prices are stored as integer cents to avoid floating-point rounding.
export function ticketPriceFromText(text) {
  const compact = String(text ?? "").replace(/\s+/g, " ");
  const match = compact.match(/(?:€\s*([0-9]+(?:[.,][0-9]{1,2})?)|([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:€|EUR\b))/i);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return {};
  const value = Number(raw.replace(",", "."));
  if (!Number.isFinite(value) || value < 0) return {};
  return { ticketPriceCents: Math.round(value * 100), ticketCurrency: "EUR" };
}

export function ticketPriceFromRate(rate) {
  const value = rate?.price ?? rate?.amount ?? rate?.fare ?? rate?.total;
  if (typeof value === "string") return ticketPriceFromText(`${value} ${rate?.currency ?? "€"}`);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return {};
  // Checkout APIs normally send euros as decimals. Explicit cent fields avoid
  // the ambiguity, so only accept a numeric rate when its currency is EUR.
  const currency = String(rate?.currency ?? rate?.currencyCode ?? "EUR").toUpperCase();
  if (currency !== "EUR" && currency !== "€") return {};
  return { ticketPriceCents: Math.round(value * 100), ticketCurrency: "EUR" };
}
