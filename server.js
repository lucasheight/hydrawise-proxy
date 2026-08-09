const http = require('http');

const PORT = Number(process.env.PORT) || 8123;
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.API_KEY;
const RUN_PERIOD_ID = process.env.RUN_PERIOD_ID || '999';
const UPSTREAM_TIMEOUT_MS = 10_000;

if (!API_KEY) {
    console.error('API_KEY not set. Export your Hydrawise API key as API_KEY.');
    process.exit(1);
}

// Default run duration. Left unset, /start sends a bare runall with no
// period_id/custom; a ?seconds= on the request overrides this per call.
const RUN_SECONDS = (() => {
    const raw = process.env.RUN_SECONDS;
    if (raw === undefined || raw === '') return undefined;
    const seconds = Number(raw);
    if (!Number.isInteger(seconds) || seconds <= 0) {
        console.error(`RUN_SECONDS must be a positive integer, got "${raw}".`);
        process.exit(1);
    }
    return seconds;
})();

// There is no request auth: the loopback bind is what keeps /start and /stop
// off the network. Anything reachable beyond localhost can run the irrigation.
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
if (!LOOPBACK.includes(HOST)) {
    console.warn(`[warn] HOST=${HOST} exposes /start and /stop to the network with no auth.`);
}

const API_BASE = 'https://api.hydrawise.com/api/v1';

function apiUrl(path, params = {}) {
    const url = new URL(`${API_BASE}/${path}`);
    url.searchParams.set('api_key', API_KEY);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }
    return url;
}

function sendBody(res, status, body, extraHeaders = {}) {
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...extraHeaders,
    });
    res.end(body);
}

function sendJson(res, status, payload, extraHeaders = {}) {
    sendBody(res, status, JSON.stringify(payload), extraHeaders);
}

async function callApi(url) {
    const upstream = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    const text = await upstream.text();

    if (!upstream.ok) {
        throw new Error(`upstream ${upstream.status}: ${text.slice(0, 200)}`);
    }

    // Hydrawise returns plain text on some error paths, so parse defensively.
    try {
        return { text, data: JSON.parse(text) };
    } catch {
        throw new Error(`upstream returned non-JSON: ${text.slice(0, 200)}`);
    }
}

// Hydrawise publishes no concrete rate limit; the statusschedule payload's
// `nextpoll` is the only signal for how often it wants to be asked. Cache
// accordingly, so a dashboard polling every few seconds costs one upstream
// call per nextpoll window rather than one per request.
const FALLBACK_NEXTPOLL_MS = 60_000;

const statusCache = {
    text: null,
    fetchedAt: 0,
    ttlMs: FALLBACK_NEXTPOLL_MS,
    inflight: null,
};

function refreshStatus() {
    // Single-flight: concurrent callers during a refresh share one upstream
    // request instead of each starting their own.
    if (statusCache.inflight) return statusCache.inflight;

    const pending = (async () => {
        const { text, data } = await callApi(apiUrl('statusschedule.php'));
        const nextpoll = Number(data?.nextpoll);
        statusCache.text = text;
        statusCache.fetchedAt = Date.now();
        statusCache.ttlMs = Number.isFinite(nextpoll) && nextpoll > 0
            ? nextpoll * 1000
            : FALLBACK_NEXTPOLL_MS;
        return text;
    })();

    statusCache.inflight = pending;
    pending
        .catch(() => {})
        .finally(() => {
            if (statusCache.inflight === pending) statusCache.inflight = null;
        });

    return pending;
}

// Starting or stopping changes what the next poll should report, so drop the
// cached copy rather than letting a dashboard show a stale "running" for up to
// a minute after the sprinklers were told to stop.
let onStatusInvalidated = null;

function invalidateStatus() {
    statusCache.fetchedAt = 0;
    if (onStatusInvalidated) onStatusInvalidated();
}

