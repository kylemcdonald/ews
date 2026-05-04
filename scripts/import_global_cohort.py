#!/usr/bin/env python3

import argparse
import csv
import datetime as dt
import gzip
import json
import pathlib
import re
import sqlite3
import urllib.request
from collections import Counter


ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "ews.sqlite"
SCHEMA_PATH = ROOT_DIR / "schema.sql"
AIRCRAFT_DB_DIR = DATA_DIR / "cache" / "aircraft_db"
ADSBX_BASIC_DB_URL = "https://downloads.adsbexchange.com/downloads/basic-ac-db.json.gz"
TAR1090_DB_URL = "https://github.com/wiedehopf/tar1090-db/raw/refs/heads/csv/aircraft.csv.gz"
ADSBX_BASIC_DB_PATH = AIRCRAFT_DB_DIR / "basic-ac-db.json.gz"
TAR1090_DB_PATH = AIRCRAFT_DB_DIR / "tar1090-aircraft.csv.gz"

SOURCE = "global_business_jet"
METADATA_SOURCE = "public_aircraft_metadata"

INCLUDE_MANUFACTURER_PATTERNS = [
    r"\bBOMBARDIER\b",
    r"\bCANADAIR\b",
    r"\bLEARJET\b",
    r"\bGULFSTREAM\b",
    r"\bDASSAULT\b",
    r"\bFALCON\b",
    r"\bCESSNA\b",
    r"\bCITATION\b",
    r"\bTEXTRON\b",
    r"\bEMBRAER\b",
    r"\bHONDA\b",
    r"\bPILATUS\b",
    r"\bBEECH\b",
    r"\bRAYTHEON\b",
    r"\bHAWKER\b",
    r"\bBRITISH AEROSPACE\b",
    r"\bISRAEL AIRCRAFT\b",
    r"\bIAI\b",
    r"\bECLIPSE\b",
    r"\bCIRRUS\b",
    r"\bSABRELINER\b",
    r"\bSYBERJET\b",
]

INCLUDE_MODEL_PATTERNS = [
    r"\bCITATION\b",
    r"\bMUSTANG\b",
    r"\bLATITUDE\b",
    r"\bLONGITUDE\b",
    r"\bGULFSTREAM\b",
    r"\bFALCON\b",
    r"\bGLOBAL\b",
    r"\bCHALLENGER\b",
    r"\bLEARJET\b",
    r"\bPHENOM\b",
    r"\bLEGACY\b",
    r"\bPRAETOR\b",
    r"\bLINEAGE\b",
    r"\bHONDAJET\b",
    r"\bPC-24\b",
    r"\bHAWKER\b",
    r"\bBEECHJET\b",
    r"\bPREMIER\b",
    r"\bASTRA\b",
    r"\bGALAXY\b",
    r"\bWESTWIND\b",
    r"\bECLIPSE\b",
    r"\bVISION JET\b",
]

INCLUDE_ICAO_TYPE_PATTERNS = [
    r"^C25",
    r"^C5(10|25|50|51|56|60)$",
    r"^C56X$",
    r"^C6(50|80|8A)$",
    r"^C700$",
    r"^C750$",
    r"^CL(30|35|60)$",
    r"^CRJ[0-9]$",  # Some corporate Challengers are coded as CRJ-family aircraft.
    r"^GL(F|5|6|7)",
    r"^G(150|200|280|LEX)$",
    r"^FA(10|20|50|5X|6X|7X|8X)$",
    r"^F(2TH|900)$",
    r"^E(35L|50P|55P|545|550)$",
    r"^H25",
    r"^BE(40|4W)$",
    r"^LJ",
    r"^HDJT$",
    r"^E500$",
    r"^SF50$",
    r"^PRM1$",
]

