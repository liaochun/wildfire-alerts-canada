# Wildfire Alerts Canada

A free, no-server wildfire tracking + alert system for Canada.

## How it works

- **Data:** [CWFIS national active fires feed](https://geoserver.cwfif.nrcan.gc.ca/geoserver/wfs) (agency-reported status: Out of Control / Being Held / Under Control / Extinguished) + [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) satellite hotspots (early signal, no status field).
- **Compute:** GitHub Actions, running every 15 minutes, all free. The workflow checks whether it's currently inside your 8am-midnight local window (in 45-minute slots) before doing any real work.
- **Control plane:** a small Cloudflare Worker + KV store holds your current location, derived timezone, and per-channel on/off state. It's the shared brain that SMS, Discord, and email commands all read from and write to.
- **Alerts:**
  - **SMS** (via your existing Twilio number) - fires within 500km of your last texted location, only on a status transition into Being Held / Out of Control, or transition to Extinguished if it was previously Being Held/Out of Control. Any fire that's within 150km and still Being Held/Out of Control gets a repeated `URGENT:` line every check cycle, not just on transition.
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
- `worker/` - the Cloudflare Worker (control plane: SMS webhook, Discord interactions, email-command endpoint, state API)
- `apps-script/Code.gs` - paste into script.google.com; polls your Gmail for commands
- `state/fires_seen.json` - dedup state committed back to the repo each run (which fires/status we've already alerted on)
- `SETUP.md` - every manual account/credential step required (do this before the workflow will do anything useful)

See `SETUP.md` to get this running end to end.
