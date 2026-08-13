#!/usr/bin/env python3

import argparse
import datetime as dt
import json
import pathlib
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from parse_heatmap import parse_heatmap, str_to_point
from db_migrations import migrate_schema


ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
DATA_DIR = ROOT_DIR / "data"
CONFIG_DIR = ROOT_DIR / "config"
DB_PATH = DATA_DIR / "ews-main.sqlite"
SCHEMA_PATH = ROOT_DIR / "schema.sql"
CACHE_DIR = DATA_DIR / "cache" / "adsbx"


def parse_args():
    parser = argparse.ArgumentParser(description="Backfill ADS-B Exchange heatmap data into SQLite.")
    parser.add_argument(
        "--watchlist",
        help="Optional path to watchlist JSON file. If omitted, tracked aircraft are loaded from SQLite.",
    )
    parser.add_argument("--db", default=str(DB_PATH), help="SQLite database path.")
    parser.add_argument("--start-date", help="Inclusive start date in YYYY-MM-DD.")
    parser.add_argument("--end-date", help="Exclusive end date in YYYY-MM-DD.")
    parser.add_argument("--days", type=int, default=365, help="Number of trailing days to backfill when start/end are omitted.")
    parser.add_argument("--relative-days", type=int, help="Backfill the last N complete UTC days.")
    parser.add_argument("--skip-download", action="store_true", help="Use cached heatmaps only.")
    parser.add_argument("--keep-cache", action="store_true", help="Keep downloaded heatmap files after parsing.")
    parser.add_argument("--rate-limit-seconds", type=float, default=0.5, help="Delay between download requests.")
    return parser.parse_args()


def ensure_directories():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def load_watchlist(path):
    watchlist_path = pathlib.Path(path)
    if not watchlist_path.exists():
        raise FileNotFoundError(
            f"Watchlist not found at {watchlist_path}. Copy {CONFIG_DIR / 'watchlist.example.json'} first."
        )

    entries = json.loads(watchlist_path.read_text("utf8"))
    if not isinstance(entries, list):
        raise ValueError("Watchlist JSON must be an array.")

    normalized = []
    for index, entry in enumerate(entries):
        hex_value = str(entry.get("hex", "")).strip().lower().replace("0x", "").replace("~", "")
        if len(hex_value) != 6 or any(char not in "0123456789abcdef" for char in hex_value):
            raise ValueError(f"Watchlist entry {index + 1} has an invalid hex code: {entry.get('hex')}")
        normalized.append(
            {
                "hex": hex_value,
                "registration": str(entry.get("registration", "")).strip().upper() or None,
                "label": str(entry.get("label", "")).strip() or None,
                "source": "local_watchlist",
                "notes": str(entry.get("notes", "")).strip() or None,
            }
        )

    return normalized


def determine_date_range(args):
    today = dt.datetime.now(dt.timezone.utc).date()

    if args.start_date and args.end_date:
        start_date = dt.date.fromisoformat(args.start_date)
        end_date = dt.date.fromisoformat(args.end_date)
        return start_date, end_date

    if args.relative_days is not None:
        end_date = today
        start_date = end_date - dt.timedelta(days=args.relative_days)
        return start_date, end_date

    end_date = today
    start_date = end_date - dt.timedelta(days=args.days)
    return start_date, end_date


def open_db(path):
    pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA_PATH.read_text("utf8"))
    migrate_schema(connection)
    return connection


def load_tracking_entries_from_db(connection):
    rows = connection.execute(
        """
        SELECT hex, registration, label, source, notes
        FROM tracked_aircraft
        WHERE source != 'demo'
        ORDER BY hex ASC
        """
    ).fetchall()

    return [dict(row) for row in rows]


def upsert_watchlist(connection, entries):
    connection.executemany(
        """
        INSERT INTO tracked_aircraft (hex, registration, label, source, notes)
        VALUES (:hex, :registration, :label, :source, :notes)
        ON CONFLICT(hex) DO UPDATE SET
          registration = excluded.registration,
          label = excluded.label,
          source = excluded.source,
          notes = excluded.notes
        """,
        entries,
    )


