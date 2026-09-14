import { chromium } from "playwright";
import { crossesNight } from "./alsa.js";

const BAM_PORTAL = "https://www.movelia.es/es/app#/area-agencias/home?portal=17114195";
const BAM_CITIES = {
  "madrid-almeria": { origin: "18", destination: "164839", originStop: "MADRID ESTACION SUR", destinationStop: "ALMERÍA ESTACIÓN DE AUTOBUSES" },
};
const MOVENTIS_DESTINATIONS = {
  "barcelona-cadaques": { id: "436", name: "CADAQUÉS, ESTACIÓ" },
  "barcelona-lloret-de-mar": { id: "249", name: "LLORET DE MAR, ESTACIÓ" },
  "barcelona-tossa-de-mar": { id: "425", name: "TOSSA DE MAR" },
  "barcelona-palamos": { id: "666", name: "PALAMÓS, ESTACIÓ" },
};
const MOVENTIS_ORIGIN = { id: "432", name: "BARCELONA, ESTACIÓ DEL NORD" };
const normalise = (value) => value.replace(/\s+/g, " ").trim();
const routeUrl = (slug) => `https://www.movelia.es/es/rutas/autobuses/${slug}`;

function timesFrom(text) { return [...new Set([...text.matchAll(/\b([01]?\d|2[0-3]):[0-5]\d(?:h)?\b/g)].map((m) => m[0].replace(/h$/, "")))]; }
function durationMinutes(text) { const match = text.match(/Tiempo\s*:?\s*(\d+)\s*h(?:\s*y\s*(\d+)\s*min)?/i); return match ? Number(match[1]) * 60 + Number(match[2] ?? 0) : null; }
function arrivalFor(departure, duration) { if (duration == null) return null; const [h, m] = departure.split(":").map(Number); const total = h * 60 + m + duration; return `${String(Math.floor((total % 1440) / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; }
function moveliaDate(date) { const [year, month, day] = date.split("-"); return `${day}/${month}/${year}`; }

async function api(page, endpoint, body) {
  return page.evaluate(async ({ endpoint, body }) => {
    const response = await fetch(`https://api.movelia.es/api_iu${endpoint}`, { method: "POST", headers: { Authorization: `Bearer ${sessionStorage.getItem("token")}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  }, { endpoint, body });
}

async function apiGet(page, endpoint) {
  return page.evaluate(async ({ endpoint }) => {
    const response = await fetch(`https://api.movelia.es/api_iu${endpoint}`, { headers: { Authorization: `Bearer ${sessionStorage.getItem("token")}` } });
    const text = await response.text();
    if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  }, { endpoint });
}

function mapInventory(segment, advertisedFree) {
  const seats = segment?.seats;
  const diagram = seats?.seatsDiagram;
  if (!Array.isArray(diagram) || seats?.freeChoice !== "1") return null;
  // Number 00 represents a drawing/aisle element, not a physical seat. `_` is
  // available in Movelia's diagram; the one preselected passenger seat is also free.
  const physical = diagram.filter((seat) => seat.seatNumber && seat.seatNumber !== "00");
  const selected = new Set(String(seats.selectedDrawingSeats ?? "").split("~").filter(Boolean).map((id) => id.slice(1)));
  const free = physical.filter((seat) => seat.state === "_" || selected.has(String(seat.id).slice(1))).length;
  const expected = Number(advertisedFree);
  if (!physical.length || !Number.isInteger(expected) || free !== expected) return null;
  return { totalSeats: physical.length, freeSeats: free, occupiedSeats: physical.length - free };
}

