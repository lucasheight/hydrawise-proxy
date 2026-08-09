const mqtt = require('mqtt');

const PREFIX = process.env.MQTT_PREFIX || 'hydrawise';
const DISCOVERY_PREFIX = process.env.MQTT_DISCOVERY_PREFIX || 'homeassistant';
const DISCOVERY = !['0', 'false', 'no'].includes(
    (process.env.MQTT_DISCOVERY || '').toLowerCase(),
);

const TOPIC = {
    availability: `${PREFIX}/availability`,
    state: `${PREFIX}/state`,
    zone: (relayId) => `${PREFIX}/zone/${relayId}/state`,
};

// Polling backs off when the upstream complains, so a rate-limited account is
// not hammered further. Hydrawise publishes no concrete limit, only nextpoll.
const MIN_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const FALLBACK_POLL_MS = 60_000;

// A zone that has counted down to time <= 1 is the one running: Hydrawise
// reports `timestr: "Now"` at that point, and `run` becomes seconds remaining
// rather than the programmed duration.
//
// Deliberately not keyed on `type === 106`. Queued zones share that type, and
// whether a *scheduled* run reports 106 at all is unverified — every sample so
// far came from a manual runall. Keying on the countdown instead keeps this
// working whatever type a scheduled run turns out to use. The observed type is
// published anyway, so the unknown can be settled from recorded data.
function isRunning(relay) {
    return Number(relay?.time) <= 1;
}

function deriveState(payload) {
    const relays = Array.isArray(payload?.relays) ? payload.relays : [];
    const active = relays.find(isRunning) || null;

    return {
        running: active !== null,
        zone: active?.name ?? null,
        relay_id: active?.relay_id ?? null,
        seconds_left: active ? Number(active.run) : null,
        zone_type: active?.type ?? null,
        zone_count: relays.length,
        updated: payload?.time ?? null,
    };
}

function deriveZone(relay) {
    const running = isRunning(relay);
    return {
        relay_id: relay.relay_id,
        name: relay.name,
        zone: relay.relay,
        running,
        // `run` means seconds remaining while running, and the programmed or
        // upcoming duration otherwise — so it is split into two fields rather
        // than published as one ambiguous number.
        seconds_left: running ? Number(relay.run) : null,
        run_seconds: running ? null : Number(relay.run),
        next_run_in: running ? null : Number(relay.time),
        next_run: relay.timestr ?? null,
        type: relay.type,
    };
}

function discoveryPayloads() {
    const device = {
        identifiers: ['hydrawise-proxy'],
        name: 'Hydrawise',
        manufacturer: 'Hunter',
        model: 'hydrawise-proxy',
    };
    const common = {
        availability_topic: TOPIC.availability,
        device,
    };

    return [
        {
            topic: `${DISCOVERY_PREFIX}/binary_sensor/hydrawise/running/config`,
            payload: {
                ...common,
                name: 'Irrigation running',
                unique_id: 'hydrawise_running',
                state_topic: TOPIC.state,
                value_template: "{{ 'ON' if value_json.running else 'OFF' }}",
                device_class: 'running',
            },
        },
        {
            topic: `${DISCOVERY_PREFIX}/sensor/hydrawise/zone/config`,
            payload: {
                ...common,
                name: 'Irrigation active zone',
                unique_id: 'hydrawise_active_zone',
                state_topic: TOPIC.state,
                value_template: '{{ value_json.zone if value_json.zone else "none" }}',
                icon: 'mdi:sprinkler-variant',
            },
        },
        {
            topic: `${DISCOVERY_PREFIX}/sensor/hydrawise/seconds_left/config`,
            payload: {
                ...common,
                name: 'Irrigation time remaining',
                unique_id: 'hydrawise_seconds_left',
                state_topic: TOPIC.state,
                value_template: '{{ value_json.seconds_left | default(0, true) }}',
                unit_of_measurement: 's',
                device_class: 'duration',
                state_class: 'measurement',
            },
        },
    ];
}

function zoneDiscovery(relay) {
    return {
        topic: `${DISCOVERY_PREFIX}/binary_sensor/hydrawise/zone_${relay.relay_id}/config`,
        payload: {
            availability_topic: TOPIC.availability,
            device: {
                identifiers: ['hydrawise-proxy'],
                name: 'Hydrawise',
                manufacturer: 'Hunter',
                model: 'hydrawise-proxy',
            },
            name: relay.name,
            unique_id: `hydrawise_zone_${relay.relay_id}`,
            state_topic: TOPIC.zone(relay.relay_id),
            value_template: "{{ 'ON' if value_json.running else 'OFF' }}",
            device_class: 'running',
        },
    };
}

