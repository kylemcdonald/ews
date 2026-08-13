#!/usr/bin/env python3

import datetime as dt
import json
import math
import pathlib
import sqlite3
import urllib.error
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from zoneinfo import ZoneInfo

import numpy as np
from PIL import Image, ImageDraw, ImageFont


ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "ews-main.sqlite"
HEATMAP_CACHE_DIR = DATA_DIR / "cache" / "adsbx_live"
TILE_CACHE_DIR = DATA_DIR / "cache" / "map_tiles" / "carto_light_all"
OUT_IMAGE = ROOT_DIR / "masters_flight_trails_comparison.png"
OUT_SUMMARY = ROOT_DIR / "tmp" / "masters_flight_trails_summary.json"

PACIFIC = ZoneInfo("America/Los_Angeles")
UTC = dt.timezone.utc

AUGUSTA = {
    "name": "Augusta, GA",
    "lat": 33.4735,
    "lon": -82.0105,
}
AUGUSTA_RADIUS_NM = 85.0
AUGUSTA_LINK_MAX_ALTITUDE_FT = 18_000
GRID_CELL_MILES = 100.0
MAP_BOUNDS = (-126.0, 24.0, -66.0, 50.0)  # lon_min, lat_min, lon_max, lat_max
PANEL_SIZE = (1080, 620)
TILE_ZOOM = 6


@dataclass(frozen=True)
class WindowSpec:
    key: str
    title: str
    date: str
    color: tuple
    comparison_key: str | None = None


WINDOWS = [
    WindowSpec(
        key="2026_masters",
        title="2026 Masters Sunday",
        date="2026-04-12",
        color=(216, 40, 32, 105),
        comparison_key="2026_prior",
    ),
    WindowSpec(
        key="2026_prior",
        title="Previous Sunday",
        date="2026-04-05",
        color=(216, 40, 32, 105),
    ),
    WindowSpec(
        key="2025_masters",
        title="2025 Masters Sunday",
        date="2025-04-13",
        color=(216, 40, 32, 105),
        comparison_key="2025_prior",
    ),
    WindowSpec(
        key="2025_prior",
        title="Previous Sunday",
        date="2025-04-06",
        color=(216, 40, 32, 105),
    ),
]


def local_window(date_iso):
    start = dt.datetime.fromisoformat(f"{date_iso}T16:00:00").replace(tzinfo=PACIFIC)
    end = dt.datetime.fromisoformat(f"{date_iso}T22:00:00").replace(tzinfo=PACIFIC)
    return start, end


def slot_index_for(timestamp):
    return timestamp.hour * 2 + (1 if timestamp.minute >= 30 else 0)


def floor_to_half_hour(timestamp):
    minute = 30 if timestamp.minute >= 30 else 0
    return timestamp.replace(minute=minute, second=0, microsecond=0)


def heatmap_cache_path(timestamp):
    idx = slot_index_for(timestamp)
    return HEATMAP_CACHE_DIR / f"{timestamp:%Y/%m/%d}" / f"{idx:02d}.bin.ttf"


def heatmap_url(timestamp):
    idx = slot_index_for(timestamp)
    return (
        "https://globe.adsbexchange.com/globe_history/"
        f"{timestamp:%Y/%m/%d}/heatmap/{idx:02d}.bin.ttf"
    )


def download_heatmap(timestamp):
    destination = heatmap_cache_path(timestamp)
    if destination.exists() and destination.stat().st_size > 0:
        return destination, True

    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        heatmap_url(timestamp),
        headers={"User-Agent": "Mozilla/5.0", "Referer": "https://globe.adsbexchange.com/"},
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        destination.write_bytes(response.read())
    return destination, False


def iter_slots(start_utc, end_utc):
    current = floor_to_half_hour(start_utc)
    while current < end_utc:
        yield current
        current += dt.timedelta(minutes=30)


def tracked_aircraft_keys():
    connection = sqlite3.connect(DB_PATH)
    try:
        rows = connection.execute("SELECT hex FROM tracked_aircraft WHERE source != 'demo'").fetchall()
    finally:
        connection.close()

    keys = set()
    for (hex_value,) in rows:
        value = str(hex_value).strip().lower()
        if not value:
            continue
        if value.startswith("~"):
            keys.add(int(value[1:], 16) | 0x1000000)
        else:
            keys.add(int(value, 16))
    return keys


