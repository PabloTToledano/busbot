import { resolve } from "node:path";
import { collectInterbus } from "./interbus.js";
import { collectAlsaMalagaValencia, collectAlsaRoutes, collectAlsaSchedule } from "./alsa.js";
import { getRoutes, openDatabase, persistObservation } from "./db.js";
import { collectMoveliaRoutes } from "./movelia.js";
import { collectFlixbusRoutes } from "./flixbus.js";
import { collectSocibus } from "./socibus.js";
import { collectAvanza } from "./avanza.js";
import { collectMonbus } from "./monbus.js";
import { collectAutobusing } from "./autobusing.js";

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

function getTodayDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

const date = option("--date") ?? getTodayDate();
const operatorInput = (option("--operator") ?? "all").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const operator = ({
  cevesa: "jiménez dorado/cevesa",
  "jimenez dorado": "jiménez dorado/cevesa",
  "jimenez dorado/cevesa": "jiménez dorado/cevesa",
  "jimenez-dorado": "jiménez dorado/cevesa",
  "jimenez-dorado/cevesa": "jiménez dorado/cevesa",
}[operatorInput] ?? operatorInput);
const limit = option("--limit") ? Number(option("--limit")) : Infinity;
const routeFilter = option("--route")
  ?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() ?? null;

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("Uso: npm run collect -- [--operator interbus|alsa|flixbus|socibus|secorbus|avanza|monbus|vibasa|movelia|busbam|jiménez dorado/cevesa|all|alsa-valencia] [--date AAAA-MM-DD] [--route Origen-Destino] [--limit N] [--headed] [--trace]");
  process.exit(2);
}

const db = openDatabase(resolve(process.env.BUS_DATA_DIR ?? "data", "bus_occupancy.sqlite"));
try {
  const headed = args.includes("--headed");
  const trace = args.includes("--trace");
  const rows = [];

  const filterRoutes = (list) => {
    if (!routeFilter) return list;
    return list.filter((r) => {
      const searchable = (value) => String(value ?? "")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const matchSlug = r.slug && searchable(r.slug).includes(routeFilter);
      const matchPair = searchable(`${r.origin}-${r.destination}`).includes(routeFilter);
      return matchSlug || matchPair;
    });
  };

  if (operator === "alsa-valencia") {
    const alsaRows = await collectAlsaMalagaValencia({ date, headed, trace, limit });
    rows.push(...alsaRows);
  } else {
    if (operator === "interbus" || operator === "all") {
      const interbusRoutes = filterRoutes(getRoutes(db, { operator: "Interbus" }));
      if (interbusRoutes.length > 0) {
        console.log(`[Interbus] Consultando ${interbusRoutes.length} rutas para ${date}...`);
        const res = await collectInterbus({ routes: interbusRoutes, date, headed, trace });
        rows.push(...res);
      }
    }
    if (operator === "alsa" || operator === "all") {
      const alsaRoutes = filterRoutes(getRoutes(db, { operator: "Alsa" }));
      if (alsaRoutes.length > 0) {
        console.log(`[Alsa] Consultando ${alsaRoutes.length} rutas para ${date}...`);
        const res = await collectAlsaRoutes({ routes: alsaRoutes, date, headed, trace, limit });
        rows.push(...res);
      }
    }
    if (operator === "flixbus" || operator === "all") {
      const flixbusRoutes = filterRoutes(getRoutes(db, { operator: "FlixBus" }));
      if (flixbusRoutes.length > 0) {
        console.log(`[FlixBus] Consultando ${flixbusRoutes.length} rutas para ${date}...`);
        rows.push(...await collectFlixbusRoutes({ routes: flixbusRoutes, date, headed, trace, limit }));
      }
    }
    if (operator === "socibus" || operator === "all") {
      const socibusRoutes = filterRoutes(getRoutes(db, { operator: "Socibus" }));
      if (socibusRoutes.length > 0) {
        console.log(`[Socibus] Consultando ${socibusRoutes.length} rutas para ${date}...`);
        rows.push(...await collectSocibus({ routes: socibusRoutes, date, headed, trace }));
      }
    }
    // Secorbus vende esta concesión en la misma pasarela Socibus y expone el
    // mismo mapa de plazas, pero se conserva su operador propio en la base.
    if (operator === "secorbus" || operator === "all") {
      const secorbusRoutes = filterRoutes(getRoutes(db, { operator: "Secorbus" }));
      if (secorbusRoutes.length > 0) {
        console.log(`[Secorbus] Consultando ${secorbusRoutes.length} rutas para ${date}...`);
        rows.push(...await collectSocibus({ routes: secorbusRoutes, operator: "Secorbus", date, headed, trace }));
      }
    }
    if (operator === "avanza" || operator === "all") {
      const avanzaRoutes = filterRoutes(getRoutes(db, { operator: "Avanza" }));
      if (avanzaRoutes.length > 0) {
        console.log(`[Avanza] Consultando ${avanzaRoutes.length} rutas para ${date}...`);
        rows.push(...await collectAvanza({ routes: avanzaRoutes, date, headed, trace, limit }));
      }
    }
    if (["monbus", "vibasa", "all"].includes(operator)) {
      // Vibasa is a Monbus group operator and its tickets are sold by the
      // same official Monbus checkout.  Keeping the database operator as
      // Vibasa preserves the source route while using its real sales channel.
      const monbusRoutes = filterRoutes(getRoutes(db)).filter((route) => {
        const sourceOperators = operator === "all" ? ["monbus", "vibasa"] : [operator];
        return sourceOperators.includes(route.operator.toLowerCase());
      });
      if (monbusRoutes.length > 0) {
        console.log(`[Monbus] Consultando ${monbusRoutes.length} rutas para ${date}...`);
        rows.push(...await collectMonbus({ routes: monbusRoutes, date, limit }));
      }
    }
    if (["jiménez dorado/cevesa", "all"].includes(operator)) {
      const autobusingRoutes = filterRoutes(getRoutes(db, { operator: "Jiménez Dorado/Cevesa" }));
      if (autobusingRoutes.length > 0) {
        console.log(`[Autobusing] Consultando ${autobusingRoutes.length} rutas para ${date}...`);
        rows.push(...await collectAutobusing({ routes: autobusingRoutes, date, headed, limit }));
      }
    }
    if (operator === "all" || getRoutes(db).some((r) => r.operator.toLowerCase() === operator)) {
      const moveliaRoutes = filterRoutes(getRoutes(db)).filter((r) => !["alsa", "interbus", "flixbus", "socibus", "secorbus", "avanza", "monbus", "vibasa", "jiménez dorado/cevesa"].includes(r.operator.toLowerCase()));
      const selected = operator === "all" ? moveliaRoutes : moveliaRoutes.filter((r) => r.operator.toLowerCase() === operator);
      if (selected.length > 0) {
        console.log(`[Movelia] Consultando ${selected.length} rutas para ${date}...`);
        rows.push(...await collectMoveliaRoutes({ routes: selected, date, headed, trace, limit }));
      }
    }
  }

  const ids = rows.map((row) => persistObservation(db, row));
  console.log(JSON.stringify({
    date,
    operator,
    stored: ids.length,
    observationIds: ids,
    routesProcessed: [...new Set(rows.map((r) => `${r.operator} ${r.origin} -> ${r.destination}`))],
    rows,
  }, null, 2));
} finally {
  db.close();
}