async function collectBusbamRoute(page, route, date, limit) {
  const city = BAM_CITIES[route.slug];
  if (!city) return [{ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: null, status: "schedule_only", evidence: "No hay configuración de estaciones verificadas para la pasarela oficial BAM.", stops: [] }];
  const schedules = await api(page, "/v1/SchedulesFromText", { origin: city.origin, originNodo: "", destination: city.destination, destinationNodo: "", departureDate: moveliaDate(date), returnDate: "", routeID: "", isOpen: 0, busplusCardNumber: "", busplusDocumentIdentifier: "", promotionalCode: "", clientIP: "", changeTicketData: "", chosenPassengers: [{ order: 1, type: 1, age: 0, pmr: 0 }] });
  const sessionId = schedules?.schedules?.sessionId;
  const combinations = schedules?.schedules?.responseData?.travel?.outbound?.section?.flatMap((section) => section.combination ?? []) ?? [];
  const candidates = combinations.filter((trip) => trip.companyId === "341" && trip.originName === city.originStop && trip.destinationName === city.destinationStop && crossesNight(trip.departureTime, trip.arrivalTime)).slice(0, limit);
  if (!candidates.length) return [{ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: null, status: "schedule_only", evidence: "La pasarela BAM no devolvió expediciones nocturnas directas para la ruta.", stops: [] }];
  const rows = [];
  for (const trip of candidates) {
    const serviceId = `busbam-${date}-${trip.combinationId ?? `${trip.departureTime}-${trip.arrivalTime}`}`;
    try {
      const rateCode = trip.rates?.rate?.[0]?.rateCode;
      if (!sessionId || !rateCode) throw new Error("La expedición no incluye sesión o tarifa para abrir el mapa de plazas.");
      const booking = await api(page, "/v1/MultiBusBooking", { combinations: [{ sessionId, combinationId: trip.combinationId, rateCode, rateCode2: "", combinationReference: "" }], voucherNumber: "", voucherFamilyDiscountType: 0, voucherFamilyDiscountNumber: "" });
      const segment = booking?.busBooking?.responseData?.travel?.outbound?.section?.[0]?.segment?.[0];
      const inventory = mapInventory(segment, trip.freeSeats);
      if (!inventory) throw new Error("El mapa de plazas no reconcilia con las plazas libres anunciadas por BAM.");
      rows.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: trip.departureTime, arrivalTime: trip.arrivalTime, serviceId, isNightService: true, status: "available", ...inventory, evidence: `Mapa oficial BAM: ${segment.seats.seatsDiagram.length} elementos, ${inventory.totalSeats} plazas físicas; disponibilidad reconciliada con ${trip.freeSeats} plazas libres.`, stops: [trip.originName, trip.destinationName] });
    } catch (error) {
      const full = /ya no hay plazas libres|no hay plazas disponibles/i.test(error.message);
      rows.push({
        observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination,
        serviceDate: date, departureTime: trip.departureTime, arrivalTime: trip.arrivalTime, serviceId, isNightService: true,
        status: full ? "full_or_unavailable" : "error",
        ...(full ? { evidence: `BAM checkout: ${error.message}` } : { error: error.message }),
        stops: [trip.originName, trip.destinationName],
      });
    }
  }
  return rows;
}

