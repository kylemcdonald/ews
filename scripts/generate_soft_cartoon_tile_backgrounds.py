from __future__ import annotations

import base64
import io
import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env"
PUBLIC_DIR = ROOT / "client" / "public" / "backgrounds"
MANIFEST_DIR = ROOT / "client" / "src" / "generated"
MANIFEST_PATH = MANIFEST_DIR / "softCartoonTileManifest.json"
TMP_DIR = ROOT / "tmp" / "cartoon_tiles_soft"
RAW_DIR = TMP_DIR / "raw"
SHEET_PATH = TMP_DIR / "soft-cartoon-tile-sheet.png"

MODEL_CANDIDATES = [
    "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image-preview",
]

TARGET_SIZE = 512


@dataclass(frozen=True)
class PromptSpec:
    background_id: str
    label: str
    filename: str
    prompt: str
    fallback_prompt: str


PROMPTS = [
    PromptSpec(
        "soft-cartoon-tile-01",
        "Soft warheads 1",
        "soft-cartoon-tile-01.png",
        "Create a seamless repeating square website wallpaper tile in a washed-out late-1990s personal-web style. Small cartoon nuclear warheads drifting diagonally across pale gray-blue paper, with very soft contrast, faded outlines, and light JPEG-like wear as if the file has been copied around the internet for years. No mushroom clouds, no spaceships, no text, no watermark.",
        "Create a seamless repeating wallpaper tile with small faded cartoon warheads on pale gray-blue paper. Low contrast 1990s web clip-art style, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-02",
        "Soft warheads 2",
        "soft-cartoon-tile-02.png",
        "Generate a seamless square wallpaper tile for a 1998-style homepage. Sparse hand-drawn cartoon warheads on off-white copier paper with faint shadowing, low saturation, and slightly degraded scan quality. Very quiet palette, soft black outlines, no explosions, no spaceships, no text, no watermark.",
        "Generate a seamless wallpaper tile with sparse faded cartoon warheads on off-white paper. Low contrast old-web clip-art style, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-03",
        "Soft warheads 3",
        "soft-cartoon-tile-03.png",
        "Create a seamless repeating wallpaper tile with little cartoon falling warheads and a few tiny radiation symbols on dusty blue-gray paper. Looks like low-budget late-90s educational clip-art that has been saved and recompressed many times. Gentle contrast, muted colors, no mushroom clouds, no spaceships, no text, no watermark.",
        "Create a seamless wallpaper tile with faded cartoon warheads and a few radiation symbols on dusty blue-gray paper. 1990s clip-art style, low contrast, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-04",
        "Soft warheads 4",
        "soft-cartoon-tile-04.png",
        "Make a seamless repeating square wallpaper tile with small cartoon warheads arranged loosely in rows on pale beige paper. Soft copier haze, slightly uneven black outlines, muted yellow-gray tones, and an old downloaded-GIF feeling without looking like pixel art. No mushroom clouds, no spaceships, no text, no watermark.",
        "Make a seamless repeating wallpaper tile with small faded cartoon warheads on pale beige paper. Quiet 1990s website style, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-05",
        "Soft warheads 5",
        "soft-cartoon-tile-05.png",
        "Create a seamless wallpaper tile with simple cartoon nuclear warheads and small radiation symbols on light gray paper with subtle scanner streaks. The image should feel old, passed around, and slightly degraded, with lower contrast and restrained color. No mushroom clouds, no spaceships, no text, no watermark.",
        "Create a seamless wallpaper tile with faded cartoon warheads and small radiation symbols on light gray paper. Old web graphic style, low contrast, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-06",
        "Soft warheads 6",
        "soft-cartoon-tile-06.png",
        "Generate a seamless square website background tile with small hand-drawn warheads drifting across pale slate-blue paper. Very muted palette, low contrast, soft edge wear, and a 1990s internet clip-art feeling as if it came from an archived GeoCities page. No mushroom clouds, no spaceships, no text, no watermark.",
        "Generate a seamless wallpaper tile with small faded cartoon warheads on pale slate-blue paper. 1990s archived-web style, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-07",
        "Soft warheads 7",
        "soft-cartoon-tile-07.png",
        "Create a seamless repeating wallpaper tile with simple cartoon warheads and occasional tiny radiation emblems on pale mint-gray paper. The art should feel photocopied, a little blurry, and modest rather than loud. Late-90s home-web wallpaper, no mushroom clouds, no spaceships, no text, no watermark.",
        "Create a seamless repeating wallpaper tile with faded cartoon warheads and tiny radiation symbols on pale mint-gray paper. Quiet late-90s web style, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-08",
        "Soft warheads 8",
        "soft-cartoon-tile-08.png",
        "Generate a seamless square wallpaper tile with small cartoon falling warheads on pale lavender-gray paper. Limited muted colors, slightly fuzzy outlines, low contrast, and a passed-around-in-email attachment feeling from the late 1990s. No mushroom clouds, no spaceships, no text, no watermark.",
        "Generate a seamless wallpaper tile with small faded cartoon warheads on pale lavender-gray paper. Low-contrast 1990s internet style, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-09",
        "Soft warheads 9",
        "soft-cartoon-tile-09.png",
        "Create a seamless repeating square wallpaper tile with sparse cartoon warheads and tiny radiation symbols on pale warm-gray paper. Mild copier artifacts, slight blur, and reduced contrast so it feels old and circulated rather than dramatic. No mushroom clouds, no spaceships, no text, no watermark.",
        "Create a seamless wallpaper tile with sparse faded cartoon warheads and tiny radiation symbols on pale warm-gray paper. Old internet wallpaper style, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-10",
        "Soft warheads 10",
        "soft-cartoon-tile-10.png",
        "Make a seamless repeating wallpaper tile for an old personal website using small cartoon nuclear warheads only, with a few faint radiation symbols allowed. Off-white to gray paper, low saturation, soft outlines, and a slightly compressed downloaded-file look. Quiet and understated, not loud. No mushroom clouds, no spaceships, no text, no watermark.",
        "Make a seamless repeating wallpaper tile with small faded cartoon warheads and a few faint radiation symbols on off-white paper. Quiet 1990s web wallpaper style, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-11",
        "Soft warheads 11",
        "soft-cartoon-tile-11.png",
        "Create a seamless repeating square wallpaper tile with sparse cartoon warheads and small radiation symbols on very pale gray-blue paper. Keep the contrast low and the outlines soft. No crumpled paper, no torn paper edges, no border, no vignette, and the pattern must tile cleanly to every edge. Quiet late-1990s web style, no spaceships, no mushroom clouds, no text, no watermark.",
        "Create a seamless wallpaper tile with sparse faded cartoon warheads and small radiation symbols on pale gray-blue paper. Low contrast, no borders or torn edges, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-12",
        "Soft warheads 12",
        "soft-cartoon-tile-12.png",
        "Generate a seamless square website wallpaper tile with only cartoon nuclear warheads and many small radiation symbols. Use muted lavender-gray and dusty blue colors similar to old clip-art. Keep the background flat and clean, with no paper creases, no torn edges, no frame, and no vignette. Soft, old, and slightly degraded, not loud. No spaceships, no mushroom clouds, no text, no watermark.",
        "Generate a seamless wallpaper tile with faded cartoon warheads and many small radiation symbols on a flat muted lavender-gray background. No borders or torn edges, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-13",
        "Soft warheads 13",
        "soft-cartoon-tile-13.png",
        "Create a seamless repeating wallpaper tile for a 1990s personal homepage. Sparse diagonal pattern of small cartoon warheads on pale blue paper, very low contrast, with occasional radiation symbols. The surface should be flat and even, not crumpled, and the tile should have no edge artifacts, no border, no torn paper effect. No spaceships, no mushroom clouds, no text, no watermark.",
        "Create a seamless wallpaper tile with a sparse diagonal pattern of faded cartoon warheads and occasional radiation symbols on pale blue paper. No border, no torn edges, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-14",
        "Soft warheads 14",
        "soft-cartoon-tile-14.png",
        "Make a seamless repeating square wallpaper tile with small hand-drawn cartoon warheads and more frequent little radiation symbols, using muted peach, gray, and dusty blue colors. The style should feel circulated and old-web, but the background must be clean and flat with no wrinkles, no torn edges, no border, and no vignette. No spaceships, no mushroom clouds, no text, no watermark.",
        "Make a seamless wallpaper tile with faded cartoon warheads and frequent small radiation symbols in muted peach and dusty blue tones. Flat background, no border or torn edges, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-15",
        "Soft warheads 15",
        "soft-cartoon-tile-15.png",
        "Create a seamless square wallpaper tile with only cartoon warheads, arranged sparsely with plenty of empty space on pale warm-gray paper. Add a few tiny radiation symbols but keep everything understated, low-contrast, and slightly worn like a downloaded background from 1999. No crumpled texture, no torn edges, no border, no vignette, no spaceships, no mushroom clouds, no text, no watermark.",
        "Create a seamless wallpaper tile with sparse faded cartoon warheads and a few tiny radiation symbols on pale warm-gray paper. Low contrast, flat background, no border or torn edges, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-16",
        "Soft warheads 16",
        "soft-cartoon-tile-16.png",
        "Generate a seamless repeating wallpaper tile with small cartoon falling warheads and more visible radiation symbols on soft blue-gray paper. The colors should be washed out and modest, with flat background tone and no edge framing or paper damage. Must tile cleanly. Feels like old late-90s clip-art passed around online. No spaceships, no mushroom clouds, no text, no watermark.",
        "Generate a seamless wallpaper tile with faded cartoon falling warheads and visible radiation symbols on soft blue-gray paper. Low contrast, flat background, no border or torn edges, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-17",
        "Soft warheads 17",
        "soft-cartoon-tile-17.png",
        "Create a seamless square website wallpaper tile with cartoon warheads in muted dusty orange and pale blue-green, using the softer colors of old web clip-art rather than bright colors. Include some small radiation symbols. Keep the layout sparse and the background clean, with no crumples, no tears, no border, and no vignette. No spaceships, no mushroom clouds, no text, no watermark.",
        "Create a seamless wallpaper tile with sparse faded cartoon warheads and small radiation symbols in muted dusty orange and pale blue-green. Flat background, no border or torn edges, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-18",
        "Soft warheads 18",
        "soft-cartoon-tile-18.png",
        "Make a seamless repeating wallpaper tile with very small cartoon warheads and many tiny radiation symbols on a pale off-white background. The look should be quiet, low-contrast, and old, like a small web wallpaper file copied many times. Clean flat paper only, no crumples, no deckled edges, no border, no vignette. No spaceships, no mushroom clouds, no text, no watermark.",
        "Make a seamless wallpaper tile with very small faded cartoon warheads and many tiny radiation symbols on pale off-white paper. Flat background, no border or torn edges, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-19",
        "Soft warheads 19",
        "soft-cartoon-tile-19.png",
        "Generate a seamless square wallpaper tile with simple faded cartoon warheads in a loose diagonal grid, using soft lavender-gray and blue tones. Add radiation symbols more often than before. Keep the tone restrained and the background perfectly flat with no wrinkles, no torn edges, no frame, and no vignette. Must tile invisibly. No spaceships, no mushroom clouds, no text, no watermark.",
        "Generate a seamless wallpaper tile with faded cartoon warheads in a loose diagonal grid and more frequent radiation symbols. Soft lavender-gray and blue tones, flat background, no border or torn edges, no spaceships, no text, no watermark.",
    ),
    PromptSpec(
        "soft-cartoon-tile-20",
        "Soft warheads 20",
        "soft-cartoon-tile-20.png",
        "Create a seamless repeating square wallpaper tile in a very quiet late-1990s internet style. Use sparse cartoon warheads, a clean flat pale blue-gray background, and a handful of small radiation symbols. The style should feel circulated and compressed but not loud. No crumpled paper, no torn edges, no border, no vignette, and the tile must repeat cleanly. No spaceships, no mushroom clouds, no text, no watermark.",
        "Create a seamless wallpaper tile with sparse faded cartoon warheads and a handful of small radiation symbols on a clean pale blue-gray background. No borders or torn edges, no spaceships, no text, no watermark.",
    ),
]


