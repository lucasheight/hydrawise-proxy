# hydrawise-proxy

A small HTTP proxy in front of the Hydrawise v1 API, so an iOS Shortcut can
start or stop a full irrigation cycle with one tap.

The use case it was built for: it is unusually dry, you want to run an extra
cycle on a weekend, and you would rather tap your phone than open an app and
navigate to the right screen.

The Hydrawise API wants the key in the query string, which makes it awkward to
call from a phone — you would be pasting a credential into a shortcut. This
wraps it instead: the key lives on a machine on your network, and the phone
hits three plain endpoints on the LAN.

Node standard library only — no dependencies, nothing to audit but one file.

### You will need

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

For anything permanent, use Docker Compose:

```bash
cp .env.example .env    # add your API key
docker compose up -d
docker compose logs -f
```

Compose builds the image locally and publishes the port on `0.0.0.0`, so the
LAN can reach it. That is what makes the phone shortcut work.

## Deploying to a registry

Only needed if you build on one machine and run on another. If you build
directly on the box that runs it, `docker compose up -d --build` is enough.

Set `IMAGE` in `.env` to your registry path, with no tag on the end:

```bash
IMAGE=registry.example.com/hydrawise-proxy
```

Then:

```bash
npm run deploy
```

That tags and pushes both `:<version>` and `:latest`. The deploy scripts read
`.env` themselves, so the same file configures Compose and deploys. A variable
set on the command line still wins, which is handy for one-offs:

```bash
PLATFORM=linux/arm64 npm run deploy
```

Then on the target host, set `IMAGE` in `.env` to the same value and:

```bash
docker compose pull && docker compose up -d
```

All three are read from `.env`, or from the environment:

| Variable | Default | Used by |
| --- | --- | --- |
| `IMAGE` | `hydrawise-proxy` | Both — repository path, no tag |
| `TAG` | `latest` | Compose — which tag to run |
| `PLATFORM` | `linux/amd64` | `npm run deploy` |

`PLATFORM` defaults to `linux/amd64` because the common case is building on an
Apple Silicon Mac for an x86_64 server. Deploying to a Raspberry Pi or other
arm64 host? Use `PLATFORM=linux/arm64`.

Bump `version` in `package.json` to cut a new tag; deploying twice on the same
version overwrites the existing tag in the registry.

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

If you need real auth, the smallest honest version is a shared secret: check a
header such as `x-proxy-token` against an environment variable using
`crypto.timingSafeEqual`, and reject anything that does not match. iOS Shortcuts
supports request headers directly, so the phone side is one extra field. That
is not implemented here — the loopback-or-LAN binding is the entire security
model, and it is stated plainly rather than hidden behind a false sense of one.

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
- `suspendall` needs no additional parameters; the bare action stops everything.
- `period_id=999` is what the docs pair with `custom`. Its exact meaning is not
  documented anywhere obvious — it is exposed as `RUN_PERIOD_ID` in case a
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
