"""Guards against the October 2026 regression where skipped scheduled runs left permanent gaps.

GitHub Actions began running the 30-minute refresh only a few times a day, and each run ingested
only the newest heatmap, so samples per day fell from 48 to 4-7. Each live run must now fill every
missing slot in the trailing 24 hours, for every cohort, and the workflows must ask it to.
"""

import datetime as dt
import json
import pathlib
import re
import sqlite3
import subprocess
import sys
import tempfile
import unittest

import numpy as np

ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT_DIR / "scripts"
WORKFLOWS_DIR = ROOT_DIR / ".github" / "workflows"
sys.path.insert(0, str(SCRIPTS_DIR))

from audit_recent_history_coverage import audit_db  # noqa: E402
from parse_heatmap import SLICE_BEGIN_MARKER, parse_heatmap, parse_latest_heatmap_slice  # noqa: E402

SLOTS = 48
TRACKED_HEXES = [f"a0000{index}" for index in range(1, 7)]
NON_ICAO_POINTS = [0x1000000 | (0x2A0000 + index) for index in range(1, 7)]
ICAO_POINTS = [int(hex_value, 16) for hex_value in TRACKED_HEXES]


def encode_record(point0, lat=40.0, lon=-75.0, altitude_ft=30000, ground_speed_kt=400):
    altitude = -123 if altitude_ft == "ground" else altitude_ft // 25
    point3 = (int(ground_speed_kt * 10) << 16) | (altitude & 0xFFFF)
    return [point0, int(lat * 1e6), int(lon * 1e6), point3]


def encode_slice(timestamp, records):
    milliseconds = int(timestamp.timestamp() * 1000)
    header = [SLICE_BEGIN_MARKER, milliseconds >> 32, milliseconds & 0xFFFFFFFF, 0]
    return header + [word for record in records for word in record]


def write_heatmap(path, slices):
    words = [0, 0, 0, 0]
    for timestamp, records in slices:
        words += encode_slice(timestamp, records)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(np.array([word & 0xFFFFFFFF for word in words], dtype=np.uint32).tobytes())


def slot_path(cache_dir, slot):
    index = slot.hour * 2 + (1 if slot.minute >= 30 else 0)
    return cache_dir / f"{slot.year:04d}" / f"{slot.month:02d}" / f"{slot.day:02d}" / f"{index:02d}.bin.ttf"


def airborne_count_for(position):
    return position % len(TRACKED_HEXES) + 1


def write_slot_heatmap(cache_dir, slot, position):
    airborne = airborne_count_for(position)
    latest_records = [
        encode_record(point0, altitude_ft=30000 if offset < airborne else "ground")
        for offset, point0 in enumerate(ICAO_POINTS)
    ]
    latest_records += [encode_record(point0) for point0 in NON_ICAO_POINTS[:airborne]]
    write_heatmap(
        slot_path(cache_dir, slot),
        [
            (slot + dt.timedelta(seconds=10), [encode_record(ICAO_POINTS[0]), encode_record(NON_ICAO_POINTS[0])]),
            (slot + dt.timedelta(minutes=29, seconds=50), latest_records),
        ],
    )


def recent_slots():
    now = dt.datetime.now(dt.timezone.utc)
    latest = now.replace(minute=30 if now.minute >= 30 else 0, second=0, microsecond=0)
    # Two extra slots keep the window covered if a half-hour boundary passes during the test.
    return [latest - dt.timedelta(minutes=30 * offset) for offset in range(SLOTS + 1, -1, -1)]


