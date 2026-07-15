// Cloudflare Worker: shared control plane for the wildfire-alerts-canada
// project. Holds location/timezone/per-channel-pause state in KV, and
// exposes it to SMS (Twilio), Discord (Interactions), email (Apps
// Script relay), and GitHub Actions (read-only) so a command on any
// platform updates the same state all the others read from.

const KV_KEY = "state";

const DEFAULT_STATE = {
  location: { lat: null, lon: null, raw_input: null, updated_at: null },
  timezone: null,
  channels: { sms: true, discord: true, email: true },
  trip_mode: false,
  last_trip_reminder: null,
  contact_number: null,
};

const CWFIS_URL = "https://geoserver.cwfif.nrcan.gc.ca/geoserver/wfs";
const CWFIS_TYPENAME = "public:cwfif_national_activefires";

const TZ_BANDS = [
  { upTo: -120, tz: "America/Vancouver" },
  { upTo: -110, tz: "America/Edmonton" },
  { upTo: -101, tz: "America/Regina" },
  { upTo: -95, tz: "America/Winnipeg" },
  { upTo: -68, tz: "America/Toronto" },
  { upTo: -56.5, tz: "America/Halifax" },
  { upTo: -52, tz: "America/St_Johns" },
];

function tzFromLon(lon) {
  for (const band of TZ_BANDS) if (lon <= band.upTo) return band.tz;
  return "America/St_Johns";
}

async function getState(env) {
  const raw = await env.CONTROL_KV.get(KV_KEY);
  if (!raw) return structuredClone(DEFAULT_STATE);
  const parsed = JSON.parse(raw);
  return {
    location: { ...DEFAULT_STATE.location, ...(parsed.location || {}) },
    timezone: parsed.timezone ?? null,
    channels: { ...DEFAULT_STATE.channels, ...(parsed.channels || {}) },
    trip_mode: parsed.trip_mode ?? false,
    last_trip_reminder: parsed.last_trip_reminder ?? null,
    contact_number: parsed.contact_number ?? null,
  };
}

async function setState(env, state) {
  await env.CONTROL_KV.put(KV_KEY, JSON.stringify(state));
}

function statusReply(state) {
  const c = state.channels;
  const loc = state.location.lat != null
    ? `${state.location.lat.toFixed(3)},${state.location.lon.toFixed(3)} (from: "${state.location.raw_input}")`
    : "not set";
  return [
    `SMS: ${c.sms ? "on" : "paused"} | Discord: ${c.discord ? "on" : "paused"} | Email: ${c.email ? "on" : "paused"}`,
    `Location: ${loc}`,
    `Timezone: ${state.timezone || "not set"}`,
    `Trip mode: ${state.trip_mode ? "on" : "off"}`,
    `Contact: ${state.contact_number || "not set"}`,
  ].join("\n\n");
}

const COORD_RE = /(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/;

function extractCoordsFromString(text) {
  const m = text.match(COORD_RE);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return { lat, lon };
  return null;
}

async function resolveLocation(text) {
  const urlMatch = text.match(/https?:\/\/\S+/);
  if (urlMatch) {
    let expanded = urlMatch[0];
    try {
      const resp = await fetch(urlMatch[0], { redirect: "follow" });
      expanded = resp.url || expanded;
    } catch (_) {
      // fall through and try to parse whatever we already have
    }
    const fromExpanded = extractCoordsFromString(decodeURIComponent(expanded));
    if (fromExpanded) return fromExpanded;
    const fromOriginal = extractCoordsFromString(text);
    if (fromOriginal) return fromOriginal;
    return null; // a link we couldn't resolve to coordinates
  }

  const direct = extractCoordsFromString(text);
  if (direct) return direct;

  // Fall back to geocoding as a place name.
  const q = encodeURIComponent(text.trim());
  const geoResp = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ca&q=${q}`,
    { headers: { "User-Agent": "wildfire-alerts-canada/1.0 (personal project)" } }
  );
  if (!geoResp.ok) return null;
  const results = await geoResp.json();
  if (!results.length) return null;
  const lat = parseFloat(results[0].lat);
  const lon = parseFloat(results[0].lon);
  if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return { lat, lon };
  return null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371.0;
  const toRad = (d) => (d * Math.PI) / 180;
  const p1 = toRad(lat1), p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1), dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function stageName(code) {
  return { OC: "Out of Control", BH: "Being Held", UC: "Under Control", EX: "Extinguished" }[code] || code;
}

async function reverseGeocodeCity(lat, lon) {
  try {
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10`,
      { headers: { "User-Agent": "wildfire-alerts-canada/1.0 (personal project)" } }
    );
    if (!resp.ok) return null;
    const addr = (await resp.json()).address || {};
    for (const key of ["city", "town", "village", "hamlet", "municipality", "county"]) {
      if (addr[key]) return addr[key];
    }
  } catch (_) {
    // fall through
  }
  return null;
}

