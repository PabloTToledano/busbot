import { chromium } from "playwright";
import { ticketPriceFromText } from "./price.js";

const routeUrl = (slug) => `https://www.alsa.es/es/ruta/${slug}`;
const NIGHT_START = 22 * 60;
const NIGHT_END = 6 * 60;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalise = (value) => value.replace(/\s+/g, " ").trim();

function minutes(time) {
  const [hours, mins] = time.split(":").map(Number);
  return hours * 60 + mins;
}

async function setAlsaDate(page, date) {
  const [year, month, day] = date.split("-");
  const inputs = page.locator('input[name="_departureDate"]');
  if (!await inputs.count()) return;
  const visibleInput = () => page.locator('input[name="_departureDate"]:visible').first();
  // ALSA now hides the editable date in its route landing pages until the
  // visitor switches from the generic timetable to “Buscar por fechas”.
  // Dispatching the Angular click avoids a physical-click wait on the animated
  // panel and makes the same checkout flow work in headless mode.
  if (!await visibleInput().count()) {
    const showDateSearch = page.getByText("Buscar por fechas", { exact: true });
    if (await showDateSearch.count()) {
      await showDateSearch.dispatchEvent("click");
      await visibleInput().waitFor({ state: "visible", timeout: 5_000 });
    }
  }
  // Angular keeps a hidden mobile/previous form in the DOM after switching
  // views. Always bind the action to the currently visible field.
  const input = visibleInput();
  if (!await input.count()) return;
  const formattedDate = `${day}/${month}/${year}`;
  if ((await input.inputValue()) === formattedDate) return;
  await input.fill(formattedDate);
  // `fill` already emits input/change. The Angular date picker rerenders the
  // form immediately afterwards, so dispatching on the former DOM node can
  // turn a successful date selection into a timeout.
  await delay(300);
}

// El servicio es nocturno si cualquiera de sus minutos de recorrido cae entre
// 22:00–06:00, incluso si sale por la tarde o de madrugada.
export function crossesNight(departure, arrival) {
  const start = minutes(departure);
  let end = minutes(arrival);
  if (end <= start) end += 24 * 60;
  for (let moment = start; moment <= end; moment += 15) {
    const clock = moment % (24 * 60);
    if (clock >= NIGHT_START || clock < NIGHT_END) return true;
  }
  return false;
}

function extractStops(text) {
  const lines = text.split("\n").map(normalise).filter(Boolean);
  const stops = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (/^(?:\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?\s+)?(?:Salida|Llegada|Parada)/i.test(lines[index])) {
      const name = lines[index + 1];
      if (name && !/^(?:España|.+,\s*España)$/i.test(name)) stops.push(name);
    }
  }
  return [...new Set(stops)];
}