def run_script(*args):
    result = subprocess.run(
        [sys.executable, *args],
        cwd=ROOT_DIR,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(f"{args[0]} failed:\n{result.stdout}\n{result.stderr}")
    return json.loads(result.stdout.strip().splitlines()[-1])


class RecentSlotFillTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp_dir.name)
        self.cache_dir = self.root / "cache"
        self.slots = recent_slots()
        for position, slot in enumerate(self.slots):
            write_slot_heatmap(self.cache_dir, slot, position)

    def tearDown(self):
        self.temp_dir.cleanup()

    def seed_db(self, name, sampled_slots, latest_slot_key=None):
        db_path = self.root / name
        connection = sqlite3.connect(db_path)
        connection.executescript((ROOT_DIR / "schema.sql").read_text("utf8"))
        connection.executemany(
            "INSERT INTO tracked_aircraft (hex, registration, label, source) VALUES (?, ?, ?, 'test')",
            [(hex_value, hex_value.upper(), hex_value.upper()) for hex_value in TRACKED_HEXES],
        )
        # Only the slots a sparse schedule happened to run for, like October 2026.
        connection.executemany(
            "INSERT INTO concurrent_metrics (sampled_at, concurrent_count) VALUES (?, ?)",
            [((slot + dt.timedelta(minutes=29, seconds=50)).isoformat(), 1) for slot in sampled_slots],
        )
        if latest_slot_key:
            connection.execute(
                "INSERT INTO meta (key, value) VALUES ('adsbx_heatmap_slot_key', ?)",
                (latest_slot_key,),
            )
        connection.commit()
        connection.close()
        return db_path

    def concurrent_counts(self, db_path):
        connection = sqlite3.connect(db_path)
        rows = dict(connection.execute("SELECT sampled_at, concurrent_count FROM concurrent_metrics").fetchall())
        connection.close()
        return rows

    def test_tracked_cohort_run_fills_every_skipped_slot(self):
        latest = self.slots[-1]
        latest_key = f"{latest.date().isoformat()}:{latest.hour * 2 + (1 if latest.minute >= 30 else 0):02d}"
        db_path = self.seed_db("main.sqlite", self.slots[::6], latest_slot_key=latest_key)

        result = run_script(
            "scripts/update_latest_heatmap.py",
            "--db", str(db_path),
            "--cache-dir", str(self.cache_dir),
            "--skip-download",
            "--fill-recent-slots",
        )

        self.assertFalse(result["skipped"], "an unchanged latest slot must not hide gaps behind it")
        self.assertGreater(result["filledSlotCount"], 30)
        report = audit_db(db_path, SLOTS)
        self.assertEqual(report["missingSlots"], 0, report["missingSlotKeys"])
        counts = self.concurrent_counts(db_path)
        for position, slot in enumerate(self.slots[-SLOTS:], start=len(self.slots) - SLOTS):
            sampled_at = (slot + dt.timedelta(minutes=29, seconds=50)).isoformat()
            if slot not in self.slots[::6] or slot == latest:
                self.assertEqual(counts[sampled_at], airborne_count_for(position), sampled_at)

    def test_untracked_cohort_run_fills_every_skipped_slot(self):
        db_path = self.seed_db("untracked.sqlite", self.slots[::6])

        result = run_script(
            "scripts/track_non_icao_hex.py",
            "--db", str(db_path),
            "--latest-live",
            "--cache-dir", str(self.cache_dir),
            "--skip-download",
            "--rate-limit-seconds", "0",
            "--replace-live-snapshot",
            "--fill-recent-slots",
        )

        self.assertGreater(result["filledSlotCount"], 30)
        report = audit_db(db_path, SLOTS)
        self.assertEqual(report["missingSlots"], 0, report["missingSlotKeys"])
        counts = self.concurrent_counts(db_path)
        position = len(self.slots) - 2
        sampled_at = (self.slots[position] + dt.timedelta(minutes=29, seconds=50)).isoformat()
        if self.slots[position] not in self.slots[::6]:
            self.assertEqual(counts[sampled_at], airborne_count_for(position))

    def test_audit_fails_when_slots_are_missing(self):
        db_path = self.seed_db("sparse.sqlite", self.slots[::6])
        result = subprocess.run(
            [
                sys.executable,
                "scripts/audit_recent_history_coverage.py",
                "--db", str(db_path),
                "--slots", str(SLOTS),
                "--max-missing", "2",
            ],
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 1, result.stdout)


class LatestSliceParserTest(unittest.TestCase):
    def test_latest_slice_matches_full_parse(self):
        base = dt.datetime(2026, 10, 1, 12, 0, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as temp_dir:
            path = pathlib.Path(temp_dir) / "heatmap.bin.ttf"
            write_heatmap(
                path,
                [
                    (base + dt.timedelta(minutes=1), [encode_record(ICAO_POINTS[0])]),
                    (base + dt.timedelta(minutes=20), [encode_record(point0) for point0 in ICAO_POINTS[:3]]),
                    (base + dt.timedelta(minutes=5), [encode_record(ICAO_POINTS[1], altitude_ft="ground")]),
                    # A newer slice with only a callsign row has no telemetry, so it is skipped.
                    (base + dt.timedelta(minutes=29), [[ICAO_POINTS[2], 0x40000000 + 1200, 0x41414141, 0x20202020]]),
                ],
            )
            expected = max(parse_heatmap(str(path), return_callsigns=False), key=lambda item: item.timestamp)
            self.assertEqual(parse_latest_heatmap_slice(str(path)), expected)
            self.assertEqual(len(expected.telemetry), 3)


class RefreshWorkflowTest(unittest.TestCase):
    def workflow_text(self, name):
        return (WORKFLOWS_DIR / name).read_text("utf8")

    def test_every_live_ingestion_step_fills_recent_slots(self):
        for name in ("refresh-live-data.yml", "refresh-daily-history.yml"):
            text = self.workflow_text(name)
            commands = re.findall(r"run: (python3 scripts/(?:update_latest_heatmap|track_non_icao_hex)\.py[^\n]*)", text)
            self.assertEqual(len(commands), 3, name)
            for command in commands:
                self.assertIn("--fill-recent-slots", command, f"{name}: {command}")

    def test_live_refresh_is_not_cancelled_by_the_next_trigger(self):
        text = self.workflow_text("refresh-live-data.yml")
        self.assertIn("workflow_dispatch:", text)
        self.assertRegex(text, r"concurrency:\n  group: refresh-live-data\n  cancel-in-progress: false")

    def test_live_refresh_fails_loudly_when_history_has_gaps(self):
        text = self.workflow_text("refresh-live-data.yml")
        self.assertRegex(text, r"audit_recent_history_coverage\.py[\s\S]*?--max-missing")


if __name__ == "__main__":
    unittest.main()
