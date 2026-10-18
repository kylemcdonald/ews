import datetime
from dataclasses import dataclass

import numpy as np


def point_to_str(point):
    hex_value = f"{point & 0xFFFFFF:06x}"
    return ("~" + hex_value) if (point & 0x1000000) else hex_value


def str_to_point(value):
    if value[0] == "~":
        return int(value[1:], 16) | 0x1000000
    return int(value, 16)


def normalize_hex_filter(hex_filter):
    if not hex_filter:
        return False, set()

    normalized = set()
    for value in hex_filter:
        if isinstance(value, int):
            normalized.add(value)
        else:
            normalized.add(str_to_point(value))

    return True, normalized


@dataclass
class Slice:
    timestamp: datetime.datetime
    callsigns: list
    telemetry: list


@dataclass
class Callsign:
    hex: str
    flight: str
    squawk: str


@dataclass
class Telemetry:
    hex: str
    type: str
    lat: float
    lon: float
    alt: float
    gs: float


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


def load_heatmap_points(filename):
    with open(filename, "rb") as file_handle:
        raw = file_handle.read()

    points_u8 = np.frombuffer(raw, dtype=np.uint8)
    return points_u8, points_u8.view(np.uint32), points_u8.view(np.int32)


def find_slice_starts(points_u):
    # Records are four words wide, so only markers aligned with the first one begin a slice.
    starts = np.flatnonzero(points_u == SLICE_BEGIN_MARKER)
    if not len(starts):
        return starts

    return starts[(starts - starts[0]) % 4 == 0]


def slice_timestamp(points_u, index):
    now = points_u[index + 2] / 1000 + points_u[index + 1] * 4294967.296
    return datetime.datetime.fromtimestamp(now, tz=datetime.timezone.utc)


def parse_slice(points_u8, points_u, points, index, end, bbox, return_callsigns, filter_hex, hex_filter):
    callsigns = []
    telemetry = []
    timestamp = slice_timestamp(points_u, index)
    index += 4

    while index < end:
        point0 = points[index]

        if filter_hex and point0 not in hex_filter:
            index += 4
            continue

        point1 = points[index + 1]
        point2 = points[index + 2]

        if point1 > 1073741824:
            if not return_callsigns:
                index += 4
                continue

            hex_value = point_to_str(point0)
            flight = None
            if points_u8[4 * (index + 2)] != 0:
                flight = "".join(chr(points_u8[4 * (index + 2) + offset]) for offset in range(8)).strip()

            squawk = str(point1 & 0xFFFF).zfill(4)
            callsigns.append(Callsign(hex=hex_value, flight=flight, squawk=squawk))
            index += 4
            continue

        lat = point1
        lon = point2

        if bbox is not None:
            if lat < bbox[0] or lat > bbox[2] or lon < bbox[1] or lon > bbox[3]:
                index += 4
                continue

        lat /= 1e6
        lon /= 1e6
        hex_value = point_to_str(point0)
        type_index = point0 >> 27 & 0x1F
        point3 = points[index + 3]

        alt = point3 & 65535
        if alt & 32768:
            alt |= -65536
        if alt == -123:
            alt = "ground"
        else:
            alt *= 25

        gs = point3 >> 16
        if gs == -1:
            gs = None
        else:
            gs /= 10

        telemetry.append(
            Telemetry(
                hex=hex_value,
                type=TYPE_LIST[type_index] if type_index < len(TYPE_LIST) else "unknown",
                lat=lat,
                lon=lon,
                alt=alt,
                gs=gs,
            )
        )
        index += 4

    if not telemetry and not callsigns:
        return None

    return Slice(timestamp=timestamp, callsigns=callsigns, telemetry=telemetry)


def parse_heatmap(filename, bbox=None, return_callsigns=True, hex_filter=None):
    points_u8, points_u, points = load_heatmap_points(filename)

    if bbox is not None:
        bbox = [bbox[0] * 1e6, bbox[1] * 1e6, bbox[2] * 1e6, bbox[3] * 1e6]

    filter_hex, hex_filter = normalize_hex_filter(hex_filter)
    starts = find_slice_starts(points_u)
    ends = [*starts[1:], len(points)]
    data = []

    for start, end in zip(starts, ends):
        heatmap_slice = parse_slice(
            points_u8, points_u, points, start, end, bbox, return_callsigns, filter_hex, hex_filter
        )
        if heatmap_slice:
            data.append(heatmap_slice)

    return data


def parse_latest_heatmap_slice(filename, return_callsigns=False):
    """Return the same slice as max(parse_heatmap(...), key=timestamp) while parsing only that slice."""
    points_u8, points_u, points = load_heatmap_points(filename)
    starts = find_slice_starts(points_u)
    ends = [*starts[1:], len(points)]
    timestamps = [points_u[start + 2] / 1000 + points_u[start + 1] * 4294967.296 for start in starts]

    # Newest first; equal timestamps keep file order, like max().
    for position in sorted(range(len(starts)), key=lambda item: (-timestamps[item], item)):
        heatmap_slice = parse_slice(
            points_u8, points_u, points, starts[position], ends[position], None, return_callsigns, False, set()
        )
        if heatmap_slice:
            return heatmap_slice

    return None
