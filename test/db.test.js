import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, persistObservation } from "../src/db.js";
import { crossesNight } from "../src/alsa.js";
import { currentDateFlixbusText, parseFlixbusTrips } from "../src/flixbus.js";
import { madridDateTimeEpoch, shouldCheckDeparture } from "../src/time.js";
import { ticketPriceFromText } from "../src/price.js";

test("clasifica como nocturno cualquier recorrido que cruce la franja nocturna", () => {
  assert.equal(crossesNight("21:30", "12:30"), true);
  assert.equal(crossesNight("08:00", "19:15"), false);
});

test("extrae expediciones concretas del buscador de FlixBus", () => {
  const trips = parseFlixbusTrips("Hora de salida: 23:55 Duración: 6:40 h Hora de llegada: 05:35 +1 día Autobús Directo");
  assert.deepEqual(trips, [{ departureTime: "23:55", arrivalTime: "05:35", duration: 400, occupancyHint: null }]);
});

test("FlixBus no atribuye al día consultado los viajes de madrugada del siguiente", () => {
  const text = "Hora de salida: 23:55 Duración: 7:50 h Hora de llegada: 06:45 +1 día Viajes después de la medianoche Hora de salida: 00:55 Duración: 7:50 h Hora de llegada: 07:45";
  assert.deepEqual(parseFlixbusTrips(currentDateFlixbusText(text)), [
    { departureTime: "23:55", arrivalTime: "06:45", duration: 470, occupancyHint: null },
  ]);
});

test("a departure becomes due ten minutes before its Madrid timetable time", () => {
  const due = madridDateTimeEpoch("2026-09-14", "22:05") - 10 * 60_000;
  assert.equal(shouldCheckDeparture({ dueAt: due, now: due }), true);
  assert.equal(shouldCheckDeparture({ dueAt: due, now: due - 1 }), false);
  assert.equal(shouldCheckDeparture({ dueAt: due, now: due + 6 * 60_000 }), false);
});

test("reads an explicit EUR fare as integer cents", () => {
  assert.deepEqual(ticketPriceFromText("Tarifa básica 19,95 €"), { ticketPriceCents: 1995, ticketCurrency: "EUR" });
  assert.deepEqual(ticketPriceFromText("Sin precio"), {});
});

test("persiste plazas y paradas como una observación atómica", () => {
  const directory = mkdtempSync(join(tmpdir(), "bus-monitor-"));
  const db = openDatabase(join(directory, "monitor.sqlite"));
  try {
    const id = persistObservation(db, {
      observedAt: "2026-09-08T12:00:00.000Z", operator: "Interbus", origin: "Málaga", destination: "Madrid",
      serviceDate: "2026-09-20", departureTime: "23:45", status: "available",
      totalSeats: 55, freeSeats: 12, occupiedSeats: 43, evidence: "selector", stops: ["Málaga", "Madrid"],
    });
    assert.equal(db.prepare("SELECT total_seats, free_seats, occupied_seats FROM observations WHERE id = ?").get(id).total_seats, 55);
    assert.deepEqual(
      db.prepare("SELECT stop_name FROM observation_stops WHERE observation_id = ? ORDER BY position").all(id).map((row) => row.stop_name),
      ["Málaga", "Madrid"],
    );
    const updatedId = persistObservation(db, {
      observedAt: "2026-09-08T12:05:00.000Z", operator: "Interbus", origin: "Málaga", destination: "Madrid",
      serviceDate: "2026-09-20", departureTime: "23:45", status: "available",
      totalSeats: 55, freeSeats: 10, occupiedSeats: 45, evidence: "selector actualizado", stops: ["Málaga", "Antequera", "Madrid"],
    });
    assert.equal(updatedId, id, "la misma expedición se actualiza, no se duplica");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM observations").get().count, 1);
    assert.equal(db.prepare("SELECT occupied_seats FROM observations WHERE id = ?").get(id).occupied_seats, 45);
    assert.deepEqual(
      db.prepare("SELECT stop_name FROM observation_stops WHERE observation_id = ? ORDER BY position").all(id).map((row) => row.stop_name),
      ["Málaga", "Antequera", "Madrid"],
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normaliza la hora al identificar una misma expedición", () => {
  const directory = mkdtempSync(join(tmpdir(), "bus-monitor-time-"));
  const db = openDatabase(join(directory, "monitor.sqlite"));
  try {
    const base = {
      observedAt: "2026-09-08T12:00:00.000Z", operator: "Damas", origin: "Sevilla", destination: "Lebrija",
      serviceDate: "2026-09-20", status: "available", totalSeats: 53, freeSeats: 12, occupiedSeats: 41, stops: [],
    };
    const first = persistObservation(db, { ...base, departureTime: "5:45" });
    const second = persistObservation(db, { ...base, observedAt: "2026-09-08T12:05:00.000Z", departureTime: "05:45", freeSeats: 11, occupiedSeats: 42 });
    assert.equal(second, first);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM observations").get().count, 1);
    assert.equal(db.prepare("SELECT departure_time, free_seats FROM observations WHERE id = ?").get(first).departure_time, "05:45");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("actualiza la expedición si el ID sólo aparece en una lectura posterior", () => {
  const directory = mkdtempSync(join(tmpdir(), "bus-monitor-id-"));
  const db = openDatabase(join(directory, "monitor.sqlite"));
  try {
    const base = {
      observedAt: "2026-09-08T12:00:00.000Z", operator: "Interbus", origin: "Málaga", destination: "Madrid",
      serviceDate: "2026-09-20", departureTime: "23:45", status: "schedule_only", stops: [],
    };
    const first = persistObservation(db, base);
    const second = persistObservation(db, {
      ...base, observedAt: "2026-09-08T12:05:00.000Z", serviceId: "portal-998", status: "available",
      totalSeats: 55, freeSeats: 12, occupiedSeats: 43,
    });
    assert.equal(second, first);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM observations").get().count, 1);
    assert.equal(db.prepare("SELECT service_id FROM observations WHERE id = ?").get(first).service_id, "portal-998");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("crea la tabla routes sin campos de horario y con rutas por defecto", () => {
  const directory = mkdtempSync(join(tmpdir(), "bus-monitor-routes-"));
  const db = openDatabase(join(directory, "monitor.sqlite"));
  try {
    const tableInfo = db.prepare("PRAGMA table_info(routes)").all();
    const columnNames = tableInfo.map((col) => col.name.toLowerCase());

    assert.ok(columnNames.includes("operator"));
    assert.ok(columnNames.includes("origin"));
    assert.ok(columnNames.includes("destination"));

    // El horario puede cambiar así que NO debe estar en la tabla de rutas
    const forbiddenScheduleWords = ["time", "horario", "departure", "arrival", "hora", "schedule"];
    for (const forbidden of forbiddenScheduleWords) {
      assert.ok(
        !columnNames.some((c) => c.includes(forbidden)),
        `La columna no debe contener '${forbidden}', ya que los horarios son variables`,
      );
    }

    const routes = db.prepare("SELECT operator, origin, destination FROM routes").all();
    assert.ok(routes.length > 0, "Debe tener rutas iniciales precargadas");
    assert.ok(routes.some((r) => r.operator === "Interbus" && r.origin === "Málaga" && r.destination === "Madrid"));
    assert.ok(routes.some((r) => r.operator === "Alsa" && r.origin === "Málaga" && r.destination === "Barcelona"));
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
