#!/usr/bin/env python3

import argparse
import datetime as dt
import json
import pathlib
import sqlite3
import sys
import urllib.error
import urllib.request

from parse_heatmap import parse_heatmap
from db_migrations import migrate_schema


ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "ews.sqlite"
SCHEMA_PATH = ROOT_DIR / "schema.sql"
LIVE_CACHE_DIR = DATA_DIR / "cache" / "adsbx_live"
SOURCE = "adsbx_heatmap"
HEATMAP_STATUS_META_KEY = "adsbx_heatmap_status"
META_SLOT_KEY = "adsbx_heatmap_slot_key"
META_SAMPLED_AT = "adsbx_heatmap_sampled_at"
META_URL = "adsbx_heatmap_url"
META_CACHE_PATH = "adsbx_heatmap_cache_path"
OBSERVATION_RETENTION_HOURS = 72
RECENT_WINDOW_SLOTS = 48


def parse_args():
    parser = argparse.ArgumentParser(description="Fetch and ingest the newest available ADS-B Exchange heatmap.")
    parser.add_argument("--db", default=str(DB_PATH), help="SQLite database path.")
    parser.add_argument(
        "--lookback-slots",
        type=int,
        default=96,
        help="How many 30-minute slots to search backward when the newest heatmap is unavailable.",
    )
    parser.add_argument(
        "--fill-recent-slots",
        action="store_true",
        help="Also ingest any missing slots in the latest 24-hour window.",
    )
    parser.add_argument("--force", action="store_true", help="Re-parse even if the newest cached slot is unchanged.")
    return parser.parse_args()


def ensure_directories():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    LIVE_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def open_db(path):
    pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA_PATH.read_text("utf8"))
    migrate_schema(connection)
    return connection


def get_meta(connection, key):
    row = connection.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


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


def load_tracking_entries(connection):
    rows = connection.execute(
        """
        SELECT hex, registration, label, source, notes
        FROM tracked_aircraft
        WHERE source != 'demo'
        ORDER BY hex ASC
        """
    ).fetchall()

    return [dict(row) for row in rows]


def floor_to_half_hour(value):
    minute = 30 if value.minute >= 30 else 0
    return value.replace(minute=minute, second=0, microsecond=0)


def slot_index_for(timestamp):
    return timestamp.hour * 2 + (1 if timestamp.minute >= 30 else 0)


def slot_key_for(timestamp):
    return f"{timestamp.date().isoformat()}:{slot_index_for(timestamp):02d}"


def cache_path_for(timestamp):
    return (
        LIVE_CACHE_DIR
        / f"{timestamp.year:04d}"
        / f"{timestamp.month:02d}"
        / f"{timestamp.day:02d}"
        / f"{slot_index_for(timestamp):02d}.bin.ttf"
    )


def heatmap_url_for(timestamp):
    return (
        "https://globe.adsbexchange.com/globe_history/"
        f"{timestamp.year:04d}/{timestamp.month:02d}/{timestamp.day:02d}/heatmap/{slot_index_for(timestamp):02d}.bin.ttf"
    )