def purge_demo_state(connection):
    deleted = connection.execute("DELETE FROM tracked_aircraft WHERE source = 'demo'").rowcount
    connection.execute("DELETE FROM observations WHERE source = 'demo'")
    connection.execute("DELETE FROM live_snapshot WHERE source = 'demo'")

    if deleted:
        connection.execute("DELETE FROM concurrent_metrics")
        connection.execute("DELETE FROM daily_metrics")


def cache_path_for(date_value, index):
    return CACHE_DIR / f"{date_value.year:04d}" / f"{date_value.month:02d}" / f"{date_value.day:02d}" / f"{index:02d}.bin.ttf"


def heatmap_url_for(date_value, index):
    return (
        f"https://globe.adsbexchange.com/globe_history/"
        f"{date_value.year:04d}/{date_value.month:02d}/{date_value.day:02d}/heatmap/{index:02d}.bin.ttf"
    )


def download_heatmap(date_value, index, destination, rate_limit_seconds, timeout_seconds=120, max_retries=4):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        return True

    request = urllib.request.Request(
        heatmap_url_for(date_value, index),
        headers={"User-Agent": "Mozilla/5.0", "Referer": "https://globe.adsbexchange.com/"},
    )

    for attempt in range(1, max_retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                destination.write_bytes(response.read())
            break
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return False
            if attempt == max_retries:
                print(
                    f"Skipping {heatmap_url_for(date_value, index)} after {max_retries} HTTP failures: {error}",
                    file=sys.stderr,
                )
                return None
        except (TimeoutError, urllib.error.URLError, OSError) as error:
            if attempt == max_retries:
                print(
                    f"Skipping {heatmap_url_for(date_value, index)} after {max_retries} download failures: {error}",
                    file=sys.stderr,
                )
                return None

        time.sleep(min(5, attempt))

    time.sleep(rate_limit_seconds)
    return True


def ingest_metrics(connection, tracked_by_hex, start_date, end_date, skip_download, rate_limit_seconds, keep_cache):
    tracked_hex_filter = {str_to_point(hex_value) for hex_value in tracked_by_hex}
    range_start_iso = f"{start_date.isoformat()}T00:00:00+00:00"
    range_end_iso = f"{end_date.isoformat()}T00:00:00+00:00"
    recompute_start = dt.datetime.combine(start_date, dt.time.min, tzinfo=dt.timezone.utc)
    connection.execute(
        """
        DELETE FROM observations
        WHERE source = 'adsbx_history'
          AND observed_at >= ?
          AND observed_at < ?
        """,
        (range_start_iso, range_end_iso),
    )
    connection.execute(
        """
        DELETE FROM concurrent_metrics
        WHERE sampled_at >= ?
          AND sampled_at < ?
        """,
        (range_start_iso, range_end_iso),
    )
    connection.execute(
        """
        DELETE FROM daily_metrics
        WHERE day >= ?
          AND day < ?
        """,
        (start_date.isoformat(), end_date.isoformat()),
    )
    total_files = (end_date - start_date).days * 48
    processed_files = 0
    concurrent_rows = []
    daily_rows_by_day = {}
    current_day = None
    day_unique = set()
    day_peak_concurrent = 0
    day_sample_count = 0

    def flush_day(day_value):
        nonlocal day_unique, day_peak_concurrent, day_sample_count
        daily_rows_by_day[day_value] = {
            "day": day_value,
            "unique_airborne_count": len(day_unique),
            "peak_concurrent_count": day_peak_concurrent,
            "sample_count": day_sample_count,
        }
        day_unique = set()
        day_peak_concurrent = 0
        day_sample_count = 0

    for day_offset in range((end_date - start_date).days):
        date_value = start_date + dt.timedelta(days=day_offset)
        for index in range(48):
            processed_files += 1
            destination = cache_path_for(date_value, index)
            if not skip_download:
                available = download_heatmap(date_value, index, destination, rate_limit_seconds)
                if not available:
                    continue
            elif not destination.exists():
                continue

            try:
                slices = parse_heatmap(str(destination), return_callsigns=False, hex_filter=tracked_hex_filter)
            except Exception as error:  # pragma: no cover - defensive parser handling
                print(f"Could not parse {destination}: {error}", file=sys.stderr)
                continue
            finally:
                if destination.exists() and not keep_cache and not skip_download:
                    destination.unlink()

            file_active_hexes = set()
            file_peak_concurrent = 0
            file_timestamp = None

            for heatmap_slice in slices:
                slice_active_hexes = set()
                for telemetry in heatmap_slice.telemetry:
                    if telemetry.alt == "ground":
                        continue

                    hex_value = telemetry.hex.lower()
                    slice_active_hexes.add(hex_value)

                if not slice_active_hexes:
                    continue

                file_active_hexes.update(slice_active_hexes)
                file_peak_concurrent = max(file_peak_concurrent, len(slice_active_hexes))
                file_timestamp = heatmap_slice.timestamp

            if not file_active_hexes or file_timestamp is None:
                if processed_files % 48 == 0:
                    print(f"Processed {processed_files}/{total_files} heatmap files", file=sys.stderr)
                continue

            timestamp = file_timestamp
            if timestamp >= recompute_start:
                concurrent_rows.append(
                    {
                        "sampled_at": timestamp.isoformat(),
                        "concurrent_count": file_peak_concurrent,
                    }
                )

            day_value = timestamp.date().isoformat()
            if current_day is None:
                current_day = day_value
            elif day_value != current_day:
                flush_day(current_day)
                current_day = day_value

            day_unique.update(file_active_hexes)
            day_peak_concurrent = max(day_peak_concurrent, file_peak_concurrent)
            day_sample_count += 1

            if processed_files % 48 == 0:
                print(f"Processed {processed_files}/{total_files} heatmap files", file=sys.stderr)

    if current_day is not None:
        flush_day(current_day)

    if concurrent_rows:
        connection.executemany(
            """
            INSERT INTO concurrent_metrics (sampled_at, concurrent_count)
            VALUES (:sampled_at, :concurrent_count)
            """,
            concurrent_rows,
        )

    final_daily_rows = []
    for offset in range((end_date - start_date).days):
        day_value = (start_date + dt.timedelta(days=offset)).isoformat()
        final_daily_rows.append(
            daily_rows_by_day.get(
                day_value,
                {
                    "day": day_value,
                    "unique_airborne_count": 0,
                    "peak_concurrent_count": 0,
                    "sample_count": 0,
                },
            )
        )

    connection.executemany(
        """
        INSERT INTO daily_metrics (
          day,
          unique_airborne_count,
          peak_concurrent_count,
          sample_count
        ) VALUES (
          :day,
          :unique_airborne_count,
          :peak_concurrent_count,
          :sample_count
        )
        """,
        final_daily_rows,
    )


def main():
    args = parse_args()
    ensure_directories()
    start_date, end_date = determine_date_range(args)

    if start_date >= end_date:
        raise ValueError("Start date must be before end date.")

    connection = open_db(args.db)
    if args.watchlist:
        tracked_entries = load_watchlist(args.watchlist)
        tracking_mode = "watchlist_file"
    else:
        tracked_entries = load_tracking_entries_from_db(connection)
        tracking_mode = "database"

    if not tracked_entries:
        raise ValueError("No tracked aircraft found. Run `npm run import:faa` first or pass --watchlist.")

    tracked_by_hex = {entry["hex"]: entry for entry in tracked_entries}
    connection.execute(
        """
        INSERT INTO ingestion_runs (run_type, started_at, status, details)
        VALUES (?, ?, ?, ?)
        """,
        ("historical_backfill", dt.datetime.now(dt.timezone.utc).isoformat(), "running", json.dumps({
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "tracked_count": len(tracked_entries),
            "tracking_mode": tracking_mode,
        })),
    )
    run_id = connection.execute("SELECT last_insert_rowid()").fetchone()[0]

    try:
        purge_demo_state(connection)
        if args.watchlist:
            upsert_watchlist(connection, tracked_entries)
        ingest_metrics(
            connection,
            tracked_by_hex,
            start_date,
            end_date,
            args.skip_download,
            args.rate_limit_seconds,
            args.keep_cache,
        )
        connection.execute(
            "UPDATE ingestion_runs SET finished_at = ?, status = ? WHERE id = ?",
            (dt.datetime.now(dt.timezone.utc).isoformat(), "completed", run_id),
        )
        connection.commit()
    except Exception:
        connection.execute(
            "UPDATE ingestion_runs SET finished_at = ?, status = ? WHERE id = ?",
            (dt.datetime.now(dt.timezone.utc).isoformat(), "failed", run_id),
        )
        connection.commit()
        raise
    finally:
        connection.close()


if __name__ == "__main__":
    main()
