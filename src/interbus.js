import { chromium } from "playwright";
import { crossesNight } from "./alsa.js";
import { ticketPriceFromText } from "./price.js";

const URL = "https://comprasweb.interbus.es/venta/";
const PAUSE_MS = 800;
const AUTOCOMPLETE_TIMEOUT_MS = 8_000;

const normalise = (value) => value.replace(/\s+/g, " ").trim();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const forInterbusAutocomplete = (value) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

async function selectAutocomplete(page, placeholder, value) {
  const input = page.locator(`input[placeholder="${placeholder}"]`).first();
  await input.waitFor({ state: "visible", timeout: AUTOCOMPLETE_TIMEOUT_MS });
  // El buscador de estaciones de Interbus indexa "Malaga" sin tilde, aunque
  // la interfaz muestre el nombre correcto. Normalizamos sólo la consulta.
  await input.fill(forInterbusAutocomplete(value));
  await wait(PAUSE_MS);
  // Interbus normaliza "Málaga" a "Malaga" en su autocompletado, así que no
  // filtramos por el texto tecleado (con acento) y tomamos la primera sugerencia visible.
  // No incluimos cualquier <li>: la cabecera contiene listas no relacionadas y
  // un clic ahí aparentaría éxito sin haber elegido ninguna estación.
  // La sugerencia anterior permanece en el DOM pero queda oculta al cambiar
  // de campo; elegimos expresamente la opción visible del desplegable actual.
  const options = page.locator('.Name:visible, [role="option"]:visible, .ng-option:visible');
  try {
    await options.first().waitFor({ state: "visible", timeout: AUTOCOMPLETE_TIMEOUT_MS });
  } catch {
    const pageText = normalise(await page.locator("body").innerText().catch(() => ""));
    throw new Error(`Interbus no devolvió sugerencias para ${placeholder} (${value}). ${pageText.slice(0, 500)}`);
  }
  // A broad city query can put nearby stops first (for example “Cruce
  // Sevilla”). Select the actual city/station rather than blindly choosing
  // the first autocomplete item.
  const desired = forInterbusAutocomplete(value).toLowerCase();
  let selected = options.first();
  for (let index = 0; index < await options.count(); index += 1) {
    const candidate = forInterbusAutocomplete(await options.nth(index).innerText()).toLowerCase();
    if (new RegExp(`^${desired.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|,|\\(|$)`).test(candidate)) {
      selected = options.nth(index);
      break;
    }
  }
  await selected.click({ noWaitAfter: true });
}

async function chooseDate(page, isoDate) {
  const candidates = page.locator('input[type="date"], input[placeholder="Ida"], input[placeholder*="fecha" i]');
  const count = await candidates.count();
  if (!count) throw new Error("No se encontró el control de fecha de Interbus");
  const input = candidates.first();
  const [year, month, day] = isoDate.split("-");
  await input.fill(`${day}/${month}/${year}`);
  await input.press("Enter");
}

function seatStateFromElement(element) {
  const className = (element.getAttribute("class") ?? "").toLowerCase();
  const aria = (element.getAttribute("aria-label") ?? "").toLowerCase();
  const text = (element.textContent ?? "").toLowerCase();
  const value = `${className} ${aria} ${text}`;
  if (/ocupad|reserved|unavailable|disabled|bloquead/.test(value)) return "occupied";
  if (/libre|available|seat|plaza/.test(value)) return "free";
  return null;
}

async function readSeatMap(page) {
  await page.getByText("Continuar", { exact: true }).click({ noWaitAfter: true });
  await page.waitForURL(/\/venta\/seats/, { timeout: 12_000 });
  // The checkout can legitimately have no layout at all: it still displays
  // “Seleccionar plaza” but exposes neither seat labels nor a total. Give the
  // client a brief render window, then preserve it as schedule-only instead
  // of reporting a collector error or deriving capacity from free seats.
  await wait(1_500);
  // Some regional Damas services deliberately use unnumbered seating. There
  // is no selectable layout in that case, so do not turn the advertised
  // aggregate into a fabricated seat-map count.
  const checkoutText = normalise(await page.locator("body").innerText());
  if (/asientos\s+sin\s+numerar/i.test(checkoutText)) return null;
  const seats = page.locator(".Seats .Seat");
  if (!await seats.count()) return null;
  const inventory = await seats.evaluateAll((nodes) => {
    let occupied = 0;
    let free = 0;
    for (const seat of nodes) {
      // Interbus aplica Disabled al label de una plaza no seleccionable.
      // La plaza que el portal preasigna temporalmente sigue siendo libre y
      // conserva un label activo, así que también cuenta como disponible.
      if (seat.querySelector("label.Disabled")) occupied += 1;
      else if (seat.querySelector("label")) free += 1;
    }
    return { occupied, free };
  });
  const totalSeats = inventory.occupied + inventory.free;
  if (!totalSeats) return null;
  return {
    totalSeats,
    freeSeats: inventory.free,
    occupiedSeats: inventory.occupied,
    evidence: `Interbus seat map: total=${totalSeats}; free=${inventory.free}; occupied=${inventory.occupied}`,
  };
}