def query_metric_samples(start_utc, end_utc):
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """
            SELECT sampled_at, concurrent_count
            FROM concurrent_metrics
            WHERE sampled_at >= ?
              AND sampled_at <= ?
            ORDER BY sampled_at
            """,
            (start_utc.isoformat(), end_utc.isoformat()),
        ).fetchall()
    finally:
        connection.close()

    return [
        {
            "sampled_at": row["sampled_at"],
            "pacific": dt.datetime.fromisoformat(row["sampled_at"]).astimezone(PACIFIC).isoformat(),
            "concurrent_count": int(row["concurrent_count"]),
        }
        for row in rows
    ]


def point_key(point0_u):
    return (point0_u & 0x00FFFFFF) | (point0_u & 0x01000000)


def decode_altitude(point3):
    altitude = point3 & 0xFFFF
    if altitude & 0x8000:
        altitude |= -0x10000
    if altitude == -123:
        return "ground"
    return altitude * 25


def haversine_nm(lat1, lon1, lat2, lon2):
    radius_nm = 3440.065
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lam = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lam / 2) ** 2
    return radius_nm * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def grid_cell_for(lon, lat):
    lon_min, lat_min, lon_max, lat_max = MAP_BOUNDS
    lat_step = GRID_CELL_MILES / 69.0
    row = math.floor((lat - lat_min) / lat_step)
    row_lat0 = lat_min + row * lat_step
    row_lat1 = row_lat0 + lat_step
    row_center = (row_lat0 + row_lat1) / 2
    lon_step = GRID_CELL_MILES / (69.0 * max(math.cos(math.radians(row_center)), 0.25))
    col = math.floor((lon - lon_min) / lon_step)
    return row, col


def grid_cell_bounds(row, col):
    lon_min, lat_min, lon_max, lat_max = MAP_BOUNDS
    lat_step = GRID_CELL_MILES / 69.0
    lat0 = lat_min + row * lat_step
    lat1 = min(lat0 + lat_step, lat_max)
    row_center = (lat0 + lat1) / 2
    lon_step = GRID_CELL_MILES / (69.0 * max(math.cos(math.radians(row_center)), 0.25))
    lon0 = lon_min + col * lon_step
    lon1 = min(lon0 + lon_step, lon_max)
    return lon0, lat0, lon1, lat1


def scan_heatmap(path, tracked_keys, map_bounds, paths, near_keys, cell_aircraft):
    raw = path.read_bytes()
    points_u8 = np.frombuffer(raw, dtype=np.uint8)
    points_i = points_u8.view(np.int32)
    points_u = points_u8.view(np.uint32)

    slice_begin_marker = 0x0E7F7C9D
    marker_hits = np.nonzero(points_i == slice_begin_marker)[0]
    if not len(marker_hits):
        return 0

    lon_min, lat_min, lon_max, lat_max = map_bounds
    lat_min_i = int(lat_min * 1_000_000)
    lat_max_i = int(lat_max * 1_000_000)
    lon_min_i = int(lon_min * 1_000_000)
    lon_max_i = int(lon_max * 1_000_000)

    index = int(marker_hits[0])
    point_count = len(points_i)
    kept = 0

    while index < point_count:
        if points_i[index] != slice_begin_marker:
            index += 1
            continue

        now = points_u[index + 2] / 1000 + points_u[index + 1] * 4294967.296
        timestamp = dt.datetime.fromtimestamp(float(now), tz=UTC)
        ts = timestamp.timestamp()
        index += 4

        while index < point_count and points_i[index] != slice_begin_marker:
            point0_u = int(points_u[index])
            point1 = int(points_i[index + 1])

            if point1 > 1073741824:
                index += 4
                continue

            lat_i = point1
            lon_i = int(points_i[index + 2])
            if lat_i < lat_min_i or lat_i > lat_max_i or lon_i < lon_min_i or lon_i > lon_max_i:
                index += 4
                continue

            key = point_key(point0_u)
            if key not in tracked_keys:
                index += 4
                continue

            lat = lat_i / 1_000_000
            lon = lon_i / 1_000_000
            point3 = int(points_i[index + 3])
            altitude = decode_altitude(point3)

            if (
                haversine_nm(lat, lon, AUGUSTA["lat"], AUGUSTA["lon"]) <= AUGUSTA_RADIUS_NM
                and (altitude == "ground" or altitude <= AUGUSTA_LINK_MAX_ALTITUDE_FT)
            ):
                near_keys.add(key)

            if altitude != "ground":
                paths[key].append((ts, lon, lat))
                cell_aircraft[grid_cell_for(lon, lat)].add(key)
                kept += 1

            index += 4

    return kept


