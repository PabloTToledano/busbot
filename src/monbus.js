import { crossesNight } from "./alsa.js";
import https from "node:https";

const API = "https://api.checkout.monbus.es/api";
const simplify = (value) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let apiAddress;

async function resolveApiAddress() {
  if (apiAddress) return apiAddress;
  const response = await fetch("https://cloudflare-dns.com/dns-query?name=api.checkout.monbus.es&type=A", {
    headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`DNS-over-HTTPS: HTTP ${response.status}`);
  const payload = await response.json();
  const address = payload.Answer?.map((answer) => answer.data).find((value) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value));
  if (!address) throw new Error("DNS-over-HTTPS no devolvió una dirección IPv4 para Monbus.");
  apiAddress = address;
  return address;
}

async function getViaResolvedAddress(path, address) {
  const url = `${API}${path}`;
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { accept: "application/json" },
      // Node asks custom lookups for all candidate addresses in recent
      // versions. Keep the URL hostname intact so SNI and certificate
      // validation still apply while the connection avoids broken local DNS.
      lookup: (_host, options, callback) => callback(
        null,
        options.all ? [{ address, family: 4 }] : address,
        options.all ? undefined : 4,
      ),
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(text)); } catch { reject(new Error("Monbus API devolvió JSON inválido.")); }
      });
    });
    request.setTimeout(15_000, () => request.destroy(new Error("Tiempo de espera de Monbus.")));
    request.on("error", reject);
  });
}

