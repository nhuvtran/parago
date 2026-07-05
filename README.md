# Parago

A Chrome extension (Manifest V3) that makes Amazon safer for older or more vulnerable shoppers.

Parago does two things:

1. **Quality filter** — flags or hides low-quality and sponsored search results (low ratings, few ratings, sponsored, non-Prime), with adjustable thresholds.
2. **Guardian approval** — optionally requires a trusted person ("guardian") to approve a purchase by **email** before checkout can proceed. Approval happens entirely server-side, so the shopper can't approve their own purchase.

## How guardian approval works

```
Shopper at Amazon checkout            Supabase (free tier)              Guardian (email)
──────────────────────────           ──────────────────────           ────────────────
content script overlay
   │ needs approval
   ▼ (via background worker)
   POST create-request ───────▶ create-request fn (service role)
                                  • insert pending row + token
                                  • send email via Brevo ───────────▶ "Approve a purchase: $X"
   ◀── { id }                                                          link → decision page
   │
   │ poll get-status ◀──────── get-status fn
   ▼
 overlay stays blocking      decision fn (GET) ◀──────────────────── guardian opens link
 until approved              decision fn (POST) ◀─────────────────── guardian clicks Approve/Reject
   approved → unblock          • flips status server-side (single-use token)
```

**Security model (summary):** the extension runs on the shopper's device, so all state changes happen server-side in Supabase Edge Functions using the service-role key (never shipped to the browser). Postgres RLS locks the table to the service role. The guardian's link carries an unguessable, single-use, 24h-expiring token. The checkout gate **fails closed** — if the backend is unreachable, the page stays blocked. The public `create-request` function is rate-limited.

> Threat boundary: this protects against impulsive/confused purchases, not a determined adversary on a device they fully control (the shopper can change settings or clear local state). The hard guarantee is that the shopper cannot forge *server* approval without the emailed token.

## Repo layout

```
src/
  content/    content scripts: search filter + checkout approval overlay
  relay/       approval transport: MockRelay (local) + SupabaseRelay (remote)
  settings/    chrome.storage settings
  ui/          options + popup pages
  i18n/        English + Vietnamese strings
  config.example.js   ← copy to config.js, set your project ref
  background.js       MV3 service worker (cross-origin fetch for content scripts)
supabase/
  migrations/  purchase_requests table + RLS
  functions/   create-request, decision, get-status (Deno) + shared helpers
  config.toml  marks the functions public (verify_jwt = false)
test/          vitest unit tests
```

## Quick start (filter only — no backend needed)

```bash
npm install
npm run build          # bundles dist/content.js, dist/checkout.js, dist/background.js
```

Then load it in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → select this folder. The quality filter works immediately. Guardian approval falls back to local (popup) approval until you configure the backend below.

## Enabling email approval (Supabase + Brevo — both free tier)

You need: a [Supabase](https://supabase.com) project, the [Supabase CLI](https://supabase.com/docs/guides/cli), and a [Brevo](https://www.brevo.com) account (free transactional email).

1. **Configure the project ref**
   ```bash
   cp src/config.example.js src/config.js
   ```
   In `src/config.js` set `functionsBaseUrl` to `https://<your-ref>.functions.supabase.co`, and set `project_id` in `supabase/config.toml` to `<your-ref>`. (`src/config.js` is gitignored.)

2. **Brevo**: verify a sender email, create an API key.

3. **Link + secrets + deploy**
   ```bash
   supabase link --project-ref <your-ref>
   supabase db push
   supabase secrets set BREVO_API_KEY=<key> BREVO_SENDER_EMAIL=<verified-sender>
   supabase functions deploy            # config.toml keeps them public (verify_jwt = false)
   ```

4. **Build + reload** the extension. In the extension's Options page, set "Ask someone to approve purchases", a spending limit (optional), and the approver's email.

## Enabling Telegram approval (optional, free)

Telegram delivers the approval as a message with one-tap **Approve / Reject** buttons, in real time, native on iPhone. Email stays as the fallback. Requires the Supabase backend above already deployed.

1. **Create a bot**: in Telegram, message [@BotFather](https://t.me/BotFather) → `/newbot` → follow the prompts. Copy the bot **token**.

2. **Secrets + deploy** (`TELEGRAM_WEBHOOK_SECRET` is any random string you choose):
   ```bash
   supabase secrets set TELEGRAM_BOT_TOKEN=<token> TELEGRAM_WEBHOOK_SECRET=<random-string>
   supabase functions deploy telegram-webhook
   ```

3. **Register the webhook** so Telegram posts updates to your function (the secret must match the one above):
   ```bash
   curl "https://api.telegram.org/bot<token>/setWebhook?url=https://<your-ref>.functions.supabase.co/telegram-webhook&secret_token=<random-string>"
   ```

4. **Link the approver**: in the extension Options, set delivery method to **Telegram**, click **Get Telegram link**, and send that `t.me/...` link to the approver. They open it and tap **Start**. Options shows "Connected" when done.

Approvals then arrive in the approver's Telegram with Approve/Reject buttons; **See full details** opens the same rich approval page. The bot token and webhook secret live only in `supabase secrets`, never in the extension.

## Development

```bash
npm test          # vitest (pure logic + relay + fail-closed gate)
npm run build     # esbuild bundles
```

## What is never committed

`src/config.js`, `.env*`, and `supabase/.temp/` are gitignored — your project ref and any local link state stay out of version control. **No API keys live in this repo**: the Supabase service-role key is injected by Supabase at runtime, and the Brevo key lives only in `supabase secrets`.

## License

[MIT](LICENSE).
