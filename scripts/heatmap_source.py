"""Download readsb heatmap slices from ADS-B Exchange or a public mirror.

ADS-B Exchange started requiring a Cloudflare Turnstile "verified session" for
``globe_history`` in October 2026.  Those files are the standard readsb
``bin.ttf`` slice format, and several community networks publish the same
format.  ``globe.adsb.fi`` currently serves current and recent history without
a login, so it is used as a drop-in fallback after ADS-B Exchange refuses a
request.

Set ``ADSBX_HEATMAP_SOURCE`` to ``adsbx`` or ``adsbfi`` to force one source,
or leave it unset/``auto`` to try ADS-B Exchange first and fall back.
"""

from __future__ import annotations

import datetime as dt
import os
import pathlib
import struct
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

ADSBX_BASE = "https://globe.adsbexchange.com/globe_history"
ADSBFI_BASE = "https://globe.adsb.fi/globe_history"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"
DEFAULT_TIMEOUT_SECONDS = 120
DEFAULT_MAX_RETRIES = 4
SLICE_MARKER = struct.pack("<I", 0x0E7F7C9D)

SOURCE_LABELS = {
    "adsbx": "ADS-B Exchange heatmap",
    "adsbfi": "adsb.fi heatmap mirror",
    "cache": "cached heatmap",
}


@dataclass(frozen=True)
class HeatmapFetch:
    available: bool
    used_cache: bool
    url: str | None = None
    source: str | None = None

    @property
    def provider_label(self) -> str:
        return SOURCE_LABELS.get(self.source or "", "ADS-B heatmap")


def parse_source_setting() -> tuple[str, ...]:
    value = os.getenv("ADSBX_HEATMAP_SOURCE", "auto").strip().lower()
    if value in {"adsbx", "adsbexchange", "adsb-exchange"}:
        return ("adsbx",)
    if value in {"adsbfi", "adsb.fi", "adsb-fi"}:
        return ("adsbfi",)
    return ("adsbx", "adsbfi")


def slot_index_for(timestamp: dt.datetime) -> int:
    return timestamp.hour * 2 + (1 if timestamp.minute >= 30 else 0)


def coerce_timestamp(value: dt.datetime | dt.date, index: int | None = None) -> dt.datetime:
    if isinstance(value, dt.datetime):
        return value if value.tzinfo else value.replace(tzinfo=dt.timezone.utc)
    if index is None:
        raise ValueError("index is required when passing a date")
    return dt.datetime(
        value.year,
        value.month,
        value.day,
        index // 2,
        30 * (index % 2),
        tzinfo=dt.timezone.utc,
    )


def url_for(timestamp: dt.datetime | dt.date, source: str = "adsbx", index: int | None = None) -> str:
    timestamp = coerce_timestamp(timestamp, index)
    base = ADSBFI_BASE if source == "adsbfi" else ADSBX_BASE
    slot = slot_index_for(timestamp) if index is None else index
    return (
        f"{base}/"
        f"{timestamp.year:04d}/{timestamp.month:02d}/{timestamp.day:02d}/heatmap/{slot:02d}.bin.ttf"
    )


def heatmap_url_for(timestamp: dt.datetime | dt.date, index: int | None = None) -> str:
    """Backward-compatible ADS-B Exchange URL helper."""
    return url_for(timestamp, "adsbx", index)


def looks_like_heatmap(path: pathlib.Path) -> bool:
    try:
        size = path.stat().st_size
        if size < 20:
            return False
        with path.open("rb") as handle:
            header = handle.read(4)
            if len(header) != 4:
                return False
            slices = struct.unpack("<I", header)[0]
            if 1 <= slices <= 1800 and size >= slices * 16 + 16:
                handle.seek(slices * 16)
                if handle.read(4) == SLICE_MARKER:
                    return True
            # Older tools and the ingestion tests write files whose header is
            # a placeholder; accept those when the slice marker is present.
            handle.seek(0)
            return SLICE_MARKER in handle.read(4096)
    except OSError:
        return False


def _validate_payload(data: bytes) -> None:
    if len(data) < 20:
        raise ValueError("response is too short to be a heatmap")
    slices = struct.unpack("<I", data[:4])[0]
    if not 1 <= slices <= 1800 or len(data) < slices * 16 + 16:
        raise ValueError("response is not a readsb heatmap header")
    if data[slices * 16 : slices * 16 + 4] != SLICE_MARKER:
        raise ValueError("response is missing the heatmap slice marker")


def _referer_for(source: str) -> str:
    return "https://globe.adsb.fi/" if source == "adsbfi" else "https://globe.adsbexchange.com/"


def _download_once(url: str, destination: pathlib.Path, source: str, timeout_seconds: int) -> None:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Referer": _referer_for(source)},
    )
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        data = response.read()
    _validate_payload(data)
    temporary = destination.with_suffix(destination.suffix + ".part")
    temporary.write_bytes(data)
    temporary.replace(destination)


def fetch_heatmap(
    timestamp: dt.datetime | dt.date,
    destination: str | pathlib.Path,
    skip_download: bool = False,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    rate_limit_seconds: float = 0.0,
    max_retries: int = DEFAULT_MAX_RETRIES,
    index: int | None = None,
) -> HeatmapFetch:
    """Fetch one half-hour heatmap slice, falling back to adsb.fi when needed.

    A cached file is reused when it is non-empty.  HTTP 403/404 (the gate and
    missing slots) moves on to the next source immediately; transient network
    errors are retried before moving on.
    """
    destination = pathlib.Path(destination)
    timestamp = coerce_timestamp(timestamp, index)
    if destination.exists() and looks_like_heatmap(destination):
        return HeatmapFetch(True, True, None, "cache")
    if skip_download:
        return HeatmapFetch(False, False)

    destination.parent.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None

    for source in parse_source_setting():
        url = url_for(timestamp, source)
        for attempt in range(1, max_retries + 1):
            try:
                _download_once(url, destination, source, timeout_seconds)
                time.sleep(max(0.0, rate_limit_seconds))
                return HeatmapFetch(True, False, url, source)
            except urllib.error.HTTPError as error:
                last_error = error
                # 403 means the ADSBX session gate; 404 means this slot/source
                # does not have the file.  Both are better handled by the next
                # source than by retrying the same URL.
                if error.code in {403, 404}:
                    break
                if attempt == max_retries:
                    break
            except (TimeoutError, urllib.error.URLError, OSError, ValueError) as error:
                last_error = error
                if attempt == max_retries:
                    break
            time.sleep(min(5, attempt))

    if last_error is not None:
        try:
            slot_label = coerce_timestamp(timestamp).isoformat()
        except (TypeError, ValueError):
            slot_label = str(timestamp)
        print(f"Could not fetch heatmap for {slot_label}: {last_error}", file=sys.stderr)
    return HeatmapFetch(False, False)