EXCLUDE_MANUFACTURER_PATTERNS = [
    r"\bAIRBUS\b",
    r"\bBOEING\b",
    r"\bMCDONNELL\b",
    r"\bDOUGLAS\b",
    r"\bANTONOV\b",
    r"\bILYUSHIN\b",
    r"\bTUPOLEV\b",
]

EXCLUDE_MODEL_PATTERNS = [
    r"\bAIRBUS\b",
    r"\bBOEING\b",
    r"\b7[0-9]{2}\b",
    r"\bA3[0-9]{2}\b",
    r"\bA2[0-9]{2}\b",
    r"\bA4[0-9]{2}\b",
    r"\bDC-[0-9]+",
    r"\bMD-[0-9]+",
    r"\bERJ[- ]?(135|140|145|170|175|190|195)\b",
    r"\bEMB[- ]?(120|135|140|145|170|175|190|195)\b",
]

EXCLUDE_ICAO_TYPE_PATTERNS = [
    r"^A(1|2|3|4|5|6)",
    r"^B(7|38M|39M)",
    r"^E(135|140|145|170|175|190|195)",
    r"^CRJ(1|2|7|9|X)$",
    r"^MD",
    r"^DC",
    r"^AT[0-9]",
    r"^DH8",
]


def parse_args():
    parser = argparse.ArgumentParser(
        description="Import a conservative global business-jet cohort from public aircraft metadata databases."
    )
    parser.add_argument("--db", default=str(DB_PATH), help="SQLite database path.")
    parser.add_argument("--refresh", action="store_true", help="Redownload source files.")
    parser.add_argument("--dry-run", action="store_true", help="Print import counts without changing SQLite.")
    parser.add_argument(
        "--include-pia",
        action="store_true",
        help="Include ADS-B Exchange rows flagged as FAA PIA even when type details are unavailable.",
    )
    parser.add_argument(
        "--replace-existing",
        action="store_true",
        help="Allow global records to update existing tracked_aircraft rows. By default existing rows are preserved.",
    )
    return parser.parse_args()


def ensure_directories():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    AIRCRAFT_DB_DIR.mkdir(parents=True, exist_ok=True)


def download_file(url, destination, refresh=False):
    if destination.exists() and not refresh:
        return destination

    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=180) as response:
        destination.write_bytes(response.read())

    return destination


def open_db(path):
    pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA_PATH.read_text("utf8"))
    return connection


def normalize_hex(value):
    normalized = str(value or "").strip().lower().replace("0x", "").replace("~", "")
    if re.fullmatch(r"[0-9a-f]{6}", normalized):
        return normalized
    return None


def normalize_text(value):
    return re.sub(r"\s+", " ", str(value or "").strip())


def compile_patterns(patterns):
    return [re.compile(pattern, re.IGNORECASE) for pattern in patterns]


PATTERNS = {
    "include_manufacturer": compile_patterns(INCLUDE_MANUFACTURER_PATTERNS),
    "include_model": compile_patterns(INCLUDE_MODEL_PATTERNS),
    "include_icao_type": compile_patterns(INCLUDE_ICAO_TYPE_PATTERNS),
    "exclude_manufacturer": compile_patterns(EXCLUDE_MANUFACTURER_PATTERNS),
    "exclude_model": compile_patterns(EXCLUDE_MODEL_PATTERNS),
    "exclude_icao_type": compile_patterns(EXCLUDE_ICAO_TYPE_PATTERNS),
}


def load_adsbx_records(path):
    records = {}
    with gzip.open(path, "rt", encoding="utf8") as file_handle:
        for line in file_handle:
            line = line.strip()
            if not line:
                continue

            row = json.loads(line)
            hex_value = normalize_hex(row.get("icao"))
            if not hex_value:
                continue

            records[hex_value] = {
                "hex": hex_value,
                "registration": normalize_text(row.get("reg")).upper() or None,
                "icao_type": normalize_text(row.get("icaotype")).upper() or None,
                "manufacturer": normalize_text(row.get("manufacturer")) or None,
                "model": normalize_text(row.get("model")) or None,
                "owner_operator": normalize_text(row.get("ownop")) or None,
                "short_type": normalize_text(row.get("short_type")).upper() or None,
                "year": row.get("year"),
                "military": bool(row.get("mil")),
                "faa_pia": bool(row.get("faa_pia")),
                "faa_ladd": bool(row.get("faa_ladd")),
                "sources": ["adsbx_basic_ac_db"],
            }

    return records