def download_heatmap(timestamp, destination, timeout_seconds=120):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        return True, True

    request = urllib.request.Request(heatmap_url_for(timestamp), headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            destination.write_bytes(response.read())
        return True, False
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False, False
        raise


def choose_latest_heatmap(now, lookback_slots):
    latest_slot = floor_to_half_hour(now)
    last_error = None

    for offset in range(lookback_slots + 1):
        candidate = latest_slot - dt.timedelta(minutes=30 * offset)
        cache_path = cache_path_for(candidate)
        try:
            available, used_cache = download_heatmap(candidate, cache_path)
        except Exception as error:  # pragma: no cover - defensive network handling
            last_error = error
            continue

        if not available:
            continue

        return {
            "slot": candidate,
            "slot_key": slot_key_for(candidate),
            "url": heatmap_url_for(candidate),
            "cache_path": cache_path,
            "used_cache": used_cache,
        }

    if last_error:
        raise last_error

    raise FileNotFoundError("No recent ADS-B Exchange heatmap file was available in the requested lookback window.")


def parse_latest_slice(cache_path):
    slices = parse_heatmap(str(cache_path), return_callsigns=False)
    if not slices:
        return None

    return max(slices, key=lambda item: item.timestamp)


def recent_sample_count(connection, latest_slot):
    window_start_iso = (latest_slot - dt.timedelta(minutes=30 * (RECENT_WINDOW_SLOTS - 1))).isoformat()
    window_end_iso = (latest_slot + dt.timedelta(minutes=30)).isoformat()
    row = connection.execute(
        """
        SELECT COUNT(*) AS sample_count
        FROM concurrent_metrics
        WHERE sampled_at >= ?
          AND sampled_at < ?
        """,
        (window_start_iso, window_end_iso),
    ).fetchone()

    return int(row["sample_count"] or 0)


def slot_already_ingested(connection, slot):
    slot_start_iso = slot.isoformat()
    slot_end_iso = (slot + dt.timedelta(minutes=30)).isoformat()
    row = connection.execute(
        """
        SELECT COUNT(*) AS sample_count
        FROM concurrent_metrics
        WHERE sampled_at >= ?
          AND sampled_at < ?
        """,
        (slot_start_iso, slot_end_iso),
    ).fetchone()

    return int(row["sample_count"] or 0) > 0


def build_recent_slots(latest_slot):
    start_slot = latest_slot - dt.timedelta(minutes=30 * (RECENT_WINDOW_SLOTS - 1))
    return [start_slot + dt.timedelta(minutes=30 * offset) for offset in range(RECENT_WINDOW_SLOTS)]


def ensure_slot_heatmap(slot):
    cache_path = cache_path_for(slot)
    available, used_cache = download_heatmap(slot, cache_path)
    if not available:
        return None

    return {
        "slot": slot,
        "slot_key": slot_key_for(slot),
        "url": heatmap_url_for(slot),
        "cache_path": cache_path,
        "used_cache": used_cache,
    }


def current_snapshot_summary(connection, sampled_at_iso):
    metrics_row = connection.execute(
        """
        SELECT concurrent_count
        FROM concurrent_metrics
        WHERE sampled_at = ?
        """,
        (sampled_at_iso,),
    ).fetchone()
    snapshot_row = connection.execute(
        """
        SELECT
          COUNT(*) AS matched_count,
          SUM(CASE WHEN is_airborne = 1 THEN 1 ELSE 0 END) AS airborne_count
        FROM live_snapshot
        WHERE source = ?
        """,
        (SOURCE,),
    ).fetchone()

    return {
        "matched_count": int(snapshot_row["matched_count"] or 0),
        "airborne_count": int(snapshot_row["airborne_count"] or 0),
        "concurrent_count": int(metrics_row["concurrent_count"] or 0) if metrics_row else 0,
    }


def normalize_float(value):
    if value is None:
        return None

    return float(value)


def normalize_altitude(value):
    if value is None or value == "ground":
        return None

    return int(value)


def ingest_slot(connection, tracked_by_hex, latest_slice, replace_live_snapshot=False):
    sampled_at_iso = latest_slice.timestamp.isoformat()
    prune_before_iso = (latest_slice.timestamp - dt.timedelta(hours=OBSERVATION_RETENTION_HOURS)).isoformat()
    snapshot_rows = []
    observation_rows = []
    airborne_hexes = set()

    for telemetry in latest_slice.telemetry:
        hex_value = telemetry.hex.lower()
        tracked_entry = tracked_by_hex.get(hex_value)
        if not tracked_entry:
            continue

        is_airborne = telemetry.alt != "ground"
        altitude_ft = normalize_altitude(telemetry.alt)
        latitude = normalize_float(telemetry.lat)
        longitude = normalize_float(telemetry.lon)
        ground_speed_kt = normalize_float(telemetry.gs)
        snapshot_rows.append(
            {
                "hex": hex_value,
                "registration": tracked_entry.get("registration"),
                "label": tracked_entry.get("label") or tracked_entry.get("registration") or hex_value.upper(),
                "observed_at": sampled_at_iso,
                "lat": latitude,
                "lon": longitude,
                "altitude_ft": altitude_ft,
                "ground_speed_kt": ground_speed_kt,
                "track": None,
                "is_airborne": 1 if is_airborne else 0,
                "source": SOURCE,
            }
        )

        if is_airborne:
            airborne_hexes.add(hex_value)
            observation_rows.append(
                {
                    "observed_at": sampled_at_iso,
                    "hex": hex_value,
                    "registration": tracked_entry.get("registration"),
                    "source": SOURCE,
                    "lat": latitude,
                    "lon": longitude,
                    "altitude_ft": altitude_ft,
                    "ground_speed_kt": ground_speed_kt,
                    "is_airborne": 1,
                }
            )

    if replace_live_snapshot:
        connection.execute("DELETE FROM live_snapshot WHERE source != 'demo'")
    connection.execute("DELETE FROM observations WHERE source = ? AND observed_at < ?", (SOURCE, prune_before_iso))
    connection.execute("DELETE FROM observations WHERE source = ? AND observed_at = ?", (SOURCE, sampled_at_iso))

    if replace_live_snapshot and snapshot_rows:
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

    if observation_rows:
        connection.executemany(
            """
            INSERT INTO observations (
              observed_at,
              hex,
              registration,
              source,
              lat,
              lon,
              altitude_ft,
              ground_speed_kt,
              is_airborne
            ) VALUES (
              :observed_at,
              :hex,
              :registration,
              :source,
              :lat,
              :lon,
              :altitude_ft,
              :ground_speed_kt,
              :is_airborne
            )
            """,
            observation_rows,
        )

    connection.execute(
        """
        INSERT INTO concurrent_metrics (sampled_at, concurrent_count)
        VALUES (?, ?)
        ON CONFLICT(sampled_at) DO UPDATE SET
          concurrent_count = excluded.concurrent_count
        """,
        (sampled_at_iso, len(airborne_hexes)),
    )

    return {
        "sampled_at": sampled_at_iso,
        "matched_count": len(snapshot_rows),
        "airborne_count": len(airborne_hexes),
        "concurrent_count": len(airborne_hexes),
    }


def main():
    args = parse_args()
    ensure_directories()
    connection = open_db(args.db)

    try:
        tracked_entries = load_tracking_entries(connection)
        if not tracked_entries:
            raise ValueError("No tracked aircraft found. Run `npm run import:faa` first.")

        tracked_by_hex = {entry["hex"]: entry for entry in tracked_entries}
        selected = choose_latest_heatmap(dt.datetime.now(dt.timezone.utc), args.lookback_slots)
        current_slot_key = get_meta(connection, META_SLOT_KEY)
        current_window_samples = recent_sample_count(connection, selected["slot"])

        latest_slot_already_current = current_slot_key == selected["slot_key"]
        recent_window_already_full = current_window_samples >= RECENT_WINDOW_SLOTS - 1
        if latest_slot_already_current and not args.force and (
            not args.fill_recent_slots or recent_window_already_full
        ):
            sampled_at = get_meta(connection, META_SAMPLED_AT)
            summary = current_snapshot_summary(connection, sampled_at) if sampled_at else {
                "matched_count": 0,
                "airborne_count": 0,
                "concurrent_count": 0,
            }
            print(
                json.dumps(
                    {
                        "ok": True,
                        "skipped": True,
                        "latestSampledAt": sampled_at,
                        "latestSlotKey": current_slot_key,
                        "latestUrl": get_meta(connection, META_URL) or selected["url"],
                        "cachePath": get_meta(connection, META_CACHE_PATH) or str(selected["cache_path"]),
                        "usedCache": True,
                        "matchedCount": summary["matched_count"],
                        "airborneCount": summary["airborne_count"],
                        "concurrentCount": summary["concurrent_count"],
                    }
                )
            )
            return

        latest_result = None
        selected_used_cache = selected["used_cache"]

        slots_to_ingest = build_recent_slots(selected["slot"]) if args.fill_recent_slots else [selected["slot"]]
        for slot in slots_to_ingest:
            if slot != selected["slot"] and not args.force and slot_already_ingested(connection, slot):
                continue

            slot_info = selected if slot == selected["slot"] else ensure_slot_heatmap(slot)
            if slot_info is None:
                continue

            latest_slice = parse_latest_slice(slot_info["cache_path"])
            if latest_slice is None:
                continue

            result = ingest_slot(connection, tracked_by_hex, latest_slice, replace_live_snapshot=slot == selected["slot"])
            if slot == selected["slot"]:
                latest_result = result
                selected_used_cache = slot_info["used_cache"]

        if latest_result is None:
            raise ValueError(f"Could not parse a usable latest heatmap from {selected['cache_path']}")

        set_meta(connection, META_SLOT_KEY, selected["slot_key"])
        set_meta(connection, META_SAMPLED_AT, latest_result["sampled_at"])
        set_meta(connection, META_URL, selected["url"])
        set_meta(connection, META_CACHE_PATH, str(selected["cache_path"]))
        set_meta(
            connection,
            HEATMAP_STATUS_META_KEY,
            json.dumps(
                {
                    "provider": SOURCE,
                    "providerLabel": "ADS-B Exchange heatmap",
                    "cadenceMinutes": 30,
                    "refreshing": False,
                    "nextRefreshAt": None,
                    "lastAttemptAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "lastSuccessAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "lastError": None,
                    "latestSampledAt": latest_result["sampled_at"],
                    "latestSlotKey": selected["slot_key"],
                    "latestUrl": selected["url"],
                    "cachePath": str(selected["cache_path"]),
                    "usedCache": selected_used_cache,
                    "matchedCount": latest_result["matched_count"],
                    "airborneCount": latest_result["airborne_count"],
                    "concurrentCount": latest_result["concurrent_count"],
                }
            ),
        )
        connection.commit()

        print(
            json.dumps(
                {
                    "ok": True,
                    "skipped": False,
                    "latestSampledAt": latest_result["sampled_at"],
                    "latestSlotKey": selected["slot_key"],
                    "latestUrl": selected["url"],
                    "cachePath": str(selected["cache_path"]),
                    "usedCache": selected_used_cache,
                    "matchedCount": latest_result["matched_count"],
                    "airborneCount": latest_result["airborne_count"],
                    "concurrentCount": latest_result["concurrent_count"],
                }
            )
        )
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # pragma: no cover - CLI error path
        print(str(error), file=sys.stderr)
        raise