async function fetchNearbyFires(lat, lon, radiusKm, maxResults) {
  const nowIso = new Date().toISOString().slice(0, 19);
  const cql = `record_start<=${nowIso}Z AND record_end>=${nowIso}Z`;
  const resp = await fetch(
    `${CWFIS_URL}?service=WFS&version=2.0.0&request=GetFeature&typeName=${CWFIS_TYPENAME}` +
      `&outputFormat=application/json&CQL_FILTER=${encodeURIComponent(cql)}`
  );
  if (!resp.ok) return [];
  const data = await resp.json();
  const fires = [];
  for (const feat of data.features || []) {
    const p = feat.properties;
    if (p.latitude == null || p.longitude == null) continue;
    const dist = haversineKm(lat, lon, p.latitude, p.longitude);
    if (dist <= radiusKm) {
      fires.push({
        fid: p.national_fire_id,
        stage: p.stage_of_control_status || "EX",
        size: p.fire_size,
        agency: p.agency_code,
        lat: p.latitude,
        lon: p.longitude,
        dist,
      });
    }
  }
  fires.sort((a, b) => a.dist - b.dist);
  return fires.slice(0, maxResults);
}

async function formatFireSnapshot(lat, lon) {
  const fires = await fetchNearbyFires(lat, lon, 500, 5);
  if (!fires.length) return "No active fires within 500km of your current location right now.";
  const lines = [];
  for (const f of fires) {
    const city = await reverseGeocodeCity(f.lat, f.lon);
    const place = city ? `${city} (${f.lat.toFixed(2)},${f.lon.toFixed(2)})` : `${f.lat.toFixed(2)},${f.lon.toFixed(2)}`;
    lines.push(`${place} (${f.agency}, ${f.size} ha): ${stageName(f.stage)}, ${f.dist.toFixed(0)}km away`);
  }
  return `Current fires within 500km of last known location (closest ${fires.length}):\n\n` + lines.join("\n\n");
}

async function sendSmsViaTwilio(env, to, body) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_FROM_NUMBER || !to) return;
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: env.TWILIO_FROM_NUMBER, To: to, Body: body }),
  });
}

const PHONE_RE = /^\+?[1-9]\d{7,14}$/;

function helpText(state) {
  return [
    "Wildfire alert commands:",
    "STATUS - show current settings",
    "CHECK - immediate fire check near your location",
    "PAUSE / PAUSE ALL - pause alerts (this platform / everywhere)",
    "RESUME / RESUME ALL - resume alerts",
    "TRIP START / TRIP STOP - road trip mode with periodic location reminders",
    "CONTACT <phone number> - also text that number your location whenever you update it during a trip (CONTACT OFF to stop)" +
      (state?.contact_number ? ` [currently: ${state.contact_number}]` : ""),
    "WHERE / UPDATE - (registered contact only) ask the trip owner to send a location update",
    "OPTIONS - show this list",
    "Or just send a location: a Maps link, \"lat,lon\", or a city/town name",
  ].join("\n\n");
}

