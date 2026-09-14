import { chromium } from "playwright";
import { crossesNight } from "./alsa.js";

const PORTALS = {
  "madrid-bejar": "http://cevesa.autobusing.com/",
};

function spanishDate(date) {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

function stationName(city) {
  return city.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

async function collectRoute(page, route, date, limit) {
  const portal = PORTALS[route.slug];
  if (!portal) {
    return [{ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: null, status: "schedule_only", evidence: "No hay una pasarela Autobusing configurada para la ruta.", stops: [] }];
  }
  await page.goto(portal, { waitUntil: "networkidle", timeout: 60_000 });
  await page.locator("#origen_nombre").fill(stationName(route.origin) === "MADRID" ? "MADRID (EST.SUR)" : stationName(route.origin));
  await page.locator("#destino_nombre").fill(stationName(route.destination));
  await page.locator("#fecha_ida").fill(spanishDate(date));
  await page.locator("form.validity").evaluate((form) => form.submit());
  await page.waitForURL(/\/venta\/horarios/, { timeout: 30_000 });

  const services = await page.locator("table.horarios tbody tr").evaluateAll((rows) => rows.map((row) => {
    const radio = row.querySelector('input[type="radio"]');
    const cells = [...row.querySelectorAll("td")].map((cell) => cell.textContent.trim());
    return { value: radio?.value, departureTime: cells[1], arrivalTime: cells[2] };
  }));
  const nightServices = services.filter((service) => service.value && crossesNight(service.departureTime, service.arrivalTime)).slice(0, limit);
  if (!nightServices.length) {
    return [{ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: null, status: "schedule_only", evidence: "La pasarela oficial CEVESA no devolvió expediciones nocturnas directas.", stops: [] }];
  }

  const results = [];
  for (const service of nightServices) {
    try {
      await page.locator(`input[type="radio"][value="${service.value}"]`).check();
      await page.locator('input[type="submit"]').click();
      await page.waitForURL(/\/venta\/plazas/, { timeout: 30_000 });
      const inventory = await page.locator(".booking span.asiento").evaluateAll((seats) => {
        const physical = seats.filter((seat) => !seat.classList.contains("sin-asiento"));
        const free = physical.filter((seat) => seat.classList.contains("libre")).length;
        return { totalSeats: physical.length, freeSeats: free, occupiedSeats: physical.length - free };
      });
      if (!inventory.totalSeats) throw new Error("CEVESA no mostró plazas físicas en el mapa.");
      results.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: service.departureTime, arrivalTime: service.arrivalTime, serviceId: `autobusing-${service.value}`, isNightService: true, status: inventory.freeSeats ? "available" : "full_or_unavailable", ...inventory, evidence: `Mapa oficial CEVESA: total=${inventory.totalSeats}; free=${inventory.freeSeats}; occupied=${inventory.occupiedSeats}`, stops: [route.origin, route.destination] });
    } catch (error) {
      results.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: service.departureTime, arrivalTime: service.arrivalTime, serviceId: `autobusing-${service.value}`, isNightService: true, status: "error", error: error.message, stops: [route.origin, route.destination] });
    }
  }
  return results;
}

export async function collectAutobusing({ routes, date, headed = false, limit = Infinity }) {
  const browser = await chromium.launch({ headless: !headed });
  const results = [];
  try {
    for (const route of routes) {
      const page = await browser.newPage();
      try {
        results.push(...await collectRoute(page, route, date, limit));
      } catch (error) {
        results.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: null, status: "error", error: error.message, stops: [] });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}
