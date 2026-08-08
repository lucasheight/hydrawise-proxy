# hydrawise-proxy

A small HTTP proxy in front of the Hydrawise v1 API, so an iOS Shortcut can
start or stop a full irrigation cycle with one tap.

The Hydrawise API needs the key in the query string, which makes it awkward to
call directly from a phone. This wraps it: the key lives on the server, and the
phone hits three plain endpoints on the LAN.

Node stdlib only — no dependencies.

## Endpoints

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/status` | Returns the raw `statusschedule.php` payload — zones, run times, next scheduled run |
| `POST` | `/start` | `runall` — every zone for `RUN_SECONDS`, run back to back |
| `POST` | `/stop` | `suspendall` — stops everything immediately |

`POST /start?seconds=N` overrides the duration for that call, which is the easy
way to test without waiting out a full cycle.

Failures return JSON, never a hang: `400` for a bad `seconds`, `404` for an
unknown path, `502` when Hydrawise itself errors or times out (10s).

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

Hydrawise rate-limits the API fairly aggressively per key. The `/status`
response includes a `nextpoll` field — 60 seconds on this account — which is the
interval it expects you to respect. Nothing here polls on a timer, but do not
add one that ignores it, and note this is why the container health check hits
the proxy itself rather than calling `/status` every 30 seconds.

## Running

Locally:

```bash
API_KEY='<your-key>' RUN_SECONDS=1800 npm start
```

With Docker Compose — this is how it runs on the server:

```bash
cp .env.example .env    # add your key
docker compose up -d
docker compose logs -f
```

## Deploying

```bash
npm run deploy          # build + push to registry.garit.au
```

Then on the server:

```bash
docker compose pull && docker compose up -d
```

The image name and target platform live in the `config` block of
`package.json`. Bump `version` there to cut a new tag — deploying twice on the
same version overwrites the existing tag in the registry.

## iOS Shortcut

Three actions, in order:

1. **Get Contents of URL** — URL `http://<server-ip>:8123/start`, Method `POST`
   (expand the action with the ▸ arrow to reach Method)
2. **Get Dictionary Value** — Get `Value` for key `message` in `Contents of URL`
3. **Show Notification** — body set to the `Dictionary Value` variable

Step 3 surfaces Hydrawise's own confirmation (*"Starting Front Rotors, …"*), so
a tap gives real feedback rather than failing silently. No JSON parsing step is
needed: the proxy sends `content-type: application/json`, so Shortcuts converts
the body to a dictionary on its own.

Duplicate the shortcut and change the URL to `/stop` for the other direction.
Then Share → **Add to Home Screen**, or just say *"Hey Siri, Start Irrigation"* —
a shortcut's name is its Siri phrase automatically.

Two things that bite:

- iOS asks for **Local Network** permission on first run. Deny it and every
  request fails with a vague error. Fix at Settings → Privacy & Security →
  Local Network → Shortcuts.
- These hit a private IP, so they only work on home Wi-Fi. For access from
  anywhere use a VPN such as Tailscale. Do not port-forward `8123` — see below.

## Security

**There is no request auth.** Whoever can reach the port can run the
irrigation. Containment is entirely the network binding:

- `BIND_ADDR=0.0.0.0` (default) — reachable by anything on the LAN
- `BIND_ADDR=127.0.0.1` — reachable only from the server itself

That is an acceptable trade on a home network and a bad one anywhere the host
is internet-facing. Never port-forward this. If it ever needs to be exposed,
add a shared-secret header check first — Shortcuts supports request headers, so
the phone side costs one field.

The container runs as `nobody` with a read-only root filesystem and all
capabilities dropped.

## Hydrawise API notes

Behaviour confirmed against a real controller, since the v1.6 docs are thin:

- `custom` on `runall` is seconds **per zone**, not a total across zones.
- Zones run **sequentially**, never together — the controller queues them, so
  four zones at `RUN_SECONDS=1800` is about two hours end to end.
- `suspendall` needs no additional parameters; the bare action stops everything.
- `period_id=999` is what the docs pair with `custom`. Its exact meaning is not
  documented anywhere I could find — it is exposed as `RUN_PERIOD_ID` in case a
  different value turns out to matter.

In `/status`, each relay's `run` is its programmed duration and `time` counts
down to its next start. Because zones are sequential, consecutive `time` values
differ by the previous zone's `run` — a useful way to confirm what a `/start`
actually queued.

## Troubleshooting

**`exec /usr/bin/node: exec format error`** — architecture mismatch. The image
was built on Apple Silicon (arm64) for an x86_64 host. `npm run deploy` pins
`linux/amd64`; rebuild and push, then `docker compose pull` on the server so it
stops using the cached bad image.

**Can't reach it over the LAN** — check `docker port hydrawise-proxy` shows
`0.0.0.0:8123` rather than `127.0.0.1:8123`, then check the host firewall.

**Empty notification from the Shortcut** — the request failed. Errors come back
as `{"error": …}` with no `message` key. Add a Quick Look action after step 1 to
see the raw response.
