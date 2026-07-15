#!/usr/bin/env python3
"""Fetch Canadian wildfire data and send alerts via SMS/Discord/email.

Run every 20 minutes by GitHub Actions (skipping the UTC hours where no
Canadian timezone's window can be open). Self-gates on the 8am-midnight
local, 45-minute-slot window before doing any real work, tracking the
last handled slot in state so it fires correctly regardless of exact
alignment between the tick interval and slot boundaries (see main()).
"""
import json
import math
import os
import re
import smtplib
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from email.mime.text import MIMEText
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

STATE_PATH = Path(__file__).resolve().parent.parent / "state" / "fires_seen.json"

CWFIS_URL = "https://geoserver.cwfif.nrcan.gc.ca/geoserver/wfs"
CWFIS_TYPENAME = "public:cwfif_national_activefires"
FIRMS_BBOX = "-141,41.7,-52.6,83.1"  # west,south,east,north (Canada)
ALERT_STAGES = {"BH", "OC"}


def env(name, default=None, required=False):
    val = os.environ.get(name, default)
    if required and not val:
        print(f"Missing required env var: {name}", file=sys.stderr)
        sys.exit(1)
    return val


def load_state():
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text())
    return {"cwfis": {}, "firms_last_watermark": "", "last_alert_slot": None}


def save_state(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2, sort_keys=True))


