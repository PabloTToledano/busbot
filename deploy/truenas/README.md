# TrueNAS SCALE Containers (LXC experimental)

This is for **Containers > Create New Container**, not Apps and not Docker.

1. Create a dataset such as `tank/apps/bus-bot-data`. Give the account that will run the service read/write access.
2. In **Containers > Configuration > Settings**, select a pool. Then create a container named `bus-bot` from the `images:debian/12` image. Enable Autostart, use the local time zone, and leave it unprivileged.
3. After it exists, open its **File System Devices** card and add the dataset as a mount at `/srv/bus-bot-data`. Do not use a host-path bind mount configured through a shell.
4. Open the container shell from the TrueNAS UI and run the commands below as root. Replace `REPOSITORY_URL` with the Git remote that contains this project:

```sh
apt-get update
apt-get install -y ca-certificates curl git gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y nodejs
useradd --system --create-home --home-dir /opt/bus-bot --shell /usr/sbin/nologin busbot
git clone REPOSITORY_URL /opt/bus-bot
cd /opt/bus-bot
npm ci
npx playwright install-deps chromium
chown -R busbot:busbot /opt/bus-bot /srv/bus-bot-data
runuser -u busbot -- sh -c 'cd /opt/bus-bot && npx playwright install chromium'
install -m 0644 deploy/truenas/bus-occupancy-monitor.service /etc/systemd/system/
install -m 0644 deploy/truenas/bus-occupancy-dashboard.service /etc/systemd/system/
install -m 0644 deploy/truenas/bus-occupancy-collector.service /etc/systemd/system/
install -m 0644 deploy/truenas/bus-occupancy-collector.timer /etc/systemd/system/
install -m 0644 deploy/truenas/renfe-arrival-monitor.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bus-occupancy-monitor bus-occupancy-dashboard bus-occupancy-collector.timer renfe-arrival-monitor
```

To enable X publishing, create `/etc/bus-bot/x.env` outside the repository and set `X_USER_ACCESS_TOKEN` to an OAuth 2.0 **user** access token for the posting account, with the `tweet.write` scope (an app-only Bearer Token cannot publish). Keep that file restricted to administrators; never commit it or paste its contents into chat. Both monitors load this optional systemd environment file. Without it, qualifying messages remain queued and no tweet is sent.

Before the first evening monitor run, collect that day’s timetable once:

```sh
sudo -u busbot BUS_DATA_DIR=/srv/bus-bot-data npm run collect -- --date 2026-09-14
```

Inspect it from the container shell:

```sh
systemctl status bus-occupancy-monitor
journalctl -u bus-occupancy-monitor -f
```

Add a proxy in the container **Proxies** card from host port `8787` to container port `8787`. Then open `http://TRUENAS-IP:8787` to view the dashboard. The daily collector builds the timetable catalogue, while `bus-occupancy-monitor` polls it every 30 seconds and refreshes a service exactly ten minutes before departure.

The monitor deliberately excludes FlixBus. It never exposes a port, and no privileged mode, Docker nesting, or host networking is needed.

`renfe-arrival-monitor` independently reads the official Renfe long-distance fleet JSON every 60 seconds. Each next-station arrival after 00:00 and before 06:00 local feed time creates one durable `renfe_arrival_alerts` row per train, station, and date, with a Spanish post draft. Both monitors use the deduplicated `x_post_outbox`; Renfe alert status is updated after the X API responds. The dashboard shows train arrival drafts and the posting history.

The bus monitor checks each discovered departure around T−10 minutes (within its configured grace window), not only night services. After a fresh seat-map pull, it queues one post for that departure only when verified occupancy is over 70%. The post includes the route, occupancy and the ticket fare observed that day; if the operator does not expose a fare, it explicitly says the price was unavailable. X posts are stored under a unique event key so subsequent scans do not repeat them. A post with an uncertain API/network outcome is not automatically retried, to avoid accidental duplicates; review it manually first.
