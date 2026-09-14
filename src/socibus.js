import { chromium } from "playwright";
import { crossesNight } from "./alsa.js";
import { ticketPriceFromText } from "./price.js";

const URL = "https://compra.socibus.es/online/search";
const PAUSE_MS = 700;
const AUTOCOMPLETE_TIMEOUT_MS = 8_000;

const normalise = (value) => value.replace(/\s+/g, " ").trim();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slug = (value) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const stationQuery = (value) => {
  if (value.toLowerCase() === "aeropuerto de madrid") return "Madrid Aeropuerto";
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
};

async function selectStation(page, id, value) {
  const input = page.locator(`input#${id}`);
  // The legacy jquery autocomplete filters on an unaccented station index.
  await input.fill(stationQuery(value));
  await wait(PAUSE_MS);
  // jquery-ui renders the results outside the input container. Restrict this
  // to visible choices: old result lists remain in the DOM after a change.
  const option = page.locator("ul.ui-autocomplete:visible li:visible, .ui-menu-item:visible").first();
  try {
    await option.waitFor({ state: "visible", timeout: AUTOCOMPLETE_TIMEOUT_MS });
  } catch {
    throw new Error(`Socibus no ofrece la estación ${value} desde la selección actual.`);
  }
  await option.click();
}

async function setDate(page, isoDate) {
  const [year, month, day] = isoDate.split("-");
  const input = page.locator("#departureDate");
  await input.fill(`${day}/${month}/${year}`);
  await input.press("Tab");
}

async function readSeatMap(page) {
  await page.getByRole("button", { name: "Continuar", exact: true }).click({ noWaitAfter: true });
  await page.getByRole("button", { name: "Seleccionar plaza", exact: true }).waitFor({ state: "visible", timeout: 12_000 });
  // This only expands the inventory; a seat is temporarily preselected by the
  // site, but no purchase or payment step is reached.
  await page.getByRole("button", { name: "Seleccionar plaza", exact: true }).click({ noWaitAfter: true });
  const seats = page.locator(".Seats .Seat");
  await seats.first().waitFor({ state: "attached", timeout: 8_000 });
  const inventory = await seats.evaluateAll((nodes) => {
    let occupied = 0;
    let free = 0;
    for (const seat of nodes) {
      // Socibus makes non-selectable places explicit with label.Disabled.
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
    evidence: `Socibus seat map: total=${totalSeats}; free=${inventory.free}; occupied=${inventory.occupied}`,
  };
}

async function searchSocibusRoute(page, { origin, destination, date }) {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 25_000 });
  await selectStation(page, "origin", origin);
  await selectStation(page, "destination", destination);
  await setDate(page, date);
  await page.getByRole("button", { name: "Buscar", exact: true }).click({ noWaitAfter: true });
  const cards = page.locator(".DepartureCard");
  await cards.first().waitFor({ state: "visible", timeout: 15_000 });
  return cards;
}

async function collectSocibusRoute(page, { origin, destination, date, operator }) {
  const observations = [];
  try {
    const cards = await searchSocibusRoute(page, { origin, destination, date });
    const count = await cards.count();
    const candidates = [];
    for (let index = 0; index < count; index += 1) {
      const card = cards.nth(index);
      const text = normalise(await card.innerText());
      const times = [...text.matchAll(/\b\d{1,2}:\d{2}\b/g)].map((match) => match[0]);
      const departureTime = times[0] ?? null;
      const arrivalTime = times[1] ?? null;
      if (!departureTime || !arrivalTime) continue;
      const freeFromSchedule = Number(text.match(/Asientos libres:\s*(\d+)/i)?.[1]);
      const isNightService = crossesNight(departureTime, arrivalTime);
      if (!isNightService) continue;
      const serviceId = `${slug(operator)}-${slug(origin)}-${slug(destination)}-${departureTime}-${arrivalTime}`;
      candidates.push({ index, text, departureTime, arrivalTime, freeFromSchedule, isNightService, serviceId });
    }
    for (const candidate of candidates) {
      const { index, text, departureTime, freeFromSchedule, isNightService, serviceId } = candidate;
      try {
        let seatMap = null;
        if (isNightService && Number.isFinite(freeFromSchedule) && freeFromSchedule > 0) {
          // The fare button chooses precisely this card; clicking the card
          // itself can also toggle a prior choice, so use its own button.
          const currentCards = await searchSocibusRoute(page, { origin, destination, date });
          await currentCards.nth(index).getByRole("button").first().click({ noWaitAfter: true });
          seatMap = await readSeatMap(page);
        }
        observations.push({
          observedAt: new Date().toISOString(), operator, origin, destination,
          serviceDate: date, departureTime, serviceId, isNightService, stops: [],
          ...ticketPriceFromText(text),
          ...(seatMap ?? { status: freeFromSchedule === 0 ? "full_or_unavailable" : "schedule_only", evidence: text }),
          status: seatMap ? "available" : freeFromSchedule === 0 ? "full_or_unavailable" : "schedule_only",
        });
      } catch (error) {
        observations.push({ observedAt: new Date().toISOString(), operator, origin, destination, serviceDate: date, departureTime, serviceId, isNightService, status: "error", error: error.message, evidence: text, stops: [] });
      }
    }
  } catch (error) {
    const unavailable = error.message.startsWith("Socibus no ofrece la estación");
    observations.push({
      observedAt: new Date().toISOString(), operator, origin, destination, serviceDate: date, departureTime: null,
      status: unavailable ? "schedule_only" : "error",
      ...(unavailable ? { evidence: error.message } : { error: error.message }),
      stops: [],
    });
  }
  return observations;
}

export async function collectSocibus({ routes, origin, destination, date, operator = "Socibus", headed = false, trace = false }) {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ locale: "es-ES", timezoneId: "Europe/Madrid" });
  if (trace) await context.tracing.start({ screenshots: true, snapshots: true });
  const routeList = routes?.length ? routes : [{ origin: origin ?? "Sevilla", destination: destination ?? "Madrid" }];
  const observations = [];
  try {
    const page = await context.newPage();
    for (const route of routeList) observations.push(...await collectSocibusRoute(page, { ...route, date, operator }));
  } finally {
    if (trace) await context.tracing.stop({ path: "data/socibus-trace.zip" });
    await browser.close();
  }
  return observations;
}
