import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dashboardPage } from "../src/dashboard-page.js";
import { openDatabase, persistObservation } from "../src/db.js";
import { madridToday } from "../src/time.js";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("dashboard exposes 14-day history, linked sent tweets and a valid database download", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bus-dashboard-"));
  const databasePath = join(directory, "bus_occupancy.sqlite");
  const db = openDatabase(databasePath);
  const today = madridToday();
  const yesterdayDate = new Date(`${today}T12:00:00.000Z`);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);
  persistObservation(db, {
    observedAt: `${yesterday}T17:00:00.000Z`, operator: "Socibus", origin: "Madrid", destination: "Sevilla",
    serviceDate: yesterday, departureTime: "23:30", status: "available", totalSeats: 50, freeSeats: 5,
    occupiedSeats: 45, ticketPriceCents: 3685, ticketCurrency: "EUR",
  });
  db.prepare(`INSERT INTO x_post_outbox (event_type,event_key,message,status,created_at,sent_at,post_id)
    VALUES ('bus_departure','test-route','Mensaje de prueba','sent',?,?,?)`)
    .run(`${yesterday}T16:50:00.000Z`, `${yesterday}T16:51:00.000Z`, "1234567890123456789");
  db.close();

  const port = await availablePort();
  const child = spawn(process.execPath, ["src/dashboard.js"], {
    cwd: process.cwd(),
    env: { ...process.env, BUS_DATA_DIR: directory, DASHBOARD_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const localCopy = join(tmpdir(), `bus-dashboard-download-${Date.now()}.sqlite`);
  try {
    let apiResponse;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        apiResponse = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
        break;
      } catch {
        if (child.exitCode !== null) throw new Error(stderr || "El dashboard terminó antes de iniciar.");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(apiResponse, stderr || "El dashboard no respondió.");
    const data = await apiResponse.json();
    assert.ok(data.history.some((row) => row.service_date === yesterday && row.operator === "Socibus"));
    assert.equal(data.sentTweets[0].post_id, "1234567890123456789");
    assert.equal(data.sentTweets[0].event_count, 1);

    const htmlResponse = await fetch(`http://127.0.0.1:${port}/`);
    const html = await htmlResponse.text();
    assert.match(html, /Descargar base de datos/);
    assert.match(html, /Tweets enviados/);
    assert.match(html, /occupancy-chart/);
    assert.match(html, /x\.com\/i\/web\/status/);
    assert.doesNotThrow(() => new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]));

    const download = await fetch(`http://127.0.0.1:${port}/api/database.sqlite`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition"), /attachment; filename="bus-occupancy-/);
    writeFileSync(localCopy, Buffer.from(await download.arrayBuffer()));
    const downloadedDb = openDatabase(localCopy);
    try {
      assert.equal(downloadedDb.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(downloadedDb.prepare("SELECT count(*) AS count FROM observations WHERE service_date = ?").get(yesterday).count, 1);
    } finally {
      downloadedDb.close();
    }
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    try { unlinkSync(localCopy); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});
