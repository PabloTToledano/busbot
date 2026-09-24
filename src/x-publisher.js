import { readFileSync, writeFileSync, renameSync } from "node:fs";

const POST_ENDPOINT = "https://api.x.com/2/tweets";
const TOKEN_ENDPOINT = "https://api.x.com/2/oauth2/token";
const MAX_POST_WEIGHT = 260;
let cachedTokenState;

function compactMessage(post) {
  const bus = post.message.match(/^🚌 ¿Esta ruta merece un tren\? (.+?) → (.+?), salida (\S+)\. Ocupación: (.+?)%\. Billete: (.+?)\.$/);
  if (post.event_type === "bus_departure" && bus) {
    return `🚌 ${bus[1]}→${bus[2]} ${bus[3]} · ${bus[4]}% ocup. · ${bus[5]}`;
  }
  const renfe = post.message.match(/^🚆 Renfe: el tren (.+?)(?: \((.+?)\))? tiene prevista su llegada a la estación (.+?) el (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::\d{2})?, después de medianoche\.$/);
  if (post.event_type === "renfe_arrival" && renfe) {
    const [, train, corridor, station, date, time] = renfe;
    const [, month, day] = date.match(/\d{4}-(\d{2})-(\d{2})/);
    return `🚆 ${train}${corridor ? `/${corridor}` : ""}→${station} ${time} ${day}/${month}`;
  }
  return post.message.replace(/\s+/g, " ").trim();
}

function renfeArrivalTime(message) {
  const match = message.match(/\bel (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::\d{2})?\b/);
  return match ? new Date(`${match[1]}T${match[2]}:00`) : null;
}

// Stay below X's post limit with a conservative weight for non-ASCII text.
function postWeight(text) {
  return [...text].reduce((sum, character) => sum + (character.codePointAt(0) > 0x7f ? 2 : 1), 0);
}

function packPosts(posts) {
  const packed = [];
  let current = [];
  let message = "";
  for (const post of posts) {
    let line = compactMessage(post);
    if (postWeight(line) > MAX_POST_WEIGHT) {
      let short = "";
      for (const character of [...line]) {
        if (postWeight(short + character + "…") > MAX_POST_WEIGHT) break;
        short += character;
      }
      line = `${short}…`;
    }
    const next = message ? `${message}\n${line}` : line;
    if (current.length && postWeight(next) > MAX_POST_WEIGHT) {
      packed.push({ posts: current, message });
      current = [];
      message = "";
    }
    current.push(post);
    message = message ? `${message}\n${line}` : line;
  }
  if (current.length) packed.push({ posts: current, message });
  return packed;
}

function tokenStorePath() {
  return process.env.X_TOKEN_STORE_PATH || null;
}