async function get(path) {
  // The public checkout API occasionally resets an individual connection.
  // Reads are idempotent, so retrying a small bounded number of times avoids
  // overwriting a current observation with a transient transport failure.
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      try {
        const address = await resolveApiAddress();
        return await getViaResolvedAddress(path, address);
      } catch (dohError) {
        // DNS-over-HTTPS is a narrow fallback for environments where the
        // Monbus zone does not resolve locally. If it is unavailable, retain
        // the normal platform resolver before surfacing an error.
        const response = await fetch(`${API}${path}`, {
          headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}; DoH: ${dohError.message}`);
        return response.json();
      }
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(600 * (attempt + 1));
    }
  }
  throw new Error(`Monbus API no disponible para ${path}: ${lastError?.message ?? "error desconocido"}`);
}

async function numberedSeatMapInventory(trip, stations, scheduled) {
  const maps = await get(`/seats/rates/es?ticketType=1&origin=${stations.origin.id}&destination=${stations.destination.id}&expedition=${trip.id}`);
  const seatMap = maps.find((rate) => rate?.seats?.go?.seatsNumbers?.length)?.seats.go;
  if (!seatMap) throw new Error("Monbus no devolvió el mapa de plazas para el vehículo numerado.");

  // seatsNumbers is the layout presented in seat selection.  Its values are
  // real seat numbers; zero/empty cells are drawing gaps such as the aisle.
  const physicalSeatNumbers = new Set(
    seatMap.seatsNumbers.flat().map(Number).filter((seat) => Number.isInteger(seat) && seat > 0)
  );
  const occupied = new Set([
    ...(seatMap.occupiedSeats ?? []),
    ...(seatMap.bookedSeats ?? []),
  ].map(Number).filter((seat) => Number.isInteger(seat) && seat > 0));
  const totalSeats = physicalSeatNumbers.size;
  const occupiedSeats = [...occupied].filter((seat) => physicalSeatNumbers.has(seat)).length;
  const freeSeats = totalSeats - occupiedSeats;
  if (!totalSeats || totalSeats !== scheduled.totalSeats || freeSeats !== scheduled.freeSeats) {
    throw new Error(`El mapa Monbus no reconcilia con el inventario: mapa ${totalSeats}/${freeSeats}, checkout ${scheduled.totalSeats}/${scheduled.freeSeats}.`);
  }
  return { totalSeats, freeSeats, occupiedSeats };
}

function findStops(payload, city) {
  const expected = simplify(city);
  const stops = ["importantStops", "stops"].flatMap((key) => payload?.data?.[key] ?? []);
  return stops.filter((stop) => {
    const name = simplify(`${stop.attributes?.name ?? ""} ${stop.attributes?.locality ?? ""}`);
    return name.includes(expected);
  });
}

async function findStations(origin, destination) {
  const originResult = await get(`/stopsSearch/es?search=${encodeURIComponent(origin)}`);
  const originStops = findStops(originResult, origin);
  if (!originStops.length) throw new Error(`Monbus no devolvió una parada para ${origin}.`);
  // A city can have several terminals. Try every matching terminal because
  // the autocomplete endpoint scopes destinations to the chosen one.
  for (const originStop of originStops) {
    const destinationResult = await get(`/stopsSearch/es/${originStop.id}/destinations?search=${encodeURIComponent(destination)}`);
    const destinationStop = findStops(destinationResult, destination)[0];
    if (destinationStop) return { origin: originStop, destination: destinationStop };
  }
  throw new Error(`Monbus no vende ${destination} desde ninguna parada de ${origin}.`);
}

export async function collectMonbus({ routes, date, limit = Infinity }) {
  const results = [];
  for (const route of routes) {
    try {
      const stations = await findStations(route.origin, route.destination);
      const trips = (await get(`/traveloptions/es/${stations.origin.id}/${stations.destination.id}/${date}/1/1`))?.data?.departuresGo?.data ?? [];
      const nightTrips = trips.filter((trip) => crossesNight(trip.attributes.stepTime, trip.attributes.arrivalHour)).slice(0, limit);
      if (!nightTrips.length) {
        results.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: null, status: "schedule_only", evidence: "El checkout oficial de Monbus no devolvió expediciones nocturnas directas.", stops: [] });
        continue;
      }
      for (const trip of nightTrips) {
        const booking = trip.attributes.booking ?? [];
        const totalSeats = booking.reduce((sum, vehicle) => sum + Number(vehicle.seats ?? 0), 0);
        const freeSeats = booking.reduce((sum, vehicle) => sum + Number(vehicle.free ?? 0), 0);
        const serviceId = `monbus-${trip.id}`;
        if (!totalSeats || !Number.isFinite(freeSeats)) {
          results.push({ observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination, serviceDate: date, departureTime: trip.attributes.stepTime, serviceId, isNightService: true, status: "schedule_only", evidence: `Monbus checkout: ${trip.attributes.description}`, stops: [] });
          continue;
        }
        const numbered = booking.some((vehicle) => vehicle.isSeatNumbering);
        if (!numbered) {
          // The checkout exposes an aggregate for this coach but provides no
          // selectable layout. The monitor's occupancy contract is based on
          // physical seats from the seat picker, so retain the service without
          // presenting the aggregate as a measured seat inventory.
          results.push({
            observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination,
            serviceDate: date, departureTime: trip.attributes.stepTime, serviceId, isNightService: true,
            status: "schedule_only",
            evidence: `Monbus checkout: vehículo sin numeración; no expone mapa seleccionable (${trip.attributes.description}).`,
            stops: [stations.origin.attributes.name, stations.destination.attributes.name],
          });
          continue;
        }
        const scheduled = { totalSeats, freeSeats };
        const inventory = await numberedSeatMapInventory(trip, stations, scheduled);
        results.push({
          observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination,
          serviceDate: date, departureTime: trip.attributes.stepTime, serviceId, isNightService: true,
          status: inventory.freeSeats ? "available" : "full_or_unavailable", ...inventory,
          evidence: `Mapa oficial Monbus validado contra checkout: total=${inventory.totalSeats}; free=${inventory.freeSeats}; occupied=${inventory.occupiedSeats}`,
          stops: [stations.origin.attributes.name, stations.destination.attributes.name],
        });
      }
    } catch (error) {
      const notSold = error.message.startsWith("Monbus no vende ") || error.message.startsWith("Monbus no devolvió una parada");
      results.push({
        observedAt: new Date().toISOString(), operator: route.operator, origin: route.origin, destination: route.destination,
        serviceDate: date, departureTime: null, status: notSold ? "schedule_only" : "error",
        ...(notSold ? { evidence: error.message } : { error: error.message }), stops: [],
      });
    }
  }
  return results;
}
