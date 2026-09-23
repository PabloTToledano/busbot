const POST_ENDPOINT = "https://api.x.com/2/tweets";

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

  for (const post of pending) {
    const claimedAt = now().toISOString();
    if (claim.run(claimedAt, post.id).changes !== 1) continue;
    try {
      const response = await fetchImpl(POST_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: post.message }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.data?.id) {
        const detail = payload?.detail ?? payload?.title ?? `X API respondió HTTP ${response.status}`;
        failed.run(String(detail).slice(0, 1000), post.id);
        if (post.event_type === "renfe_arrival") updateRenfe.run("failed", null, null, post.event_key);
        failedCount += 1;
        continue;
      }
      const sentAt = now().toISOString();
      sent.run(sentAt, String(payload.data.id), post.id);
      if (post.event_type === "renfe_arrival") updateRenfe.run("sent", String(payload.data.id), sentAt, post.event_key);
      sentCount += 1;
    } catch (error) {
      // Do not automatically retry uncertain network outcomes: X may have accepted the post before the connection failed.
      failed.run(`Resultado incierto; requiere revisión antes de reintentar: ${error.message}`.slice(0, 1000), post.id);
      if (post.event_type === "renfe_arrival") updateRenfe.run("failed", null, null, post.event_key);
      failedCount += 1;
    }
  }
  return { sent: sentCount, failed: failedCount };
}