async function collectEditorialRoute(page, route, date, limit) {
  await page.goto(routeUrl(route.slug), { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2_000);
  const evidence = normalise((await page.locator("body").allInnerTexts()).join(" ").slice(0, 8_000));
  const duration = durationMinutes(evidence);
  const times = timesFrom(evidence).slice(0, limit);
  if (!times.length) return [{ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: null, status: "schedule_only", evidence, stops: [] }];
  return times.map((departureTime) => { const arrivalTime = arrivalFor(departureTime, duration); return { observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime, status: "schedule_only", isNightService: arrivalTime ? crossesNight(departureTime, arrivalTime) : false, evidence, stops: [] }; });
}

const comparable = (value) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();

async function findMoveliaCity(page, city) {
  const result = await apiGet(page, `/v1/GetCitiesAndSubCities?city=${encodeURIComponent(city)}&language=ES`);
  const target = comparable(city);
  const stops = result?.stops ?? [];
  return stops.find((stop) => comparable(stop.name) === target)
    ?? stops.find((stop) => comparable(stop.name).startsWith(`${target} (`))
    ?? stops.find((stop) => comparable(stop.name).includes(target))
    ?? null;
}

async function collectGenericMoveliaRoute(page, route, date, limit) {
  await page.goto("https://www.movelia.es/es/app", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => Boolean(sessionStorage.getItem("token")), null, { timeout: 30_000 });
  const [origin, destination] = await Promise.all([findMoveliaCity(page, route.origin), findMoveliaCity(page, route.destination)]);
  if (!origin || !destination) throw new Error("Movelia no devolvió una estación válida para la ruta.");
  const schedules = await api(page, "/v1/SchedulesFromText", {
    origin: origin.param, originNodo: "", destination: destination.param, destinationNodo: "", departureDate: moveliaDate(date), returnDate: "", routeID: "", isOpen: 0,
    busplusCardNumber: "", busplusDocumentIdentifier: "", promotionalCode: "", clientIP: "", changeTicketData: "", chosenPassengers: [{ order: 1, type: 1, age: 0, pmr: 0 }],
  });
  const trips = schedules?.schedules?.responseData?.travel?.outbound?.section?.flatMap((section) => section.combination ?? []) ?? [];
  // The aggregator also returns rail and air results.  Only direct bus/coach
  // expeditions belong in this collector and can have a coach seat map.
  const nightTrips = trips.filter((trip) => trip.busOrBoat === "1" && trip.direct === "1" && crossesNight(trip.departureTime, trip.arrivalTime)).slice(0, limit);
  if (!nightTrips.length) return [{ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: null, status: "schedule_only", evidence: "El checkout oficial de Movelia no devolvió autocares directos nocturnos para la ruta.", stops: [] }];

  const rows = [];
  for (const trip of nightTrips) {
    const serviceId = `movelia-${trip.companyId}-${trip.origin}-${trip.destination}-${date}-${trip.departureTime}-${trip.arrivalTime}`;
    try {
      const rateCode = trip.rates?.rate?.[0]?.rateCode;
      if (!rateCode) throw new Error("La expedición no incluye tarifa para abrir el mapa.");
      const booking = await api(page, "/v1/MultiBusBooking", { combinations: [{ sessionId: schedules.schedules.sessionId, combinationId: trip.combinationId, rateCode, rateCode2: "", combinationReference: "" }], voucherNumber: "", voucherFamilyDiscountType: 0, voucherFamilyDiscountNumber: "" });
      const segments = booking?.busBooking?.responseData?.travel?.outbound?.section?.[0]?.segment ?? [];
      const inventory = segments.length === 1 ? mapInventory(segments[0], trip.freeSeats) : null;
      if (!inventory) {
        rows.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: trip.departureTime, arrivalTime: trip.arrivalTime, serviceId, isNightService: true, status: "schedule_only", evidence: `Movelia no expone un mapa de plazas reconciliable para ${trip.companyName}.`, stops: [trip.originName, trip.destinationName] });
        continue;
      }
      rows.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: trip.departureTime, arrivalTime: trip.arrivalTime, serviceId, isNightService: true, status: inventory.freeSeats ? "available" : "full_or_unavailable", ...inventory, evidence: `Mapa oficial Movelia (${trip.companyName}): total=${inventory.totalSeats}; free=${inventory.freeSeats}; occupied=${inventory.occupiedSeats}`, stops: [trip.originName, trip.destinationName] });
    } catch (error) {
      rows.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: trip.departureTime, arrivalTime: trip.arrivalTime, serviceId, isNightService: true, status: "error", error: error.message, stops: [trip.originName, trip.destinationName] });
    }
  }
  return rows;
}

function moventisUrl(destination, date) {
  const query = new URLSearchParams({
    origin: MOVENTIS_ORIGIN.name,
    origin_id: MOVENTIS_ORIGIN.id,
    origin_address: "null",
    destination: destination.name,
    destination_id: destination.id,
    destination_address: "null",
    journey_type: "0",
    departure_time: date,
    passengers: "1",
    locale: "es-ES",
  });
  return `https://compras.moventis.es/online/selection?${query}`;
}

