import io
import os
import pathlib
import struct
import sys
import tempfile
import unittest
import urllib.error
import datetime as dt
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))

import heatmap_source
from heatmap_source import fetch_heatmap, looks_like_heatmap, url_for


MARKER = struct.pack("<I", 0x0E7F7C9D)


def sample_heatmap(slices=1):
    return struct.pack("<I", slices) + b"\0" * (slices * 16 - 4) + MARKER + b"\0" * 32


class HeatmapSourceTests(unittest.TestCase):
    def setUp(self):
        self.previous_source = os.environ.get("ADSBX_HEATMAP_SOURCE")
        os.environ.pop("ADSBX_HEATMAP_SOURCE", None)

    def tearDown(self):
        if self.previous_source is None:
            os.environ.pop("ADSBX_HEATMAP_SOURCE", None)
        else:
            os.environ["ADSBX_HEATMAP_SOURCE"] = self.previous_source

    def test_urls_use_same_slot_layout(self):
        timestamp = dt.datetime(2026, 10, 29, 16, 30, tzinfo=dt.timezone.utc)
        self.assertEqual(
            url_for(timestamp, "adsbx"),
            "https://globe.adsbexchange.com/globe_history/2026/10/29/heatmap/33.bin.ttf",
        )
        self.assertEqual(
            url_for(timestamp, "adsbfi"),
            "https://globe.adsb.fi/globe_history/2026/10/29/heatmap/33.bin.ttf",
        )

    def test_falls_back_to_adsbfi_after_403(self):
        def fake_urlopen(request, timeout=0):
            if "adsbexchange.com" in request.full_url:
                raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, None)
            return io.BytesIO(sample_heatmap())

        with tempfile.TemporaryDirectory() as directory:
            destination = pathlib.Path(directory) / "33.bin.ttf"
            with mock.patch("heatmap_source.urllib.request.urlopen", side_effect=fake_urlopen):
                result = fetch_heatmap(
                    dt.datetime(2026, 10, 29, 16, 30, tzinfo=dt.timezone.utc),
                    destination,
                    max_retries=1,
                )
            self.assertTrue(result.available)
            self.assertEqual(result.source, "adsbfi")
            self.assertTrue(destination.exists())
            self.assertTrue(looks_like_heatmap(destination))

    def test_forced_source_does_not_fall_back(self):
        os.environ["ADSBX_HEATMAP_SOURCE"] = "adsbx"

        def fake_urlopen(request, timeout=0):
            raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, None)

        with tempfile.TemporaryDirectory() as directory:
            destination = pathlib.Path(directory) / "33.bin.ttf"
            with mock.patch("heatmap_source.urllib.request.urlopen", side_effect=fake_urlopen):
                result = fetch_heatmap(
                    dt.datetime(2026, 10, 29, 16, 30, tzinfo=dt.timezone.utc),
                    destination,
                    max_retries=1,
                )
            self.assertFalse(result.available)
            self.assertFalse(destination.exists())

    def test_rejects_html_error_page(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = pathlib.Path(directory) / "33.bin.ttf"
            with mock.patch(
                "heatmap_source.urllib.request.urlopen",
                side_effect=lambda request, timeout=0: io.BytesIO(b"<html>blocked</html>"),
            ):
                result = fetch_heatmap(
                    dt.datetime(2026, 10, 29, 16, 30, tzinfo=dt.timezone.utc),
                    destination,
                    max_retries=1,
                )
            self.assertFalse(result.available)
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
