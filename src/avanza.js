import { chromium } from "playwright";
import { crossesNight } from "./alsa.js";
import { ticketPriceFromText } from "./price.js";

const URL = "https://booking.avanzabus.com/web/";
const STATIONS = {
  "madrid-badajoz": { origin: "S00001", destination: "S00141" },
};

const normalise = (value) => value.replace(/\s+/g, " ").trim();
const spanishDate = (date) => {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
};

async function startSearch(page, route, date) {
  const stations = STATIONS[route.slug];
  if (!stations) throw new Error("No hay códigos de parada verificados para esta ruta de Avanza.");
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.evaluate(async ({ origin, destination, dateValue }) => {
    let destinations = await $.post("/web/step0_do.php", { op: "ax_destinations", origin });
    if (typeof destinations === "string") destinations = JSON.parse(destinations);
    if (!destinations.some((item) => item.id === destination)) throw new Error("El destino no está disponible desde esta parada.");
    $("select[name='origin']").val(origin);
    $("select[name='destination']").empty().append(destinations.map((item) => `<option value="${item.id}">${item.text}</option>`).join("")).val(destination);
    $("input[name='type'][value='one_way']").prop("checked", true);
    $("input[name='outwardDate']").val(dateValue);
    // Avanza exige este identificador anónimo antes de aceptar la búsqueda.
    $("input[name='user']").val("avzdfgh890234bw2q");
    document.querySelector("form[name='step0']").submit();
  }, { ...stations, dateValue: spanishDate(date) });
  await page.waitForURL("**/step1.php", { timeout: 20_000 });
  await page.locator(".filter_block").first().waitFor({ state: "visible", timeout: 15_000 });
}

async function listServices(page) {
  return page.locator(".filter_block").evaluateAll((cards) => cards.map((card) => ({
    departureTime: card.dataset.departure,
    arrivalTime: card.dataset.arrival,
    available: card.dataset.available === "1",
    text: card.innerText.replace(/\s+/g, " ").trim(),
  })).filter((trip) => /^\d{2}:\d{2}$/.test(trip.departureTime ?? "") && /^\d{2}:\d{2}$/.test(trip.arrivalTime ?? "")));
}

async function readSeatMap(page, route, date, service) {
  await startSearch(page, route, date);
  const card = page.locator(`.filter_block[data-departure="${service.departureTime}"][data-arrival="${service.arrivalTime}"]`).first();
  if (!await card.count()) throw new Error("La expedición ya no está disponible en el checkout de Avanza.");
  await card.locator(".filters").click();
  await page.locator("input[name='outwardTripCode']").waitFor({ state: "attached" });
  if (!await page.locator("input[name='outwardTripCode']").inputValue()) throw new Error("Avanza no dejó seleccionar la expedición.");
  await page.locator("form[name='step1']").evaluate((form) => form.submit());
  await page.waitForURL("**/step2.php", { timeout: 20_000 });
  await page.evaluate(() => {
    const values = {
      namecontact: "Consulta", surnamecontact: "Plazas", document: "00000000T",
      fechaNacimiento: "01/01/1990", zipCode: "28001", phone: "600000000",
      email: "consulta-plazas@example.com", email_confirm: "consulta-plazas@example.com",
      nameAdult1: "Consulta", surname1Adult1: "Plazas", user: "avzfp2o1u6p05t40j",
    };
    for (const [name, value] of Object.entries(values)) document.querySelector(`[name="${name}"]`).value = value;
    document.querySelector("form[name='step2']").submit();
  });
  await page.waitForURL("**/step3.php", { timeout: 20_000 });
  // `P` cells draw the central aisle and are not passenger seats.
  const seats = page.locator(".seatmap .seat[data-plaza]:not([data-plaza='P'])");
  await seats.first().waitFor({ state: "attached", timeout: 12_000 });
  const inventory = await seats.evaluateAll((nodes) => {
    let free = 0;
    let total = 0;
    let unknown = 0;
    for (const seat of nodes) {
      const status = [...seat.classList].find((name) => /^seatStatus/.test(name));
      // D = disponible and S = the temporarily selected seat. V and T are
      // explicitly non-selectable states in Avanza's map.
      if (!status) { unknown += 1; continue; }
      total += 1;
      if (status === "seatStatusD" || status === "seatStatusS") free += 1;
      else if (status !== "seatStatusV" && status !== "seatStatusT") unknown += 1;
    }
    return { total, free, unknown };
  });
  if (!inventory.total || inventory.unknown) throw new Error("El mapa de plazas de Avanza contiene estados no reconocidos.");
  return {
    totalSeats: inventory.total,
    freeSeats: inventory.free,
    occupiedSeats: inventory.total - inventory.free,
    evidence: `Avanza seat map: total=${inventory.total}; free=${inventory.free}; occupied=${inventory.total - inventory.free}`,
  };
}

export async function collectAvanza({ routes, date, headed = false, trace = false, limit = Infinity }) {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ locale: "es-ES", timezoneId: "Europe/Madrid" });
  if (trace) await context.tracing.start({ screenshots: true, snapshots: true });
  const results = [];
  try {
    for (const route of routes) {
      const schedulePage = await context.newPage();
      try {
        await startSearch(schedulePage, route, date);
        const services = (await listServices(schedulePage)).filter((service) => crossesNight(service.departureTime, service.arrivalTime)).slice(0, limit);
        for (const service of services) {
          const serviceId = `avanza-${route.slug ?? `${route.origin}-${route.destination}`}-${date}-${service.departureTime}-${service.arrivalTime}`;
          if (!service.available) {
            results.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: service.departureTime, serviceId, isNightService: true, status: "full_or_unavailable", ...ticketPriceFromText(service.text), evidence: service.text, stops: [] });
            continue;
          }
          const checkoutPage = await context.newPage();
          try {
            const inventory = await readSeatMap(checkoutPage, route, date, service);
            results.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: service.departureTime, serviceId, isNightService: true, status: "available", ...ticketPriceFromText(service.text), ...inventory, stops: [] });
          } catch (error) {
            results.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: service.departureTime, serviceId, isNightService: true, status: "error", error: error.message, evidence: service.text, stops: [] });
          } finally { await checkoutPage.close(); }
        }
      } catch (error) {
        results.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: null, status: "error", error: error.message, stops: [] });
      } finally { await schedulePage.close(); }
    }
  } finally {
    if (trace) await context.tracing.stop({ path: "data/avanza-trace.zip" });
    await browser.close();
  }
  return results;
}