/**
 * Connects to the broker and publishes irrigation state on the interval the
 * Hydrawise payload asks for via `nextpoll`.
 *
 * Every failure path is contained here: the HTTP endpoints must keep working
 * whether or not the broker is reachable, because stopping the sprinklers in
 * the rain is the reason this project exists.
 */
function start({ url, fetchStatus, log = console }) {
    const client = mqtt.connect(url, {
        username: process.env.MQTT_USERNAME || undefined,
        password: process.env.MQTT_PASSWORD || undefined,
        clientId: process.env.MQTT_CLIENT_ID || `hydrawise-proxy-${process.pid}`,
        reconnectPeriod: 10_000,
        will: {
            topic: TOPIC.availability,
            payload: 'offline',
            qos: 1,
            retain: true,
        },
    });

    let timer = null;
    let backoffMs = 0;
    let announcedZones = new Set();
    let stopped = false;

    const publish = (topic, payload, opts = { qos: 1, retain: true }) =>
        client.publish(
            topic,
            typeof payload === 'string' ? payload : JSON.stringify(payload),
            opts,
        );

    client.on('connect', () => {
        log.log(`[mqtt] connected to ${url}`);
        publish(TOPIC.availability, 'online');
        if (DISCOVERY) {
            for (const { topic, payload } of discoveryPayloads()) publish(topic, payload);
        }
        // Re-announce zones after a reconnect, since the broker may have been
        // restarted and lost retained discovery messages.
        announcedZones = new Set();
        poll();
    });

    // Without a listener, a connection error is an unhandled 'error' event and
    // takes the whole process down — including the HTTP endpoints.
    client.on('error', (err) => log.warn(`[mqtt] ${err.message}`));
    client.on('offline', () => log.warn('[mqtt] offline'));
    client.on('reconnect', () => log.log('[mqtt] reconnecting'));

    function schedule(ms) {
        if (stopped) return;
        clearTimeout(timer);
        timer = setTimeout(poll, ms);
        if (typeof timer.unref === 'function') timer.unref();
    }

    async function poll() {
        if (stopped) return;

        try {
            const { text } = await fetchStatus();
            const payload = JSON.parse(text);

            publish(TOPIC.state, deriveState(payload));

            for (const relay of payload?.relays ?? []) {
                if (DISCOVERY && !announcedZones.has(relay.relay_id)) {
                    const { topic, payload: cfg } = zoneDiscovery(relay);
                    publish(topic, cfg);
                    announcedZones.add(relay.relay_id);
                }
                publish(TOPIC.zone(relay.relay_id), deriveZone(relay));
            }

            backoffMs = 0;
            const nextpoll = Number(payload?.nextpoll);
            schedule(Number.isFinite(nextpoll) && nextpoll > 0 ? nextpoll * 1000 : FALLBACK_POLL_MS);
        } catch (err) {
            // Back off rather than continuing at the same rate — especially on
            // 429, where polling harder is exactly the wrong response.
            backoffMs = Math.min(Math.max(backoffMs * 2, MIN_BACKOFF_MS), MAX_BACKOFF_MS);
            log.warn(`[mqtt] poll failed, retrying in ${backoffMs / 1000}s: ${err.message}`);
            schedule(backoffMs);
        }
    }

    // Called after /start or /stop. Without it a dashboard keeps showing the
    // old state until the next scheduled poll — up to a minute of "running"
    // after the sprinklers were told to stop. The small delay gives Hydrawise
    // a moment to reflect the change before we ask.
    function refreshSoon(delayMs = 2000) {
        if (stopped) return;
        backoffMs = 0;
        schedule(delayMs);
    }

    async function stop() {
        stopped = true;
        clearTimeout(timer);
        try {
            // Say goodbye properly so subscribers do not wait for the LWT.
            await new Promise((resolve) => {
                if (!client.connected) return resolve();
                client.publish(TOPIC.availability, 'offline', { qos: 1, retain: true }, resolve);
            });
            await new Promise((resolve) => client.end(false, {}, resolve));
        } catch {
            // Shutting down anyway.
        }
    }

    return { stop, refreshSoon };
}

module.exports = { start, deriveState, deriveZone, isRunning, TOPIC };
