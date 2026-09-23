# Monitor de ocupación de autobuses

Recolector local y de sólo lectura de rutas nocturnas. Entra en el flujo público de compra de cada operador y sólo guarda ocupación cuando puede contar el plano de asientos seleccionable. Los resultados se guardan en SQLite.

## Instalación

```powershell
cd C:\Users\pablo\Desktop\Projects\bus-bot
npm install
npx playwright install chromium
```

Requiere Node.js 22 o posterior y conexión a Internet.

## Consultas

```powershell
# Todas las rutas configuradas, para hoy
npm run collect

# Un operador y una fecha concreta
npm run collect -- --operator avanza --date 2026-09-14

# Una ruta concreta; se admiten nombres sin tildes
npm run collect -- --operator alsa --route malaga-valencia --date 2026-09-14

# Alias comercial de Jiménez Dorado/Cevesa
npm run collect -- --operator cevesa --date 2026-09-14
```

Los operadores configurados son Alsa, Avanza, Busbam, Interbus, Monbus, Movelia/Moventis, Socibus, Secorbus, Vibasa y Jiménez Dorado/Cevesa. `--operator all` es el valor predeterminado.

La salida JSON muestra únicamente las expediciones que cruzan la franja 22:00–06:00. `--headed` abre el navegador para diagnóstico y `--trace` guarda una traza Playwright.

## Comprobación automática a diez minutos de la salida

Primero recoge el catálogo de salidas del día; el monitor usa esas expediciones ya descubiertas. Después déjalo en ejecución:

```powershell
npm run monitor -- --date 2026-09-14
```

Cada 30 segundos localiza las salidas descubiertas entre T−10 y T−5 minutos, vuelve a abrir el checkout oficial y actualiza la misma fila SQLite con las plazas libres y ocupadas. `departure_checks` evita revisar dos veces una salida y recupera un intento interrumpido tras 15 minutos. Si la ocupación verificada supera el 70%, prepara/publica un aviso en X con la ruta, ocupación y precio del billete observado ese día. Para una prueba única:

```powershell
npm run monitor -- --date 2026-09-14 --once
```

Se puede ajustar el intervalo y la tolerancia con `--poll-seconds 30` y `--grace-minutes 5`.

## TrueNAS SCALE (Containers experimental)

Para desplegarlo como contenedor Linux LXC —no como una App ni una imagen Docker— sigue [la guía de despliegue](deploy/truenas/README.md). El estado SQLite se almacena en un dataset montado y el monitor se inicia mediante `systemd`.

## Datos y actualización

La base está en `data/bus_occupancy.sqlite`:

- `routes`: rutas configuradas, sin horarios fijos.
- `observations`: una fila por operador, origen, destino, fecha y hora de salida.
- `observation_stops`: paradas de la observación.
- `renfe_trains`: estado más reciente conocido de los trenes del feed de larga distancia.
- `renfe_arrival_alerts`: llegadas nocturnas previstas y mensajes preparados para publicarlos en X.

El monitor Renfe (`npm run monitor:renfe`) consulta cada 60 segundos el feed oficial [flotaLD.json](https://tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json), actualiza los trenes vistos y registra una sola alerta por tren, estación y fecha cuando `horaLlegadaSigEst` cae después de las 00:00 y antes de las 06:00 (hora local del feed). Conserva la hora prevista, el retraso informado como contexto, los códigos de estación, la evidencia JSON y el borrador preparado para publicar. El JSON sólo trae códigos de estación, no nombres.

Ambos monitores publican mediante la API v2 de X cuando `X_USER_ACCESS_TOKEN` contiene un token de usuario OAuth 2.0 con el permiso `tweet.write`. Sin credencial, dejan los borradores pendientes; el Bearer Token de aplicación no sirve para publicar. No guardes credenciales en el repositorio. Cada aviso se deduplica de forma persistente; un resultado de red incierto no se reintenta automáticamente para evitar duplicados. El intervalo y el final de la franja nocturna pueden cambiarse con `RENFE_POLL_SECONDS` y `RENFE_ARRIVAL_WINDOW_END_HOUR`.

Una nueva ejecución actualiza esa misma fila, incluidas plazas libres, ocupadas, evidencia y paradas. No crea una fila adicional aunque el portal entregue un identificador de servicio sólo en una ejecución posterior.

Cuando el checkout muestra un importe explícito, también se guarda `ticket_price_cents` y `ticket_currency` (la tarifa visible para un adulto, sin estimaciones). Si el portal no muestra precio antes del pago, esos campos quedan vacíos.

Estados:

- `available`: se contó un mapa oficial y `total_seats = free_seats + occupied_seats`.
- `full_or_unavailable`: el portal confirma que no hay plazas o no permite seleccionar esa expedición.
- `schedule_only`: hay horario, pero no hay mapa seleccionable; no se infiere capacidad de textos comerciales ni agregados.
- `error`: fallo técnico transitorio o inesperado del portal.

Algunos operadores pueden impedir el acceso al mapa. En ese caso se guarda `schedule_only` y nunca se inventa ocupación.

Si el DNS local no resuelve el API de Monbus, el colector usa automáticamente DNS-over-HTTPS como respaldo para esa conexión, sin cambiar la configuración de red del equipo.

## Verificación

```powershell
npm test
```

## Límites operativos

No se inicia sesión, no se reservan plazas, no se añaden pasajeros y no se avanza al pago. Revisa las condiciones de uso de cada operador antes de programar ejecuciones periódicas.
