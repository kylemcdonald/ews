# ADS-B Exchange history gate (October 2026)

## Symptom

Requests for `https://globe.adsbexchange.com/globe_history/...` started returning:

- `403 Historical data requires a verified session.` when a browser-like `Referer` was present
- `403 Direct access to globe history data is not permitted.` otherwise

The live map still loads, but the heatmap, trace, and replay files used by the
refresh jobs and the `adsbx-proxy` worker are blocked. The gate also applies to
the live `re-api` feed, so it is not only a historical-data problem.

## Why a login does not fix it

The page mints a short-lived session by posting a Cloudflare Turnstile token to
`POST /turnstile-token`. Automated Chromium (headless or Xvfb) cannot complete
the challenge on these hosts. Signing in with a normal ADSB Exchange account
sets `adsbx_identity` / `adsbx_identity_exp`, but the heatmap endpoint still
returns the same 403, so the account is not a substitute for the Turnstile
session.

## Workaround

`globe.adsb.fi` publishes the same standard readsb `bin.ttf` heatmap slices at
the same UTC path layout:

```text
https://globe.adsb.fi/globe_history/YYYY/MM/DD/heatmap/HH.bin.ttf
```

The file is also public, needs no login, and passes the same structural checks
(slice table plus the `0x0E7F7C9D` marker). Both projects now try ADS-B Exchange
first and fall back to `globe.adsb.fi` on `403`, `404`, or a network error.

### EWS ingestion scripts

`scripts/heatmap_source.py` owns the URL construction, validation, and fallback.
It is used by:

- `scripts/update_latest_heatmap.py`
- `scripts/backfill_history.py`
- `scripts/track_non_icao_hex.py`
- `scripts/build_masters_flight_trails.py`

Control it with `ADSBX_HEATMAP_SOURCE`:

| Value | Behaviour |
| --- | --- |
| unset / `auto` | ADS-B Exchange first, then adsb.fi |
| `adsbx` | ADS-B Exchange only |
| `adsbfi` | adsb.fi only |

The dashboard status metadata records the real source as `source: "adsbfi"` and
the URL that was actually downloaded.

### adsbx-proxy worker

`ADSBX_BASE_URL` is the primary and `ADSBX_FALLBACK_URL` is the mirror. The
worker falls back on `403`/`404` or a connection error, honours `429
Retry-After` globally, and records `last_download_source` (`adsbx` or `adsbfi`)
in `proxy-status.json`. Set `ADSBX_FALLBACK_URL=` to disable the mirror.

## Trade-offs

- The mirror is an independent community network, so aircraft coverage differs
  from ADS-B Exchange. Counts and flight inference after the cut-over reflect
  adsb.fi coverage where the primary is blocked.
- adsb.fi keeps a shorter archive than ADS-B Exchange. Very old mirror holes
  remain 404 on both sources; recent live and daily-history slots are available.
- The fallback is transparent in storage: files are still named and parsed as
  standard readsb heatmaps, so no schema or downstream parser changes were
  needed.

## Reverting

If ADS-B Exchange removes the gate or a verified session is added:

1. Set `ADSBX_HEATMAP_SOURCE=adsbx` for EWS and `ADSBX_FALLBACK_URL=` for
   `adsbx-proxy`.
2. Re-run the normal live refresh; no database migration is required.
3. Watch the first few runs for `source: "adsbx"` / `last_download_source:
   "adsbx"` before removing the mirror configuration.
