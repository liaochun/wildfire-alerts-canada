# Wildfire Alerts Canada

A free, no-server wildfire tracking + alert system for Canada.

## How it works

- **Data:** [CWFIS national active fires feed](https://geoserver.cwfif.nrcan.gc.ca/geoserver/wfs) (agency-reported status: Out of Control / Being Held / Under Control / Extinguished) + [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) satellite hotspots (early signal, no status field).
- **Compute:** Discord and email run via GitHub Actions on its existing schedule (`scripts/check_and_alert.py`), free, and that workflow checks whether it's currently inside your 8am-midnight local window (in 45-minute slots) before doing any real work. SMS runs separately via a single Cloudflare Worker Cron Trigger (`worker/index.js`, every 15 minutes, driving both the fire-check and trip-reminder engines) - moved off GitHub Actions because its `schedule:` trigger is best-effort and was observed silently skipping scheduled ticks in production (a 2h11m gap where six 20-minute ticks should have run and didn't), which is unacceptable for a safety-critical proximity alert. Worker Cron Triggers fire reliably, and at 96 invocations/day this is comfortably inside Cloudflare's free tier - mostly-awaited network calls don't count against the CPU-time limit the way active JS execution does.
- **Control plane:** a small Cloudflare Worker + KV store holds your current location, derived timezone, and per-channel on/off state. It's the shared brain that SMS, Discord, and email commands all read from and write to.
- **Alerts:**
  - **SMS** (via your existing Twilio number) - sent by the Cloudflare Worker's cron trigger, not the GitHub Actions script. Fires within 500km of your last texted location, only on a status transition into Being Held / Out of Control, or transition to Extinguished if it was previously Being Held/Out of Control. Any fire that's within 150km and still Being Held/Out of Control gets a repeated `URGENT:` line every check cycle, not just on transition. Every SMS states the location it's tracking, and every fire mentioned gets a reverse-geocoded city/province alongside its raw lat,lon wherever that data is available. At the last check of the day (~11pm local, or whenever your cadence's last slot lands) an additional end-of-day SMS lists every currently active fire within 500km, regardless of transition. Dedupe state lives in the Worker's KV store (`fire_alert` field), separate from the git-committed state used by Discord/email. Cadence defaults to hourly, adjustable down to 15 min via `CHECK EVERY <n> MIN/HOURS`; trip-mode location reminders default to every 2 hours, adjustable the same way via `TRIP REMINDER EVERY <n> MIN/HOURS`.
  - **Discord** - every fire status transition nationwide, plus new high-confidence FIRMS hotspot clusters.
  - **Email** - periodic digest via your Gmail (sent directly, no third-party email service).

## Commands (same on SMS, Discord, and email)

| Command | Effect |
|---|---|
| `PAUSE` | Pause alerts on the platform you sent it from |
| `PAUSE ALL` | Pause alerts on all platforms |
| `RESUME` | Resume alerts on the platform you sent it from |
| `RESUME ALL` | Resume alerts on all platforms |
| `STATUS` | Reply with current state: paused/active per platform, current location, current timezone |
| *(anything else)* | Treated as a location update - a Google/Apple Maps share link, raw `lat,lon`, or a city/town name |

Any command from any platform updates the shared state that all platforms read.

## Repo layout

- `scripts/check_and_alert.py` - the main fetch/dedupe/alert script, run by GitHub Actions
- `.github/workflows/wildfire-check.yml` - the schedule
- `worker/` - the Cloudflare Worker (control plane: SMS webhook, Discord interactions, email-command endpoint, state API); also now owns the SMS wildfire-proximity cron and the trip-reminder cron via a single Cron Trigger in `worker/index.js` (every 15 minutes) - the primary path for SMS, replacing GitHub Actions for that job
- `apps-script/Code.gs` - paste into script.google.com; polls your Gmail for commands
- `state/fires_seen.json` - dedup state committed back to the repo each run, used by Discord/email (which fires/status we've already alerted on); SMS keeps its own separate dedupe state in the Worker's KV store
- `SETUP.md` - every manual account/credential step required (do this before the workflow will do anything useful)

See `SETUP.md` to get this running end to end.
