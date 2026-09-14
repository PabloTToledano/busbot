import { createServer } from "node:http";
import { resolve } from "node:path";

import { openDatabase } from "./db.js";
import { madridDateTimeEpoch, madridToday } from "./time.js";

const port = Number(process.env.DASHBOARD_PORT ?? 8787);
const db = openDatabase(resolve(process.env.BUS_DATA_DIR ?? "data", "bus_occupancy.sqlite"));

function rowsForDashboard() {
  const date = madridToday();
  const services = db.prepare(`
    SELECT o.operator, o.origin, o.destination, o.service_date, o.departure_time,
      o.status, o.total_seats, o.free_seats, o.occupied_seats,
      o.ticket_price_cents, o.ticket_currency, o.price_reference_date,
      o.observed_at, d.checked_at, d.outcome
    FROM observations o
    LEFT JOIN departure_checks d ON d.service_key = o.service_key
    WHERE o.service_date >= ? AND o.is_night_service = 1
    ORDER BY o.service_date, o.departure_time
  `).all(date).map((row) => ({
    ...row,
    dueAt: row.departure_time
      ? new Date(madridDateTimeEpoch(row.service_date, row.departure_time) - 10 * 60_000).toISOString()
      : null,
  }));
  const routeCount = db.prepare("SELECT count(*) AS count FROM routes").get().count;
  const plannedRoutes = db.prepare(`
    SELECT operator, origin, destination
    FROM routes
    ORDER BY operator, origin, destination
  `).all();
  const byStatus = db.prepare("SELECT status, count(*) AS count FROM observations WHERE service_date = ? GROUP BY status").all(date);
  return { date, routeCount, plannedRoutes, byStatus, services, generatedAt: new Date().toISOString() };
}

