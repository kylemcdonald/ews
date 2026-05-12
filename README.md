# Early Warning System

Web app for monitoring business-jet cohorts against concurrent-activity and calendar-learned baselines.

This project now supports both local development and a low-cost public deployment model:

- Node/Express API with SQLite persistence
- React dashboard with an alarm dial, world map, and historical charts
- Python backfill script that reuses the ADS-B Exchange heatmap approach from the referenced parsing workflow
- FAA and global cohort importers that build tracked sets from public aircraft metadata
- Latest-state refresh via ADS-B Exchange half-hour heatmaps
- Static snapshot publishing for public hosting

## What is included

- Demo mode: if no cohort has been imported yet, the dashboard serves synthetic review data
- Main/global historical store: `data/ews-main.sqlite`
- Military historical store: `data/ews-military.sqlite`
- Non-ICAO historical store: `data/ews-untracked.sqlite`
- FAA importer: `scripts/import_faa_cohort.py`
- Global importer: `scripts/import_global_cohort.py`
- Backfill script: `scripts/backfill_history.py`
- Snapshot exporter: `scripts/export_dashboard_snapshot.js`

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Run the app in demo mode:

```bash
npm run dev
```

The API runs on `http://localhost:3030` and the Vite client runs on `http://localhost:5173`.

To export a static snapshot for a public frontend:

```bash
npm run export:snapshot
```

## Real cohort setup

1. Import the global business-jet cohort:

```bash
npm run import:faa
npm run import:global
```

2. Run a 365-day backfill:

```bash
npm run backfill
```

Optional examples:

```bash
python3 scripts/import_faa_cohort.py --refresh
python3 scripts/import_global_cohort.py --dry-run
python3 scripts/import_faa_cohort.py --db data/ews-main.sqlite
python3 scripts/import_global_cohort.py --db data/ews-main.sqlite --refresh
python3 scripts/import_faa_cohort.py --min-seats 4 --max-seats 16
python3 scripts/backfill_history.py --start-date 2025-04-07 --end-date 2026-04-07
python3 scripts/backfill_history.py --db data/ews-main.sqlite --start-date 2024-04-08 --end-date 2026-05-04 --keep-cache
python3 scripts/backfill_history.py --relative-days 1
python3 scripts/backfill_history.py --skip-download
python3 scripts/track_non_icao_hex.py --start-date 2026-04-20 --end-date 2026-05-01 --skip-download
```

The default backfill reads tracked aircraft directly from SQLite, so once the global cohort is imported you do not need a separate watchlist file.

When the import or backfill starts, any previously seeded demo data is removed so it cannot pollute the real baseline.

## Useful commands

```bash
npm run dev
npm run build
npm run pages:dev
npm run d1:migrate:local
npm run d1:migrate:remote
npm run lint
npm run import:faa
npm run import:global
npm run seed:demo
npm run update:main
npm run update:military
npm run update:untracked
npm run export:snapshot
npm run export:main
npm run export:military
npm run export:untracked
npm run rss:update
npm run telegram:alert
```

## Notes

- Historical ingestion uses ADS-B Exchange heatmap binaries from `globe_history`.
- The current “live” view also comes from ADS-B Exchange heatmaps, updated every 30 minutes and cached between refreshes.
- The FAA importer uses a pragmatic business-jet heuristic so the tracked set excludes helicopters, props, large airliners, and government aircraft.
- The global importer merges ADS-B Exchange and tar1090/Mictronics metadata into `aircraft_metadata`, classifies rows into broad categories such as `business_jet`, `large_airliner`, `regional_airliner`, `military`, and `non_jet_aircraft`, then adds only `business_jet` rows to the main tracked cohort.
- The concurrent-count model uses an all-history weekly baseline and learned half-hour profiles around U.S. federal holidays, with a standard-deviation band exported for the dashboard.
- Non-ICAO `~hex` activity can be scanned into aggregate SQLite tables with `scripts/track_non_icao_hex.py`; rows are split by ADS-B/ADS-R/TIS-B message type so synthetic rebroadcast traffic can be analyzed separately from direct ADS-B reports.
- The production build currently emits a large JS bundle warning because the map and chart stack are bundled together. The app still builds and runs locally.
- `data/` is ignored so the SQLite file can be moved independently without checking it into source control.

