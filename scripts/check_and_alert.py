#!/usr/bin/env python3
"""Fetch Canadian wildfire data and send alerts via Discord/email.

SMS alerting has moved to the Cloudflare Worker's own cron trigger for
reliability (GitHub Actions' best-effort "schedule:" trigger was observed
silently skipping ticks in production); this script no longer sends SMS.

Run every 20 minutes by GitHub Actions (skipping the UTC hours where no
Canadian timezone's window can be open). Self-gates on the 8am-midnight
local, hourly-slot window before doing any real work, tracking the last
handled slot in state so it fires correctly regardless of exact alignment
between the tick interval and slot boundaries (see main()).
"""
import json
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
    """Return (date_str, slot_index) for the current hourly slot (8am-midnight)
    in tz_name's local time, or None if outside the window.

    Slot boundaries are on the hour (8:00, 9:00, 10:00, ...), but the
    workflow tick interval need not align exactly with them - the caller
    compares this against the last slot it handled and fires whenever the
    tick has crossed into a new one, which works at any tick interval
    instead of requiring an exact match.
    """
    if not tz_name:
        return None
    now_local = datetime.now(ZoneInfo(tz_name))
    minutes_since_8am = now_local.hour * 60 + now_local.minute - 8 * 60
    if not (0 <= minutes_since_8am <= 15 * 60):
        return None
    return now_local.date().isoformat(), minutes_since_8am // 60


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


def stage_name(code):
    return {"OC": "Out of Control", "BH": "Being Held", "UC": "Under Control", "EX": "Extinguished"}.get(code, code)


def reverse_geocode_city_province(lat, lon):
    try:
        resp = requests.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={"format": "json", "lat": lat, "lon": lon, "zoom": 10},
            headers={"User-Agent": "wildfire-alerts-canada/1.0 (personal project)"},
            timeout=15,
        )
        resp.raise_for_status()
        addr = resp.json().get("address", {})
        city = None
        for key in ("city", "town", "village", "hamlet", "municipality", "county"):
            if addr.get(key):
                city = addr[key]
                break
        if not city:
            return None
        return f"{city}, {addr['state']}" if addr.get("state") else city
    except requests.RequestException:
        return None


def format_cwfis_event(fid, prev_stage, new_stage, fire, place):
    where = f"{place} ({fire.get('lat')},{fire.get('lon')})" if place else f"{fire.get('lat')},{fire.get('lon')}"
    return (
        f"Fire {fid} ({fire.get('agency')}, {fire.get('size')} ha): "
        f"{stage_name(prev_stage) if prev_stage else 'new'} -> {stage_name(new_stage)} "
        f"at {where}"
    )


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

    channels = control.get("channels", {"discord": True, "email": True})

    prev_fires = state.get("cwfis", {})

    cur_fires = fetch_cwfis()
    cwfis_events = compute_cwfis_transitions(prev_fires, cur_fires)

    firms_map_key = env("FIRMS_MAP_KEY")
    firms_rows = fetch_firms(firms_map_key)
    firms_clusters, new_watermark = summarize_firms(firms_rows, state.get("firms_last_watermark", ""))

    # Nominatim allows ~1 req/sec - stagger every reverse-geocode call below
    # (both the per-fire-event loop and the FIRMS cluster loop) with a shared
    # counter: no sleep before the first call, 1s before every call after.
    geocode_calls = 0

    def staggered_geocode(lat, lon):
        nonlocal geocode_calls
        if geocode_calls > 0:
            time.sleep(1)
        geocode_calls += 1
        return reverse_geocode_city_province(lat, lon)

    discord_lines = []
    for fid, prev_stage, new_stage, fire in cwfis_events:
        place = None
        if fire.get("lat") is not None and fire.get("lon") is not None:
            place = staggered_geocode(fire["lat"], fire["lon"])
        discord_lines.append(format_cwfis_event(fid, prev_stage, new_stage, fire, place))
    if firms_clusters:
        cluster_lines = []
        for (lat, lon), n in firms_clusters:
            place = staggered_geocode(lat, lon)
            where = f"{place} ({lat},{lon})" if place else f"{lat},{lon}"
            cluster_lines.append(f"~{where} ({n} detections)")
        discord_lines.append("New FIRMS hotspot clusters: " + "; ".join(cluster_lines))

    if channels.get("discord") and env("DISCORD_WEBHOOK_URL"):
        for line in discord_lines:
            send_discord(env("DISCORD_WEBHOOK_URL"), line)

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
