# Setup

Everything here is free. Do these in order - each later step depends on
values produced by an earlier one.

## 1. Cloudflare Worker (the control plane)

1. Create a free account at https://dash.cloudflare.com/sign-up if you don't have one.
2. Install Wrangler and log in:
   ```
   npm install -g wrangler
   wrangler login
   ```
3. From the `worker/` folder, create the KV namespace:
   ```
   cd worker
   wrangler kv namespace create CONTROL_KV
   ```
   This prints an `id`. Paste it into `worker/wrangler.toml`, replacing
   `REPLACE_WITH_KV_NAMESPACE_ID`.
4. Set secrets (you'll get `DISCORD_PUBLIC_KEY` in step 3 and choose your
   own random string for `API_SHARED_SECRET` - anything long and random,
   e.g. output of `openssl rand -hex 32`):
   ```
   wrangler secret put API_SHARED_SECRET
   wrangler secret put DISCORD_PUBLIC_KEY
   wrangler secret put TWILIO_AUTH_TOKEN
   ```
5. Deploy:
   ```
   wrangler deploy
   ```
   Note the URL it prints, e.g. `https://wildfire-alerts-control.<you>.workers.dev`.
   This is your `CF_WORKER_URL`.

## 2. Twilio (SMS)

In the Twilio Console, open your phone number's configuration and set
**"A message comes in"** to a webhook:
```
https://<your-worker-url>/twilio-sms
```
Method: HTTP POST.

## 3. NASA FIRMS (satellite hotspot feed)

Get a free `MAP_KEY` at https://firms.modaps.eosdis.nasa.gov/api/area/
(there's a "Get MAP_KEY" link on that page). This becomes `FIRMS_MAP_KEY`.

## 4. Discord

1. Go to https://discord.com/developers/applications, create a New Application.
2. Under **General Information**, copy the **Public Key** - that's what
   you fed into `wrangler secret put DISCORD_PUBLIC_KEY` above (go back
   and set it now if you did step 1 before creating the app).
3. Set **Interactions Endpoint URL** (same General Information page) to:
   ```
   https://<your-worker-url>/discord-interactions
   ```
   Discord will POST a test ping here immediately - the Worker must
   already be deployed with the correct public key for this to save
   successfully.
4. Under **Bot**, create a bot and copy its token, then invite it to
   your server (OAuth2 > URL Generator > scopes: `bot`, `applications.commands`
   > permissions: Send Messages > open the generated URL).
5. Register the `/wildfire` slash command (one-time; replace
   `YOUR_APP_ID` and `YOUR_BOT_TOKEN`):
   ```
   curl -X PUT https://discord.com/api/v10/applications/YOUR_APP_ID/commands \
     -H "Authorization: Bot YOUR_BOT_TOKEN" \
     -H "Content-Type: application/json" \
     -d '[{
       "name": "wildfire",
       "description": "Wildfire alerts control",
       "options": [{
         "type": 3,
         "name": "command",
         "description": "PAUSE, PAUSE ALL, RESUME, RESUME ALL, STATUS, or a location",
         "required": true
       }]
     }]'
   ```
6. Separately, create a plain **Incoming Webhook** in whichever channel
   you want outbound fire alerts posted to (Channel Settings > Integrations
   > Webhooks > New Webhook). Copy its URL - that's `DISCORD_WEBHOOK_URL`.
   This is independent of the bot/slash-command setup above.

## 5. Gmail (outbound digest + inbound commands)

1. Turn on 2-Step Verification on your Google account if it isn't already.
2. Google Account > Security > 2-Step Verification > App Passwords.
   Create one (name it "wildfire alerts"). That's `GMAIL_APP_PASSWORD`.
3. Open https://script.google.com, create a new project, paste in
   `apps-script/Code.gs`.
4. Project Settings (gear icon) > Script Properties, add:
   - `WORKER_URL` = your Worker URL from step 1
   - `API_SHARED_SECRET` = the same secret from step 1
5. Triggers (clock icon) > Add Trigger > function `checkForCommands` >
   Time-driven > Minutes timer > Every 5 minutes > Save (it'll ask you
   to authorize Gmail access - that's expected).
6. To send a command by email, email yourself (or the address tied to
   this Gmail account) with subject `FIRE: PAUSE ALL`, `FIRE: Kelowna BC`,
   `FIRE: STATUS`, etc. The `FIRE:` prefix is required.

## 6. GitHub repo secrets

Under this repo's Settings > Secrets and variables > Actions, add:

| Secret | Value |
|---|---|
| `CF_WORKER_URL` | from step 1 |
| `CF_API_SHARED_SECRET` | from step 1 |
| `FIRMS_MAP_KEY` | from step 3 |
| `TWILIO_ACCOUNT_SID` | from your Twilio console |
| `TWILIO_AUTH_TOKEN` | from your Twilio console (same value as the Worker secret) |
| `TWILIO_FROM_NUMBER` | your Twilio number, e.g. `+15551234567` |
| `TWILIO_TO_NUMBER` | your personal phone number |
| `DISCORD_WEBHOOK_URL` | from step 4.6 |
| `GMAIL_ADDRESS` | your Gmail address |
| `GMAIL_APP_PASSWORD` | from step 5.2 |
| `EMAIL_TO` | (optional) where digests go, if different from `GMAIL_ADDRESS` |

## 7. Test it

- Text `STATUS` to your Twilio number - you should get a reply showing
  all channels "on", location "not set".
- Text a location (a Maps share link, `lat,lon`, or a city name) -
  you should get back a confirmation with coordinates and timezone.
- Run the workflow manually once to confirm it works end to end:
  Actions tab > "Wildfire check and alert" > Run workflow.