def merge_tar1090_records(records, path):
    with gzip.open(path, "rt", encoding="utf8", newline="") as file_handle:
        reader = csv.reader(file_handle, delimiter=";")
        for row in reader:
            if len(row) < 5:
                continue

            hex_value = normalize_hex(row[0])
            if not hex_value:
                continue

            record = records.setdefault(
                hex_value,
                {
                    "hex": hex_value,
                    "registration": None,
                    "icao_type": None,
                    "manufacturer": None,
                    "model": None,
                    "owner_operator": None,
                    "short_type": None,
                    "year": None,
                    "military": False,
                    "faa_pia": False,
                    "faa_ladd": False,
                    "sources": [],
                },
            )
            registration = normalize_text(row[1]).upper()
            icao_type = normalize_text(row[2]).upper()
            description = normalize_text(row[4])

            record["registration"] = record["registration"] or registration or None
            record["icao_type"] = record["icao_type"] or icao_type or None
            if description and not (record["manufacturer"] or record["model"]):
                record["model"] = description
            record["tar1090_description"] = description or record.get("tar1090_description")
            if "tar1090_db" not in record["sources"]:
                record["sources"].append("tar1090_db")

    return records


def matches_any(value, patterns):
    text = normalize_text(value).upper()
    return bool(text) and any(pattern.search(text) for pattern in patterns)


def is_jet_record(record):
    short_type = normalize_text(record.get("short_type")).upper()
    if re.fullmatch(r"[A-Z][0-9]J", short_type):
        return True
    if re.fullmatch(r"[A-Z][0-9][A-Z-]", short_type):
        return False

    searchable = " ".join(
        filter(
            None,
            [
                record.get("manufacturer"),
                record.get("model"),
                record.get("tar1090_description"),
                record.get("icao_type"),
            ],
        )
    )
    return matches_any(searchable, PATTERNS["include_model"]) or matches_any(
        record.get("icao_type"), PATTERNS["include_icao_type"]
    )


def is_excluded_airliner(record):
    manufacturer = record.get("manufacturer") or ""
    model = " ".join(filter(None, [record.get("model"), record.get("tar1090_description")]))
    icao_type = record.get("icao_type") or ""

    if matches_any(manufacturer, PATTERNS["exclude_manufacturer"]):
        return True
    if matches_any(icao_type, PATTERNS["exclude_icao_type"]):
        return True
    return matches_any(model, PATTERNS["exclude_model"])


def is_business_jet(record, include_pia=False):
    if record.get("military"):
        return False

    if include_pia and record.get("faa_pia"):
        return True

    manufacturer = record.get("manufacturer") or ""
    model = " ".join(filter(None, [record.get("model"), record.get("tar1090_description")]))
    icao_type = record.get("icao_type") or ""

    has_business_identity = (
        matches_any(manufacturer, PATTERNS["include_manufacturer"])
        or matches_any(model, PATTERNS["include_model"])
        or matches_any(icao_type, PATTERNS["include_icao_type"])
    )
    if not has_business_identity or not is_jet_record(record):
        return False

    if is_excluded_airliner(record) and not matches_any(model, PATTERNS["include_model"]):
        return False

    return True


