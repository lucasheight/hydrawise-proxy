# hydrawise-proxy

A small HTTP proxy in front of the Hydrawise v1 API, so an iOS Shortcut can
start or stop a full irrigation cycle with one tap.

The use case it was built for is **stopping a cycle when it starts raining**.
The sprinklers are running, or about to, the weather has changed, and you want
them off *now* — not after unlocking your phone, finding the app, waiting for it
to load, and navigating to the right screen. One tap instead.

Stop suspends until midnight rather than just cancelling the current run, so
that tap also skips the rest of the day's schedule and everything resumes on
its own the next morning.

The reverse is handy too: it is unusually dry, and you want an extra cycle on a
weekend without going through the same rigmarole.

Node standard library only, apart from an MQTT client that is loaded solely if
you turn [MQTT](#mqtt) on. Leave it off and nothing but stdlib runs.

## Do you even need this?

Maybe not, and it is worth two minutes of your time to decide before setting up
a server.

The Hydrawise API is a plain GET with the key in the query string, so an iOS
Shortcut can call it directly with no proxy at all:

```
https://api.hydrawise.com/api/v1/setzone.php?api_key=YOUR-KEY&action=suspendall
```

That is genuinely simpler — nothing to host, nothing to maintain, nothing to
update. **And it works from anywhere**, on cellular or someone else's Wi-Fi,
which this proxy does not: it is LAN-only by design, so the rain-stop only works
while you are home.

If you are one person with one phone, stop reading and go build that shortcut.

### What the proxy is actually for

**Your API key never reaches the phone.** In a direct shortcut the key sits in
an iCloud-synced item, readable by anyone who picks up an unlocked device. More
importantly, it means **you cannot share the shortcut**. Sending a working
direct shortcut to a neighbour hands them a credential that controls your
irrigation. A shortcut pointed at this proxy contains nothing but a LAN address,
so it is safe to pass around — everyone runs their own proxy with their own key.

**Configuration lives in one place.** Run durations and the awkward
`period_id`/`custom` parameters sit on the server, not duplicated across every
shortcut on every phone. Changing the watering time is one edit. Rotating the
key is one edit, and every client keeps working rather than needing to be
tracked down.

**Several clients can share it.** Family phones, Home Assistant, a `curl` in
cron — all hitting the same endpoints, none of them holding a credential.

**There is somewhere to put logic.** Check a rain sensor before starting, refuse
to run twice in an hour, log what ran and when. None of that fits in a URL.

So: one person, one phone, wants it working away from home → call the API
directly. More than one person or device, or you would rather the key stayed off
phones → this is what the proxy is for.

## You will need

- A Hunter Hydrawise controller on your account, and an API key ([where to find
  it](#getting-an-api-key))
- Somewhere on your home network to run it — a Raspberry Pi, NAS, or any
  always-on box with Docker
- An iPhone, if you want the shortcut. The endpoints are ordinary HTTP, so
  anything that can make a request works: Android, Home Assistant, `curl`, cron

**Before you deploy this, read [Security](#security).** It has no authentication
of its own by design, which is fine on a home LAN and not fine anywhere else.

## Endpoints

| Method | Path | Does |
| --- | --- | --- |
| `POST` | `/stop` | `suspendall` — stops everything now, and suspends until midnight |
| `POST` | `/start` | `runall` — every zone for `RUN_SECONDS`, run back to back |
| `GET` | `/status` | Returns the raw `statusschedule.php` payload — zones, run times, next scheduled run |

`POST /start?seconds=N` overrides the duration for that call, which is the easy
way to test without waiting out a full cycle.

Failures return JSON, never a hang: `400` for a bad `seconds`, `404` for an
unknown path, `502` when Hydrawise itself errors or times out (10s).

### /status is cached

Poll `/status` as often as you like. It is served from memory and only refreshed
once the payload's own `nextpoll` interval has elapsed — 60 seconds on the
accounts seen so far. A dashboard refreshing every 2 seconds therefore costs one
upstream call a minute, not thirty.

This matters because Hunter publishes no concrete rate limit. The
[support page](https://www.hunterirrigation.com/en-metric/support/hydrawise-rate-limiting-too-many-requests)
and the API PDF only say to respect `nextpoll`, and Home Assistant's own
integration has tripped HTTP 429 repeatedly over it. Without caching, it is easy
to rate-limit your own account with a keen dashboard.

The response body is passed through byte for byte, exactly as Hydrawise returned
it. Cache state goes in headers instead:

| Header | Meaning |
| --- | --- |
| `X-Cache: HIT` | Served from memory |
| `X-Cache: MISS` | Refreshed from Hydrawise on this request |
| `X-Cache: STALE` | Refresh failed; this is the last good copy |
| `Age` | Seconds since that copy was fetched |

Three behaviours worth knowing:

- **`/start` and `/stop` clear the cache**, so the next `/status` reflects what
  you just did rather than showing a stale "running" for up to a minute after
  you stopped the sprinklers.
- **A failed refresh serves the last good payload** with `X-Cache: STALE` rather
  than a 502, so a dashboard does not go blank over one timed-out call. With no
  cached copy to fall back on, it is still a 502. `/start` and `/stop` always
  fail loudly — they are actions, not state.
- **An idle proxy makes no upstream calls at all.** Refresh happens on request,
  not on a timer, so it can sit untouched for weeks between rain events. Turning
  [MQTT](#mqtt) on changes this — push means polling regardless of traffic.

`GET /status?fresh=1` bypasses the cache when you genuinely need current data —
useful right after triggering a run to see what got queued.

## Configuration

All via environment. `API_KEY` is required and the server exits if it is missing.

| Variable | Default | Meaning |
| --- | --- | --- |
| `API_KEY` | *(required)* | Hydrawise API key |
| `RUN_SECONDS` | *(unset)* | Seconds **per zone** for `/start`. Unset sends a bare `runall` |
| `RUN_PERIOD_ID` | `999` | Sent as `period_id` alongside `custom` |
| `PORT` | `8123` | Listen port |
| `HOST` | `127.0.0.1` | Listen address. The Docker image sets `0.0.0.0` |
| `BIND_ADDR` | `0.0.0.0` | *(compose only)* Host interface the port publishes on |
| `MQTT_URL` | *(unset)* | Broker URL. Unset disables [MQTT](#mqtt) entirely |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | *(unset)* | Broker credentials, if required |
| `MQTT_PREFIX` | `hydrawise` | Topic root |
| `MQTT_DISCOVERY` | `1` | Home Assistant discovery; `0` to disable |
| `MQTT_DISCOVERY_PREFIX` | `homeassistant` | Discovery topic root |

Copy `.env.example` to `.env` and fill in `API_KEY`. `.env` is gitignored; keep
the key out of source.

### Getting an API key

Sign in to the Hydrawise web app at <https://app.hydrawise.com> with the same
account the controller is registered to, then find the API key under your
account settings — it has lived under *Account Details* / *My Account*, though
Hunter has moved it around between UI revisions, so look for "API key" or
"Generate API Key" if that path does not match what you see. The mobile app
does not expose it; use the web app.

The key is account-wide, not per-controller, and looks like `XXXX-XXXX-XXXX-XXXX`.
Treat it as a password: anyone holding it can run your irrigation. It can be
regenerated from the same screen, which immediately invalidates the old one —
worth doing if it ever lands somewhere it should not, and the reason it is read
from the environment rather than written into `server.js`.

Hydrawise rate-limits the API per key. The `/status` response includes a
`nextpoll` field — 60 seconds, in the payloads seen so far — which is the
interval it expects you to respect. Nothing here polls on a timer, but do not
add one that ignores it. It is also why the container health check pings the
proxy itself rather than calling `/status` every 30 seconds.

## Running

Quickest way to try it, no Docker:

```bash
API_KEY='<your-key>' RUN_SECONDS=1800 npm start
curl localhost:8123/status
```

Note that this binds to `127.0.0.1` by default, so your phone cannot reach it
yet. That is deliberate — see [Security](#security).

For anything permanent, use Docker Compose. A prebuilt multi-arch image is
published to GHCR, so there is nothing to build:

```bash
curl -O https://raw.githubusercontent.com/lucasheight/hydrawise-proxy/main/compose.yaml
curl -o .env https://raw.githubusercontent.com/lucasheight/hydrawise-proxy/main/.env.example
# put your API key in .env
docker compose up -d
docker compose logs -f
```

The image covers `linux/amd64` and `linux/arm64`, so the same command works on
a Raspberry Pi or an x86_64 box. Compose publishes the port on `0.0.0.0`, which
is what lets the phone reach it.

To build from source instead — worth doing if you would rather not run someone
else's image on your network:

```bash
git clone https://github.com/lucasheight/hydrawise-proxy
cd hydrawise-proxy
cp .env.example .env    # add your API key
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

## Publishing

Pushing a tag builds and publishes a multi-arch image to GHCR automatically via
[`.github/workflows/publish.yml`](.github/workflows/publish.yml):

```bash
npm version patch     # or minor / major — commits and tags
git push --follow-tags
```

Pushes to `main` refresh `:latest`; tags additionally publish `:1.2.3` and
`:1.2`. Nothing needs to be built or pushed from your laptop.

### Running your own image instead

If you would rather not pull from GHCR, build locally with the
`compose.build.yaml` overlay shown above, or point Compose at your own registry
with an override file next to `compose.yaml`:

```yaml
# compose.override.yaml — picked up automatically, and gitignored
services:
  hydrawise-proxy:
    image: registry.example.com/hydrawise-proxy:latest
```

## iOS Shortcut

Build the **Stop** one first — it is the one you will want in a hurry, standing
at a window watching rain fall on your running sprinklers.

Three actions, in order:

1. **Get Contents of URL** — URL `http://<server-ip>:8123/stop`, Method `POST`
   (expand the action with the ▸ arrow to reach Method)
2. **Get Dictionary Value** — Get `Value` for key `message` in `Contents of URL`
3. **Show Notification** — body set to the `Dictionary Value` variable

If you have a reverse proxy, use a hostname rather than the IP — see
[adding auth without touching the code](#adding-auth-without-touching-the-code).
A shortcut pointed at a raw IP breaks the day the server's address changes,
which you will discover at the worst possible moment.

Step 3 surfaces Hydrawise's own confirmation, so a tap gives real feedback
rather than failing silently — which matters most when you are trying to stop
something. No JSON parsing step is needed: the proxy sends
`content-type: application/json`, so Shortcuts converts the body to a dictionary
on its own.

Name it **"Stop Irrigation"**, then Share → **Add to Home Screen** so it is one
tap from the lock screen. Siri works with no extra setup, since a shortcut's
name is its phrase: *"Hey Siri, Stop Irrigation"* — useful when your hands are
full or the phone is across the room.

Then duplicate it, change the URL to `/start`, and rename to **"Start
Irrigation"** for the dry-weekend direction.

If you use **Back Tap** (Settings → Accessibility → Touch → Back Tap), map it to
Stop rather than Start. Back Tap misfires on bumps and pockets, and an accidental
stop costs nothing while an accidental start is 30 minutes of watering nobody
asked for.

Two things that bite:

- iOS asks for **Local Network** permission on first run. Deny it and every
  request fails with a vague error. Fix at Settings → Privacy & Security →
  Local Network → Shortcuts.
- These hit a private IP, so they only work on home Wi-Fi. For access from
  anywhere use a VPN such as Tailscale. Do not port-forward `8123` — see below.

## MQTT

Optional, and off unless `MQTT_URL` is set. It connects to a broker **you
already run** — none is bundled, and the only dependency is a client library,
which is not even loaded when MQTT is off.

```bash
MQTT_URL=broker.lan
MQTT_USERNAME=…        # if your broker requires auth
MQTT_PASSWORD=…
```

A bare host is enough — plain MQTT on port 1883 is assumed. Give a scheme only
when you need something else: `mqtts://broker.lan:8883`, `wss://broker.lan/mqtt`.
Credentials embedded in the URL are redacted from the logs.

### Topics

All retained, so a dashboard restarting gets current state immediately.

| Topic | Payload |
| --- | --- |
| `hydrawise/availability` | `online` / `offline` |
| `hydrawise/state` | `{ running, zone, relay_id, seconds_left, zone_type, zone_count, updated }` |
| `hydrawise/zone/<relay_id>/state` | `{ name, running, seconds_left, run_seconds, next_run_in, next_run, type }` |

`availability` is a Last Will, so the broker publishes `offline` even if the
proxy is killed outright — a dashboard shows unavailable rather than a stale
`running: false`.

`seconds_left` is a genuine countdown on the active zone, not a boolean, so a
progress bar is possible. It is populated only while running; the duration of a
zone's next run is `run_seconds` instead. Hydrawise overloads one field for
both, and splitting them here avoids a whole class of subtle dashboard bug.

On a cycle-and-soak program, `zone` changes several times per cycle and a zone
can become active more than once, while `running` stays on throughout — the
controller soaks one zone by running the others. Do not read a change of `zone`,
or a zone finishing, as the cycle being over.

*Untested guess:* a program with only one zone in it has nothing to fill the
soak with, so `running` would presumably drop out mid-cycle and come back. Every
program observed here has been multi-zone, and none has ever paused. Do not
build an automation around this without checking it on your own controller.

### Home Assistant

Discovery is on by default, so entities appear by themselves: a **running**
binary sensor, **active zone** and **time remaining** sensors, and one binary
sensor per zone, all grouped under a single Hydrawise device and tied to the
availability topic. Set `MQTT_DISCOVERY=0` to publish state without creating
entities.

### Polling

With MQTT on, `/status` is polled on a timer at the interval the payload's
`nextpoll` asks for, since push implies watching even when nobody is making an
HTTP request. It goes through the same cache the HTTP endpoints use, so
Hydrawise still sees exactly one caller however many dashboards are watching.

A failed poll backs off — starting at a minute, doubling to a fifteen-minute
ceiling — because polling harder is the wrong answer to a rate limit.

Turning MQTT on therefore ends the "idle proxy makes no upstream calls"
property: it polls continuously, around 1400 calls a day at the default
interval.

`/start` and `/stop` trigger a publish a couple of seconds later rather than
waiting out the interval, so the dashboard catches up with the tap.

### Broker outage

Nothing about MQTT can take the HTTP endpoints down. Connection errors are
logged, the client reconnects on its own, and `/status`, `/start` and `/stop`
keep working throughout — stopping the sprinklers in the rain is the reason
this exists, and it cannot depend on a broker being up.

## Security

Read this bit before deploying, not after.

**There is no request authentication.** Anything that can reach the port can
start or stop your irrigation. There is no password, no token, no allowlist.
Containment is entirely the network binding:

- `BIND_ADDR=0.0.0.0` (compose default) — reachable by anything on your LAN
- `BIND_ADDR=127.0.0.1` — reachable only from the host itself

That is a reasonable trade on a home network, where the realistic worst case is
a housemate or a compromised smart TV wasting some water. It is a bad trade
anywhere the host is reachable from the internet.

So:

- **Do not port-forward `8123`.** An unauthenticated irrigation trigger on the
  public internet will eventually be found and used.
- **Do not run this on a VPS or anything with a public IP** without adding auth
  first.
- For access away from home, use a VPN — [Tailscale](https://tailscale.com) is
  the least painful, and the shortcut then just points at the Tailscale address.

### Adding auth without touching the code

The proxy has no authentication of its own and none is planned as a
requirement, so the practical way to add it is a reverse proxy in front — most
people running this already have one.

With [Nginx Proxy Manager](https://nginxproxymanager.com), point a host at
`http://<server-ip>:8123`, give it a certificate, and attach an **Access List**
with basic auth. Traefik, Caddy and plain nginx all do the equivalent.

Two things fall out of this beyond the auth itself:

- **A hostname instead of an IP.** `https://water.example.lan/stop` keeps
  working when the server's address changes; `http://192.168.1.42:8123/stop`
  silently breaks and you find out during the next downpour.
- **TLS**, so the request is not in the clear on your network.

On the phone, basic auth is one extra row in the shortcut's **Headers**
section:

```
Authorization: Basic <base64 of user:password>
```

Generate it with `printf 'user:password' | base64`. Prefer that over putting
credentials in the URL, which is deprecated and unreliable in Shortcuts.

Keep the proxy itself bound to the LAN even behind a reverse proxy — anything
that can still reach port 8123 directly bypasses whatever the proxy enforces.

Your Hydrawise API key never leaves the server: it lives in `.env` (gitignored)
and is injected as an environment variable. The phone only ever talks to the
proxy.

The container runs as `nobody` with a read-only root filesystem and all Linux
capabilities dropped.

## Hydrawise API notes

Behaviour confirmed against a real controller, since the v1.6 docs are thin:

- `custom` on `runall` is seconds **per zone**, not a total across zones.
- Zones run **sequentially**, never together — the controller queues them, so
  four zones at `RUN_SECONDS=1800` is about two hours end to end.
- `suspendall` needs no additional parameters. The bare action stops whatever is
  running *and* suspends until 00:00 the following day — it does not merely
  cancel the current cycle. So one tap on Stop when it starts raining also
  skips the rest of the day's scheduled runs, and normal watering resumes by
  itself the next morning. Convenient if your programs run after sunrise; worth
  knowing if you water before midnight, since those runs would be skipped too.
- `period_id=999` is what the docs pair with `custom`. Its exact meaning is not
  documented anywhere obvious — it is exposed as `RUN_PERIOD_ID` in case a
  different value turns out to matter.

### Reading zone state from /status

`run` and `time` mean different things depending on what a zone is doing, which
is the part that catches people out:

| State | `time` | `timestr` | `run` |
| --- | --- | --- | --- |
| Running now | `1` | `"Now"` | **seconds remaining** |
| Queued | seconds until start | clock time | full duration of the upcoming run |
| Idle | seconds to next scheduled run | day name | duration of the next run |

**Ignore `type` when deciding whether a zone is running.** It reflects *how* the
run was triggered, not its state: a manual `runall` reports `106` for both the
running and the queued zones, while a scheduled program reports `9` throughout —
the same value an idle zone reports. The running zone is the one that has
counted down to `time <= 1`:

```js
const active = relays.find(r => r.time <= 1);
// active ? { zone: active.name, secondsLeft: active.run } : null
```

Zones run back to back, so a running zone's `time + run` equals the next zone's
`time`, and queued zones chain the same way. That is a handy way to confirm what
a `/start` actually queued — and it is how the table above was verified.

Two things a program can do that the payload gives no direct sign of:

- **Seasonal adjustment** scales run times through the year, so `run` is the
  duration of that particular run, not a fixed program setting. It drifts over
  the season.
- **Cycle-and-soak** splits a zone's watering into shorter bursts so water soaks
  in rather than running off — used on sloping ground. The controller fills the
  soak by running the *other* zones in between, so the chain above still holds
  and something is watering throughout; the cycle simply revisits a zone.

The catch with cycle-and-soak is that each `relay_id` appears exactly **once** in
`relays[]`, advertising only its next burst — and a *running* zone advertises
none, since its fields describe the burst in progress. So the list understates
what is still to come: summing `run` across zones is not the length of the
cycle, and a zone's `run` is one burst rather than its total for the day.

There is **no `running` array** in the payload, despite some third-party
integrations assuming one.

Captured payloads are in [`samples/`](samples/), along with the working: a
manual `runall` polled through a full cycle, and a scheduled program mid-run.

### How cycle-and-soak turns into a run order

The app asks for two numbers per zone — a **maximum run time** and a **soak
time** — and then says nothing about what the controller does with them. What
the payloads show:

- **The soak time is a minimum, not a wait.** The controller does not pause for
  it. It moves to the next zone and comes back once the soak has elapsed, so
  the real gap is however long the other zones take. In `status-scheduled.json`
  a zone with a 5-minute soak actually rests 32 minutes, because zones 2, 3 and
  4 run in between.
- **Water is on continuously.** Soaking one zone is paid for by watering
  another, so the cycle has no idle stretches — the queue simply revisits a
  zone. Nothing in `/status` marks a revisit as different from a first run.
- **A zone's total is split into bursts no longer than the maximum.** One zone
  watering 17 minutes with a 10-minute cap ran 9 minutes, then 8 minutes later
  in the cycle. Note it did *not* run the cap first and the remainder second.
  The exact split rule is not clear from one cycle.

So a cycle is not "zone 1, 2, 3, 4, done". It is a queue of *bursts*, ordered so
that no zone is revisited before its soak has passed, and only the next burst
per zone is visible at any moment.

**Unverified, but implied by the above:** a program watering a single zone has
no other zone to fill the soak with, so the gap would have to become real dead
time — no zone at `time <= 1`, and `running` false partway through a cycle that
has not finished. Nobody here has tested it; every program observed has been
multi-zone, and none has ever paused. If it holds, it would apply to any program
with one zone in it, not only to single-zone controllers.

One thing worth checking against your own settings: burst lengths should never
exceed that zone's maximum, and a zone exceeding it is a sign the setting is per
zone rather than per program, or that the zone is not soaking at all. In the
sample, three zones stay at or under the 10-minute cap while `Back Garden` runs
13 minutes in one go.

## Troubleshooting

**`exec /usr/bin/node: exec format error`** — architecture mismatch: the image
was built for a different CPU than the host, typically on an Apple Silicon Mac
for an x86_64 server. The published image is multi-arch so this should not
happen when pulling; if you built locally, run `docker compose pull` to replace
it with the published one.

**Can't reach it over the LAN** — check `docker port hydrawise-proxy` shows
`0.0.0.0:8123` rather than `127.0.0.1:8123`, then check the host firewall.

**Empty notification from the Shortcut** — the request failed. Errors come back
as `{"error": …}` with no `message` key. Add a Quick Look action after step 1 to
see the raw response.

**`API key not valid`** — the proxy reached Hydrawise but the key was rejected.
Check for a stray space or newline in `.env`, and that the key belongs to the
account the controller is registered to.

## Contributing

Issues and pull requests welcome. This scratches one specific itch and is
deliberately small; the most useful contributions are corrections to the
Hydrawise API notes above, since that behaviour was derived by observation
rather than from documentation and may differ across controller models.

## License

ISC — see [LICENSE](LICENSE).

Not affiliated with Hunter Industries or Hydrawise. Watering your garden is
your own responsibility; check that a cycle finished rather than assuming.