def build_window_tracks(spec, tracked_keys):
    local_start, local_end = local_window(spec.date)
    start_utc = local_start.astimezone(UTC)
    end_utc = local_end.astimezone(UTC)

    paths = defaultdict(list)
    near_keys = set()
    cell_aircraft = defaultdict(set)
    files = []
    downloaded = 0
    kept_points = 0

    for slot in iter_slots(start_utc, end_utc):
        path, used_cache = download_heatmap(slot)
        files.append(str(path.relative_to(ROOT_DIR)))
        if not used_cache:
            downloaded += 1
        kept_points += scan_heatmap(path, tracked_keys, MAP_BOUNDS, paths, near_keys, cell_aircraft)

    filtered_paths = {}
    for key in paths:
        points = sorted(paths.get(key, []), key=lambda item: item[0])
        if len(points) >= 2:
            filtered_paths[key] = dedupe_points(points)

    metric_samples = query_metric_samples(start_utc, end_utc)
    counts = [row["concurrent_count"] for row in metric_samples]
    return {
        "key": spec.key,
        "title": spec.title,
        "date": spec.date,
        "local_start": local_start.isoformat(),
        "local_end": local_end.isoformat(),
        "utc_start": start_utc.isoformat(),
        "utc_end": end_utc.isoformat(),
        "files": files,
        "downloaded_files": downloaded,
        "kept_track_points": kept_points,
        "augusta_radius_nm": AUGUSTA_RADIUS_NM,
        "augusta_link_max_altitude_ft": AUGUSTA_LINK_MAX_ALTITUDE_FT,
        "augusta_linked_unique_aircraft": len(near_keys),
        "visible_unique_aircraft": len(filtered_paths),
        "active_grid_cells": len(cell_aircraft),
        "cell_aircraft": cell_aircraft,
        "metric_samples": metric_samples,
        "metric_peak": max(counts) if counts else None,
        "metric_average": round(sum(counts) / len(counts), 1) if counts else None,
        "paths": filtered_paths,
    }


def dedupe_points(points):
    deduped = []
    last = None
    for point in points:
        comparable = (round(point[0]), round(point[1], 5), round(point[2], 5))
        if comparable == last:
            continue
        deduped.append(point)
        last = comparable
    return deduped


def lonlat_to_world_px(lon, lat, zoom):
    lat = max(min(lat, 85.05112878), -85.05112878)
    scale = 256 * (2**zoom)
    x = (lon + 180.0) / 360.0 * scale
    sin_lat = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + sin_lat) / (1 - sin_lat)) / (4 * math.pi)) * scale
    return x, y


def fetch_tile(zoom, x, y):
    destination = TILE_CACHE_DIR / str(zoom) / str(x) / f"{y}.png"
    if destination.exists() and destination.stat().st_size > 0:
        return Image.open(destination).convert("RGB")

    destination.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://a.basemaps.cartocdn.com/light_all/{zoom}/{x}/{y}.png"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        destination.write_bytes(response.read())
    return Image.open(destination).convert("RGB")


def build_basemap(bounds, size):
    lon_min, lat_min, lon_max, lat_max = bounds
    x0, y1 = lonlat_to_world_px(lon_min, lat_min, TILE_ZOOM)
    x1, y0 = lonlat_to_world_px(lon_max, lat_max, TILE_ZOOM)
    left = math.floor(x0 / 256)
    right = math.floor(x1 / 256)
    top = math.floor(y0 / 256)
    bottom = math.floor(y1 / 256)

    tile_image = Image.new("RGB", ((right - left + 1) * 256, (bottom - top + 1) * 256), "white")
    for tile_x in range(left, right + 1):
        for tile_y in range(top, bottom + 1):
            try:
                tile = fetch_tile(TILE_ZOOM, tile_x, tile_y)
            except (urllib.error.URLError, OSError):
                tile = Image.new("RGB", (256, 256), "#f7f7f4")
            tile_image.paste(tile, ((tile_x - left) * 256, (tile_y - top) * 256))

    crop = (
        int(round(x0 - left * 256)),
        int(round(y0 - top * 256)),
        int(round(x1 - left * 256)),
        int(round(y1 - top * 256)),
    )
    return tile_image.crop(crop).resize(size, Image.Resampling.LANCZOS).convert("RGBA")