def load_api_key() -> str:
    if os.environ.get("GEMINI_API_KEY"):
        return os.environ["GEMINI_API_KEY"]

    for raw_line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() == "GEMINI_API_KEY":
            value = value.strip().strip('"').strip("'")
            if value:
                return value
    raise RuntimeError("GEMINI_API_KEY not found in .env")


def request_image_bytes(api_key: str, prompt: str) -> tuple[bytes, str]:
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {
                "aspectRatio": "1:1",
                "imageSize": "1K",
            },
        },
    }
    body = json.dumps(payload).encode("utf-8")

    last_error: Exception | None = None
    for model in MODEL_CANDIDATES:
        request = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": api_key,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=240) as response:
                data = json.load(response)
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code in {400, 404}:
                continue
            error_body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Gemini request failed ({exc.code}): {error_body}") from exc
        except urllib.error.URLError as exc:
            last_error = exc
            continue

        for candidate in data.get("candidates", []):
            content = candidate.get("content", {})
            for part in content.get("parts", []):
                inline_data = part.get("inlineData") or part.get("inline_data")
                if inline_data and inline_data.get("data"):
                    return base64.b64decode(inline_data["data"]), inline_data.get("mimeType", "image/png")

        raise RuntimeError(f"No image returned for prompt: {prompt}")

    if last_error is None:
        raise RuntimeError("Gemini request failed before reaching the API")
    raise RuntimeError(f"Gemini request failed: {last_error}") from last_error