async function getStatus({ fresh = false } = {}) {
    const age = Date.now() - statusCache.fetchedAt;

    if (!fresh && statusCache.text !== null && age < statusCache.ttlMs) {
        return { text: statusCache.text, cache: 'HIT', ageMs: age };
    }

    try {
        return { text: await refreshStatus(), cache: 'MISS', ageMs: 0 };
    } catch (err) {
        // A dashboard should not go blank because one upstream call failed.
        // Serve what we have and label it, rather than claiming it is current.
        if (statusCache.text === null) throw err;
        console.warn(`[warn] status refresh failed, serving stale: ${err.message}`);
        return {
            text: statusCache.text,
            cache: 'STALE',
            ageMs: Date.now() - statusCache.fetchedAt,
        };
    }
}

// runall takes period_id plus custom, where custom is seconds *per zone* — the
// controller then runs the zones sequentially. Both are sent together or not at
// all, since custom is meaningless without its period_id.
async function runAllZones(seconds) {
    const params = { action: 'runall' };
    if (seconds !== undefined) {
        params.period_id = RUN_PERIOD_ID;
        params.custom = String(seconds);
    }
    const { data } = await callApi(apiUrl('setzone.php', params));
    invalidateStatus();
    return data;
}

// Bare suspendall stops everything; confirmed against the controller, no extra params needed.
async function suspendAllZones() {
    const { data } = await callApi(apiUrl('setzone.php', { action: 'suspendall' }));
    invalidateStatus();
    return data;
}

function parseSeconds(searchParams) {
    const raw = searchParams.get('seconds');
    if (raw === null) return RUN_SECONDS;
    const seconds = Number(raw);
    if (!Number.isInteger(seconds) || seconds <= 0) {
        throw new RangeError('seconds must be a positive integer');
    }
    return seconds;
}

const server = http.createServer(async (req, res) => {
    const { method, url } = req;
    console.log(`[http] ${method} ${url}`);

    const { pathname, searchParams } = new URL(url, `http://${req.headers.host ?? 'localhost'}`);

    try {
        if (method === 'GET' && pathname === '/status') {
            const { text, cache, ageMs } = await getStatus({
                fresh: searchParams.get('fresh') === '1',
            });
            // Body is passed through untouched so consumers see exactly what
            // Hydrawise returned; cache state goes in headers.
            return sendBody(res, 200, text, {
                'x-cache': cache,
                age: String(Math.floor(ageMs / 1000)),
            });
        }

        if (method === 'POST' && pathname === '/start') {
            return sendJson(res, 200, await runAllZones(parseSeconds(searchParams)));
        }

        if (method === 'POST' && pathname === '/stop') {
            return sendJson(res, 200, await suspendAllZones());
        }

        return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
        if (err instanceof RangeError) {
            return sendJson(res, 400, { error: err.message });
        }
        console.error(`[error] ${method} ${pathname}:`, err.message);
        return sendJson(res, 502, { error: 'upstream request failed' });
    }
});

// Opt-in. With no MQTT_URL the module is never even loaded, so its dependency
// tree stays out of the process for anyone who only wants the HTTP endpoints.
let mqttPublisher = null;
if (process.env.MQTT_URL) {
    const { start } = require('./mqtt-publisher');
    // Polls through the same cache the HTTP endpoints use, so Hydrawise still
    // sees a single caller no matter how many things are watching.
    mqttPublisher = start({
        url: process.env.MQTT_URL,
        fetchStatus: () => getStatus(),
    });
    // Push an update shortly after a start or stop instead of waiting out the
    // poll interval, so the dashboard reflects the tap almost immediately.
    onStatusInvalidated = () => mqttPublisher.refreshSoon();
}

server.listen(PORT, HOST, () => {
    const run = RUN_SECONDS === undefined
        ? 'bare runall (no period_id/custom)'
        : `${RUN_SECONDS}s, period_id=${RUN_PERIOD_ID}`;
    console.log(`[hydrawise-proxy] listening on http://${HOST}:${PORT} — /start default: ${run}`);
    if (!mqttPublisher) console.log('[hydrawise-proxy] MQTT disabled (no MQTT_URL)');
});

// Without this, `docker stop` waits out its grace period before SIGKILL.
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
        console.log(`[${signal}] shutting down`);
        if (mqttPublisher) await mqttPublisher.stop();
        server.close(() => process.exit(0));
    });
}