const page = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bus monitor</title>
<style>
  :root { color-scheme: dark; --bg:#09121f; --panel:#101f32; --line:#25415d; --ink:#e9f2fb; --muted:#9db0c5; --accent:#46d7b0; --warn:#ffc857; --bad:#ff7b7b; }
  * { box-sizing:border-box } body { margin:0; font:15px system-ui,sans-serif; background:var(--bg); color:var(--ink) } main { max-width:1500px; margin:auto; padding:28px }
  header { display:flex; justify-content:space-between; gap:20px; align-items:end } h1 { margin:0; font-size:1.7rem } .muted { color:var(--muted) }
  #stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:22px 0 } .stat,section { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px } .stat b { display:block; font-size:1.55rem; margin-top:4px }
  section { margin-top:16px; overflow:auto } h2 { margin:0 0 12px; font-size:1.05rem } table { width:100%; border-collapse:collapse; white-space:nowrap } th,td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line) } th { color:var(--muted); font-weight:600 } .available { color:var(--accent) } .full_or_unavailable { color:var(--bad) } .schedule_only { color:var(--warn) } .error { color:var(--bad) }
  .controls { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:12px } input,select { background:#0b1726; color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:9px 10px; font:inherit } input { min-width:260px; flex:1 }
  @media(max-width:600px){main{padding:16px} table{font-size:.83rem} header{align-items:start;flex-direction:column}}
</style><main><header><div><h1>Monitor de autobuses</h1><div class="muted" id="updated">Cargando…</div></div><div class="muted">Actualización automática: 30 s</div></header><div id="stats"></div>
<section><h2>Próximas comprobaciones (T−10 min)</h2><table><thead><tr><th>Ruta</th><th>Salida</th><th>Pull previsto</th><th>Estado</th></tr></thead><tbody id="upcoming"></tbody></table></section>
<section><h2>Rutas planificadas para cachear</h2><div class="controls"><input id="route-search" type="search" placeholder="Buscar operador, origen o destino…"><select id="operator-filter"><option value="">Todos los operadores</option></select></div><div class="muted" id="route-total"></div><table><thead><tr><th>Operador</th><th>Origen</th><th>Destino</th></tr></thead><tbody id="planned-routes"></tbody></table></section>
<section><h2>Lecturas de rutas nocturnas</h2><table><thead><tr><th>Operador</th><th>Ruta</th><th>Salida</th><th>Ocupación</th><th>Precio</th><th>Estado</th><th>Última lectura</th></tr></thead><tbody id="services"></tbody></table></section></main>
<script>
const fmt = (date) => date ? new Intl.DateTimeFormat('es-ES',{dateStyle:'short',timeStyle:'short'}).format(new Date(date)) : '—';
const esc = (value) => String(value ?? '—').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function price(row){ return row.ticket_price_cents == null ? '—' : (row.ticket_price_cents/100).toLocaleString('es-ES',{style:'currency',currency:row.ticket_currency||'EUR'}) + (row.price_reference_date ? ' · ref. '+row.price_reference_date : ''); }
function state(row){ return '<span class="'+esc(row.status)+'">'+esc(row.status)+'</span>'; }
let latestData; const routeSearch=document.querySelector('#route-search'), operatorFilter=document.querySelector('#operator-filter');
function renderRoutes(){ if(!latestData) return; const term=routeSearch.value.trim().toLocaleLowerCase('es'); const operator=operatorFilter.value; const routes=latestData.plannedRoutes.filter(r => (!operator || r.operator===operator) && (!term || [r.operator,r.origin,r.destination].join(' ').toLocaleLowerCase('es').includes(term))); document.querySelector('#route-total').textContent=routes.length+' de '+latestData.plannedRoutes.length+' rutas'; document.querySelector('#planned-routes').innerHTML=routes.map(r=>'<tr><td>'+esc(r.operator)+'</td><td>'+esc(r.origin)+'</td><td>'+esc(r.destination)+'</td></tr>').join('')||'<tr><td colspan="3">No hay rutas que coincidan con la búsqueda.</td></tr>'; }
routeSearch.addEventListener('input',renderRoutes); operatorFilter.addEventListener('change',renderRoutes);
async function refresh(){ const data=await fetch('/api/dashboard').then(r=>r.json()); const counts=Object.fromEntries(data.byStatus.map(x=>[x.status,x.count])); document.querySelector('#updated').textContent='Datos del '+data.date+' · generado '+fmt(data.generatedAt);
document.querySelector('#stats').innerHTML=[['Rutas planeadas',data.routeCount],['Expediciones nocturnas',data.services.length],['Con ocupación',counts.available||0],['Llenas',counts.full_or_unavailable||0],['Con precio',data.services.filter(x=>x.ticket_price_cents!=null).length]].map(([k,v])=>'<div class="stat"><span class="muted">'+k+'</span><b>'+v+'</b></div>').join('');
const upcoming=data.services.filter(x=>x.dueAt).sort((a,b)=>a.dueAt.localeCompare(b.dueAt)).slice(0,20); document.querySelector('#upcoming').innerHTML=upcoming.map(x=>'<tr><td>'+esc(x.origin)+' → '+esc(x.destination)+'</td><td>'+esc(x.service_date)+' '+esc(x.departure_time)+'</td><td>'+fmt(x.dueAt)+'</td><td>'+esc(x.checked_at?'comprobada':'pendiente')+'</td></tr>').join('')||'<tr><td colspan="4">Sin salidas planificadas.</td></tr>';
const selected=operatorFilter.value; const operators=[...new Set(data.plannedRoutes.map(r=>r.operator))]; operatorFilter.innerHTML='<option value="">Todos los operadores</option>'+operators.map(x=>'<option>'+esc(x)+'</option>').join(''); operatorFilter.value=operators.includes(selected)?selected:''; latestData=data; renderRoutes();
document.querySelector('#services').innerHTML=data.services.map(x=>'<tr><td>'+esc(x.operator)+'</td><td>'+esc(x.origin)+' → '+esc(x.destination)+'</td><td>'+esc(x.service_date)+' '+esc(x.departure_time)+'</td><td>'+esc(x.free_seats==null?'—':x.free_seats+'/'+x.total_seats+' libres')+'</td><td>'+price(x)+'</td><td>'+state(x)+'</td><td>'+fmt(x.observed_at)+'</td></tr>').join('')||'<tr><td colspan="7">Aún no hay lecturas.</td></tr>'; }
refresh(); setInterval(refresh,30000);
</script>`;

createServer((request, response) => {
  if (request.url === "/api/dashboard") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(rowsForDashboard()));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
}).listen(port, "0.0.0.0", () => console.log(`Dashboard listening on ${port}`));