function loadTokenState() {
  if (cachedTokenState) return cachedTokenState;
  const storePath = tokenStorePath();
  if (storePath) {
    try {
      cachedTokenState = JSON.parse(readFileSync(storePath, "utf8"));
      return cachedTokenState;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  cachedTokenState = {
    accessToken: process.env.X_USER_ACCESS_TOKEN || null,
    refreshToken: process.env.X_REFRESH_TOKEN || null,
    expiresAt: process.env.X_REFRESH_TOKEN ? 0 : Number.POSITIVE_INFINITY,
  };
  return cachedTokenState;
}

function saveTokenState(state) {
  const storePath = tokenStorePath();
  if (!storePath) return;
  const temporaryPath = `${storePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, storePath);
}

async function refreshAccessToken(state, { fetchImpl, force = false, clientId = process.env.X_CLIENT_ID, clientSecret = process.env.X_CLIENT_SECRET, cacheState = true } = {}) {
  if (!state.refreshToken || !clientId) {
    if (state.accessToken) return state.accessToken;
    throw new Error("X_USER_ACCESS_TOKEN y X_REFRESH_TOKEN/X_CLIENT_ID no están configurados.");
  }
  if (!force && state.accessToken && state.expiresAt > Date.now() + 5 * 60_000) return state.accessToken;

  const tokenBody = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: state.refreshToken,
  });
  const tokenHeaders = { "content-type": "application/x-www-form-urlencoded" };
  if (clientSecret) {
    tokenHeaders.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  } else {
    tokenBody.set("client_id", clientId);
  }
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: tokenHeaders,
    body: tokenBody,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    throw new Error(`No se pudo renovar la autorización de X (HTTP ${response.status}).`);
  }
  const nextState = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + Number(payload.expires_in || 7200) * 1000,
  };
  Object.assign(state, nextState);
  saveTokenState(state);
  if (cacheState) cachedTokenState = state;
  return nextState.accessToken;
}

export function occupancyPercent(occupiedSeats, totalSeats) {
  if (!Number.isFinite(occupiedSeats) || !Number.isFinite(totalSeats) || totalSeats <= 0 || occupiedSeats < 0) return null;
  return occupiedSeats / totalSeats * 100;
}

export function formatBusDemandMessage(service, { occupiedPercent, ticketPriceCents, ticketCurrency = "EUR" }) {
  const price = ticketPriceCents == null
    ? "no disponible en la consulta"
    : new Intl.NumberFormat("es-ES", { style: "currency", currency: ticketCurrency || "EUR" }).format(ticketPriceCents / 100);
  const percent = Number(occupiedPercent).toLocaleString("es-ES", { maximumFractionDigits: 1 });
  return `🚌 ¿Esta ruta merece un tren? ${service.origin} → ${service.destination}, salida ${service.departure_time}. Ocupación: ${percent}%. Billete: ${price}.`;
}

export function queueXPost(db, { eventType, eventKey, message, now = new Date() }) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO x_post_outbox (event_type, event_key, message, created_at)
    VALUES (?, ?, ?, ?)
  `).run(eventType, eventKey, message, now.toISOString());
  return Number(result.changes) === 1;
}

export async function publishPendingXPosts(db, {
  token,
  refreshToken = process.env.X_REFRESH_TOKEN,
  clientId = process.env.X_CLIENT_ID,
  clientSecret = process.env.X_CLIENT_SECRET,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  const tokenState = { ...loadTokenState() };
  const cacheState = token === undefined && refreshToken === process.env.X_REFRESH_TOKEN;
  if (token !== undefined) tokenState.accessToken = token;
  if (refreshToken) tokenState.refreshToken = refreshToken;
  if (refreshToken && token !== undefined) tokenState.expiresAt = 0;
  const pending = db.prepare(`
    SELECT id, event_type, event_key, message FROM x_post_outbox
    WHERE status = 'pending' ORDER BY id
  `).all();
  const claim = db.prepare(`UPDATE x_post_outbox SET status = 'sending', claimed_at = ? WHERE id = ? AND status = 'pending'`);
  const sent = db.prepare(`UPDATE x_post_outbox SET status = 'sent', sent_at = ?, post_id = ?, error_message = NULL WHERE id = ? AND status = 'sending'`);
  const failed = db.prepare(`UPDATE x_post_outbox SET status = 'failed', error_message = ? WHERE id = ? AND status = 'sending'`);
  const updateRenfe = db.prepare(`
    UPDATE renfe_arrival_alerts SET notification_status = ?, notification_post_id = ?, notification_sent_at = ?
    WHERE alert_key = ?
  `);
  let sentCount = 0;
  let failedCount = 0;

  const currentTime = now();
  const expirePending = db.prepare(`
    UPDATE x_post_outbox SET status = 'failed', error_message = ? WHERE id = ? AND status = 'pending'
  `);
  const publishable = [];
  for (const post of pending) {
    const arrivalTime = post.event_type === "renfe_arrival" ? renfeArrivalTime(post.message) : null;
    if (arrivalTime && arrivalTime <= currentTime) {
      const reason = `Aviso caducado: la llegada prevista (${arrivalTime.toISOString()}) ya pasó.`;
      expirePending.run(reason, post.id);
      updateRenfe.run("failed", null, null, post.event_key);
      failedCount += 1;
    } else {
      publishable.push(post);
    }
  }
  if (!tokenState.accessToken && !tokenState.refreshToken) {
    return { skipped: "X_USER_ACCESS_TOKEN is not configured", sent: sentCount, failed: failedCount };
  }

  for (const bundle of packPosts(publishable)) {
    const claimedAt = now().toISOString();
    const claimedPosts = bundle.posts.filter((post) => claim.run(claimedAt, post.id).changes === 1);
    if (!claimedPosts.length) continue;
    const claimedKeys = new Set(claimedPosts.map((post) => post.id));
    const message = packPosts(claimedPosts).map((part) => part.message).join("\n");
    try {
      let accessToken = await refreshAccessToken(tokenState, { fetchImpl, clientId, clientSecret, cacheState });
      const request = () => fetchImpl(POST_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ text: message }),
        signal: AbortSignal.timeout(15_000),
      });
      let response = await request();
      if (response.status === 401 && tokenState.refreshToken) {
        accessToken = await refreshAccessToken(tokenState, { fetchImpl, force: true, clientId, clientSecret, cacheState });
        response = await request();
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.data?.id) {
        const detail = payload?.detail ?? payload?.title ?? `X API respondió HTTP ${response.status}`;
        for (const post of claimedPosts) {
          failed.run(String(detail).slice(0, 1000), post.id);
          if (post.event_type === "renfe_arrival") updateRenfe.run("failed", null, null, post.event_key);
          failedCount += 1;
        }
        continue;
      }
      const sentAt = now().toISOString();
      for (const post of claimedPosts) {
        if (!claimedKeys.has(post.id)) continue;
        sent.run(sentAt, String(payload.data.id), post.id);
        if (post.event_type === "renfe_arrival") updateRenfe.run("sent", String(payload.data.id), sentAt, post.event_key);
      }
      sentCount += 1;
    } catch (error) {
      // Do not automatically retry uncertain network outcomes: X may have accepted the post before the connection failed.
      for (const post of claimedPosts) {
        failed.run(`Resultado incierto; requiere revisión antes de reintentar: ${error.message}`.slice(0, 1000), post.id);
        if (post.event_type === "renfe_arrival") updateRenfe.run("failed", null, null, post.event_key);
        failedCount += 1;
      }
    }
  }
  return { sent: sentCount, failed: failedCount };
}