## Public deployment

The public deployment can run with:

- Cloudflare Pages for the static frontend
- Cloudflare R2 for the public `dashboard.json`, `military-dashboard.json`, and `untracked-dashboard.json` snapshots, plus canonical main, military, and untracked SQLite state files
- GitHub Actions for the scheduled refresh jobs

The repository includes scheduled workflows in `.github/workflows/refresh-live-data.yml` and `.github/workflows/refresh-daily-history.yml` for that setup. The main site uses the global business-jet state DB, while military and non-ICAO cohorts are published as JSON data sources for the root dashboard toggles. All three are refreshed from the newest heatmap on the half-hour cadence and uploaded to R2.

Production frontend builds require explicit dashboard snapshot URLs. The build fails if `VITE_DASHBOARD_URL`, `VITE_MILITARY_DASHBOARD_URL`, or `VITE_UNTRACKED_DASHBOARD_URL` is missing, and `npm run build` also verifies that the emitted bundle contains those URLs rather than the local `/dashboard.json` fallback.

For local Pages deploys, prefer the guarded deploy script:

```bash
npm run verify:deploy-env
npm run deploy:pages
```

`deploy:pages` loads `.env`, builds, verifies the bundle, preserves the currently deployed RSS file, deploys to Cloudflare Pages, then runs a Playwright smoke test against the live site. For a Codex-assisted visual check, run:

```bash
npm run smoke:live:prompt
```

### Cloudflare credentials

Do not use `wrangler login` output or a copied `WRANGLER_OAUTH_CONFIG` secret in GitHub Actions. That is interactive user login state and can stop refreshing. The workflows use `CLOUDFLARE_API_TOKEN` instead.

For a durable setup, create an account-owned Cloudflare API token in `Manage Account > Account API Tokens`, with no expiration date and no IP address restriction. Add it to GitHub as the repository secret `CLOUDFLARE_API_TOKEN`, alongside `CLOUDFLARE_ACCOUNT_ID`.

Required account-owned token permissions for this repo:

- `Cloudflare Pages: Edit`
- `Workers R2 Storage: Edit`
- `Account Settings: Read`

If you use a user-owned API token instead of an account-owned token, also include `User Details: Read` and `User Memberships: Read`. Account-owned tokens are preferred here because they act as CI service credentials rather than as copied user session state.

After replacing the secret, rerun the `Deploy Pages` workflow. The old `WRANGLER_OAUTH_CONFIG` repository secret is no longer used by these workflows.

### Paid SMS and email notifications

The public Pages deployment includes Cloudflare Pages Functions for paid notification signup, Stripe webhooks, and the Cloudflare Access-protected `/admin` pages. Subscriber contact details are stored in Cloudflare D1 using encrypted email/phone fields plus keyed hashes for lookup and dedupe.

Create the D1 database:

```bash
npx wrangler d1 create ews-notifications
```

Copy `wrangler.example.toml` to the ignored `wrangler.toml`, replace the `database_id`, then apply the schema:

```bash
npm run d1:migrate:local
npm run d1:migrate:remote
```

In the Cloudflare Pages project, add a D1 binding named `EWS_NOTIFY_DB` pointing at `ews-notifications`. Add these Pages secrets/environment variables:

```text
APP_BASE_URL=https://ews.kylemcdonald.net
EWS_PUBLIC_URL=https://ews.kylemcdonald.net/
EWS_NOTIFICATION_URL=https://aews.cc/
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
STRIPE_PRODUCT_ID=prod_USlMnoY4GL7OAn
STRIPE_PRICE_ID=...
SENDGRID_API_KEY=...
SENDGRID_FROM_EMAIL=alerts@your-domain.example
SENDGRID_FROM_NAME=Apocalypse EWS
TELNYX_API_KEY=...
TELNYX_NUMBER=+1...
TELNYX_PUBLIC_KEY=...
TELNYX_WEBHOOK_URL=
TELNYX_WEBHOOK_FAILOVER_URL=
INTERNAL_ALERT_TOKEN=...
NOTIFICATION_HASH_SECRET=...
NOTIFICATION_ENCRYPTION_KEY=...
```