async function applyCommand(env, channel, rawText, fromNumber) {
  const text = (rawText || "").trim();
  const upper = text.toUpperCase();
  const state = await getState(env);

  if (fromNumber && state.contact_number && fromNumber === state.contact_number && (upper === "WHERE" || upper === "UPDATE")) {
    await sendSmsViaTwilio(
      env,
      env.TWILIO_TO_NUMBER,
      "Your contact is asking for a location update - reply with FIRE: <your location> to send one."
    );
    return "Request sent - they'll get a text asking to update their location.";
  }

  if (upper === "STATUS") {
    return statusReply(state);
  }

  if (upper === "OPTIONS" || upper === "HELP") {
    return helpText(state);
  }

  if (upper === "PAUSE" || upper === "PAUSE ALL") {
    if (upper === "PAUSE ALL") {
      state.channels = { sms: false, discord: false, email: false };
    } else {
      state.channels[channel] = false;
    }
    await setState(env, state);
    return upper === "PAUSE ALL"
      ? "All wildfire alerts paused (SMS, Discord, email). Text RESUME ALL to resume everywhere."
      : `Wildfire ${channel} alerts paused. Text RESUME to turn back on, or PAUSE ALL / RESUME ALL to control every platform.`;
  }

  if (upper === "RESUME" || upper === "RESUME ALL") {
    if (upper === "RESUME ALL") {
      state.channels = { sms: true, discord: true, email: true };
    } else {
      state.channels[channel] = true;
    }
    await setState(env, state);
    return upper === "RESUME ALL"
      ? "All wildfire alerts resumed (SMS, Discord, email)."
      : `Wildfire ${channel} alerts resumed.`;
  }

  if (upper === "CHECK") {
    if (state.location.lat == null) {
      return "No location set yet - text a Maps link, \"lat,lon\", or a city/town name first.";
    }
    return await formatFireSnapshot(state.location.lat, state.location.lon);
  }

  if (upper === "TRIP START" || upper === "TRIP ON") {
    state.trip_mode = true;
    state.last_trip_reminder = null;
    await setState(env, state);
    return (
      "Trip mode on. I'll ping you about every 1.5 hours (during your 8am-midnight window) to update your " +
      "location. Text a new location any time for an immediate fire check - if you don't, I'll keep using " +
      "your last known one. Text TRIP STOP to turn this off."
    );
  }

  if (upper === "TRIP STOP" || upper === "TRIP OFF" || upper === "TRIP END") {
    state.trip_mode = false;
    await setState(env, state);
    return "Trip mode off. Location reminders stopped.";
  }

  if (upper === "CONTACT" || upper.startsWith("CONTACT ")) {
    const arg = text.slice("CONTACT".length).trim();
    if (!arg || arg.toUpperCase() === "OFF" || arg.toUpperCase() === "STOP") {
      if (!arg) {
        return "Reply with the phone number to notify on each location update during a trip, e.g. CONTACT +15551234567. Text CONTACT OFF to stop.";
      }
      state.contact_number = null;
      await setState(env, state);
      return "Contact notifications off.";
    }
    const digits = arg.replace(/[\s()-]/g, "");
    if (!PHONE_RE.test(digits)) {
      return `That doesn't look like a phone number: "${arg}". Try e.g. CONTACT +15551234567.`;
    }
    state.contact_number = digits.startsWith("+") ? digits : digits.length === 10 ? `+1${digits}` : `+${digits}`;
    await setState(env, state);
    return `Contact set to ${state.contact_number}. They'll get a text with your location every time you update it while trip mode is on.`;
  }

  // Otherwise: treat as a location update.
  const coords = await resolveLocation(text);
  if (!coords) {
    return `Couldn't figure out a location from "${text}".\n\n` + helpText(state);
  }
  state.location = { lat: coords.lat, lon: coords.lon, raw_input: text, updated_at: new Date().toISOString() };
  state.timezone = tzFromLon(coords.lon);
  await setState(env, state);

  let reply = `Location updated to ${coords.lat.toFixed(3)},${coords.lon.toFixed(3)} (timezone: ${state.timezone}). SMS alerts now scoped to 500km of here.`;
  if (state.trip_mode) {
    reply += "\n\n" + (await formatFireSnapshot(coords.lat, coords.lon));
    if (state.contact_number) {
      await sendSmsViaTwilio(
        env,
        state.contact_number,
        `Location Update: ${text} (${coords.lat.toFixed(3)},${coords.lon.toFixed(3)})`
      );
    }
  }
  return reply;
}