def mime_suffix(mime_type: str) -> str:
    return {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
    }.get(mime_type, ".bin")


def normalize_tile(image_bytes: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(image_bytes))
    image = ImageOps.exif_transpose(image).convert("RGB")
    width, height = image.size
    square = min(width, height)
    left = max(0, (width - square) // 2)
    top = max(0, (height - square) // 2)
    image = image.crop((left, top, left + square, top + square))
    return image.resize((TARGET_SIZE, TARGET_SIZE), resample=Image.Resampling.LANCZOS)


def build_contact_sheet(paths: list[Path]) -> None:
    thumbs = []
    for path in paths:
        image = Image.open(path).convert("RGB").resize((180, 180), resample=Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (220, 220), "white")
        canvas.paste(image, (20, 10))
        draw = ImageDraw.Draw(canvas)
        draw.rectangle((19, 9, 200, 190), outline="black")
        draw.text((12, 196), path.stem[:24], fill="black")
        thumbs.append(canvas)

    cols = 2
    rows = (len(thumbs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * 220, rows * 220), (240, 240, 240))
    for index, image in enumerate(thumbs):
        sheet.paste(image, ((index % cols) * 220, (index // cols) * 220))
    SHEET_PATH.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(SHEET_PATH)


def main() -> None:
    api_key = load_api_key()
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)

    manifest = []
    processed_paths: list[Path] = []

    for index, spec in enumerate(PROMPTS, start=1):
        print(f"[{index}/{len(PROMPTS)}] {spec.label}")
        try:
            image_bytes, mime_type = request_image_bytes(api_key, spec.prompt)
        except RuntimeError:
            image_bytes, mime_type = request_image_bytes(api_key, spec.fallback_prompt)

        raw_path = RAW_DIR / f"{spec.background_id}-raw{mime_suffix(mime_type)}"
        raw_path.write_bytes(image_bytes)

        image = normalize_tile(image_bytes)
        output_path = PUBLIC_DIR / spec.filename
        image.save(output_path, optimize=True)

        manifest.append(
            {
                "id": spec.background_id,
                "label": spec.label,
                "category": "Gemini soft warhead tiles",
                "file": spec.filename,
            }
        )
        processed_paths.append(output_path)
        time.sleep(1.0)

    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    build_contact_sheet(processed_paths)
    print(f"Wrote {len(manifest)} soft cartoon tile backgrounds to {PUBLIC_DIR}")


if __name__ == "__main__":
    main()
