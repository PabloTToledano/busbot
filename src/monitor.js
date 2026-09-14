import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "./db.js";
import { madridDateTimeEpoch, madridToday, shouldCheckDeparture } from "./time.js";

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function timestamp() { return new Date().toISOString(); }

function runCollector(service) {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "--operator", service.operator, "--route", `${service.origin}-${service.destination}`, "--date", service.service_date], { cwd: process.cwd(), stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, error: stderr.trim() || `collector exited with ${code}` }));
  });
}

export async function runDueChecks(db, { date = madridToday(), graceMinutes = 5, now = Date.now() } = {}) {
  const services = db.prepare(`SELECT service_key, operator, origin, destination, service_date, departure_time FROM observations
    WHERE is_night_service = 1 AND service_date >= ? AND departure_time IS NOT NULL AND lower(operator) <> 'flixbus'`).all(date);
  const due = services.filter((service) => shouldCheckDeparture({
    dueAt: madridDateTimeEpoch(service.service_date, service.departure_time) - 10 * 60_000, now, graceMinutes,
  }));
  const claim = db.prepare(`INSERT INTO departure_checks(service_key, due_at, claimed_at) VALUES (?, ?, ?)
    ON CONFLICT(service_key) DO UPDATE SET claimed_at = excluded.claimed_at
    WHERE departure_checks.checked_at IS NULL AND (departure_checks.claimed_at IS NULL OR departure_checks.claimed_at < ?)`);
  const complete = db.prepare("UPDATE departure_checks SET checked_at = ?, outcome = ?, error_message = ? WHERE service_key = ?");
  const observation = db.prepare("SELECT status, error_message, total_seats, free_seats, occupied_seats, ticket_price_cents, ticket_currency FROM observations WHERE service_key = ?");
  const results = [];
  for (const service of due) {
    const dueAt = new Date(madridDateTimeEpoch(service.service_date, service.departure_time) - 10 * 60_000).toISOString();
    const claimed = claim.run(service.service_key, dueAt, timestamp(), new Date(now - 15 * 60_000).toISOString());
    if (claimed.changes === 0) continue;
    const refresh = await runCollector(service);
    const latest = observation.get(service.service_key);
    const outcome = refresh.ok ? latest?.status ?? "error" : "error";
    const error = refresh.ok ? latest?.error_message ?? null : refresh.error;
    complete.run(timestamp(), outcome, error, service.service_key);
    results.push({ ...service, status: outcome, seatsTotal: latest?.total_seats ?? null, seatsFree: latest?.free_seats ?? null, seatsOccupied: latest?.occupied_seats ?? null, ticketPriceCents: latest?.ticket_price_cents ?? null, ticketCurrency: latest?.ticket_currency ?? null, error });
  }
  return results;
}

async function main() {
  const pollSeconds = Number(option("--poll-seconds", "30"));
  const graceMinutes = Number(option("--grace-minutes", "5"));
  const date = option("--date") ?? madridToday();
  if (!Number.isFinite(pollSeconds) || pollSeconds < 5 || !Number.isFinite(graceMinutes) || graceMinutes < 0) throw new Error("Invalid monitor interval.");
  const db = openDatabase(path.resolve(process.env.BUS_DATA_DIR ?? "data", "bus_occupancy.sqlite"));
  const scan = async () => {
    const results = await runDueChecks(db, { date, graceMinutes });
    results.forEach((result) => console.log(JSON.stringify(result)));
  };
  await scan();
  if (process.argv.includes("--once")) return;
  setInterval(() => scan().catch((error) => console.error(error.stack || error.message)), pollSeconds * 1000);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
