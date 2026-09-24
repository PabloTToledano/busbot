const POST_ENDPOINT = "https://api.x.com/2/tweets";
const MAX_POST_WEIGHT = 260;

function compactMessage(post) {
  const bus = post.message.match(/^🚌 ¿Esta ruta merece un tren\? (.+?) → (.+?), salida (\S+)\. Ocupación: (.+?)%\. Billete: (.+?)\.$/);
  if (post.event_type === "bus_departure" && bus) {
    return `🚌 ${bus[1]}→${bus[2]} ${bus[3]} · ${bus[4]}% ocup. · ${bus[5]}`;
  }
  const renfe = post.message.match(/^🚆 Renfe: el tren (.+?)(?: \((.+?)\))? tiene prevista su llegada a la estación (.+?) el (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::\d{2})?, después de medianoche\.$/);
  if (post.event_type === "renfe_arrival" && renfe) {
    return `🚆 ${renfe[1]}${renfe[2] ? `/${renfe[2]}` : ""}→${renfe[3]} ${renfe[4]} ${renfe[5]}`;
  }
  return post.message.replace(/\s+/g, " ").trim();
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
  token = process.env.X_USER_ACCESS_TOKEN,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  if (!token) return { skipped: "X_USER_ACCESS_TOKEN is not configured", sent: 0, failed: 0 };

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

  for (const bundle of packPosts(pending)) {
    const claimedAt = now().toISOString();
    const claimedPosts = bundle.posts.filter((post) => claim.run(claimedAt, post.id).changes === 1);
    if (!claimedPosts.length) continue;
    const claimedKeys = new Set(claimedPosts.map((post) => post.id));
    const message = packPosts(claimedPosts).map((part) => part.message).join("\n");
    try {
      const response = await fetchImpl(POST_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: message }),
        signal: AbortSignal.timeout(15_000),
      });
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