def classify_record(record, include_pia=False):
    manufacturer = record.get("manufacturer") or ""
    model = " ".join(filter(None, [record.get("model"), record.get("tar1090_description")]))
    icao_type = record.get("icao_type") or ""
    short_type = normalize_text(record.get("short_type")).upper()

    if record.get("military"):
        return "military", "adsbx_military_flag"

    if is_business_jet(record, include_pia=include_pia):
        return "business_jet", "business_jet_type_match"

    if matches_any(icao_type, PATTERNS["exclude_icao_type"]) or matches_any(
        manufacturer, PATTERNS["exclude_manufacturer"]
    ):
        if re.search(r"^(CRJ|E1[37]|E1[49])", icao_type):
            return "regional_airliner", "regional_airliner_type_match"
        return "large_airliner", "airliner_type_match"

    if matches_any(model, PATTERNS["exclude_model"]):
        if re.search(r"\b(CRJ|ERJ|EMB[- ]?(135|140|145|170|175|190|195))\b", model, flags=re.IGNORECASE):
            return "regional_airliner", "regional_airliner_model_match"
        return "large_airliner", "airliner_model_match"

    if re.fullmatch(r"[A-Z][0-9]J", short_type):
        return "jet_other", "short_type_jet"

    if re.fullmatch(r"[A-Z][0-9][A-Z-]", short_type):
        return "non_jet_aircraft", "short_type_non_jet"

    if icao_type:
        return "other_known_type", "icao_type_present"

    return "unknown", "insufficient_type_metadata"


def build_label(record):
    manufacturer = record.get("manufacturer")
    model = record.get("model") or record.get("tar1090_description")
    if manufacturer and model and manufacturer.upper() not in model.upper():
        return f"{manufacturer} {model}".strip()
    return model or manufacturer or record.get("icao_type") or record["hex"].upper()