async function readStops(page) {
  const text = await page.locator("body").innerText();
  const line = text.match(/(?:paradas?|itinerario)\s*:?\s*([\s\S]{0,1000})/i)?.[1] ?? "";
  return [...new Set(
    line.split(/\n|→|->|·/).map(normalise).filter((item) => item.length > 2 && item.length < 120),
  )].slice(0, 30);
}

async function searchRoute(page, { origin, destination, date }) {
  // Rebuild the result page before selecting each departure. Selecting a
  // departure replaces the timetable with the checkout/map, so retaining a
  // locator from the prior timetable would silently fail for a route with
  // more than one night service.
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 25_000 });
  await wait(1_500);
  await selectAutocomplete(page, "Origen", origin);
  await selectAutocomplete(page, "Destino", destination);
  await chooseDate(page, date);
  await page.getByRole("button", { name: /buscar/i }).dispatchEvent("click");
  await wait(4_000);
  return page.locator(".DepartureCard");
}

async function collectInterbusRoute(page, { origin, destination, date, operator = "Interbus" }) {
  const observations = [];
  try {
    // Sólo las tarjetas de salida. El selector anterior incluía contenedores,
    // calendario y resumen, y por eso acababa navegando sin fin.
    const departures = await searchRoute(page, { origin, destination, date });
    const count = await departures.count();
    if (!count) {
      observations.push({
        observedAt: new Date().toISOString(), operator, origin, destination,
        serviceDate: date, departureTime: null, status: "full_or_unavailable",
        evidence: "No se encontraron tarjetas de salida visibles", stops: [],
      });
      return observations;
    }
    const candidates = [];
    for (let index = 0; index < count; index += 1) {
      const departure = departures.nth(index);
      const departureText = normalise(await departure.innerText());
      const times = [...departureText.matchAll(/\b\d{1,2}:\d{2}\b/g)].map((match) => match[0]);
      const departureTime = times[0] ?? null;
      const arrivalTime = times[1] ?? null;
      if (!departureTime || !arrivalTime) continue;
      const isNightService = crossesNight(departureTime, arrivalTime);
      if (!isNightService) continue;
      candidates.push({ index, departureText, departureTime, arrivalTime, isNightService });
    }
    for (const candidate of candidates) {
      const { index, departureText, departureTime, arrivalTime, isNightService } = candidate;
      try {
        const available = departureText.match(/Asientos libres:\s*(\d+)/i);
        let seatMap = null;
        if (isNightService && available && Number(available[1]) > 0) {
          const currentDepartures = await searchRoute(page, { origin, destination, date });
          const selectedDeparture = currentDepartures.nth(index);
          await selectedDeparture.click();
          seatMap = await readSeatMap(page);
        }
        observations.push({
          observedAt: new Date().toISOString(), operator, origin, destination,
          serviceDate: date, departureTime,
          serviceId: `interbus-${forInterbusAutocomplete(origin).toLowerCase()}-${forInterbusAutocomplete(destination).toLowerCase()}-${departureTime}-${arrivalTime}`,
          isNightService, stops: [],
          ...ticketPriceFromText(departureText),
          ...(seatMap ?? { status: available && Number(available[1]) === 0 ? "full_or_unavailable" : "schedule_only", evidence: departureText }),
          status: seatMap ? "available" : available && Number(available[1]) === 0 ? "full_or_unavailable" : "schedule_only",
        });
      } catch (error) {
        observations.push({
          observedAt: new Date().toISOString(), operator, origin, destination,
          serviceDate: date, departureTime, status: "error", error: error.message, evidence: departureText, stops: [],
        });
      }
    }
  } catch (error) {
    // El error es una observación del estado del portal, no una indicación de
    // ocupación. Así se conserva el diagnóstico sin inventar un autobús lleno.
    observations.push({
      observedAt: new Date().toISOString(), operator, origin, destination,
      serviceDate: date, departureTime: null, status: "error", error: error.message, stops: [],
    });
  }
  return observations;
}

export async function collectInterbus({ routes, origin, destination, date, headed = false, trace = false }) {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ locale: "es-ES", timezoneId: "Europe/Madrid" });
  if (trace) await context.tracing.start({ screenshots: true, snapshots: true });
  const routeList = routes && routes.length > 0
    ? routes
    : [{ origin: origin ?? "Málaga", destination: destination ?? "Madrid" }];
  const allObservations = [];
  try {
    const page = await context.newPage();
    for (const route of routeList) {
      const items = await collectInterbusRoute(page, {
        ...route, date,
      });
      allObservations.push(...items);
    }
  } finally {
    if (trace) await context.tracing.stop({ path: "data/interbus-trace.zip" });
    await browser.close();
  }
  return allObservations;
}