def project(lon, lat, bounds, size):
    lon_min, lat_min, lon_max, lat_max = bounds
    x0, y1 = lonlat_to_world_px(lon_min, lat_min, TILE_ZOOM)
    x1, y0 = lonlat_to_world_px(lon_max, lat_max, TILE_ZOOM)
    x, y = lonlat_to_world_px(lon, lat, TILE_ZOOM)
    px = (x - x0) / (x1 - x0) * size[0]
    py = (y - y0) / (y1 - y0) * size[1]
    return px, py


def load_font(size, bold=False):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    ]
    for path in candidates:
        if pathlib.Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_radius(draw, bounds, size):
    points = []
    radius_deg_lat = AUGUSTA_RADIUS_NM / 60
    lat0 = AUGUSTA["lat"]
    lon0 = AUGUSTA["lon"]
    for degree in range(0, 361, 4):
        theta = math.radians(degree)
        lat = lat0 + math.sin(theta) * radius_deg_lat
        lon = lon0 + math.cos(theta) * radius_deg_lat / max(math.cos(math.radians(lat0)), 0.1)
        points.append(project(lon, lat, bounds, size))
    draw.line(points, fill=(60, 60, 60, 95), width=2)


def draw_paths(panel, paths, color):
    overlay = Image.new("RGBA", panel.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay, "RGBA")
    max_gap_seconds = 15 * 60
    width = 1

    for points in paths.values():
        segment = []
        last_ts = None
        for ts, lon, lat in points:
            if last_ts is not None and ts - last_ts > max_gap_seconds:
                if len(segment) >= 2:
                    draw.line(segment, fill=color, width=width, joint="curve")
                segment = []
            segment.append(project(lon, lat, MAP_BOUNDS, panel.size))
            last_ts = ts
        if len(segment) >= 2:
            draw.line(segment, fill=color, width=width, joint="curve")

    return Image.alpha_composite(panel, overlay)


def grid_delta_stats(current, baseline):
    deltas = {}
    for cell in set(current["cell_aircraft"]) | set(baseline["cell_aircraft"]):
        deltas[cell] = len(current["cell_aircraft"].get(cell, set())) - len(baseline["cell_aircraft"].get(cell, set()))
    values = list(deltas.values())
    positives = [value for value in values if value > 0]
    negatives = [value for value in values if value < 0]
    return {
        "cells": len(deltas),
        "positive_cells": len(positives),
        "negative_cells": len(negatives),
        "neutral_cells": len([value for value in values if value == 0]),
        "max_positive": max(positives) if positives else 0,
        "max_negative": min(negatives) if negatives else 0,
    }


def draw_grid_delta_overlay(panel, current, baseline):
    deltas = {}
    for cell in set(current["cell_aircraft"]) | set(baseline["cell_aircraft"]):
        deltas[cell] = len(current["cell_aircraft"].get(cell, set())) - len(baseline["cell_aircraft"].get(cell, set()))

    if not deltas:
        return panel

    nonzero = sorted(abs(value) for value in deltas.values() if value)
    scale = nonzero[int(0.92 * (len(nonzero) - 1))] if nonzero else 1
    scale = max(scale, 1)

    overlay = Image.new("RGBA", panel.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay, "RGBA")
    for (row, col), delta in deltas.items():
        lon0, lat0, lon1, lat1 = grid_cell_bounds(row, col)
        corners = [
            project(lon0, lat0, MAP_BOUNDS, panel.size),
            project(lon1, lat0, MAP_BOUNDS, panel.size),
            project(lon1, lat1, MAP_BOUNDS, panel.size),
            project(lon0, lat1, MAP_BOUNDS, panel.size),
        ]
        if delta > 0:
            intensity = min(abs(delta) / scale, 1.0)
            fill = (205, 34, 38, int(38 + 114 * intensity))
            outline = (150, 26, 28, 145)
        elif delta < 0:
            intensity = min(abs(delta) / scale, 1.0)
            fill = (32, 96, 182, int(36 + 108 * intensity))
            outline = (25, 73, 140, 140)
        else:
            fill = (122, 122, 122, 34)
            outline = (96, 96, 96, 82)
        draw.polygon(corners, fill=fill)
        draw.line(corners + [corners[0]], fill=outline, width=1)

    return Image.alpha_composite(panel, overlay)


