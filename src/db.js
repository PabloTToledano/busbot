import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_ROUTES = [
  { operator: "Interbus", origin: "Málaga", destination: "Madrid", slug: null },
  { operator: "Alsa", origin: "Málaga", destination: "Barcelona", slug: "malaga-barcelona" },
  { operator: "Alsa", origin: "Málaga", destination: "Valencia", slug: "malaga-valencia" },
  { operator: "Alsa", origin: "Madrid", destination: "Santander", slug: "madrid-santander" },
  { operator: "Alsa", origin: "Madrid", destination: "Llanes", slug: "madrid-llanes" },
  { operator: "Alsa", origin: "Madrid", destination: "Soria", slug: "madrid-soria" },
  { operator: "Alsa", origin: "Madrid", destination: "Avilés", slug: "madrid-aviles" },
  { operator: "Alsa", origin: "Madrid", destination: "Alicante", slug: "madrid-alicante" },
  { operator: "Alsa", origin: "Madrid", destination: "Mieres", slug: "madrid-mieres" },
  { operator: "Alsa", origin: "Madrid", destination: "Bilbao", slug: "madrid-bilbao" },
  { operator: "Alsa", origin: "Madrid", destination: "San Sebastián", slug: "madrid-san-sebastian" },
  { operator: "Alsa", origin: "Madrid", destination: "Pamplona", slug: "madrid-soria-pamplona" },
  { operator: "Alsa", origin: "Madrid", destination: "Burgos", slug: "madrid-burgos" },
  { operator: "Alsa", origin: "Madrid", destination: "León", slug: "madrid-leon" },
  { operator: "Alsa", origin: "Madrid", destination: "Logroño", slug: "madrid-logrono" },
  { operator: "Alsa", origin: "Madrid", destination: "Oviedo", slug: "madrid-oviedo" },
  { operator: "Alsa", origin: "Madrid", destination: "Gijón", slug: "madrid-gijon-xixon" },
  { operator: "Alsa", origin: "Madrid", destination: "A Coruña", slug: "madrid-la-coruna-a-coruna" },
  { operator: "Alsa", origin: "Madrid", destination: "Lugo", slug: "madrid-lugo" },
  { operator: "Alsa", origin: "Madrid", destination: "Santiago de Compostela", slug: "madrid-santiago-de-compostela" },
  { operator: "Alsa", origin: "Madrid", destination: "Ferrol", slug: "madrid-ferrol" },
  { operator: "Alsa", origin: "Madrid", destination: "Tudela", slug: "madrid-tudela" },
  { operator: "Alsa", origin: "Madrid", destination: "Mojácar", slug: "madrid-mojacar" },
  { operator: "Alsa", origin: "Madrid", destination: "Altea", slug: "madrid-altea" },
  { operator: "Alsa", origin: "Madrid", destination: "Jávea", slug: "madrid-javea" },
  { operator: "Alsa", origin: "Madrid", destination: "Valladolid", slug: "madrid-valladolid" },
  { operator: "Alsa", origin: "Madrid", destination: "Zamora", slug: "madrid-zamora" },
  { operator: "Alsa", origin: "Madrid", destination: "Albacete", slug: "madrid-albacete" },
  { operator: "Alsa", origin: "Madrid", destination: "Murcia", slug: "madrid-murcia" },
  { operator: "Alsa", origin: "Madrid", destination: "Salamanca", slug: "madrid-salamanca" },
  { operator: "Alsa", origin: "Madrid", destination: "Valencia", slug: "madrid-valencia" },
  { operator: "Alsa", origin: "Madrid", destination: "Castellón de la Plana", slug: "madrid-castellon-de-la-plana" },
  { operator: "Alsa", origin: "Madrid", destination: "Palencia", slug: "madrid-palencia" },
  { operator: "Alsa", origin: "Madrid", destination: "Vitoria", slug: "madrid-vitoria" },
  { operator: "Alsa", origin: "Madrid", destination: "Jaén", slug: "madrid-jaen" },
  { operator: "Alsa", origin: "Madrid", destination: "Teruel", slug: "madrid-teruel" },
  { operator: "Alsa", origin: "Madrid", destination: "Cartagena", slug: "madrid-cartagena" },
  { operator: "Alsa", origin: "Madrid", destination: "Ourense", slug: "madrid-ourense" },
  { operator: "Alsa", origin: "Cáceres", destination: "Pontevedra", slug: "caceres-pontevedra" },
  { operator: "Alsa", origin: "Cáceres", destination: "Algeciras", slug: "caceres-algeciras" },
  { operator: "Alsa", origin: "Cáceres", destination: "Sevilla", slug: "caceres-sevilla" },
  { operator: "Alsa", origin: "Cáceres", destination: "Jerez de la Frontera", slug: "caceres-jerez-de-la-frontera" },
  { operator: "Alsa", origin: "Cáceres", destination: "Vigo", slug: "caceres-vigo" },
  { operator: "Alsa", origin: "Cáceres", destination: "Gijón", slug: "caceres-gijon" },
  { operator: "Alsa", origin: "Cáceres", destination: "Oviedo", slug: "caceres-oviedo" },
  { operator: "Socibus", origin: "Sevilla", destination: "Madrid", slug: "sevilla-madrid" },
  { operator: "Alsa", origin: "Sevilla", destination: "Barcelona", slug: "sevilla-barcelona" },
  { operator: "Alsa", origin: "Sevilla", destination: "Almería", slug: "sevilla-almeria" },
  { operator: "Alsa", origin: "Sevilla", destination: "Córdoba", slug: "sevilla-cordoba" },
  { operator: "Alsa", origin: "Sevilla", destination: "Granada", slug: "sevilla-granada" },
  { operator: "Alsa", origin: "Sevilla", destination: "Málaga", slug: "sevilla-malaga" },
  { operator: "Alsa", origin: "Sevilla", destination: "Valencia", slug: "sevilla-valencia" },
  { operator: "Alsa", origin: "Sevilla", destination: "Lisboa", slug: "sevilla-lisboa" },
  { operator: "Alsa", origin: "Madrid", destination: "Lisboa", slug: "madrid-lisboa" },
  { operator: "Alsa", origin: "Salamanca", destination: "Lisboa", slug: "salamanca-lisboa" },
  { operator: "Alsa", origin: "Salamanca", destination: "Madrid", slug: "salamanca-madrid" },
  { operator: "Alsa", origin: "Salamanca", destination: "Valladolid", slug: "salamanca-valladolid" },
  { operator: "Alsa", origin: "Badajoz", destination: "Lisboa", slug: "badajoz-lisboa" },
  { operator: "Alsa", origin: "Barcelona", destination: "Lisboa", slug: "barcelona-lisboa" },
  { operator: "Alsa", origin: "San Sebastián", destination: "Lisboa", slug: "san-sebastian-lisboa" },
  { operator: "Movelia", origin: "Sevilla", destination: "Lebrija", slug: "sevilla-lebrija" },
  { operator: "Movelia", origin: "Sevilla", destination: "La Línea de la Concepción", slug: "sevilla-la-linea-de-la-concepcion" },
  { operator: "Movelia", origin: "Sevilla", destination: "El Rocío", slug: "sevilla-el-rocio" },
  { operator: "Movelia", origin: "Sevilla", destination: "Lorca", slug: "sevilla-lorca" },
  { operator: "Movelia", origin: "Sevilla", destination: "Islantilla", slug: "sevilla-islantilla" },
  { operator: "Movelia", origin: "Sevilla", destination: "Jerez de los Caballeros", slug: "sevilla-jerez-de-los-caballeros" },
  { operator: "Alsa", origin: "Barcelona", destination: "Sevilla", slug: "barcelona-sevilla" },
  { operator: "Alsa", origin: "Barcelona", destination: "Madrid", slug: "barcelona-madrid" },
  { operator: "Alsa", origin: "Barcelona", destination: "Valencia", slug: "barcelona-valencia" },
  { operator: "Alsa", origin: "Barcelona", destination: "Pamplona", slug: "barcelona-pamplona" },
  { operator: "Alsa", origin: "Barcelona", destination: "Zaragoza", slug: "barcelona-zaragoza" },
  { operator: "Alsa", origin: "Barcelona", destination: "Benidorm", slug: "barcelona-benidorm" },
  { operator: "Alsa", origin: "Barcelona", destination: "Alicante", slug: "barcelona-alicante" },
  { operator: "Alsa", origin: "Barcelona", destination: "Granada", slug: "barcelona-granada" },
  { operator: "Alsa", origin: "Barcelona", destination: "Tudela", slug: "barcelona-tudela" },
  { operator: "Alsa", origin: "Barcelona", destination: "Castellón de la Plana", slug: "barcelona-castellon-de-la-plana" },
  { operator: "Monbus", origin: "Barcelona", destination: "Lugo", slug: "barcelona-lugo" },
  { operator: "Monbus", origin: "Barcelona", destination: "Vigo", slug: "barcelona-vigo" },
  { operator: "Monbus", origin: "Vigo", destination: "Barcelona", slug: "vigo-barcelona" },
  { operator: "Monbus", origin: "Barcelona", destination: "Ourense", slug: "barcelona-orense-ourense" },
  { operator: "Monbus", origin: "Barcelona", destination: "Tolosa", slug: "barcelona-tolosa" },
  { operator: "Monbus", origin: "Barcelona", destination: "Tudela", slug: "barcelona-tudela" },
  { operator: "Alsa", origin: "Barcelona", destination: "Bilbao", slug: "barcelona-bilbao" },
  { operator: "Movelia", origin: "Barcelona", destination: "Cadaqués", slug: "barcelona-cadaques" },
  { operator: "Movelia", origin: "Barcelona", destination: "Lloret de Mar", slug: "barcelona-lloret-de-mar" },
  { operator: "Movelia", origin: "Barcelona", destination: "Tossa de Mar", slug: "barcelona-tossa-de-mar" },
  { operator: "Movelia", origin: "Barcelona", destination: "Palamós", slug: "barcelona-palamos" },
  { operator: "Alsa", origin: "Aeropuerto Madrid-Barajas T4", destination: "Oviedo", slug: "aeropuerto-madrid-barajas-t4-oviedo" },
  { operator: "Alsa", origin: "Aeropuerto Madrid-Barajas T4", destination: "Gijón", slug: "aeropuerto-madrid-barajas-t4-gijon-xixon" },
  { operator: "Interbus", origin: "Madrid", destination: "Málaga", slug: null },
  { operator: "Interbus", origin: "Madrid", destination: "Marbella", slug: null },
  { operator: "Interbus", origin: "Madrid", destination: "Algeciras", slug: null },
  { operator: "Interbus", origin: "Madrid", destination: "Barcelona", slug: null },
  { operator: "Monbus", origin: "Madrid", destination: "Vigo", slug: "madrid-vigo" },
  { operator: "Vibasa", origin: "Madrid", destination: "Pontevedra", slug: "madrid-pontevedra" },
  { operator: "Socibus", origin: "Madrid", destination: "Sevilla", slug: "madrid-sevilla" },
  { operator: "Socibus", origin: "Madrid", destination: "Córdoba", slug: "madrid-cordoba" },
  { operator: "Socibus", origin: "Madrid", destination: "Dos Hermanas", slug: "madrid-dos-hermanas" },
  { operator: "Socibus", origin: "Aeropuerto de Madrid", destination: "Huelva", slug: "aeropuerto-de-madrid-huelva" },
  { operator: "Avanza", origin: "Madrid", destination: "Badajoz", slug: "madrid-badajoz" },
  { operator: "Busbam", origin: "Madrid", destination: "Almería", slug: "madrid-almeria" },
  { operator: "Jiménez Dorado/Cevesa", origin: "Madrid", destination: "Béjar", slug: "madrid-bejar" },
  { operator: "Secorbus", origin: "Madrid", destination: "Andújar", slug: "madrid-andujar" },
  { operator: "Interbus", origin: "Madrid", destination: "Herencia", slug: "madrid-herencia" },
];