def build_entries(records, include_pia=False):
    entries = []
    for record in records.values():
        if not is_business_jet(record, include_pia=include_pia):
            continue

        notes = {
            "icao_type": record.get("icao_type"),
            "manufacturer": record.get("manufacturer"),
            "model": record.get("model"),
            "tar1090_description": record.get("tar1090_description"),
            "owner_operator": record.get("owner_operator"),
            "short_type": record.get("short_type"),
            "year": record.get("year"),
            "faa_pia": record.get("faa_pia"),
            "faa_ladd": record.get("faa_ladd"),
            "sources": record.get("sources"),
            "imported_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
        entries.append(
            {
                "hex": record["hex"],
                "registration": record.get("registration"),
                "label": build_label(record),
                "source": SOURCE,
                "notes": json.dumps(notes, separators=(",", ":"), sort_keys=True),
            }
        )

    return sorted(entries, key=lambda item: item["hex"])


def build_metadata_rows(records, include_pia=False):
    imported_at = dt.datetime.now(dt.timezone.utc).isoformat()
    rows = []

    for record in records.values():
        category, category_reason = classify_record(record, include_pia=include_pia)
        rows.append(
            {
                "hex": record["hex"],
                "registration": record.get("registration"),
                "icao_type": record.get("icao_type"),
                "manufacturer": record.get("manufacturer"),
                "model": record.get("model") or record.get("tar1090_description"),
                "owner_operator": record.get("owner_operator"),
                "short_type": record.get("short_type"),
                "year": None if record.get("year") is None else str(record.get("year")),
                "military": 1 if record.get("military") else 0,
                "faa_pia": 1 if record.get("faa_pia") else 0,
                "faa_ladd": 1 if record.get("faa_ladd") else 0,
                "category": category,
                "category_reason": category_reason,
                "sources_json": json.dumps(record.get("sources") or [METADATA_SOURCE], separators=(",", ":")),
                "updated_at": imported_at,
            }
        )

    return sorted(rows, key=lambda item: item["hex"])


def import_metadata(connection, rows):
    connection.execute("DELETE FROM aircraft_metadata")
    connection.executemany(
        """
        INSERT INTO aircraft_metadata (
          hex,
          registration,
          icao_type,
          manufacturer,
          model,
          owner_operator,
          short_type,
          year,
          military,
          faa_pia,
          faa_ladd,
          category,
          category_reason,
          sources_json,
          updated_at
        ) VALUES (
          :hex,
          :registration,
          :icao_type,
          :manufacturer,
          :model,
          :owner_operator,
          :short_type,
          :year,
          :military,
          :faa_pia,
          :faa_ladd,
          :category,
          :category_reason,
          :sources_json,
          :updated_at
        )
        ON CONFLICT(hex) DO UPDATE SET
          registration = excluded.registration,
          icao_type = excluded.icao_type,
          manufacturer = excluded.manufacturer,
          model = excluded.model,
          owner_operator = excluded.owner_operator,
          short_type = excluded.short_type,
          year = excluded.year,
          military = excluded.military,
          faa_pia = excluded.faa_pia,
          faa_ladd = excluded.faa_ladd,
          category = excluded.category,
          category_reason = excluded.category_reason,
          sources_json = excluded.sources_json,
          updated_at = excluded.updated_at
        """,
        rows,
    )
    return connection.execute("SELECT COUNT(*) FROM aircraft_metadata").fetchone()[0]


def import_entries(connection, entries, replace_existing=False):
    connection.execute("DELETE FROM tracked_aircraft WHERE source = ?", (SOURCE,))

    if replace_existing:
        statement = """
            INSERT INTO tracked_aircraft (hex, registration, label, source, notes)
            VALUES (:hex, :registration, :label, :source, :notes)
            ON CONFLICT(hex) DO UPDATE SET
              registration = excluded.registration,
              label = excluded.label,
              source = excluded.source,
              notes = excluded.notes
        """
    else:
        statement = """
            INSERT INTO tracked_aircraft (hex, registration, label, source, notes)
            VALUES (:hex, :registration, :label, :source, :notes)
            ON CONFLICT(hex) DO NOTHING
        """

    connection.executemany(statement, entries)
    inserted = connection.execute(
        "SELECT COUNT(*) FROM tracked_aircraft WHERE source = ?",
        (SOURCE,),
    ).fetchone()[0]
    connection.execute(
        """
        INSERT INTO meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        ("global_business_jet_imported_at", dt.datetime.now(dt.timezone.utc).isoformat()),
    )
    connection.execute(
        """
        INSERT INTO meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        ("global_business_jet_count", str(inserted)),
    )
    return inserted


def main():
    args = parse_args()
    ensure_directories()
    adsbx_path = download_file(ADSBX_BASIC_DB_URL, ADSBX_BASIC_DB_PATH, refresh=args.refresh)
    tar1090_path = download_file(TAR1090_DB_URL, TAR1090_DB_PATH, refresh=args.refresh)

    records = load_adsbx_records(adsbx_path)
    merge_tar1090_records(records, tar1090_path)
    metadata_rows = build_metadata_rows(records, include_pia=args.include_pia)
    entries = build_entries(records, include_pia=args.include_pia)
    category_counts = Counter(row["category"] for row in metadata_rows)

    print(f"Loaded {len(records):,} unique aircraft metadata rows")
    print(f"Selected {len(entries):,} global business-jet candidates")
    print("Top metadata categories:")
    for category, count in category_counts.most_common(10):
        print(f"  {count:7d}  {category}")
    print(f"ADS-B Exchange cache: {adsbx_path}")
    print(f"tar1090/Mictronics cache: {tar1090_path}")

    if args.dry_run:
        for entry in entries[:12]:
            print(f"  {entry['hex']} {entry['registration'] or '-'} {entry['label']}")
        return

    connection = open_db(args.db)
    metadata_count = import_metadata(connection, metadata_rows)
    inserted = import_entries(connection, entries, replace_existing=args.replace_existing)
    connection.commit()
    connection.close()
    print(f"Imported {metadata_count:,} aircraft metadata rows into {args.db}")
    print(f"Imported {inserted:,} global aircraft into {args.db} with source={SOURCE!r}")


if __name__ == "__main__":
    main()
