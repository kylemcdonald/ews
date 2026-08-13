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
from collections import Counter, defaultdict

import numpy as np

from db_migrations import migrate_schema


ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "ews-untracked.sqlite"
SCHEMA_PATH = ROOT_DIR / "schema.sql"
CACHE_DIR = DATA_DIR / "cache" / "adsbx"
SOURCE = "adsbx_history"

SLICE_BEGIN_MARKER = 0x0E7F7C9D
TYPE_LIST = [
    "adsb_icao",
    "adsb_icao_nt",
    "adsr_icao",
    "tisb_icao",
    "adsc",
    "mlat",
    "other",
    "mode_s",
    "adsb_other",
    "adsr_other",
    "tisb_trackfile",
    "tisb_other",
    "mode_ac",
]


def parse_args():
    parser = argparse.ArgumentParser(
        description="Aggregate ADS-B Exchange heatmap rows that use readsb non-ICAO (~hex) addresses."
    )
    parser.add_argument("--db", default=str(DB_PATH), help="SQLite database path.")
    parser.add_argument("--start-date", help="Inclusive start date in YYYY-MM-DD.")
    parser.add_argument("--end-date", help="Exclusive end date in YYYY-MM-DD.")
    parser.add_argument("--days", type=int, default=365, help="Trailing days to scan when start/end are omitted.")
    parser.add_argument("--relative-days", type=int, help="Scan the last N complete UTC days.")
    parser.add_argument("--skip-download", action="store_true", help="Use cached heatmaps only.")
    parser.add_argument("--rate-limit-seconds", type=float, default=0.5, help="Delay between download requests.")
    parser.add_argument("--max-files", type=int, help="Stop after this many heatmap files, for testing.")
    parser.add_argument("--cache-dir", default=str(CACHE_DIR), help="Heatmap cache directory.")
    parser.add_argument(
        "--latest-live",
        action="store_true",
        help="Find and ingest only the newest available heatmap slot.",
    )
    parser.add_argument(
        "--lookback-slots",
        type=int,
        default=96,
        help="How many 30-minute slots to search backward with --latest-live.",
    )
    parser.add_argument(
        "--metrics-only",
        action="store_true",
        help="Skip per-hex non_icao_activity rows and store only aggregate metrics.",
    )
    parser.add_argument(
        "--write-concurrent-metrics",
        action="store_true",
        help="Mirror airborne non-ICAO counts into concurrent_metrics for dashboard use.",
    )
    parser.add_argument(
        "--replace-live-snapshot",
        action="store_true",
        help="Replace live_snapshot with the latest parsed non-ICAO aircraft positions.",
    )
    return parser.parse_args()


def ensure_directories():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def determine_date_range(args):
    today = dt.datetime.now(dt.timezone.utc).date()

    if args.start_date and args.end_date:
        return dt.date.fromisoformat(args.start_date), dt.date.fromisoformat(args.end_date)

    if args.relative_days is not None:
        end_date = today
        return end_date - dt.timedelta(days=args.relative_days), end_date

    end_date = today
    return end_date - dt.timedelta(days=args.days), end_date


def open_db(path):
    pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA_PATH.read_text("utf8"))
    migrate_schema(connection)
    return connection


def cache_path_for(cache_dir, date_value, index):
    return cache_dir / f"{date_value.year:04d}" / f"{date_value.month:02d}" / f"{date_value.day:02d}" / f"{index:02d}.bin.ttf"


def heatmap_url_for(date_value, index):
    return (
        f"https://globe.adsbexchange.com/globe_history/"
        f"{date_value.year:04d}/{date_value.month:02d}/{date_value.day:02d}/heatmap/{index:02d}.bin.ttf"
    )


def floor_to_half_hour(value):
    minute = 30 if value.minute >= 30 else 0
    return value.replace(minute=minute, second=0, microsecond=0)


def slot_index_for(timestamp):
    return timestamp.hour * 2 + (1 if timestamp.minute >= 30 else 0)