function normaliseDepartureTime(value) {
  if (typeof value !== "string") return value;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : value;
}

export function insertRoute(db, { operator, origin, destination, slug = null }) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO routes (operator, origin, destination, slug)
    VALUES (?, ?, ?, ?)
  `);
  return insert.run(operator, origin, destination, slug);
}

export function initDefaultRoutes(db) {
  for (const route of DEFAULT_ROUTES) {
    insertRoute(db, route);
  }
}

export function getRoutes(db, { operator } = {}) {
  if (operator && operator.toLowerCase() !== "all") {
    return db.prepare("SELECT * FROM routes WHERE LOWER(operator) = LOWER(?) ORDER BY id").all(operator);
  }
  return db.prepare("SELECT * FROM routes ORDER BY operator, id").all();
}

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // El dashboard, el catálogo y el monitor son procesos independientes. WAL y
  // un pequeño tiempo de espera permiten que las lecturas no bloqueen las
  // escrituras cortas de las observaciones (y viceversa).
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;");
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'observations'").get();
  // La primera maqueta sólo conocía tres estados. Como no contenía datos reales,
  // la actualizamos de forma segura para poder distinguir un horario de una lectura
  // de ocupación. Una base con historial real no se toca automáticamente.
  if (existing?.sql && !existing.sql.includes("schedule_only")) {
    const count = db.prepare("SELECT COUNT(*) AS count FROM observations").get().count;
    if (count === 0) db.exec("DROP TABLE observation_stops; DROP TABLE observations;");
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY,
      operator TEXT NOT NULL,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      slug TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(operator, origin, destination)
    );
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY,
      observed_at TEXT NOT NULL,
      operator TEXT NOT NULL,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      service_date TEXT NOT NULL,
      departure_time TEXT,
      service_id TEXT,
      service_key TEXT,
      status TEXT NOT NULL CHECK(status IN ('available', 'full_or_unavailable', 'schedule_only', 'error')),
      is_night_service INTEGER NOT NULL DEFAULT 0 CHECK(is_night_service IN (0, 1)),
      total_seats INTEGER,
      free_seats INTEGER,
      occupied_seats INTEGER,
      ticket_price_cents INTEGER,
      ticket_currency TEXT,
      price_reference_date TEXT,
      raw_evidence TEXT,
      error_message TEXT
    );
    CREATE TABLE IF NOT EXISTS observation_stops (
      observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      stop_name TEXT NOT NULL,
      PRIMARY KEY (observation_id, position)
    );
    CREATE TABLE IF NOT EXISTS departure_checks (
      service_key TEXT PRIMARY KEY,
      due_at TEXT NOT NULL,
      claimed_at TEXT,
      checked_at TEXT,
      outcome TEXT,
      error_message TEXT
    );
    CREATE TABLE IF NOT EXISTS renfe_trains (
      train_key TEXT PRIMARY KEY,
      commercial_code TEXT,
      circulation_code TEXT NOT NULL,
      corridor_code TEXT,
      previous_station_code TEXT,
      next_station_code TEXT,
      previous_station_departure TEXT,
      next_station_arrival_estimate TEXT,
      delay_minutes INTEGER NOT NULL,
      latitude REAL,
      longitude REAL,
      feed_updated_at TEXT,
      last_seen_at TEXT NOT NULL,
      raw_data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS renfe_delay_alerts (
      id INTEGER PRIMARY KEY,
      train_key TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      delay_minutes INTEGER NOT NULL,
      commercial_code TEXT,
      circulation_code TEXT NOT NULL,
      corridor_code TEXT,
      previous_station_code TEXT,
      next_station_code TEXT,
      next_station_arrival_estimate TEXT,
      notification_text TEXT NOT NULL,
      notification_status TEXT NOT NULL DEFAULT 'pending' CHECK(notification_status IN ('pending', 'sent', 'failed')),
      notification_post_id TEXT,
      notification_sent_at TEXT,
      UNIQUE(train_key)
    );
    CREATE INDEX IF NOT EXISTS idx_observations_route_date
      ON observations(operator, origin, destination, service_date, observed_at);
    CREATE INDEX IF NOT EXISTS idx_routes_operator
      ON routes(operator);
  `);
  // The observation identity is enforced by an index created later in this
  // migration. SQLite foreign keys cannot target it at this point, so replace
  // only the short-lived monitor ledger created by older versions.
  const departureChecksSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'departure_checks'").get();
  if (departureChecksSchema?.sql?.includes("FOREIGN KEY")) {
    db.exec(`
      DROP TABLE departure_checks;
      CREATE TABLE departure_checks (
        service_key TEXT PRIMARY KEY,
        due_at TEXT NOT NULL,
        claimed_at TEXT,
        checked_at TEXT,
        outcome TEXT,
        error_message TEXT
      );
    `);
  }
  const observationColumns = db.prepare("PRAGMA table_info(observations)").all().map((column) => column.name);
  if (!observationColumns.includes("service_key")) {
    db.exec("ALTER TABLE observations ADD COLUMN service_key TEXT;");
  }
  if (!observationColumns.includes("ticket_price_cents")) {
    db.exec("ALTER TABLE observations ADD COLUMN ticket_price_cents INTEGER;");
  }
  if (!observationColumns.includes("ticket_currency")) {
    db.exec("ALTER TABLE observations ADD COLUMN ticket_currency TEXT;");
  }
  if (!observationColumns.includes("price_reference_date")) {
    db.exec("ALTER TABLE observations ADD COLUMN price_reference_date TEXT;");
  }
  const departureCheckColumns = db.prepare("PRAGMA table_info(departure_checks)").all().map((column) => column.name);
  if (!departureCheckColumns.includes("claimed_at")) {
    db.exec("ALTER TABLE departure_checks ADD COLUMN claimed_at TEXT;");
  }
  // A service ID is useful evidence but not a durable database identity: a
  // failed checkout may not expose it, while the next successful scrape will.
  // The route, travel date and canonical departure time are present in both
  // cases, so use them as the stable identity and update one row on reruns.
  db.exec("DROP INDEX IF EXISTS idx_observations_service_key;");
  const legacyTimes = db.prepare("SELECT id, operator, origin, destination, service_date, departure_time FROM observations").all();
  const updateLegacyTime = db.prepare("UPDATE observations SET departure_time = ?, service_key = ? WHERE id = ?");
  for (const row of legacyTimes) {
    const departureTime = normaliseDepartureTime(row.departure_time ?? "");
    const serviceKey = [row.operator.toLowerCase(), row.origin.toLowerCase(), row.destination.toLowerCase(), row.service_date, departureTime].join("|");
    updateLegacyTime.run(departureTime || null, serviceKey, row.id);
  }
  // Consolidamos las lecturas antiguas antes de imponer la unicidad para que
  // un re-scrape actualice, en vez de sumar.
  db.exec(`
    DELETE FROM observation_stops
    WHERE observation_id IN (
      SELECT id FROM observations WHERE id NOT IN (
        SELECT MAX(id) FROM observations GROUP BY service_key
      )
    );
    DELETE FROM observations
    WHERE id NOT IN (SELECT MAX(id) FROM observations GROUP BY service_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_service_key
      ON observations(service_key);
  `);
  initDefaultRoutes(db);
  return db;
}

