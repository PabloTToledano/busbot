import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { openDatabase } from "./db.js";
import { dashboardPage } from "./dashboard-page.js";
import { madridDateTimeEpoch, madridToday } from "./time.js";

const port = Number(process.env.DASHBOARD_PORT ?? 8787);
const db = openDatabase(resolve(process.env.BUS_DATA_DIR ?? "data", "bus_occupancy.sqlite"));

async function downloadDatabase(response) {
  const snapshotPath = join(tmpdir(), `bus-occupancy-${randomUUID()}.sqlite`);
  try {
    // VACUUM INTO exports a consistent SQLite snapshot, including committed
    // changes still in the WAL, without copying live database sidecar files.
    db.prepare("VACUUM INTO ?").run(snapshotPath);
    await chmod(snapshotPath, 0o600);
    response.writeHead(200, {
      "content-type": "application/vnd.sqlite3",
      "content-disposition": `attachment; filename="bus-occupancy-${madridToday()}.sqlite"`,
      "cache-control": "no-store",
    });
    await pipeline(createReadStream(snapshotPath), response);
  } catch (error) {
    console.error(`Database download failed: ${error.message}`);
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("No se pudo generar la copia de la base de datos.\n");
    } else if (!response.destroyed) {
      response.destroy(error);
    }
  } finally {
    await unlink(snapshotPath).catch(() => {});
  }
}

function rowsForDashboard() {
  const date = madridToday();
  const historyStart = new Date(`${date}T12:00:00.000Z`);
  historyStart.setUTCDate(historyStart.getUTCDate() - 13);
  const historyFrom = historyStart.toISOString().slice(0, 10);
  const services = db.prepare(`
    SELECT o.operator, o.origin, o.destination, o.service_date, o.departure_time,
      o.status, o.total_seats, o.free_seats, o.occupied_seats,
      o.ticket_price_cents, o.ticket_currency, o.price_reference_date,
      o.observed_at, d.checked_at, d.outcome
    FROM observations o
    LEFT JOIN departure_checks d ON d.service_key = o.service_key
    WHERE o.service_date >= ?
    ORDER BY o.service_date, o.departure_time
  `).all(date).map((row) => ({
    ...row,
    dueAt: row.departure_time
      ? new Date(madridDateTimeEpoch(row.service_date, row.departure_time) - 10 * 60_000).toISOString()
      : null,
  }));
  const history = db.prepare(`
    SELECT operator, origin, destination, service_date, departure_time,
      status, total_seats, free_seats, occupied_seats,
      ticket_price_cents, ticket_currency, observed_at
    FROM observations
    WHERE service_date >= ? AND service_date <= ?
    ORDER BY service_date DESC, observed_at DESC
    LIMIT 2500
  `).all(historyFrom, date);
  const routeCount = db.prepare("SELECT count(*) AS count FROM routes").get().count;
  const plannedRoutes = db.prepare(`
    SELECT operator, origin, destination
    FROM routes
    ORDER BY operator, origin, destination
  `).all();
  const renfeTrains = db.prepare(`
    SELECT commercial_code, circulation_code, corridor_code, previous_station_code,
      next_station_code, next_station_arrival_estimate, delay_minutes, last_seen_at
    FROM renfe_trains
    ORDER BY delay_minutes DESC, last_seen_at DESC
    LIMIT 100
  `).all();
  const renfeAlerts = db.prepare(`
    SELECT id, train_key, detected_at, expected_arrival_at, delay_minutes, commercial_code,
      circulation_code, corridor_code, next_station_code,
      next_station_arrival_estimate, notification_text, notification_status,
      notification_sent_at
    FROM renfe_arrival_alerts
    ORDER BY detected_at DESC
    LIMIT 100
  `).all();
  const xPosts = db.prepare(`
    SELECT event_type, event_key, message, status, created_at, sent_at, post_id, error_message
    FROM x_post_outbox ORDER BY id DESC LIMIT 100
  `).all();
  const sentTweets = db.prepare(`
    SELECT post_id, max(sent_at) AS sent_at, count(*) AS event_count,
      group_concat(message, char(10)) AS message
    FROM x_post_outbox
    WHERE status = 'sent' AND post_id IS NOT NULL
    GROUP BY post_id
    ORDER BY sent_at DESC
    LIMIT 100
  `).all();
  const byStatus = db.prepare("SELECT status, count(*) AS count FROM observations WHERE service_date = ? GROUP BY status").all(date);
  return { date, historyFrom, routeCount, plannedRoutes, byStatus, services, history, renfeTrains, renfeAlerts, xPosts, sentTweets, generatedAt: new Date().toISOString() };
}

const page = dashboardPage;

createServer((request, response) => {
  if (request.method === "GET" && new URL(request.url, "http://localhost").pathname === "/api/database.sqlite") {
    void downloadDatabase(response);
    return;
  }
  if (request.url === "/api/dashboard") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(rowsForDashboard()));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
}).listen(port, "0.0.0.0", () => console.log(`Dashboard listening on ${port}`));