def choose_latest_heatmap(cache_dir, lookback_slots, skip_download, rate_limit_seconds):
    latest_slot = floor_to_half_hour(dt.datetime.now(dt.timezone.utc))
    last_error = None

    for offset in range(lookback_slots + 1):
        candidate = latest_slot - dt.timedelta(minutes=30 * offset)
        destination = cache_path_for(cache_dir, candidate.date(), slot_index_for(candidate))
        try:
            if skip_download:
                available = destination.exists()
            else:
                available = download_heatmap(candidate.date(), slot_index_for(candidate), destination, rate_limit_seconds)
        except Exception as error:  # pragma: no cover - defensive network handling
            last_error = error
            continue

        if not available:
            continue

        return {
            "slot": candidate,
            "slot_key": f"{candidate.date().isoformat()}:{slot_index_for(candidate):02d}",
            "url": heatmap_url_for(candidate.date(), slot_index_for(candidate)),
            "cache_path": destination,
            "used_cache": destination.exists(),
        }

    if last_error:
        raise last_error

    raise FileNotFoundError("No recent ADS-B Exchange heatmap file was available in the requested lookback window.")


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
                print(f"Skipping {heatmap_url_for(date_value, index)} after HTTP failures: {error}", file=sys.stderr)
                return None
        except (TimeoutError, urllib.error.URLError, OSError) as error:
            if attempt == max_retries:
                print(f"Skipping {heatmap_url_for(date_value, index)} after download failures: {error}", file=sys.stderr)
                return None
        time.sleep(min(5, attempt))

    time.sleep(rate_limit_seconds)
    return True


def point_to_non_icao_hex(point0_u):
    return f"~{point0_u & 0xFFFFFF:06x}"


def decode_callsign(points_u8, point_offset):
    if points_u8[point_offset] == 0:
        return None
    return "".join(chr(points_u8[point_offset + offset]) for offset in range(8)).strip() or None


def update_altitude_bounds(summary, altitude):
    if altitude == "ground":
        return

    if summary["min_altitude_ft"] is None or altitude < summary["min_altitude_ft"]:
        summary["min_altitude_ft"] = altitude
    if summary["max_altitude_ft"] is None or altitude > summary["max_altitude_ft"]:
        summary["max_altitude_ft"] = altitude


def new_summary(hex_value, message_type):
    return {
        "hex": hex_value,
        "message_type": message_type,
        "observation_count": 0,
        "airborne_observation_count": 0,
        "first_lat": None,
        "first_lon": None,
        "last_lat": None,
        "last_lon": None,
        "min_altitude_ft": None,
        "max_altitude_ft": None,
        "max_ground_speed_kt": None,
        "flight": None,
        "squawk": None,
    }


def parse_non_icao_heatmap(filename):
    raw = pathlib.Path(filename).read_bytes()
    points_u8 = np.frombuffer(raw, dtype=np.uint8)
    points_u = points_u8.view(np.uint32)
    points = points_u8.view(np.int32)

    index = 0
    while index < len(points) and int(points_u[index]) != SLICE_BEGIN_MARKER:
        index += 1

    sampled_at = None
    summaries = {}

    while index < len(points):
        now = int(points_u[index + 2]) / 1000 + int(points_u[index + 1]) * 4294967.296
        sampled_at = dt.datetime.fromtimestamp(now, tz=dt.timezone.utc)
        index += 4

        while index < len(points) and int(points_u[index]) != SLICE_BEGIN_MARKER:
            point0_u = int(points_u[index])
            if not point0_u & 0x1000000:
                index += 4
                continue

            point1_u = int(points_u[index + 1])
            point1 = int(points[index + 1])
            point2 = int(points[index + 2])
            hex_value = point_to_non_icao_hex(point0_u)
            type_index = (point0_u >> 27) & 0x1F
            message_type = TYPE_LIST[type_index] if type_index < len(TYPE_LIST) else "unknown"
            key = (hex_value, message_type)
            summary = summaries.setdefault(key, new_summary(hex_value, message_type))

            if point1_u > 1073741824:
                flight = decode_callsign(points_u8, 4 * (index + 2))
                squawk = str(point1_u & 0xFFFF).zfill(4)
                summary["flight"] = summary["flight"] or flight
                summary["squawk"] = summary["squawk"] or squawk
                summary["observation_count"] += 1
                index += 4
                continue

            point3 = int(points[index + 3])
            altitude = point3 & 65535
            if altitude & 32768:
                altitude |= -65536
            if altitude == -123:
                altitude = "ground"
            else:
                altitude *= 25

            ground_speed = point3 >> 16
            ground_speed = None if ground_speed == -1 else ground_speed / 10
            lat = point1 / 1e6
            lon = point2 / 1e6

            summary["observation_count"] += 1
            if altitude != "ground":
                summary["airborne_observation_count"] += 1
            if summary["first_lat"] is None:
                summary["first_lat"] = lat
                summary["first_lon"] = lon
            summary["last_lat"] = lat
            summary["last_lon"] = lon
            update_altitude_bounds(summary, altitude)
            if ground_speed is not None:
                summary["max_ground_speed_kt"] = max(summary["max_ground_speed_kt"] or 0, ground_speed)
            index += 4

    return sampled_at, list(summaries.values())


