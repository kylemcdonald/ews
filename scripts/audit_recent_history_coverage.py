#!/usr/bin/env python3

import argparse
import datetime as dt
import json
import pathlib
import sqlite3
import sys


ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
DB_PATH = ROOT_DIR / "data" / "ews-main.sqlite"
HALF_HOUR_SECONDS = 30 * 60


def parse_args():
    parser = argparse.ArgumentParser(
        description="Report missing recent half-hour concurrent_metrics slots without downloading data."
    )
    parser.add_argument(
        "--db",
        action="append",
        default=[],
        help="SQLite DB to audit. May be repeated. Defaults to data/ews-main.sqlite.",
    )
    parser.add_argument(
        "--slots",
        type=int,
        default=48,
        help="Number of recent half-hour slots to check, ending at the latest recorded sample.",
    )
    parser.add_argument(
        "--max-missing",
        type=int,
        help="Exit with an error when any DB is missing more than this many slots.",
    )
    return parser.parse_args()


def parse_timestamp(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(dt.timezone.utc)


def canonical_slot_key(value):
    timestamp = parse_timestamp(value).timestamp()
    rounded = round(timestamp / HALF_HOUR_SECONDS) * HALF_HOUR_SECONDS
    return dt.datetime.fromtimestamp(rounded, tz=dt.timezone.utc).isoformat()


def audit_db(db_path, slots):
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    latest_row = connection.execute(
        "SELECT MAX(sampled_at) AS latest_sampled_at FROM concurrent_metrics"
    ).fetchone()
    latest_sampled_at = latest_row["latest_sampled_at"] if latest_row else None
    if not latest_sampled_at:
        connection.close()
        return {
            "db": str(db_path),
            "latestSampledAt": None,
            "expectedSlots": slots,
            "observedSlots": 0,
            "missingSlots": slots,
            "missingSlotKeys": [],
        }

    latest_slot = parse_timestamp(canonical_slot_key(latest_sampled_at))
    start_slot = latest_slot - dt.timedelta(minutes=30 * (slots - 1))
    start_iso = (start_slot - dt.timedelta(minutes=15)).isoformat()
    end_iso = (latest_slot + dt.timedelta(minutes=15)).isoformat()
    rows = connection.execute(
        """
        SELECT sampled_at
        FROM concurrent_metrics
        WHERE sampled_at >= ?
          AND sampled_at <= ?
        """,
        (start_iso, end_iso),
    ).fetchall()
    connection.close()

    observed_keys = {canonical_slot_key(row["sampled_at"]) for row in rows}
    expected_keys = [
        (start_slot + dt.timedelta(minutes=30 * offset)).isoformat()
        for offset in range(slots)
    ]
    missing_keys = [key for key in expected_keys if key not in observed_keys]

    return {
        "db": str(db_path),
        "latestSampledAt": latest_sampled_at,
        "expectedSlots": slots,
        "observedSlots": len(observed_keys),
        "missingSlots": len(missing_keys),
        "missingSlotKeys": missing_keys,
    }


def main():
    args = parse_args()
    db_paths = [pathlib.Path(path) for path in args.db] or [DB_PATH]
    reports = [audit_db(path, args.slots) for path in db_paths]
    ok = args.max_missing is None or all(report["missingSlots"] <= args.max_missing for report in reports)
    print(json.dumps({"ok": ok, "reports": reports}, indent=2))
    if not ok:
        print(
            f"Recent history is missing more than {args.max_missing} of {args.slots} half-hour slots.",
            file=sys.stderr,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
