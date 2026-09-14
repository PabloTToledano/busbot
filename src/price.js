// A fare is only retained when the public checkout explicitly renders an EUR
// amount. Prices are stored as integer cents to avoid floating-point rounding.
export function ticketPriceFromText(text) {
  const compact = String(text ?? "").replace(/\s+/g, " ");
  const amounts = [...compact.matchAll(/(?:€\s*([0-9]+(?:[.,][0-9]{1,2})?)|([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:€|EUR\b))/gi)]
    .map((match) => Number((match[1] ?? match[2]).replace(",", ".")))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (!amounts.length) return {};
  // ALSA renders a crossed-out/list fare followed by its selectable fare.
  return { ticketPriceCents: Math.round(Math.min(...amounts) * 100), ticketCurrency: "EUR" };
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