async function readAlsaSeatAvailability(page, { slug, date, departureTime, arrivalTime }) {
  await page.goto(routeUrl(slug), { waitUntil: "domcontentloaded", timeout: 45_000 });
  await setAlsaDate(page, date);
  await page.locator("#journeySearchFormButtonjs").dispatchEvent("click");
  await page.waitForTimeout(3_500);

  const cards = page.locator("purchase-journey-card");
  let selectedCard = null;
  for (let index = 0; index < await cards.count(); index += 1) {
    const card = cards.nth(index);
    const text = normalise(await card.innerText());
    if (text.includes(departureTime) && text.includes(arrivalTime)) {
      selectedCard = card;
      break;
    }
  }
  if (!selectedCard) {
    return { status: "schedule_only", evidence: "La expedición no aparece como seleccionable en el flujo de compra de ALSA" };
  }
  const cardText = normalise(await selectedCard.innerText());
  const fare = ticketPriceFromText(cardText);
  if (/no hay plazas disponibles/i.test(cardText)) {
    return { status: "full_or_unavailable", evidence: cardText };
  }

  await selectedCard.getByText("Ver tarifas", { exact: true }).dispatchEvent("click");
  await page.waitForTimeout(300);
  // ALSA mueve el panel de tarifas fuera de la tarjeta en algunas versiones
  // del checkout; por eso se consulta el panel visible en toda la página.
  const fares = page.getByText("Elegir tarifa", { exact: true });
  if (!await fares.count()) return null;
  // La tarifa básica basta para abrir el mapa y no inicia ningún pago.
  await fares.last().dispatchEvent("click");
  // La etiqueta del resumen se divide en varios nodos de Angular y no es un
  // selector estable. Esperamos a que la selección termine antes de continuar.
  await delay(800);
  await page.getByText("Continuar", { exact: true }).click({ noWaitAfter: true });
  await page.getByText("Elige tus asientos", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("Ver asientos", { exact: true }).waitFor({ state: "visible", timeout: 12_000 });
  await page.getByText("Ver asientos", { exact: true }).dispatchEvent("click");
  // ALSA sometimes renders two identical layout components at the same screen
  // coordinates during checkout. One component contains the entire bus map;
  // count one component only, otherwise every seat is doubled.
  const seats = page.locator("purchase-bus-layout").first().locator(".seat");
  await seats.locator(".occupied, .available, .select").first().waitFor({ state: "attached", timeout: 8_000 });
  await delay(300);

  const inventory = await seats.evaluateAll((seats) => {
    const counts = { occupied: 0, free: 0, unknown: 0 };
    for (const seat of seats) {
      if (seat.querySelector(".occupied")) counts.occupied += 1;
      // `select` es la plaza que ALSA preasigna temporalmente al viajero.
      // Seguía disponible antes de abrir el mapa, por lo que se cuenta como libre.
      else if (seat.querySelector(".available, .select")) counts.free += 1;
      else counts.unknown += 1;
    }
    return counts;
  });
  const totalSeats = inventory.occupied + inventory.free;
  // Sólo aceptamos el mapa cuando todos los iconos de plaza tienen estado.
  if (!totalSeats || inventory.unknown) return null;
  return {
    status: "available",
    totalSeats,
    freeSeats: inventory.free,
    occupiedSeats: inventory.occupied,
    ...fare,
    evidence: `ALSA seat map: total=${totalSeats}; free=${inventory.free}; occupied=${inventory.occupied}`,
  };
}

function nextWeek(date) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 7);
  return value.toISOString().slice(0, 10);
}

async function listCheckoutServices(page, { slug, date, limit = Infinity }) {
  await page.goto(routeUrl(slug), { waitUntil: "domcontentloaded", timeout: 45_000 });
  await setAlsaDate(page, date);
  await page.locator("#journeySearchFormButtonjs").dispatchEvent("click");
  await page.waitForTimeout(3_500);
  const cards = page.locator("purchase-journey-card");
  const services = [];
  for (let index = 0; index < await cards.count() && services.length < limit; index += 1) {
    const text = normalise(await cards.nth(index).innerText());
    const times = [...text.matchAll(/\b\d{1,2}:\d{2}\b/g)].map((match) => match[0]);
    const [departureTime, arrivalTime] = times;
    if (!departureTime || !arrivalTime || !crossesNight(departureTime, arrivalTime)) continue;
    services.push({ departureTime, arrivalTime, text, ...ticketPriceFromText(text) });
  }
  return services;
}

