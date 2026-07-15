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
};

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
  return (
    `SMS: ${c.sms ? "on" : "paused"} | Discord: ${c.discord ? "on" : "paused"} | ` +
    `Email: ${c.email ? "on" : "paused"}\nLocation: ${loc}\nTimezone: ${state.timezone || "not set"}`
  );
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

async function applyCommand(env, channel, rawText) {
  const text = (rawText || "").trim();
  const upper = text.toUpperCase();
  const state = await getState(env);

  if (upper === "STATUS") {
    return statusReply(state);
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

  // Otherwise: treat as a location update.
  const coords = await resolveLocation(text);
  if (!coords) {
    return `Couldn't figure out a location from "${text}". Send a Maps link, "lat,lon", or a city/town name - or PAUSE/RESUME/STATUS.`;
  }
  state.location = { lat: coords.lat, lon: coords.lon, raw_input: text, updated_at: new Date().toISOString() };
  state.timezone = tzFromLon(coords.lon);
  await setState(env, state);
  return `Location updated to ${coords.lat.toFixed(3)},${coords.lon.toFixed(3)} (timezone: ${state.timezone}). SMS alerts now scoped to 500km of here.`;
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

      const reply = await applyCommand(env, "sms", fireMatch[1]);
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
};

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}
