# Early Warning System

Web app for monitoring business-jet cohorts against rolling and calendar-learned baselines.

This project now supports both local development and a low-cost public deployment model:

- Node/Express API with SQLite persistence
- React dashboard with an alarm dial, world map, and historical charts
- Python backfill script that reuses the ADS-B Exchange heatmap approach from the referenced parsing workflow
- FAA and global cohort importers that build tracked sets from public aircraft metadata
- Latest-state refresh via ADS-B Exchange half-hour heatmaps
- Static snapshot publishing for public hosting

## What is included

- Demo mode: if no cohort has been imported yet, the dashboard serves synthetic review data
- Historical store: `data/ews.sqlite`
- Beta/global historical store: `data/ews-beta.sqlite`
- FAA importer: `scripts/import_faa_cohort.py`
- Global importer: `scripts/import_global_cohort.py`
- Backfill script: `scripts/backfill_history.py`
- Snapshot exporter: `scripts/export_dashboard_snapshot.js`
- Beta snapshot exporter: `scripts/export_beta_dashboard_snapshot.js`

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

1. Import the FAA-derived business-jet cohort:

```bash
npm run import:faa
```

2. Run a 365-day backfill:

```bash
npm run backfill
```

Optional examples:

```bash
python3 scripts/import_faa_cohort.py --refresh
python3 scripts/import_global_cohort.py --dry-run
python3 scripts/import_faa_cohort.py --db data/ews-beta.sqlite
python3 scripts/import_global_cohort.py --db data/ews-beta.sqlite --refresh
python3 scripts/import_faa_cohort.py --min-seats 4 --max-seats 16
python3 scripts/backfill_history.py --start-date 2025-04-07 --end-date 2026-04-07
python3 scripts/backfill_history.py --db data/ews-beta.sqlite --start-date 2024-04-08 --end-date 2026-05-04 --keep-cache
python3 scripts/backfill_history.py --relative-days 1
python3 scripts/backfill_history.py --skip-download
python3 scripts/track_non_icao_hex.py --start-date 2026-04-20 --end-date 2026-05-01 --skip-download
```

The default backfill reads tracked aircraft directly from SQLite, so once the FAA cohort is imported you do not need a separate watchlist file.

When the import or backfill starts, any previously seeded demo data is removed so it cannot pollute the real baseline.

## Useful commands

```bash
npm run dev
npm run build
npm run lint
npm run import:faa
npm run import:global
npm run seed:demo
npm run update:daily
npm run export:snapshot
npm run export:beta
npm run rss:update
npm run telegram:alert
```

## Notes

- Historical ingestion uses ADS-B Exchange heatmap binaries from `globe_history`.
- The current “live” view also comes from ADS-B Exchange heatmaps, updated every 30 minutes and cached between refreshes.
- The FAA importer uses a pragmatic business-jet heuristic so the tracked set excludes helicopters, props, large airliners, and government aircraft.
- The global importer merges ADS-B Exchange and tar1090/Mictronics metadata into `aircraft_metadata`, classifies rows into broad categories such as `business_jet`, `large_airliner`, `regional_airliner`, `military`, and `non_jet_aircraft`, then adds only `business_jet` rows to the beta tracked cohort.
- The concurrent-count model includes a calendar-agnostic prior-year residual adjustment so recurrent seasonal disruptions can be learned without hardcoding holiday dates.
- Non-ICAO `~hex` activity can be scanned into aggregate SQLite tables with `scripts/track_non_icao_hex.py`; rows are split by ADS-B/ADS-R/TIS-B message type so synthetic rebroadcast traffic can be analyzed separately from direct ADS-B reports.
- The production build currently emits a large JS bundle warning because the map and chart stack are bundled together. The app still builds and runs locally.
- `data/` is ignored so the SQLite file can be moved independently without checking it into source control.

## Public deployment

The public deployment can run with:

- Cloudflare Pages for the static frontend
- Cloudflare R2 for the public `dashboard.json` and `beta-dashboard.json` snapshots, plus canonical `data/ews.sqlite` and `data/ews-beta.sqlite` state files
- GitHub Actions for the scheduled refresh jobs

The repository includes scheduled workflows in `.github/workflows/refresh-live-data.yml` and `.github/workflows/refresh-daily-history.yml` for that setup. The main site uses the FAA-derived state DB and `/beta` uses the global state DB; both are refreshed from the newest heatmap on the half-hour cadence, and both public JSON snapshots are uploaded to R2.

### Cloudflare credentials

Do not use `wrangler login` output or a copied `WRANGLER_OAUTH_CONFIG` secret in GitHub Actions. That is interactive user login state and can stop refreshing. The workflows use `CLOUDFLARE_API_TOKEN` instead.

For a durable setup, create an account-owned Cloudflare API token in `Manage Account > Account API Tokens`, with no expiration date and no IP address restriction. Add it to GitHub as the repository secret `CLOUDFLARE_API_TOKEN`, alongside `CLOUDFLARE_ACCOUNT_ID`.

Required account-owned token permissions for this repo:

- `Cloudflare Pages: Edit`
- `Workers R2 Storage: Edit`
- `Account Settings: Read`

If you use a user-owned API token instead of an account-owned token, also include `User Details: Read` and `User Memberships: Read`. Account-owned tokens are preferred here because they act as CI service credentials rather than as copied user session state.

After replacing the secret, rerun the `Deploy Pages` workflow. The old `WRANGLER_OAUTH_CONFIG` repository secret is no longer used by these workflows.

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
