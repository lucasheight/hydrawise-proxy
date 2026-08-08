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

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
    });
    res.end(body);
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
        return JSON.parse(text);
    } catch {
        throw new Error(`upstream returned non-JSON: ${text.slice(0, 200)}`);
    }
}

function getStatus() {
    return callApi(apiUrl('statusschedule.php'));
}

// runall takes period_id plus custom, where custom is seconds *per zone* — the
// controller then runs the zones sequentially. Both are sent together or not at
// all, since custom is meaningless without its period_id.
function runAllZones(seconds) {
    const params = { action: 'runall' };
    if (seconds !== undefined) {
        params.period_id = RUN_PERIOD_ID;
        params.custom = String(seconds);
    }
    return callApi(apiUrl('setzone.php', params));
}

// Bare suspendall stops everything; confirmed against the controller, no extra params needed.
function suspendAllZones() {
    return callApi(apiUrl('setzone.php', { action: 'suspendall' }));
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
            return sendJson(res, 200, await getStatus());
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

server.listen(PORT, HOST, () => {
    const run = RUN_SECONDS === undefined
        ? 'bare runall (no period_id/custom)'
        : `${RUN_SECONDS}s, period_id=${RUN_PERIOD_ID}`;
    console.log(`[hydrawise-proxy] listening on http://${HOST}:${PORT} — /start default: ${run}`);
});

// Without this, `docker stop` waits out its grace period before SIGKILL.
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        console.log(`[${signal}] shutting down`);
        server.close(() => process.exit(0));
    });
}
