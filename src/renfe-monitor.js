import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "./db.js";

export const RENFE_FEED_URL = "https://tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json";
export const DEFAULT_DELAY_THRESHOLD_MINUTES = 12 * 60;

function asText(value) {
  return value == null ? null : String(value).trim() || null;
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function renfeTrainKey(train) {
  const circulationCode = asText(train.codCirculacion) ?? asText(train.codComercial);
  if (!circulationCode) return null;
  const serviceDate = asText(train.horaSalidaEstAnterior)?.slice(0, 10) ?? "unknown-date";
  const corridor = asText(train.corr) ?? "unknown-corridor";
  return [circulationCode, corridor, serviceDate].join("|");
}

export function formatRenfeAlert(train, delayMinutes) {
  const trainCode = asText(train.codComercial) ?? asText(train.codCirculacion) ?? "sin código";
  const corridor = asText(train.corr);
  const nextStop = asText(train.codEstSig);
  const arrival = asText(train.horaLlegadaSigEst);
  const hours = Math.floor(delayMinutes / 60);
  const minutes = delayMinutes % 60;
  const duration = minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  const progress = [nextStop ? `próxima estación ${nextStop}` : null, arrival ? `llegada estimada ${arrival.replace("T", " ")}` : null]
    .filter(Boolean)
    .join(", ");
  return `🚆 Renfe: el tren ${trainCode}${corridor ? ` (${corridor})` : ""} registra ${duration} de retraso${progress ? `; ${progress}` : ""}.`;
}

export function recordRenfeFeed(db, feed, { now = new Date(), thresholdMinutes = DEFAULT_DELAY_THRESHOLD_MINUTES } = {}) {
  if (!feed || !Array.isArray(feed.trenes)) throw new Error("El feed de Renfe no contiene una lista trenes válida.");
  const seenAt = now.toISOString();
  const upsert = db.prepare(`
    INSERT INTO renfe_trains (
      train_key, commercial_code, circulation_code, corridor_code,
      previous_station_code, next_station_code, previous_station_departure,
      next_station_arrival_estimate, delay_minutes, latitude, longitude,
      feed_updated_at, last_seen_at, raw_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(train_key) DO UPDATE SET
      commercial_code = excluded.commercial_code,
      circulation_code = excluded.circulation_code,
      corridor_code = excluded.corridor_code,
      previous_station_code = excluded.previous_station_code,
      next_station_code = excluded.next_station_code,
      previous_station_departure = excluded.previous_station_departure,
      next_station_arrival_estimate = excluded.next_station_arrival_estimate,
      delay_minutes = excluded.delay_minutes,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      feed_updated_at = excluded.feed_updated_at,
      last_seen_at = excluded.last_seen_at,
      raw_data = excluded.raw_data
  `);
  const addAlert = db.prepare(`
    INSERT OR IGNORE INTO renfe_delay_alerts (
      train_key, detected_at, delay_minutes, commercial_code, circulation_code,
      corridor_code, previous_station_code, next_station_code,
      next_station_arrival_estimate, notification_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let saved = 0;
  let alertsAdded = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const train of feed.trenes) {
      const key = renfeTrainKey(train);
      const delayMinutes = asNumber(train.ultRetraso);
      const circulationCode = asText(train.codCirculacion) ?? asText(train.codComercial);
      if (!key || delayMinutes == null || !circulationCode) continue;

      upsert.run(
        key,
        asText(train.codComercial),
        circulationCode,
        asText(train.corr),
        asText(train.codEstAnt),
        asText(train.codEstSig),
        asText(train.horaSalidaEstAnterior),
        asText(train.horaLlegadaSigEst),
        Math.trunc(delayMinutes),
        asNumber(train.latitud),
        asNumber(train.longitud),
        asText(feed.fechaActualizacion),
        seenAt,
        JSON.stringify(train),
      );
      saved += 1;

      if (delayMinutes > thresholdMinutes) {
        const result = addAlert.run(
          key,
          seenAt,
          Math.trunc(delayMinutes),
          asText(train.codComercial),
          circulationCode,
          asText(train.corr),
          asText(train.codEstAnt),
          asText(train.codEstSig),
          asText(train.horaLlegadaSigEst),
          formatRenfeAlert(train, Math.trunc(delayMinutes)),
        );
        alertsAdded += Number(result.changes);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { feedUpdatedAt: asText(feed.fechaActualizacion), trainsSaved: saved, alertsAdded };
}

export async function collectRenfeFeed({ url = RENFE_FEED_URL, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "bus-occupancy-monitor/0.1" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`El feed de Renfe respondió HTTP ${response.status}.`);
  const feed = await response.json();
  if (!feed || !Array.isArray(feed.trenes)) throw new Error("El feed de Renfe devolvió un formato no reconocido.");
  return feed;
}

async function main() {
  const pollSeconds = Number(process.env.RENFE_POLL_SECONDS ?? 60);
  const thresholdMinutes = Number(process.env.RENFE_DELAY_THRESHOLD_MINUTES ?? DEFAULT_DELAY_THRESHOLD_MINUTES);
  if (!Number.isFinite(pollSeconds) || pollSeconds < 10 || !Number.isFinite(thresholdMinutes) || thresholdMinutes < 1) {
    throw new Error("RENFE_POLL_SECONDS debe ser >= 10 y RENFE_DELAY_THRESHOLD_MINUTES debe ser >= 1.");
  }
  const db = openDatabase(resolve(process.env.BUS_DATA_DIR ?? "data", "bus_occupancy.sqlite"));

  const poll = async () => {
    try {
      const feed = await collectRenfeFeed();
      const result = recordRenfeFeed(db, feed, { thresholdMinutes });
      console.log(JSON.stringify({ observedAt: new Date().toISOString(), ...result }));
    } catch (error) {
      console.error(JSON.stringify({ observedAt: new Date().toISOString(), error: error.message }));
    }
  };

  await poll();
  while (true) {
    await delay(pollSeconds * 1000);
    await poll();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