def prefix_counts(summaries):
    counts = Counter()
    for summary in summaries:
        counts[summary["hex"][1:3]] += 1
    return counts.most_common(20)


def build_metric_row(sampled_at_iso, summaries):
    airborne_hexes = {
        summary["hex"]
        for summary in summaries
        if summary["airborne_observation_count"] > 0
    }
    type_counts = Counter()
    for summary in summaries:
        type_counts[summary["message_type"]] += summary["observation_count"]

    return {
        "sampled_at": sampled_at_iso,
        "unique_hex_count": len({summary["hex"] for summary in summaries}),
        "airborne_unique_hex_count": len(airborne_hexes),
        "observation_count": sum(summary["observation_count"] for summary in summaries),
        "airborne_observation_count": sum(summary["airborne_observation_count"] for summary in summaries),
        "message_type_counts_json": json.dumps(dict(sorted(type_counts.items())), separators=(",", ":")),
        "top_prefix_counts_json": json.dumps(prefix_counts(summaries), separators=(",", ":")),
        "source": SOURCE,
    }


def build_top_prefix_counts_from_hexes(hex_values):
    counts = Counter()
    for hex_value in hex_values:
        counts[hex_value[1:3]] += 1
    return counts.most_common(20)


def parse_non_icao_metric_heatmap(filename):
    raw = pathlib.Path(filename).read_bytes()
    points_u8 = np.frombuffer(raw, dtype=np.uint8)
    points_u = points_u8.view(np.uint32)
    points = points_u8.view(np.int32)

    index = 0
    while index < len(points) and int(points_u[index]) != SLICE_BEGIN_MARKER:
        index += 1

    sampled_at = None
    unique_hexes = set()
    airborne_unique_hexes = set()
    message_type_counts = Counter()
    observation_count = 0
    airborne_observation_count = 0
    peak_airborne_unique_hex_count = 0

    while index < len(points):
        now = int(points_u[index + 2]) / 1000 + int(points_u[index + 1]) * 4294967.296
        sampled_at = dt.datetime.fromtimestamp(now, tz=dt.timezone.utc)
        index += 4
        slice_airborne_hexes = set()

        while index < len(points) and int(points_u[index]) != SLICE_BEGIN_MARKER:
            point0_u = int(points_u[index])
            if not point0_u & 0x1000000:
                index += 4
                continue

            hex_value = point_to_non_icao_hex(point0_u)
            type_index = (point0_u >> 27) & 0x1F
            message_type = TYPE_LIST[type_index] if type_index < len(TYPE_LIST) else "unknown"
            unique_hexes.add(hex_value)
            message_type_counts[message_type] += 1
            observation_count += 1

            point1_u = int(points_u[index + 1])
            if point1_u > 1073741824:
                index += 4
                continue

            point3 = int(points[index + 3])
            altitude = point3 & 65535
            if altitude & 32768:
                altitude |= -65536

            if altitude != -123:
                airborne_observation_count += 1
                airborne_unique_hexes.add(hex_value)
                slice_airborne_hexes.add(hex_value)

            index += 4

        peak_airborne_unique_hex_count = max(peak_airborne_unique_hex_count, len(slice_airborne_hexes))

    if sampled_at is None:
        return None, None

    sampled_at_iso = sampled_at.isoformat()
    return sampled_at, {
        "sampled_at": sampled_at_iso,
        "unique_hex_count": len(unique_hexes),
        "airborne_unique_hex_count": len(airborne_unique_hexes),
        "peak_airborne_unique_hex_count": peak_airborne_unique_hex_count,
        "observation_count": observation_count,
        "airborne_observation_count": airborne_observation_count,
        "message_type_counts_json": json.dumps(dict(sorted(message_type_counts.items())), separators=(",", ":")),
        "top_prefix_counts_json": json.dumps(
            build_top_prefix_counts_from_hexes(unique_hexes),
            separators=(",", ":"),
        ),
        "source": SOURCE,
    }


