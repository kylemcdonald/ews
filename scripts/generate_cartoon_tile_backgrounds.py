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
MANIFEST_PATH = MANIFEST_DIR / "cartoonTileManifest.json"
TMP_DIR = ROOT / "tmp" / "cartoon_tiles"
RAW_DIR = TMP_DIR / "raw"
SHEET_PATH = TMP_DIR / "cartoon-tile-sheet.png"

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
        "cartoon-tile-01",
        "Dramatic clip-art 1",
        "cartoon-tile-01.png",
        "Create a seamless repeating square website wallpaper tile for a late-1990s personal homepage. Small cartoon nuclear warheads, mushroom clouds, and blast stars scattered across pale gray paper. Dramatic but handmade. Not pixel art. Not a video game. Looks like clip-art and airbrushed illustration from a 1990s website. No text, no watermark.",
        "Create a seamless repeating square wallpaper tile with small cartoon warheads, mushroom clouds, and starburst explosions on pale gray paper. 1990s web clip-art style, not pixel art, no text, no watermark.",
    ),
    PromptSpec(
        "cartoon-tile-02",
        "Dramatic clip-art 2",
        "cartoon-tile-02.png",
        "Generate a seamless repeating wallpaper tile with hand-drawn cartoon mushroom clouds, orange blast stars, and a few falling warheads. Cream notebook-paper background with faint horizontal rules. 1990s homemade website illustration, dramatic but silly, not a video game, not pixel art, no text, no watermark.",
        "Generate a seamless repeating wallpaper tile with cartoon mushroom clouds, blast stars, and falling warheads on cream lined paper. 1990s web illustration style, no text, no watermark.",
    ),
    PromptSpec(
        "cartoon-tile-03",
        "Dramatic clip-art 3",
        "cartoon-tile-03.png",
        "Create a seamless square wallpaper tile with dramatic cartoon explosions and mushroom clouds in a photocopied zine-meets-clip-art style. Pale blue background, black outlines, orange-red accents, little warheads drifting through the pattern. 1990s website wallpaper, not pixel art, no text, no watermark.",
        "Create a seamless wallpaper tile with cartoon explosions, mushroom clouds, and little warheads on pale blue paper. 1990s clip-art style, not pixel art, no text, no watermark.",
    ),
    PromptSpec(
        "cartoon-tile-04",
        "Dramatic clip-art 4",
        "cartoon-tile-04.png",
        "Make a seamless repeating wallpaper tile for a 1997-style website. Sparse cartoon warheads and mushroom clouds on a dusty lavender background with soft paper texture. Dramatic orange blast stars. Handmade, awkward, clip-art feeling. Not a game. No text. No watermark.",
        "Make a seamless repeating wallpaper tile with cartoon warheads, mushroom clouds, and blast stars on dusty lavender paper. 1990s website style, no text, no watermark.",
    ),
    PromptSpec(
        "cartoon-tile-05",
        "Dramatic clip-art 5",
        "cartoon-tile-05.png",
        "Generate a seamless square wallpaper tile filled with little cartoon missile shapes, smoke puffs, starburst explosions, and mushroom clouds. Pale yellow background, black outline drawing with limited orange and red color. Feels like 1990s clip-art, hand-made and dramatic, not pixel art, no text, no watermark.",
        "Generate a seamless wallpaper tile with cartoon missiles, mushroom clouds, and blast stars on pale yellow paper. 1990s clip-art style, no text, no watermark.",
    ),
    PromptSpec(
        "cartoon-tile-06",
        "Dramatic clip-art 6",
        "cartoon-tile-06.png",
        "Create a seamless repeating square wallpaper tile with cartoon mushroom clouds and bursts arranged diagonally like old office wallpaper. Light gray-blue background, a few small falling warheads. Slightly airbrushed, slightly hand-drawn, definitely 1990s web graphic rather than video game. No text, no watermark.",
        "Create a seamless repeating wallpaper tile with cartoon mushroom clouds, bursts, and a few falling warheads on light gray-blue paper. 1990s web graphic style, no text, no watermark.",
    ),
    PromptSpec(
        "cartoon-tile-07",
        "Dramatic clip-art 7",
        "cartoon-tile-07.png",
        "Create a seamless repeating wallpaper tile with dramatic cartoon blast stars and mushroom clouds, plus a few tilted warheads. Pale mint or pale green paper background. Looks like home-made late-90s website art, not pixel art, not a game, no text, no watermark.",
        "Create a seamless repeating wallpaper tile with cartoon blast stars, mushroom clouds, and a few tilted warheads on pale mint paper. 1990s website art, no text, no watermark.",
    ),
    PromptSpec(
        "cartoon-tile-08",
        "Dramatic clip-art 8",
        "cartoon-tile-08.png",
        "Generate a seamless repeating square tile with little cartoon mushroom clouds, warheads, and starburst explosions on pale peach paper. Use bold black outlines and warm orange-red colors. Slightly goofy and dramatic, like a 1990s homepage wallpaper, not pixel art, no text, no watermark.",
        "Generate a seamless repeating wallpaper tile with cartoon mushroom clouds, warheads, and explosions on pale peach paper. 1990s homepage style, no text, no watermark.",
    ),
    PromptSpec(
        "cartoon-tile-09",
        "Dramatic clip-art 9",
        "cartoon-tile-09.png",
        "Create a seamless square website wallpaper tile with sparse cartoon warheads, smoke curls, tiny mushroom clouds, and dramatic little bursts. Off-white background with faint copier texture. Handmade 1990s intervention graphics, not pixel art, no text, no watermark.",
        "Create a seamless square wallpaper tile with sparse cartoon warheads, mushroom clouds, and dramatic bursts on off-white paper. 1990s handmade graphic style, no text, no watermark.",
    ),
    PromptSpec(
        "cartoon-tile-10",
        "Dramatic clip-art 10",
        "cartoon-tile-10.png",
        "Make a seamless repeating wallpaper tile with dramatic cartoon mushroom clouds, falling warheads, and comic-book style explosions. Pale steel-blue background, slightly grim but still handmade and humorous. Feels like late-90s web wallpaper and clip-art, not pixel art, no text, no watermark.",
        "Make a seamless repeating wallpaper tile with cartoon mushroom clouds, falling warheads, and comic-book explosions on pale steel-blue paper. 1990s web wallpaper style, no text, no watermark.",
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

    for existing in PUBLIC_DIR.glob("*"):
        existing.unlink()

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
                "category": "Gemini cartoon tiles",
                "file": spec.filename,
            }
        )
        processed_paths.append(output_path)
        time.sleep(1.0)

    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    build_contact_sheet(processed_paths)
    print(f"Wrote {len(manifest)} cartoon tile backgrounds to {PUBLIC_DIR}")


if __name__ == "__main__":
    main()