def get_control_state(worker_url, shared_secret):
    resp = requests.get(
        f"{worker_url}/state",
        headers={"Authorization": f"Bearer {shared_secret}"},
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()


def current_slot(tz_name):
    """Return (date_str, slot_index) for the current 45-min-from-8am slot in
    tz_name's local time, or None if outside the 8am-midnight window.

    Slot boundaries are always on a quarter-hour mark (8:00, 8:45, 9:30,
    10:15, 11:00, ...), but the workflow tick interval need not align
    exactly with them - the caller compares this against the last slot it
    handled and fires whenever the tick has crossed into a new one, which
    works at any tick interval instead of requiring an exact match.
    """
    if not tz_name:
        return None
    now_local = datetime.now(ZoneInfo(tz_name))
    minutes_since_8am = now_local.hour * 60 + now_local.minute - 8 * 60
    if not (0 <= minutes_since_8am <= 23 * 60 + 45 - 8 * 60):
        return None
    return now_local.date().isoformat(), minutes_since_8am // 45


def next_slot_time_str(slot_index):
    """Human-friendly clock time of the next scheduled 45-min slot."""
    next_index = slot_index + 1
    wraps_to_tomorrow = next_index > 21
    if wraps_to_tomorrow:
        next_index = 0
    total_minutes = 8 * 60 + next_index * 45
    hour = (total_minutes // 60) % 24
    minute = total_minutes % 60
    suffix = "am" if hour < 12 else "pm"
    hour12 = hour % 12 or 12
    time_str = f"{hour12}:{minute:02d}{suffix}"
    return f"{time_str} tomorrow" if wraps_to_tomorrow else time_str


def fetch_cwfis():
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    cql = f"record_start<={now_iso}Z AND record_end>={now_iso}Z"
    resp = requests.get(
        CWFIS_URL,
        params={
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeName": CWFIS_TYPENAME,
            "outputFormat": "application/json",
            "CQL_FILTER": cql,
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    fires = {}
    for feat in data.get("features", []):
        p = feat["properties"]
        fid = p.get("national_fire_id")
        if not fid:
            continue
        stage = p.get("stage_of_control_status") or "EX"
        if stage not in ("OC", "BH", "UC"):
            stage = "EX"
        fires[fid] = {
            "stage": stage,
            "size": p.get("fire_size"),
            "lat": p.get("latitude"),
            "lon": p.get("longitude"),
            "agency": p.get("agency_code"),
        }
    return fires


def fetch_firms(map_key):
    if not map_key:
        return []
    url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{map_key}/VIIRS_SNPP_NRT/{FIRMS_BBOX}/1"
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    lines = resp.text.strip().splitlines()
    if len(lines) < 2:
        return []
    header = lines[0].split(",")
    rows = []
    for line in lines[1:]:
        vals = line.split(",")
        row = dict(zip(header, vals))
        if row.get("confidence") in ("h", "n"):
            rows.append(row)
    return rows


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


COMPASS_POINTS = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
]


def compass_direction(lat1, lon1, lat2, lon2):
    y = math.sin(math.radians(lon2 - lon1)) * math.cos(math.radians(lat2))
    x = math.cos(math.radians(lat1)) * math.sin(math.radians(lat2)) - math.sin(
        math.radians(lat1)
    ) * math.cos(math.radians(lat2)) * math.cos(math.radians(lon2 - lon1))
    bearing = (math.degrees(math.atan2(y, x)) + 360) % 360
    return COMPASS_POINTS[round(bearing / 22.5) % 16]


def compute_cwfis_transitions(prev_fires, cur_fires):
    events = []
    for fid, cur in cur_fires.items():
        prev = prev_fires.get(fid)
        prev_stage = prev["stage"] if prev else None
        new_stage = cur["stage"]
        if new_stage in ALERT_STAGES and new_stage != prev_stage:
            events.append((fid, prev_stage, new_stage, cur))
        elif new_stage == "EX" and prev_stage in ALERT_STAGES:
            events.append((fid, prev_stage, new_stage, cur))
    return events


def summarize_firms(rows, watermark):
    new_rows = [r for r in rows if f"{r.get('acq_date','')} {r.get('acq_time','')}" > watermark]
    if not new_rows:
        return [], watermark
    clusters = {}
    for r in new_rows:
        try:
            lat, lon = float(r["latitude"]), float(r["longitude"])
        except (KeyError, ValueError):
            continue
        key = (round(lat, 1), round(lon, 1))
        clusters.setdefault(key, 0)
        clusters[key] += 1
    new_watermark = max(f"{r.get('acq_date','')} {r.get('acq_time','')}" for r in new_rows)
    return list(clusters.items()), new_watermark


def reverse_geocode_city(lat, lon):
    try:
        resp = requests.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={"format": "json", "lat": lat, "lon": lon, "zoom": 10},
            headers={"User-Agent": "wildfire-alerts-canada/1.0 (personal project)"},
            timeout=15,
        )
        resp.raise_for_status()
        addr = resp.json().get("address", {})
        for key in ("city", "town", "village", "hamlet", "municipality", "county"):
            if addr.get(key):
                return addr[key]
    except requests.RequestException:
        pass
    return None


def stage_name(code):
    return {"OC": "Out of Control", "BH": "Being Held", "UC": "Under Control", "EX": "Extinguished"}.get(code, code)


def format_cwfis_event(fid, prev_stage, new_stage, fire):
    return (
        f"Fire {fid} ({fire.get('agency')}, {fire.get('size')} ha): "
        f"{stage_name(prev_stage) if prev_stage else 'new'} -> {stage_name(new_stage)} "
        f"at {fire.get('lat')},{fire.get('lon')}"
    )


def send_sms(account_sid, auth_token, from_number, to_number, body):
    resp = requests.post(
        f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json",
        auth=(account_sid, auth_token),
        data={"From": from_number, "To": to_number, "Body": body},
        timeout=20,
    )
    resp.raise_for_status()


def send_discord(webhook_url, content):
    resp = requests.post(webhook_url, json={"content": content[:1900]}, timeout=20)
    resp.raise_for_status()


def send_email(gmail_address, gmail_app_password, to_addr, subject, body):
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = gmail_address
    msg["To"] = to_addr
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(gmail_address, gmail_app_password)
        server.sendmail(gmail_address, [to_addr], msg.as_string())


def main():
    worker_url = env("CF_WORKER_URL", required=True).rstrip("/")
    shared_secret = env("CF_API_SHARED_SECRET", required=True)

    control = get_control_state(worker_url, shared_secret)
    tz_name = control.get("timezone")

    state = load_state()

    slot = None
    if tz_name:
        slot = current_slot(tz_name)
        if slot is None:
            print(f"Outside alert window (tz={tz_name}) - skipping.")
            return
        last_slot = state.get("last_alert_slot")
        if last_slot is not None and tuple(last_slot) == slot:
            print(f"Already handled slot {slot} (tz={tz_name}) - skipping.")
            return
        state["last_alert_slot"] = list(slot)
    # else: no location texted yet, so no timezone/window to gate on -
    # run unconditionally (national Discord/email feed still useful).

    channels = control.get("channels", {"sms": True, "discord": True, "email": True})
    location = control.get("location") or {}
    loc_lat, loc_lon = location.get("lat"), location.get("lon")

    prev_fires = state.get("cwfis", {})

    cur_fires = fetch_cwfis()
    cwfis_events = compute_cwfis_transitions(prev_fires, cur_fires)

    firms_map_key = env("FIRMS_MAP_KEY")
    firms_rows = fetch_firms(firms_map_key)
    firms_clusters, new_watermark = summarize_firms(firms_rows, state.get("firms_last_watermark", ""))

    discord_lines = [format_cwfis_event(*e) for e in cwfis_events]
    if firms_clusters:
        discord_lines.append(
            "New FIRMS hotspot clusters: "
            + "; ".join(f"~{lat},{lon} ({n} detections)" for (lat, lon), n in firms_clusters)
        )

    if channels.get("discord") and env("DISCORD_WEBHOOK_URL"):
        for line in discord_lines:
            send_discord(env("DISCORD_WEBHOOK_URL"), line)

    if channels.get("sms") and loc_lat is not None and loc_lon is not None:
        sms_lines = []
        for i, (fid, prev_stage, new_stage, fire) in enumerate(cwfis_events):
            if fire.get("lat") is None or fire.get("lon") is None:
                continue
            dist = haversine_km(loc_lat, loc_lon, fire["lat"], fire["lon"])
            if dist <= 500:
                if i > 0:
                    time.sleep(1)  # respect Nominatim's 1 req/sec usage policy
                city = reverse_geocode_city(fire["lat"], fire["lon"])
                coords = f"{fire['lat']:.2f},{fire['lon']:.2f}"
                near = f"{city} ({coords})" if city else coords
                direction = compass_direction(loc_lat, loc_lon, fire["lat"], fire["lon"])
                sms_lines.append(
                    f"Fire near {near} ({fire.get('agency')}, {fire.get('size')} ha): "
                    f"{stage_name(prev_stage) if prev_stage else 'new'} -> {stage_name(new_stage)}, "
                    f"{dist:.0f}km {direction} of you"
                )
        if sms_lines:
            header = f"Wildfire alert ({len(sms_lines)} fire{'s' if len(sms_lines) != 1 else ''} near you):\n\n"
            footer = f"\n\nNext check: {next_slot_time_str(slot[1])}" if slot is not None else ""
            send_sms(
                env("TWILIO_ACCOUNT_SID", required=True),
                env("TWILIO_AUTH_TOKEN", required=True),
                env("TWILIO_FROM_NUMBER", required=True),
                env("TWILIO_TO_NUMBER", required=True),
                header + "\n\n".join(sms_lines) + footer,
            )

    gmail_address = env("GMAIL_ADDRESS")
    if channels.get("email") and discord_lines and gmail_address:
        send_email(
            gmail_address,
            env("GMAIL_APP_PASSWORD", required=True),
            env("EMAIL_TO", default=gmail_address),
            "Wildfire alert digest",
            "\n".join(discord_lines),
        )

    state["cwfis"] = cur_fires
    state["firms_last_watermark"] = new_watermark or state.get("firms_last_watermark", "")
    save_state(state)
    print(f"Done: {len(cwfis_events)} CWFIS transitions, {len(firms_clusters)} FIRMS clusters.")


if __name__ == "__main__":
    main()