def insert_non_icao_metric_row(connection, metric_row):
    connection.execute(
        """
        INSERT INTO non_icao_metrics (
          sampled_at,
          unique_hex_count,
          airborne_unique_hex_count,
          observation_count,
          airborne_observation_count,
          message_type_counts_json,
          top_prefix_counts_json,
          source
        ) VALUES (
          :sampled_at,
          :unique_hex_count,
          :airborne_unique_hex_count,
          :observation_count,
          :airborne_observation_count,
          :message_type_counts_json,
          :top_prefix_counts_json,
          :source
        )
        """,
        metric_row,
    )


def upsert_dashboard_concurrent_metric(connection, metric_row):
    concurrent_count = metric_row.get(
        "peak_airborne_unique_hex_count",
        metric_row["airborne_unique_hex_count"],
    )
    connection.execute(
        """
        INSERT INTO concurrent_metrics (sampled_at, concurrent_count)
        VALUES (?, ?)
        ON CONFLICT(sampled_at) DO UPDATE SET
          concurrent_count = excluded.concurrent_count
        """,
        (metric_row["sampled_at"], concurrent_count),
    )


def ingest_file(connection, cache_path, metrics_only=False, write_concurrent_metrics=False):
    if metrics_only:
        sampled_at, metric_row = parse_non_icao_metric_heatmap(cache_path)
        if sampled_at is None:
            return 0, 0, None

        sampled_at_iso = metric_row["sampled_at"]
        connection.execute(
            "DELETE FROM non_icao_metrics WHERE sampled_at = ? AND source = ?",
            (sampled_at_iso, SOURCE),
        )
        insert_non_icao_metric_row(connection, metric_row)
        if write_concurrent_metrics:
            upsert_dashboard_concurrent_metric(connection, metric_row)

        return metric_row["unique_hex_count"], metric_row["observation_count"], {
            "sampled_at": sampled_at_iso,
            "cache_path": str(cache_path),
            "airborne_unique_hex_count": metric_row["airborne_unique_hex_count"],
            "peak_airborne_unique_hex_count": metric_row["peak_airborne_unique_hex_count"],
        }

    sampled_at, summaries = parse_non_icao_heatmap(cache_path)
    if sampled_at is None:
        return 0, 0, None

    sampled_at_iso = sampled_at.isoformat()
    if not metrics_only:
        connection.execute(
            "DELETE FROM non_icao_activity WHERE sampled_at = ? AND source = ?",
            (sampled_at_iso, SOURCE),
        )
    connection.execute(
        "DELETE FROM non_icao_metrics WHERE sampled_at = ? AND source = ?",
        (sampled_at_iso, SOURCE),
    )

    activity_rows = [
        {
            "sampled_at": sampled_at_iso,
            "source": SOURCE,
            **summary,
        }
        for summary in summaries
    ]
    if activity_rows and not metrics_only:
        connection.executemany(
            """
            INSERT INTO non_icao_activity (
              sampled_at,
              hex,
              message_type,
              observation_count,
              airborne_observation_count,
              first_lat,
              first_lon,
              last_lat,
              last_lon,
              min_altitude_ft,
              max_altitude_ft,
              max_ground_speed_kt,
              flight,
              squawk,
              source
            ) VALUES (
              :sampled_at,
              :hex,
              :message_type,
              :observation_count,
              :airborne_observation_count,
              :first_lat,
              :first_lon,
              :last_lat,
              :last_lon,
              :min_altitude_ft,
              :max_altitude_ft,
              :max_ground_speed_kt,
              :flight,
              :squawk,
              :source
            )
            """,
            activity_rows,
        )

    metric_row = build_metric_row(sampled_at_iso, summaries)
    insert_non_icao_metric_row(connection, metric_row)
    if write_concurrent_metrics:
        upsert_dashboard_concurrent_metric(connection, metric_row)

    return len(summaries), sum(summary["observation_count"] for summary in summaries), {
        "sampled_at": sampled_at_iso,
        "cache_path": str(cache_path),
        "airborne_unique_hex_count": metric_row["airborne_unique_hex_count"],
    }


def set_meta(connection, key, value):
    connection.execute(
        """
        INSERT INTO meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value
        """,
        (key, str(value)),
    )


