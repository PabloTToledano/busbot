import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import { formatBusDemandMessage, occupancyPercent, publishPendingXPosts, queueXPost } from "../src/x-publisher.js";

async function withDb(run) {
  const directory = mkdtempSync(join(tmpdir(), "bus-x-posts-"));
  const db = openDatabase(join(directory, "monitor.sqlite"));
  try { return await run(db); }
  finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
}

test("bus post includes route, verified occupancy percentage, and fare", () => {
  assert.match(formatBusDemandMessage(
    { origin: "Salamanca", destination: "Madrid", departure_time: "23:15" },
    { occupiedPercent: 72, ticketPriceCents: 1599, ticketCurrency: "EUR" },
  ), /Salamanca → Madrid.*72%.*15,99/);
});

test("occupancy threshold is strictly greater than 70 percent", () => {
  assert.equal(occupancyPercent(7, 10), 70);
  assert.ok(occupancyPercent(71, 100) > 70);
  assert.equal(occupancyPercent(1, 0), null);
});

test("outbox deduplicates by event key and publishes once", async () => withDb(async (db) => {
  const post = { eventType: "bus_departure", eventKey: "alsa|salamanca|madrid|2026-10-01|23:15", message: "Prueba de contenido" };
  assert.equal(queueXPost(db, post), true);
  assert.equal(queueXPost(db, post), false);
  let requests = 0;
  const result = await publishPendingXPosts(db, {
    token: "test-user-token",
    now: () => new Date("2026-09-24T12:00:00.000Z"),
    fetchImpl: async (_url, options) => {
      requests += 1;
      assert.equal(options.method, "POST");
      assert.equal(options.headers.authorization, "Bearer test-user-token");
      assert.deepEqual(JSON.parse(options.body), { text: post.message });
      return { ok: true, status: 201, json: async () => ({ data: { id: "tweet-123" } }) };
    },
  });
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal(requests, 1);
  assert.deepEqual({ ...db.prepare("SELECT status, post_id FROM x_post_outbox").get() }, { status: "sent", post_id: "tweet-123" });
  assert.deepEqual(await publishPendingXPosts(db, { token: "test-user-token", fetchImpl: async () => { throw new Error("must not resend"); } }), { sent: 0, failed: 0 });
}));

test("packs pending bus and Renfe alerts into as few posts as possible", async () => withDb(async (db) => {
  queueXPost(db, {
    eventType: "bus_departure",
    eventKey: "bus-1",
    message: "🚌 ¿Esta ruta merece un tren? Salamanca → Madrid, salida 23:15. Ocupación: 82%. Billete: 15,99 €.",
  });
  queueXPost(db, {
    eventType: "renfe_arrival",
    eventKey: "train-1",
    message: "🚆 Renfe: el tren 04125 (1526) tiene prevista su llegada a la estación 23002 el 2026-09-24 05:26:10, después de medianoche.",
  });
  queueXPost(db, {
    eventType: "renfe_arrival",
    eventKey: "train-2",
    message: "🚆 Renfe: el tren 04126 (1527) tiene prevista su llegada a la estación 23004 el 2026-09-24 05:42:00, después de medianoche.",
  });
  const bodies = [];
  const result = await publishPendingXPosts(db, {
    token: "test-user-token",
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body).text);
      return { ok: true, status: 201, json: async () => ({ data: { id: "one-bundled-post" } }) };
    },
  });
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /Salamanca→Madrid 23:15 · 82% ocup\. · 15,99 €/);
  assert.match(bodies[0], /04125\/1526→23002 05:26 24\/09/);
  assert.match(bodies[0], /04126\/1527→23004 05:42 24\/09/);
  assert.equal(db.prepare("SELECT count(DISTINCT post_id) AS count FROM x_post_outbox WHERE status = 'sent'").get().count, 1);
}));

test("refreshes an expired OAuth token before posting", async () => withDb(async (db) => {
  queueXPost(db, { eventType: "renfe_arrival", eventKey: "train-refresh", message: "🚆 04125→23002 2026-09-24 05:26" });
  const requests = [];
  const result = await publishPendingXPosts(db, {
    token: "expired-access-token",
    refreshToken: "old-refresh-token",
    clientId: "public-client-id",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/oauth2/token")) {
        assert.equal(String(options.body), "grant_type=refresh_token&refresh_token=old-refresh-token&client_id=public-client-id");
        return { ok: true, status: 200, json: async () => ({ access_token: "fresh-access-token", refresh_token: "rotated-refresh-token", expires_in: 7200 }) };
      }
      assert.equal(options.headers.authorization, "Bearer fresh-access-token");
      return { ok: true, status: 201, json: async () => ({ data: { id: "tweet-refreshed" } }) };
    },
  });
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal(requests.length, 2);
}));

test("leaves queued drafts untouched when the posting token is absent", async () => withDb(async (db) => {
  queueXPost(db, { eventType: "renfe_arrival", eventKey: "train|date|station", message: "Llegada" });
  assert.deepEqual(await publishPendingXPosts(db, { token: "" }), { skipped: "X_USER_ACCESS_TOKEN is not configured", sent: 0, failed: 0 });
  assert.equal(db.prepare("SELECT status FROM x_post_outbox").get().status, "pending");
}));