export function persistObservation(db, observation) {
  const departureTime = normaliseDepartureTime(observation.departureTime ?? "");
  const serviceKey = [
    observation.operator.toLowerCase(), observation.origin.toLowerCase(), observation.destination.toLowerCase(),
    observation.serviceDate, departureTime,
  ].join("|");
  const insert = db.prepare(`
    INSERT INTO observations (
      observed_at, operator, origin, destination, service_date, departure_time,
      service_id, service_key, status, is_night_service, total_seats, free_seats, occupied_seats, ticket_price_cents, ticket_currency, price_reference_date, raw_evidence, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(service_key) DO UPDATE SET
      observed_at = excluded.observed_at,
      operator = excluded.operator,
      origin = excluded.origin,
      destination = excluded.destination,
      service_date = excluded.service_date,
      departure_time = excluded.departure_time,
      service_id = excluded.service_id,
      status = excluded.status,
      is_night_service = excluded.is_night_service,
      total_seats = excluded.total_seats,
      free_seats = excluded.free_seats,
      occupied_seats = excluded.occupied_seats,
      ticket_price_cents = excluded.ticket_price_cents,
      ticket_currency = excluded.ticket_currency,
      price_reference_date = excluded.price_reference_date,
      raw_evidence = excluded.raw_evidence,
      error_message = excluded.error_message
  `);
  const result = insert.run(
    observation.observedAt, observation.operator, observation.origin, observation.destination,
    observation.serviceDate, departureTime || null, observation.serviceId ?? null, serviceKey,
    observation.status, observation.isNightService ? 1 : 0, observation.totalSeats ?? null, observation.freeSeats ?? null,
    observation.occupiedSeats ?? null, observation.ticketPriceCents ?? null, observation.ticketCurrency ?? null,
    observation.priceReferenceDate ?? null, observation.evidence ?? null, observation.error ?? null,
  );
  const observationId = Number(db.prepare("SELECT id FROM observations WHERE service_key = ?").get(serviceKey).id);
  db.prepare("DELETE FROM observation_stops WHERE observation_id = ?").run(observationId);
  const insertStop = db.prepare(
    "INSERT INTO observation_stops (observation_id, position, stop_name) VALUES (?, ?, ?)",
  );
  for (const [position, stop] of (observation.stops ?? []).entries()) {
    insertStop.run(observationId, position + 1, stop);
  }
  return observationId;
}