def build_live_snapshot_rows(sampled_at_iso, summaries):
    rows_by_hex = {}
    for summary in summaries:
        if summary["airborne_observation_count"] <= 0:
            continue
        if summary["last_lat"] is None or summary["last_lon"] is None:
            continue

        existing = rows_by_hex.get(summary["hex"])
        if existing and existing["observation_count"] >= summary["observation_count"]:
            continue

        altitude_ft = summary["max_altitude_ft"]
        if summary["min_altitude_ft"] is not None and summary["max_altitude_ft"] is not None:
            altitude_ft = (summary["min_altitude_ft"] + summary["max_altitude_ft"]) / 2

        rows_by_hex[summary["hex"]] = {
            "hex": summary["hex"],
            "registration": None,
            "label": f"{summary['hex']} {summary['message_type']}",
            "observed_at": sampled_at_iso,
            "lat": summary["last_lat"],
            "lon": summary["last_lon"],
            "altitude_ft": altitude_ft,
            "ground_speed_kt": summary["max_ground_speed_kt"],
            "track": None,
            "is_airborne": 1,
            "source": "adsbx_heatmap",
            "observation_count": summary["observation_count"],
        }

    return sorted(rows_by_hex.values(), key=lambda row: row["hex"])


def parse_latest_non_icao_snapshot(cache_path):
    raw = pathlib.Path(cache_path).read_bytes()
    points_u8 = np.frombuffer(raw, dtype=np.uint8)
    points_u = points_u8.view(np.uint32)
    points = points_u8.view(np.int32)

    index = 0
    while index < len(points) and int(points_u[index]) != SLICE_BEGIN_MARKER:
        index += 1

    latest_sampled_at = None
    peak_rows = []

    while index < len(points):
        now = int(points_u[index + 2]) / 1000 + int(points_u[index + 1]) * 4294967.296
        sampled_at = dt.datetime.fromtimestamp(now, tz=dt.timezone.utc)
        index += 4
        rows_by_hex = {}

        while index < len(points) and int(points_u[index]) != SLICE_BEGIN_MARKER:
            point0_u = int(points_u[index])
            if not point0_u & 0x1000000:
                index += 4
                continue

            point1_u = int(points_u[index + 1])
            if point1_u > 1073741824:
                index += 4
                continue

            point1 = int(points[index + 1])
            point2 = int(points[index + 2])
            point3 = int(points[index + 3])
            altitude = point3 & 65535
            if altitude & 32768:
                altitude |= -65536
            if altitude == -123:
                index += 4
                continue
            altitude *= 25

            ground_speed = point3 >> 16
            ground_speed = None if ground_speed == -1 else ground_speed / 10
            hex_value = point_to_non_icao_hex(point0_u)
            type_index = (point0_u >> 27) & 0x1F
            message_type = TYPE_LIST[type_index] if type_index < len(TYPE_LIST) else "unknown"
            rows_by_hex[hex_value] = {
                "hex": hex_value,
                "registration": None,
                "label": f"{hex_value} {message_type}",
                "observed_at": sampled_at.isoformat(),
                "lat": point1 / 1e6,
                "lon": point2 / 1e6,
                "altitude_ft": altitude,
                "ground_speed_kt": ground_speed,
                "track": None,
                "is_airborne": 1,
                "source": "adsbx_heatmap",
            }
            index += 4

        latest_sampled_at = sampled_at
        if len(rows_by_hex) > len(peak_rows):
            peak_rows = sorted(rows_by_hex.values(), key=lambda row: row["hex"])

    if latest_sampled_at is None:
        return None, []

    return latest_sampled_at.isoformat(), peak_rows