async function collectMoventisRoute(page, route, date, limit) {
  const destination = MOVENTIS_DESTINATIONS[route.slug];
  if (!destination) return null;
  await page.goto(moventisUrl(destination, date), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator(".DepartureCard").first().waitFor({ timeout: 30_000 });
  const cardServices = await page.locator(".DepartureCard").evaluateAll((cards) => cards.map((card, index) => {
    const text = card.textContent;
    const time = (selector) => card.querySelector(selector)?.textContent.replace(/\s+/g, " ").trim() ?? "";
    const freeMatch = text.match(/Asientos libres:\s*(\d+)/i);
    return { index, departureTime: time(".Departure .DepartureTime"), arrivalTime: time(".Arrive .DepartureTime"), advertisedFree: freeMatch ? Number(freeMatch[1]) : null };
  }));
  const services = cardServices.filter((service) => crossesNight(service.departureTime, service.arrivalTime)).slice(0, limit);
  if (!services.length) return [{ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: null, status: "schedule_only", evidence: "La pasarela oficial Moventis no devolvió expediciones nocturnas directas.", stops: [] }];

  const rows = [];
  for (const service of services) {
    try {
      await page.goto(moventisUrl(destination, date), { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.locator(".DepartureCard").nth(service.index).locator(".Prices button.Button").click();
      await page.getByRole("button", { name: "Continuar" }).click();
      await page.waitForURL(/\/online\/seats/, { timeout: 30_000 });
      await page.locator(".Seats .Seat").first().waitFor({ timeout: 30_000 });
      const inventory = await page.locator(".Seats .Seat").evaluateAll((seats) => ({
        totalSeats: seats.length,
        freeSeats: seats.filter((seat) => !seat.querySelector("label")?.classList.contains("Disabled")).length,
      }));
      inventory.occupiedSeats = inventory.totalSeats - inventory.freeSeats;
      if (!inventory.totalSeats || (Number.isInteger(service.advertisedFree) && inventory.freeSeats !== service.advertisedFree)) {
        throw new Error(`El mapa Moventis no reconcilia: mapa ${inventory.totalSeats}/${inventory.freeSeats}, horarios ${service.advertisedFree}.`);
      }
      rows.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: service.departureTime, arrivalTime: service.arrivalTime, serviceId: `moventis-${date}-${destination.id}-${service.departureTime}`, isNightService: true, status: inventory.freeSeats ? "available" : "full_or_unavailable", ...inventory, evidence: `Mapa oficial Moventis validado contra horarios: total=${inventory.totalSeats}; free=${inventory.freeSeats}; occupied=${inventory.occupiedSeats}`, stops: [MOVENTIS_ORIGIN.name, destination.name] });
    } catch (error) {
      rows.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: service.departureTime, arrivalTime: service.arrivalTime, isNightService: true, status: "error", error: error.message, stops: [] });
    }
  }
  return rows;
}

export async function collectMoveliaRoutes({ routes, date, headed = false, trace = false, limit = Infinity }) {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ locale: "es-ES", timezoneId: "Europe/Madrid" });
  if (trace) await context.tracing.start({ screenshots: true, snapshots: true });
  const results = [];
  try {
    for (const route of routes) {
      const page = await context.newPage();
      try {
        if (route.operator.toLowerCase() === "busbam") {
          await page.goto(BAM_PORTAL, { waitUntil: "domcontentloaded", timeout: 60_000 });
          // The anonymous token is replaced by the BAM portal token immediately
          // after initial load, causing one client-side navigation.
          await page.waitForTimeout(6_000);
          await page.waitForFunction(() => Boolean(sessionStorage.getItem("token")), null, { timeout: 20_000 });
          results.push(...await collectBusbamRoute(page, route, date, limit));
        } else {
          const moventisRows = await collectMoventisRoute(page, route, date, limit);
          if (moventisRows) results.push(...moventisRows);
          else results.push(...await collectGenericMoveliaRoute(page, route, date, limit));
        }
      } catch (error) { results.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: null, status: "error", error: error.message, stops: [] });
      } finally { await page.close(); }
    }
  } finally { if (trace) await context.tracing.stop({ path: "data/movelia-trace.zip" }); await browser.close(); }
  return results;
}