def draw_panel(base, window_data, spec, baseline_data=None):
    panel = base.copy()
    panel = draw_paths(panel, window_data["paths"], spec.color)
    if baseline_data is not None:
        panel = draw_grid_delta_overlay(panel, window_data, baseline_data)
    draw = ImageDraw.Draw(panel, "RGBA")
    draw_radius(draw, MAP_BOUNDS, panel.size)

    aug_x, aug_y = project(AUGUSTA["lon"], AUGUSTA["lat"], MAP_BOUNDS, panel.size)
    draw.ellipse((aug_x - 6, aug_y - 6, aug_x + 6, aug_y + 6), fill=(30, 30, 30, 230), outline=(255, 255, 255, 240), width=2)

    title_font = load_font(25, bold=True)
    meta_font = load_font(17)
    chip_font = load_font(15, bold=True)
    label_font = load_font(13)

    local_start = dt.datetime.fromisoformat(window_data["local_start"])
    local_end = dt.datetime.fromisoformat(window_data["local_end"])
    date_label = local_start.strftime("%b %-d, %Y")
    time_label = f"{local_start.strftime('%-I %p')}-{local_end.strftime('%-I %p')} PDT"

    draw.rounded_rectangle((16, 16, 520, 112), radius=8, fill=(255, 255, 255, 224), outline=(210, 210, 205, 230), width=1)
    draw.text((30, 26), f"{window_data['title']} · {date_label}", fill=(25, 30, 35, 255), font=title_font)
    draw.text((30, 61), time_label, fill=(60, 65, 70, 255), font=meta_font)
    draw.text(
        (30, 85),
        f"{window_data['visible_unique_aircraft']} tracked aircraft · {window_data['augusta_linked_unique_aircraft']} low-altitude Augusta-linked · peak {window_data['metric_peak']}",
        fill=(60, 65, 70, 255),
        font=meta_font,
    )

    if baseline_data is not None:
        stats = grid_delta_stats(window_data, baseline_data)
        legend_x = 324
        legend_y = panel.size[1] - 43
        draw.rounded_rectangle((legend_x, legend_y, legend_x + 465, legend_y + 27), radius=5, fill=(255, 255, 255, 220))
        draw.rectangle((legend_x + 12, legend_y + 8, legend_x + 32, legend_y + 20), fill=(205, 34, 38, 135), outline=(150, 26, 28, 160))
        draw.rectangle((legend_x + 134, legend_y + 8, legend_x + 154, legend_y + 20), fill=(32, 96, 182, 125), outline=(25, 73, 140, 150))
        draw.rectangle((legend_x + 248, legend_y + 8, legend_x + 268, legend_y + 20), fill=(122, 122, 122, 52), outline=(96, 96, 96, 95))
        draw.text((legend_x + 40, legend_y + 4), f"+ cells {stats['positive_cells']}", fill=(45, 45, 45, 255), font=chip_font)
        draw.text((legend_x + 162, legend_y + 4), f"- cells {stats['negative_cells']}", fill=(45, 45, 45, 255), font=chip_font)
        draw.text((legend_x + 276, legend_y + 4), f"0 cells {stats['neutral_cells']}", fill=(45, 45, 45, 255), font=chip_font)

    draw.rounded_rectangle((18, panel.size[1] - 42, 214, panel.size[1] - 16), radius=5, fill=(255, 255, 255, 215))
    draw.line((31, panel.size[1] - 29, 70, panel.size[1] - 29), fill=spec.color, width=4)
    draw.text((80, panel.size[1] - 38), "tracked aircraft trail", fill=(45, 45, 45, 255), font=chip_font)
    draw.text((aug_x + 9, aug_y - 18), "Augusta", fill=(35, 35, 35, 230), font=label_font, stroke_width=2, stroke_fill=(255, 255, 255, 210))
    return panel


def aligned_deltas(current, baseline):
    current_counts = [row["concurrent_count"] for row in current["metric_samples"]]
    baseline_counts = [row["concurrent_count"] for row in baseline["metric_samples"]]
    deltas = [a - b for a, b in zip(current_counts, baseline_counts)]
    return {
        "peak_delta": max(deltas) if deltas else None,
        "average_delta": round(sum(deltas) / len(deltas), 1) if deltas else None,
        "deltas": deltas,
    }