`STRIPE_PRICE_ID` is optional. If it is blank, the signup function resolves the active `$5/year` price for `STRIPE_PRODUCT_ID`. `EWS_NOTIFICATION_URL` controls the short dashboard URL used in SMS and email alert bodies; keep `APP_BASE_URL` and `EWS_PUBLIC_URL` on the canonical hostname. `TELNYX_NUMBER` is the E.164 sender number. `TELNYX_PUBLIC_KEY` is required to process webhooks and is available in the Telnyx Mission Control Portal under Keys & Credentials. Without it, webhooks are acknowledged but ignored. `TELNYX_WEBHOOK_URL` is optional; if it is blank, outbound SMS sends use `${APP_BASE_URL}/api/telnyx/webhook` for delivery callbacks. Generate `NOTIFICATION_ENCRYPTION_KEY` with:

```bash
openssl rand -base64 32
```

For local testing, copy `.dev.vars.example` to `.dev.vars` and fill the same values. This workspace already has ignored local scaffolding in `.dev.vars` and `wrangler.toml`; replace the blank SendGrid, Telnyx, and Stripe webhook values before testing end to end.

Run the local Pages app with Functions and local D1:

```bash
npm run pages:dev
```

Stripe Checkout redirects to `/signup?success=1`, but the subscription is only activated by the webhook. For local webhook testing:

```bash
stripe listen --forward-to http://localhost:8788/api/stripe/webhook
```

Copy the printed `whsec_...` value into `STRIPE_WEBHOOK_SECRET` in `.dev.vars`, then restart `npm run pages:dev`.

For production, add a Stripe webhook endpoint at:

```text
https://ews.kylemcdonald.net/api/stripe/webhook
```

Subscribe it to `checkout.session.completed`, `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`.

The scheduled refresh workflows call `/api/internal/level5-alert` after dashboard export. Add a GitHub repository secret named `EWS_INTERNAL_ALERT_TOKEN` with the same value as the Cloudflare Pages `INTERNAL_ALERT_TOKEN` secret. SMS/email alerts send only for emergency level 5 and are globally cooled down for 24 hours.

For Telnyx SMS, configure the messaging profile's webhook URL to:

```text
https://ews.kylemcdonald.net/api/telnyx/webhook
```

If you want to use the short domain as the failover URL, set:

```text
https://aews.cc/api/telnyx/webhook
```

The app records Telnyx `message.sent` and `message.finalized` callbacks in D1. Inbound `message.received` callbacks process STOP/START/HELP replies and update SMS preferences.

### Telegram emergency alerts

Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, and `TELEGRAM_CHANNEL` in `.env` for the Node server runtime. For the scheduled public refresh workflows, set the same values as GitHub repository secrets.

After each successful heatmap refresh, the backend builds the current dashboard signal. If the emergency level is 5, it posts:

```text
emergency level 5!
521 airborne (+121 above expected)
https://ews.kylemcdonald.net/
```

The last alerted heatmap slot is stored in SQLite so the same slot is not reposted after a restart or retry. Run `npm run telegram:alert -- --dry-run` to verify the current alert decision without posting.

### RSS emergency feed

The Node server exposes the same level-5 alert stream at `/rss.xml` and `/feed.xml`. The public static deployment also includes `/rss.xml`. Scheduled refresh workflows update that feed only when a new heatmap slot reaches emergency level 5, then publish the new RSS file to R2 and redeploy the Pages endpoint.

Run `npm run rss:update -- --dry-run --output tmp/rss.xml` to verify the current RSS decision without recording a new feed item.
