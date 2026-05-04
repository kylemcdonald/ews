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


ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "ews.sqlite"
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
    return connection


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

    request = urllib.request.Request(heatmap_url_for(date_value, index), headers={"User-Agent": "Mozilla/5.0"})
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


def ingest_file(connection, cache_path):
    sampled_at, summaries = parse_non_icao_heatmap(cache_path)
    if sampled_at is None:
        return 0, 0

    sampled_at_iso = sampled_at.isoformat()
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
    if activity_rows:
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
        build_metric_row(sampled_at_iso, summaries),
    )
    return len(summaries), sum(summary["observation_count"] for summary in summaries)


def scan_range(connection, start_date, end_date, skip_download, rate_limit_seconds, max_files=None):
    total_files = (end_date - start_date).days * 48
    processed_files = 0
    parsed_files = 0
    activity_rows = 0
    observation_count = 0

    for day_offset in range((end_date - start_date).days):
        date_value = start_date + dt.timedelta(days=day_offset)
        for index in range(48):
            if max_files is not None and processed_files >= max_files:
                return parsed_files, activity_rows, observation_count

            processed_files += 1
            destination = cache_path_for(date_value, index)
            if not skip_download:
                available = download_heatmap(date_value, index, destination, rate_limit_seconds)
                if not available:
                    continue
            elif not destination.exists():
                continue

            try:
                file_activity_rows, file_observation_count = ingest_file(connection, destination)
            except Exception as error:  # pragma: no cover - defensive parser handling
                print(f"Could not parse {destination}: {error}", file=sys.stderr)
                continue

            parsed_files += 1
            activity_rows += file_activity_rows
            observation_count += file_observation_count
            if processed_files % 48 == 0:
                print(f"Processed {processed_files}/{total_files} heatmap files", file=sys.stderr)

    return parsed_files, activity_rows, observation_count


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
    start_date, end_date = determine_date_range(args)
    if start_date >= end_date:
        raise ValueError("Start date must be before end date.")

    connection = open_db(args.db)
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
        parsed_files, activity_rows, observation_count = scan_range(
            connection,
            start_date,
            end_date,
            args.skip_download,
            args.rate_limit_seconds,
            args.max_files,
        )
        top_patterns = summarize_top_patterns(connection, start_date, end_date)
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
                "top_patterns": top_patterns,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
