const madridFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function partsFor(date) {
  return Object.fromEntries(
    madridFormatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

export function madridToday(now = new Date()) {
  const parts = partsFor(now);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

// Converts a timetable value expressed in Europe/Madrid into an absolute instant.
export function madridDateTimeEpoch(serviceDate, departureTime) {
  const [year, month, day] = serviceDate.split("-").map(Number);
  const [hour, minute] = departureTime.split(":").map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let epoch = wanted;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = partsFor(new Date(epoch));
    const rendered = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    epoch += wanted - rendered;
  }
  return epoch;
}

export function shouldCheckDeparture({ dueAt, now = Date.now(), graceMinutes = 5 }) {
  const dueEpoch = typeof dueAt === "number" ? dueAt : new Date(dueAt).getTime();
  return now >= dueEpoch && now <= dueEpoch + graceMinutes * 60_000;
}
