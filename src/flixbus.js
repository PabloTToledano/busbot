import { chromium } from "playwright";
import { crossesNight } from "./alsa.js";

const routeUrl = (slug) => `https://www.flixbus.es/rutas/${slug}`;
const normalise = (value) => value.replace(/\s+/g, " ").trim();

function durationMinutes(text) {
  const match = text.match(/(?:duraci[oó]n m[ií]nima del viaje|duración del viaje|minimum trip duration)[^\d]*(\d+)\s*h(?:\s*(\d+)\s*min)?/i);
  return match ? Number(match[1]) * 60 + Number(match[2] ?? 0) : null;
}

function arrivalFor(departure, duration) {
  if (duration == null) return null;
  const [h, m] = departure.split(":").map(Number);
  const total = h * 60 + m + duration;
  return `${String(Math.floor((total % 1440) / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function timesFrom(text) {
  const matches = [
    ...text.matchAll(/(?:primer|first)[^\d]{0,100}(\d{1,2}:[0-5]\d)/gi),
    ...text.matchAll(/(?:últim|last)[^\d]{0,100}(\d{1,2}:[0-5]\d)/gi),
  ];
  return [...new Set(matches.map((m) => m[1]))];
}

function searchUrlFromOnclick(onclick) {
  const rawUrl = onclick?.match(/location\.href='([^']+)'/)?.[1];
  return rawUrl?.replace(/\\u0026/g, "&").replace(/\\\//g, "/") ?? null;
}

export function parseFlixbusTrips(text) {
  const evidence = normalise(text);
  const trips = [];
  const pattern = /Hora de salida:\s*(\d{1,2}:\d{2})[\s\S]{0,250}?Duración:\s*(\d+):(\d{2})\s*h[\s\S]{0,250}?Hora de llegada:\s*(\d{1,2}:\d{2})([\s\S]{0,300}?)(?=Hora de salida:|$)/gi;
  for (const match of evidence.matchAll(pattern)) {
    const [, departureTime, hours, minutes, arrivalTime, tail] = match;
    trips.push({
      departureTime,
      arrivalTime,
      duration: Number(hours) * 60 + Number(minutes),
      // Es una señal comercial, no un recuento: nunca se convierte en plazas.
      occupancyHint: /casi lleno/i.test(tail) ? "almost_full" : null,
    });
  }
  return trips;
}

export function parseFlixbusEvidence(text) {
  const evidence = normalise(text);
  const duration = durationMinutes(evidence);
  return { evidence, duration, times: timesFrom(evidence) };
}

export function currentDateFlixbusText(text) {
  return text.split(/Viajes después de la medianoche/i)[0];
}

async function checkFlixbusSeatCheckout(page, tripIndex) {
  const reserveButtons = page.locator('[data-e2e="button-reserve-trip"]');
  if (tripIndex < 0 || tripIndex >= await reserveButtons.count()) {
    return "FlixBus no expuso un control de selección para la expedición nocturna.";
  }
  // This performs the same ordinary “Continuar” action a traveller takes,
  // but never attempts to solve or bypass a CAPTCHA. It lets the stored
  // observation distinguish a missing layout from an access challenge.
  await reserveButtons.nth(tripIndex).dispatchEvent("click");
  await page.waitForTimeout(700);
  const checkoutText = normalise((await page.locator("body").innerText()).slice(-2_500));
  if (/resuelve\s+el\s+captcha|captcha/i.test(checkoutText)) {
    return "FlixBus exige CAPTCHA antes del selector de asientos; no se puede obtener un mapa sin intervención humana.";
  }
  return "El checkout de FlixBus no expuso un mapa de asientos contable tras seleccionar la expedición.";
}

export async function collectFlixbusRoutes({ routes, date, headed = false, trace = false, limit = Infinity }) {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ locale: "es-ES", timezoneId: "Europe/Madrid" });
  if (trace) await context.tracing.start({ screenshots: true, snapshots: true });
  const results = [];
  try {
    for (const route of routes) {
      const page = await context.newPage();
      try {
        await page.goto(routeUrl(route.slug), { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(1_500);
        // La landing contiene un enlace interno con los identificadores de las
        // dos estaciones. El buscador sí devuelve las expediciones concretas.
        const viewTrips = page.getByText("Ver viajes", { exact: true }).first();
        const searchUrl = searchUrlFromOnclick(await viewTrips.getAttribute("onclick").catch(() => null));
        if (searchUrl) {
          const url = new URL(searchUrl);
          url.searchParams.set("rideDate", date);
          await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
          // El listado se hidrata después de que ya haya cargado el DOM inicial.
          await page.getByText(/resultados/i).first().waitFor({ state: "visible", timeout: 12_000 }).catch(() => {});
          await page.waitForTimeout(500);
        }
        const bodyText = (await page.locator("body").allInnerTexts()).join(" ").slice(0, 12_000);
        // The search page appends a separate “Viajes después de la medianoche”
        // section for the following calendar day. It must not share the
        // queried service date or collide with a same-time departure today.
        const currentDateText = currentDateFlixbusText(bodyText);
        const parsed = parseFlixbusEvidence(currentDateText);
        const allTrips = parseFlixbusTrips(currentDateText);
        const trips = allTrips.filter((trip) => crossesNight(trip.departureTime, trip.arrivalTime)).slice(0, limit);
        const firstNightTripIndex = allTrips.findIndex((trip) => crossesNight(trip.departureTime, trip.arrivalTime));
        const checkoutEvidence = firstNightTripIndex >= 0
          ? await checkFlixbusSeatCheckout(page, firstNightTripIndex)
          : null;
        if (!trips.length) {
          results.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: null, status: "schedule_only", evidence: parsed.evidence, stops: [] });
        } else for (const trip of trips) {
          results.push({
            observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination,
            serviceDate: date, departureTime: trip.departureTime,
            serviceId: `flixbus-${route.slug}-${trip.departureTime}-${trip.arrivalTime}`,
            status: "schedule_only", isNightService: crossesNight(trip.departureTime, trip.arrivalTime),
            evidence: `${parsed.evidence.slice(0, 7_500)}${checkoutEvidence && crossesNight(trip.departureTime, trip.arrivalTime) ? ` | ${checkoutEvidence}` : ""}${trip.occupancyHint ? ` | occupancy_hint=${trip.occupancyHint}` : ""}`,
            stops: [],
          });
        }
      } catch (error) {
        results.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: null, status: "error", error: error.message, stops: [] });
      } finally { await page.close(); }
    }
  } finally {
    if (trace) await context.tracing.stop({ path: "data/flixbus-trace.zip" });
    await browser.close();
  }
  return results;
}