async function readRoute(page, { slug, operator, origin, destination, date, limit = Infinity }) {
    const services = await listCheckoutServices(page, { slug, date, limit });
    const result = [];
    for (const service of services) {
      const item = {
        observedAt: new Date().toISOString(), operator, origin, destination,
        serviceDate: date, departureTime: service.departureTime,
        serviceId: `alsa-${slug}-${service.departureTime}-${service.arrivalTime}`,
        status: /no hay plazas disponibles/i.test(service.text) ? "full_or_unavailable" : "schedule_only",
        isNightService: true, ...ticketPriceFromText(service.text), evidence: service.text, stops: [],
      };
      const occupancyPage = await page.context().newPage();
      try {
        const inventory = await readAlsaSeatAvailability(occupancyPage, {
          slug, date, departureTime: service.departureTime, arrivalTime: service.arrivalTime,
        });
        if (inventory) Object.assign(item, inventory);
      } catch (error) {
        item.evidence = `${item.evidence} | seat-map error: ${error.message}`;
      } finally {
        await occupancyPage.close();
      }
      if (item.status === "full_or_unavailable" && item.ticketPriceCents == null) {
        const referenceDate = nextWeek(date);
        const pricePage = await page.context().newPage();
        try {
          const future = await listCheckoutServices(pricePage, { slug, date: referenceDate });
          const comparable = future.find((candidate) => candidate.departureTime === service.departureTime && candidate.ticketPriceCents != null);
          if (comparable) Object.assign(item, comparable, { priceReferenceDate: referenceDate });
        } finally { await pricePage.close(); }
      }
      result.push(item);
    }
    return result;
}

async function withAlsaBrowser({ headed, trace, traceName }, work) {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ locale: "es-ES", timezoneId: "Europe/Madrid" });
  if (trace) await context.tracing.start({ screenshots: true, snapshots: true });
  try {
    return await work(context);
  } finally {
    if (trace) await context.tracing.stop({ path: `data/${traceName}.zip` });
    await browser.close();
  }
}

export function slugify(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function collectAlsaRoutes({ routes, date, headed = false, trace = false, limit = Infinity }) {
  return withAlsaBrowser({ headed, trace, traceName: "alsa-trace" }, async (context) => {
    const results = [];
    // Alsa conserva estado de la búsqueda en el cliente. Reutilizar una página
    // (o consultar rutas en paralelo) puede asociar resultados de una búsqueda
    // con el origen/destino de otra. Cada ruta se aísla en una página nueva.
    for (const route of routes) {
      const page = await context.newPage();
      try {
        const slug = route.slug || `${slugify(route.origin)}-${slugify(route.destination)}`;
        const rows = await readRoute(page, {
          slug,
          operator: route.operator || "Alsa",
          origin: route.origin,
          destination: route.destination,
          date,
          limit,
        });
        results.push(...rows);
      } catch (err) {
        results.push({
          observedAt: new Date().toISOString(),
          operator: route.operator || "Alsa",
          origin: route.origin,
          destination: route.destination,
          serviceDate: date,
          departureTime: null,
          status: "error",
          error: err.message,
          stops: [],
        });
      } finally {
        await page.close();
      }
    }
    return results;
  });
}

export async function collectAlsaSchedule({ date, headed = false, trace = false, limit = Infinity }) {
  return withAlsaBrowser({ headed, trace, traceName: "alsa-trace" }, async (context) =>
    readRoute(await context.newPage(), { slug: "malaga-barcelona", operator: "Alsa", origin: "Málaga", destination: "Barcelona", date, limit }),
  );
}

function isPrefix(prefix, whole) {
  return prefix.length < whole.length && prefix.every((stop, index) => stop === whole[index]);
}

export async function collectAlsaMalagaValencia({ date, headed = false, trace = false, limit = Infinity }) {
  return withAlsaBrowser({ headed, trace, traceName: "alsa-valencia-trace" }, async (context) => {
    const valencia = await readRoute(await context.newPage(), {
      slug: "malaga-valencia", operator: "Alsa", origin: "Málaga", destination: "Valencia", date, limit,
    });
    // Alsa presenta el tramo Málaga–Valencia aunque el mismo vehículo continúe
    // a Barcelona. Se compara la secuencia de paradas, no sólo la hora, para
    // descartar exactamente esos servicios pasantes.
    const barcelona = await readRoute(await context.newPage(), {
      slug: "malaga-barcelona", operator: "Alsa", origin: "Málaga", destination: "Barcelona", date, limit,
    });
    return valencia.filter((service) => !barcelona.some((through) =>
      through.departureTime === service.departureTime && isPrefix(service.stops, through.stops),
    ));
  });
}