def replace_live_snapshot(connection, cache_path):
    sampled_at_iso, snapshot_rows = parse_latest_non_icao_snapshot(cache_path)
    if sampled_at_iso is None:
        return None

    connection.execute("DELETE FROM live_snapshot WHERE source != 'demo'")
    if snapshot_rows:
        connection.executemany(
            """
            INSERT INTO live_snapshot (
              hex,
              registration,
              label,
              observed_at,
              lat,
              lon,
              altitude_ft,
              ground_speed_kt,
              track,
              is_airborne,
              source
            ) VALUES (
              :hex,
              :registration,
              :label,
              :observed_at,
              :lat,
              :lon,
              :altitude_ft,
              :ground_speed_kt,
              :track,
              :is_airborne,
              :source
            )
            """,
            snapshot_rows,
        )

    set_meta(connection, "cohort_source", "non_icao_untracked")
    set_meta(connection, "adsbx_heatmap_sampled_at", sampled_at_iso)
    set_meta(connection, "adsbx_heatmap_cache_path", str(cache_path))
    set_meta(connection, "adsbx_heatmap_status", json.dumps({
        "provider": "adsbx_heatmap",
        "providerLabel": "ADS-B Exchange heatmap",
        "cadenceMinutes": 30,
        "refreshing": False,
        "nextRefreshAt": None,
        "lastAttemptAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "lastSuccessAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "lastError": None,
        "latestSampledAt": sampled_at_iso,
        "cachePath": str(cache_path),
        "matchedCount": len(snapshot_rows),
        "airborneCount": len(snapshot_rows),
        "concurrentCount": len(snapshot_rows),
    }))
    return {
        "sampled_at": sampled_at_iso,
        "snapshot_rows": len(snapshot_rows),
    }


def scan_range(
    connection,
    cache_dir,
    start_date,
    end_date,
    skip_download,
    rate_limit_seconds,
    max_files=None,
    metrics_only=False,
    write_concurrent_metrics=False,
):
    total_files = (end_date - start_date).days * 48
    processed_files = 0
    parsed_files = 0
    activity_rows = 0
    observation_count = 0
    latest_parsed_file = None

    for day_offset in range((end_date - start_date).days):
        date_value = start_date + dt.timedelta(days=day_offset)
        for index in range(48):
            if max_files is not None and processed_files >= max_files:
                return parsed_files, activity_rows, observation_count

            processed_files += 1
            destination = cache_path_for(cache_dir, date_value, index)
            if not skip_download:
                available = download_heatmap(date_value, index, destination, rate_limit_seconds)
                if not available:
                    continue
            elif not destination.exists():
                continue

            try:
                file_activity_rows, file_observation_count, parsed_file = ingest_file(
                    connection,
                    destination,
                    metrics_only=metrics_only,
                    write_concurrent_metrics=write_concurrent_metrics,
                )
            except Exception as error:  # pragma: no cover - defensive parser handling
                print(f"Could not parse {destination}: {error}", file=sys.stderr)
                continue

            parsed_files += 1
            activity_rows += file_activity_rows
            observation_count += file_observation_count
            latest_parsed_file = parsed_file or latest_parsed_file
            if processed_files % 48 == 0:
                print(f"Processed {processed_files}/{total_files} heatmap files", file=sys.stderr)

    return parsed_files, activity_rows, observation_count, latest_parsed_file


def summarize_top_patterns(connection, start_date, end_date):
    rows = connection.execute(
        """
        SELECT
          hex,
          SUM(observation_count) AS observations,
          COUNT(DISTINCT sampled_at) AS slots,
          COUNT(*) AS type_rows
        FROM non_icao_activity
        WHERE sampled_at >= ?
          AND sampled_at < ?
          AND source = ?
        GROUP BY hex
        ORDER BY observations DESC
        LIMIT 20
        """,
        (f"{start_date.isoformat()}T00:00:00+00:00", f"{end_date.isoformat()}T00:00:00+00:00", SOURCE),
    ).fetchall()
    return [dict(row) for row in rows]