async function verifyTwilioSignature(request, authToken, bodyParams) {
  const signature = request.headers.get("X-Twilio-Signature");
  if (!signature || !authToken) return false;
  let data = request.url;
  const keys = Object.keys(bodyParams).sort();
  for (const k of keys) data += k + bodyParams[k];
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === signature;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function verifyDiscordSignature(request, publicKeyHex, bodyText) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !publicKeyHex) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "NODE-ED25519", namedCurve: "NODE-ED25519" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      "NODE-ED25519",
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + bodyText)
    );
  } catch (_) {
    return false;
  }
}

async function proxyToTalkyto(bodyText, env) {
  if (!env.TALKYTO_FORWARD_URL) {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, {
      headers: { "Content-Type": "text/xml" },
    });
  }
  try {
    const resp = await fetch(env.TALKYTO_FORWARD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: bodyText,
    });
    const respText = await resp.text();
    const contentType = resp.headers.get("Content-Type") || "text/xml";
    return new Response(respText, { status: resp.status, headers: { "Content-Type": contentType } });
  } catch (_) {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, {
      headers: { "Content-Type": "text/xml" },
    });
  }
}

function requireBearer(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${env.API_SHARED_SECRET}`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/twilio-sms") {
      const bodyText = await request.text();
      const params = Object.fromEntries(new URLSearchParams(bodyText));
      const ok = await verifyTwilioSignature(request, env.TWILIO_AUTH_TOKEN, params);
      if (!ok) return new Response("Forbidden", { status: 403 });

      // This number's Messaging Service also carries an existing business
      // texting integration (Talkyto). Only messages explicitly prefixed
      // with FIRE: are ours; everything else is passed through untouched
      // so normal texting keeps working.
      const fireMatch = (params.Body || "").match(/^\s*FIRE:?\s*(.*)$/is);
      if (!fireMatch) {
        return await proxyToTalkyto(bodyText, env);
      }

      const reply = await applyCommand(env, "sms", fireMatch[1], params.From);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`;
      return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
    }

    if (request.method === "POST" && url.pathname === "/discord-interactions") {
      const bodyText = await request.text();
      const ok = await verifyDiscordSignature(request, env.DISCORD_PUBLIC_KEY, bodyText);
      if (!ok) return new Response("Forbidden", { status: 401 });
      const interaction = JSON.parse(bodyText);
      if (interaction.type === 1) {
        return Response.json({ type: 1 });
      }
      if (interaction.type === 2) {
        const opt = (interaction.data?.options || []).find((o) => o.name === "command");
        const reply = await applyCommand(env, "discord", opt ? opt.value : "");
        return Response.json({ type: 4, data: { content: reply } });
      }
      return new Response("Unhandled interaction type", { status: 400 });
    }

    if (request.method === "POST" && url.pathname === "/email-command") {
      if (!requireBearer(request, env)) return new Response("Forbidden", { status: 403 });
      const body = await request.json();
      const reply = await applyCommand(env, "email", body.text || "");
      return Response.json({ reply });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      if (!requireBearer(request, env)) return new Response("Forbidden", { status: 403 });
      const state = await getState(env);
      return Response.json(state);
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const state = await getState(env);
    if (!state.trip_mode || !state.channels.sms) return;
    if (!state.timezone) return; // no location yet - nothing to remind about

    const nowLocal = new Date(new Date().toLocaleString("en-US", { timeZone: state.timezone }));
    const hour = nowLocal.getHours();
    if (hour < 8) return; // outside the 8am-midnight window - platform silence hours

    const slotKey = `${nowLocal.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:${String(nowLocal.getMinutes()).padStart(2, "0")}`;
    if (state.last_trip_reminder === slotKey) return; // already reminded this slot

    await sendSmsViaTwilio(
      env,
      env.TWILIO_TO_NUMBER,
      "Trip mode: reply FIRE: <your location> to update and get an immediate fire check, or I'll keep using your last known location. Text FIRE: TRIP STOP to turn this off."
    );
    state.last_trip_reminder = slotKey;
    await setState(env, state);
  },
};

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}