def write_summary(results):
    serializable = {}
    for key, data in results.items():
        serializable[key] = {k: v for k, v in data.items() if k not in ("paths", "cell_aircraft")}
        serializable[key]["path_aircraft"] = len(data["paths"])

    serializable["comparisons"] = {
        "2026_masters_vs_prior": aligned_deltas(results["2026_masters"], results["2026_prior"]),
        "2025_masters_vs_prior": aligned_deltas(results["2025_masters"], results["2025_prior"]),
    }
    serializable["grid_delta_comparisons"] = {
        "cell_size_miles": GRID_CELL_MILES,
        "2026_masters_vs_prior": grid_delta_stats(results["2026_masters"], results["2026_prior"]),
        "2025_masters_vs_prior": grid_delta_stats(results["2025_masters"], results["2025_prior"]),
    }
    OUT_SUMMARY.parent.mkdir(parents=True, exist_ok=True)
    OUT_SUMMARY.write_text(json.dumps(serializable, indent=2), "utf8")


def render_image(results):
    base = build_basemap(MAP_BOUNDS, PANEL_SIZE)
    panels = []
    for spec in WINDOWS:
        baseline = results[spec.comparison_key] if spec.comparison_key else None
        panels.append(draw_panel(base, results[spec.key], spec, baseline))

    gutter = 28
    header_h = 118
    footer_h = 54
    width = PANEL_SIZE[0] * 2 + gutter * 3
    height = header_h + PANEL_SIZE[1] * 2 + gutter * 2 + footer_h
    image = Image.new("RGBA", (width, height), "#f3f1eb")
    draw = ImageDraw.Draw(image, "RGBA")

    title_font = load_font(38, bold=True)
    subtitle_font = load_font(19)
    small_font = load_font(14)
    draw.text((gutter, 24), "Masters Sunday Flight Trail Density", fill=(24, 28, 32, 255), font=title_font)
    draw.text(
        (gutter, 72),
        f"All tracked aircraft during each 4 PM-10 PM PDT window. Masters panels include ~{GRID_CELL_MILES:.0f} mi unique-aircraft delta cells vs the previous Sunday.",
        fill=(66, 70, 74, 255),
        font=subtitle_font,
    )

    positions = [
        (gutter, header_h),
        (gutter * 2 + PANEL_SIZE[0], header_h),
        (gutter, header_h + PANEL_SIZE[1] + gutter),
        (gutter * 2 + PANEL_SIZE[0], header_h + PANEL_SIZE[1] + gutter),
    ]
    for panel, position in zip(panels, positions):
        shadow = Image.new("RGBA", (PANEL_SIZE[0] + 6, PANEL_SIZE[1] + 6), (0, 0, 0, 0))
        shadow_draw = ImageDraw.Draw(shadow)
        shadow_draw.rounded_rectangle((6, 6, PANEL_SIZE[0] + 5, PANEL_SIZE[1] + 5), radius=9, fill=(0, 0, 0, 35))
        image.alpha_composite(shadow, (position[0] - 3, position[1] - 3))
        image.alpha_composite(panel, position)
        border = ImageDraw.Draw(image, "RGBA")
        border.rounded_rectangle(
            (position[0], position[1], position[0] + PANEL_SIZE[0], position[1] + PANEL_SIZE[1]),
            radius=8,
            outline=(190, 188, 182, 230),
            width=1,
        )

    comp_2026 = aligned_deltas(results["2026_masters"], results["2026_prior"])
    comp_2025 = aligned_deltas(results["2025_masters"], results["2025_prior"])
    footer = (
        f"Metric check vs previous Sunday: 2026 avg {comp_2026['average_delta']:+.1f}, peak aligned {comp_2026['peak_delta']:+d}; "
        f"2025 avg {comp_2025['average_delta']:+.1f}, peak aligned {comp_2025['peak_delta']:+d}. "
        "Basemap: © OpenStreetMap contributors © CARTO."
    )
    draw.text((gutter, height - 38), footer, fill=(76, 78, 80, 255), font=small_font)

    OUT_IMAGE.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(OUT_IMAGE, quality=95)


def main():
    tracked_keys = tracked_aircraft_keys()
    results = {}
    for spec in WINDOWS:
        print(f"Building {spec.key} ({spec.date})...")
        results[spec.key] = build_window_tracks(spec, tracked_keys)
        print(
            f"  {results[spec.key]['augusta_linked_unique_aircraft']} aircraft, "
            f"{results[spec.key]['kept_track_points']} tracked points, "
            f"{results[spec.key]['downloaded_files']} downloads"
        )

    write_summary(results)
    render_image(results)
    print(f"Wrote {OUT_IMAGE.relative_to(ROOT_DIR)}")
    print(f"Wrote {OUT_SUMMARY.relative_to(ROOT_DIR)}")


if __name__ == "__main__":
    main()
