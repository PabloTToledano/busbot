import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../src/db.js";
import { delayedArrivalAt, isAfterMidnightArrival, recordRenfeFeed } from "../src/renfe-monitor.js";

function withDb(run) {
  const directory = mkdtempSync(join(tmpdir(), "renfe-monitor-"));
  const db = openDatabase(join(directory, "monitor.sqlite"));
  try { return run(db); }
  finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
}

const train = (arrival, delay) => ({
  codCirculacion: "12345", codComercial: "12345", corr: "LD", codEstAnt: "100", codEstSig: "200",
  horaSalidaEstAnterior: "2026-09-24T23:00:00", horaLlegadaSigEst: arrival, ultRetraso: delay,
});

test("suma retraso acumulado a la hora de llegada programada", () => {
  assert.equal(delayedArrivalAt("2026-09-24T23:50:00", 20), "2026-09-25T00:10:00");
  assert.equal(delayedArrivalAt("hora inválida", 20), null);
});

test("alerta solo cuando el retraso desplaza una llegada programada al periodo nocturno", () => withDb((db) => {
  const result = recordRenfeFeed(db, { trenes: [
    train("2026-09-24T23:50:00", 20), // cruzaría medianoche por el retraso
    { ...train("2026-09-24T00:20:00", 10), codCirculacion: "23456" }, // ya era nocturna según horario
    { ...train("2026-09-24T23:50:00", 5), codCirculacion: "34567" }, // no cruza medianoche
  ] }, { now: new Date("2026-09-24T21:00:00.000Z") });

  assert.equal(result.arrivalsQueued, 1);
  const alert = db.prepare("SELECT expected_arrival_at, delay_minutes, notification_text FROM renfe_arrival_alerts").get();
  assert.equal(alert.expected_arrival_at, "2026-09-25T00:10:00");
  assert.match(alert.notification_text, /2026-09-25 00:10/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM x_post_outbox WHERE event_type = 'renfe_arrival'").get().count, 1);
}));

test("no considera las 00:00 exactas como llegada posterior a medianoche", () => {
  assert.equal(isAfterMidnightArrival("2026-09-25T00:00:00"), false);
});