def main():
    args = parse_args()
    ensure_directories()
    connection = open_db(args.db)
    cache_dir = pathlib.Path(args.cache_dir)

    if args.latest_live:
        connection.execute(
            """
            INSERT INTO ingestion_runs (run_type, started_at, status, details)
            VALUES (?, ?, ?, ?)
            """,
            (
                "non_icao_latest_live",
                dt.datetime.now(dt.timezone.utc).isoformat(),
                "running",
                json.dumps({"lookback_slots": args.lookback_slots, "cache_dir": str(cache_dir)}),
            ),
        )
        run_id = connection.execute("SELECT last_insert_rowid()").fetchone()[0]

        try:
            selected = choose_latest_heatmap(
                cache_dir,
                args.lookback_slots,
                args.skip_download,
                args.rate_limit_seconds,
            )
            activity_rows, observation_count, latest_parsed_file = ingest_file(
                connection,
                selected["cache_path"],
                metrics_only=True,
                write_concurrent_metrics=True,
            )
            live_snapshot = replace_live_snapshot(connection, selected["cache_path"])
            connection.execute(
                "UPDATE ingestion_runs SET finished_at = ?, status = ?, details = ? WHERE id = ?",
                (
                    dt.datetime.now(dt.timezone.utc).isoformat(),
                    "completed",
                    json.dumps(
                        {
                            "selected": {
                                "slot": selected["slot"].isoformat(),
                                "slot_key": selected["slot_key"],
                                "url": selected["url"],
                                "cache_path": str(selected["cache_path"]),
                                "used_cache": selected["used_cache"],
                            },
                            "activity_rows": activity_rows,
                            "observation_count": observation_count,
                            "latest_parsed_file": latest_parsed_file,
                            "live_snapshot": live_snapshot,
                        },
                        separators=(",", ":"),
                    ),
                    run_id,
                ),
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

        print(
            json.dumps(
                {
                    "ok": True,
                    "latestSampledAt": latest_parsed_file["sampled_at"] if latest_parsed_file else None,
                    "latestSlotKey": selected["slot_key"],
                    "latestUrl": selected["url"],
                    "cachePath": str(selected["cache_path"]),
                    "usedCache": selected["used_cache"],
                    "airborneCount": latest_parsed_file["peak_airborne_unique_hex_count"]
                    if latest_parsed_file
                    else 0,
                    "concurrentCount": latest_parsed_file["peak_airborne_unique_hex_count"]
                    if latest_parsed_file
                    else 0,
                    "liveSnapshotCount": live_snapshot["snapshot_rows"] if live_snapshot else 0,
                }
            )
        )
        return

    start_date, end_date = determine_date_range(args)
    if start_date >= end_date:
        raise ValueError("Start date must be before end date.")

    range_start_iso = f"{start_date.isoformat()}T00:00:00+00:00"
    range_end_iso = f"{end_date.isoformat()}T00:00:00+00:00"
    if args.write_concurrent_metrics:
        connection.execute(
            """
            DELETE FROM concurrent_metrics
            WHERE sampled_at >= ?
              AND sampled_at < ?
            """,
            (range_start_iso, range_end_iso),
        )
    if args.metrics_only:
        connection.execute(
            """
            DELETE FROM non_icao_metrics
            WHERE sampled_at >= ?
              AND sampled_at < ?
              AND source = ?
            """,
            (range_start_iso, range_end_iso, SOURCE),
        )
    connection.execute(
        """
        INSERT INTO ingestion_runs (run_type, started_at, status, details)
        VALUES (?, ?, ?, ?)
        """,
        (
            "non_icao_scan",
            dt.datetime.now(dt.timezone.utc).isoformat(),
            "running",
                json.dumps({"start_date": start_date.isoformat(), "end_date": end_date.isoformat()}),
        ),
    )
    run_id = connection.execute("SELECT last_insert_rowid()").fetchone()[0]

    try:
        parsed_files, activity_rows, observation_count, latest_parsed_file = scan_range(
            connection,
            cache_dir,
            start_date,
            end_date,
            args.skip_download,
            args.rate_limit_seconds,
            args.max_files,
            metrics_only=args.metrics_only,
            write_concurrent_metrics=args.write_concurrent_metrics,
        )
        live_snapshot = replace_live_snapshot(
            connection,
            latest_parsed_file["cache_path"],
        ) if args.replace_live_snapshot and latest_parsed_file else None
        top_patterns = [] if args.metrics_only else summarize_top_patterns(connection, start_date, end_date)
        connection.execute(
            "UPDATE ingestion_runs SET finished_at = ?, status = ?, details = ? WHERE id = ?",
            (
                dt.datetime.now(dt.timezone.utc).isoformat(),
                "completed",
                json.dumps(
                    {
                        "start_date": start_date.isoformat(),
                        "end_date": end_date.isoformat(),
                        "parsed_files": parsed_files,
                        "activity_rows": activity_rows,
                        "observation_count": observation_count,
                        "latest_parsed_file": latest_parsed_file,
                        "live_snapshot": live_snapshot,
                        "top_patterns": top_patterns,
                    },
                    separators=(",", ":"),
                ),
                run_id,
            ),
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

    print(
        json.dumps(
            {
                "start_date": start_date.isoformat(),
                "end_date": end_date.isoformat(),
                "parsed_files": parsed_files,
                "activity_rows": activity_rows,
                "observation_count": observation_count,
                "latest_parsed_file": latest_parsed_file,
                "top_patterns": top_patterns,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
