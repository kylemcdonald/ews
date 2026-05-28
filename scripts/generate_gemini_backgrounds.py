from __future__ import annotations

import base64
import argparse
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "client" / "public" / "backgrounds"
MANIFEST_DIR = ROOT / "client" / "src" / "generated"
MANIFEST_PATH = MANIFEST_DIR / "geminiBackgroundManifest.json"
ENV_PATH = ROOT / ".env"
TMP_DIR = ROOT / "tmp" / "gemini"
RAW_OUTPUT_DIR = TMP_DIR / "raw"
MODEL_CANDIDATES = [
    "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image-preview",
]


@dataclass(frozen=True)
class PromptSpec:
    background_id: str
    label: str
    category: str
    filename: str
    prompt: str
    fallback_prompt: str | None = None


PROMPTS = [
    PromptSpec(
        "gemini-warhead-1",
        "Gemini warhead 1",
        "Gemini illustrated tiles",
        "gemini-warhead-1.png",
        "Create a seamless repeating website background tile for a 1997 GeoCities page. Tiny cartoon falling nuclear warheads with red noses, wobble lines, and little smoke puffs. Very sparse repeat, lots of empty pale blue paper background. Silly hand-drawn lo-fi illustration, slightly awkward, black outlines, limited colors, no text, no watermark, edges must align seamlessly for tiling.",
    ),
    PromptSpec(
        "gemini-warhead-2",
        "Gemini warhead 2",
        "Gemini illustrated tiles",
        "gemini-warhead-2.png",
        "Make a seamless square wallpaper tile with a few small olive green cartoon nuclear warheads dropping diagonally across the frame. 1990s homemade website art, naive hand-drawn style, thin black outlines, cream notebook paper background, sparse composition, no text, no watermark, must repeat cleanly at the edges.",
    ),
    PromptSpec(
        "gemini-warhead-3",
        "Gemini warhead 3",
        "Gemini illustrated tiles",
        "gemini-warhead-3.png",
        "Generate a seamless repeating web wallpaper tile with tiny comic-book nuclear bombs, crooked fins, and short motion marks. Slightly goofy and hand-made like early web clip art. Pastel gray background, black outlines, muted colors, small motifs only, no central composition, no text, no watermark, edges should tile cleanly.",
    ),
    PromptSpec(
        "gemini-ink-blast-1",
        "Gemini ink blast 1",
        "Gemini illustrated tiles",
        "gemini-ink-blast-1.png",
        "Create a seamless repeating square background tile made of tiny black-and-white cartoon mushroom cloud doodles. Photocopied zine look, rough ink lines, sparse pattern, mostly white background, no text, no watermark, no large central image. It must work as a tiled wallpaper on a web page.",
    ),
    PromptSpec(
        "gemini-ink-blast-2",
        "Gemini ink blast 2",
        "Gemini illustrated tiles",
        "gemini-ink-blast-2.png",
        "Design a seamless tile for a web page background: small black and white cartoon explosion doodles with crosshatching, naive hand-drawn energy, very light notebook texture, sparse diagonal placement, 1990s homemade web graphic feel, no text, no watermark, edges align for perfect tiling.",
    ),
    PromptSpec(
        "gemini-pixel-blast-1",
        "Gemini pixel blast 1",
        "Gemini pixel tiles",
        "gemini-pixel-blast-1.png",
        "Generate a seamless repeating website wallpaper tile with tiny 8-bit explosion sprites. Bright yellow, orange, red pixels on a pale cyan checkerboard background. Very low-fi GIF-style, like a 1996 game fan page. Small motifs, lots of empty space, no text, no watermark, tile edges must align perfectly.",
    ),
    PromptSpec(
        "gemini-pixel-blast-2",
        "Gemini pixel blast 2",
        "Gemini pixel tiles",
        "gemini-pixel-blast-2.png",
        "Make a seamless square tile for a webpage background with tiny pixel-art nuclear explosions in a crude GIF palette. Lavender grid background, orange and pink blast sprites, intentionally low-fi and slightly awkward, sparse pattern, no text, no watermark, must tile cleanly at the edges.",
    ),
    PromptSpec(
        "gemini-pixel-blast-3",
        "Gemini pixel blast 3",
        "Gemini pixel tiles",
        "gemini-pixel-blast-3.png",
        "Create a seamless repeating web wallpaper tile with tiny lo-fi 8-bit mushroom cloud sprites and rough dithering. Beige or off-white background, a few little explosions only, 1990s homemade GIF aesthetic, hand-made and silly, no text, no watermark, edges should repeat seamlessly.",
    ),
    PromptSpec(
        "gemini-pixel-blast-4",
        "Gemini pixel blast 4",
        "Gemini pixel tiles",
        "gemini-pixel-blast-4.png",
        "Create a seamless square web wallpaper tile with very small 8-bit mushroom cloud sprites on a dusty rose grid background. Low-fi GIF style, slightly awkward and handmade, limited 1990s palette, sparse pattern, no text, no watermark, edges must tile cleanly.",
        "Create a seamless square web wallpaper tile with tiny 8-bit explosion sprites on a dusty rose grid background. Very low-fi GIF style, sparse pattern, no text, no watermark, edges must tile cleanly.",
    ),
    PromptSpec(
        "gemini-pixel-blast-5",
        "Gemini pixel blast 5",
        "Gemini pixel tiles",
        "gemini-pixel-blast-5.png",
        "Generate a seamless repeating tile for a 1990s website background with tiny pixel-art nuclear blasts in orange, cream, and magenta. Pale blue notebook-paper background with faint horizontal lines. Crude GIF aesthetic, sparse spacing, no text, no watermark, must repeat seamlessly.",
        "Generate a seamless repeating tile with tiny pixel-art explosions on pale blue lined paper. Crude GIF aesthetic, sparse spacing, no text, no watermark, must repeat seamlessly.",
    ),
    PromptSpec(
        "gemini-pixel-blast-6",
        "Gemini pixel blast 6",
        "Gemini pixel tiles",
        "gemini-pixel-blast-6.png",
        "Make a seamless square wallpaper tile with tiny 8-bit mushroom cloud sprites and tiny ring-shaped blast puffs on a mint checkerboard background. Very low-fi 1990s GIF style, awkward and charming, lots of empty space, no text, no watermark, tile edges must align.",
        "Make a seamless square wallpaper tile with tiny 8-bit mushroom cloud sprites on a mint checkerboard background. Very low-fi 1990s GIF style, sparse, no text, no watermark, tile edges must align.",
    ),
    PromptSpec(
        "gemini-pixel-blast-7",
        "Gemini pixel blast 7",
        "Gemini pixel tiles",
        "gemini-pixel-blast-7.png",
        "Design a seamless repeating webpage background tile with tiny pixelated orange-and-yellow blast stars and a few tiny mushroom clouds on a light gray background. Rough dithering, crude amateur GIF look, sparse pattern, no text, no watermark, edges repeat cleanly.",
        "Design a seamless repeating webpage background tile with tiny pixelated blast stars on a light gray background. Rough dithering, crude amateur GIF look, sparse pattern, no text, no watermark, edges repeat cleanly.",
    ),
    PromptSpec(
        "gemini-pixel-blast-8",
        "Gemini pixel blast 8",
        "Gemini pixel tiles",
        "gemini-pixel-blast-8.png",
        "Create a seamless square background tile with tiny 8-bit nuclear blast sprites in a weird bright palette: orange, pink, yellow, and purple. Lavender graph-paper background. Homemade 1990s web graphics, sparse diagonal placement, no text, no watermark, edges should tile.",
        "Create a seamless square background tile with tiny 8-bit blast sprites in orange, pink, yellow, and purple on lavender graph paper. Sparse diagonal placement, no text, no watermark, edges should tile.",
    ),
    PromptSpec(
        "gemini-pixel-warhead-1",
        "Gemini pixel warhead 1",
        "Gemini pixel tiles",
        "gemini-pixel-warhead-1.png",
        "Generate a seamless repeating 1990s web wallpaper tile with tiny pixel-art falling bombs, each with a red nose cone and little gray smoke pixels. Pale steel-blue background. Crude 8-bit sprite look, sparse pattern, no text, no watermark, edges align for tiling.",
        "Generate a seamless repeating wallpaper tile with tiny pixel-art falling bombs with red nose cones on pale steel-blue background. Crude 8-bit sprite look, sparse pattern, no text, no watermark, edges align for tiling.",
    ),
    PromptSpec(
        "gemini-pixel-warhead-2",
        "Gemini pixel warhead 2",
        "Gemini pixel tiles",
        "gemini-pixel-warhead-2.png",
        "Make a seamless square tile for a 1997-style website with tiny 8-bit olive bombs drifting diagonally across cream lined paper. Silly low-fi sprite art, sparse arrangement, black pixel outlines, no text, no watermark, must repeat cleanly.",
        "Make a seamless square tile with tiny 8-bit olive bombs drifting diagonally across cream lined paper. Silly low-fi sprite art, sparse arrangement, no text, no watermark, must repeat cleanly.",
    ),
    PromptSpec(
        "gemini-pixel-warhead-3",
        "Gemini pixel warhead 3",
        "Gemini pixel tiles",
        "gemini-pixel-warhead-3.png",
        "Create a seamless repeating web background tile with tiny pixel-art warheads in yellow, rust, and gray scattered across a pale gray-blue field. Homemade awkward GIF aesthetic, slightly uneven spacing, sparse pattern, no text, no watermark, tile edges line up.",
        "Create a seamless repeating web background tile with tiny pixel-art warheads in yellow, rust, and gray on pale gray-blue field. Homemade awkward GIF aesthetic, sparse pattern, no text, no watermark, tile edges line up.",
    ),
    PromptSpec(
        "gemini-pixel-warhead-4",
        "Gemini pixel warhead 4",
        "Gemini pixel tiles",
        "gemini-pixel-warhead-4.png",
        "Generate a seamless square wallpaper tile with tiny pixel-art missiles and a few tiny pixel smoke loops on lavender graph paper. Low-fi game-fan-page style from the late 1990s, sparse and slightly goofy, no text, no watermark, edges tile cleanly.",
        "Generate a seamless square wallpaper tile with tiny pixel-art missiles on lavender graph paper. Low-fi game-fan-page style, sparse, no text, no watermark, edges tile cleanly.",
    ),
    PromptSpec(
        "gemini-pixel-warhead-5",
        "Gemini pixel warhead 5",
        "Gemini pixel tiles",
        "gemini-pixel-warhead-5.png",
        "Design a seamless repeating tile for a retro website background using tiny 8-bit bombs on a pale yellow paper texture. Add a few tiny orange blast puffs. Very crude GIF sprite art, sparse composition, no text, no watermark, edges must repeat cleanly.",
        "Design a seamless repeating tile using tiny 8-bit bombs on a pale yellow paper texture with a few tiny orange blast puffs. Very crude GIF sprite art, sparse composition, no text, no watermark, edges must repeat cleanly.",
    ),
    PromptSpec(
        "gemini-radiation-1",
        "Gemini radiation 1",
        "Gemini illustrated tiles",
        "gemini-radiation-1.png",
        "Create a seamless square background tile with tiny cartoon radiation symbols that look hand-drawn and slightly wobbly, plus little orange smoke puffs underneath them. Pale yellow paper background, sparse arrangement, 1990s web graphics, black outlines, no text, no watermark, must tile cleanly.",
        "Create a seamless square website background tile with tiny hand-drawn hazard doodles and little orange smoke puffs on pale yellow paper. Very sparse, childish 1990s web graphic style, black outlines, no text, no watermark, must repeat cleanly at the edges.",
    ),
    PromptSpec(
        "gemini-fallout-1",
        "Gemini fallout 1",
        "Gemini illustrated tiles",
        "gemini-fallout-1.png",
        "Design a seamless repeating tile for a web page background featuring small hand-drawn fallout shelter signs and tiny mushroom cloud doodles. Dry, low-fi, homemade 1990s internet style, pale green background, simple black outlines, sparse spacing, no text, no watermark, edges align seamlessly.",
        "Design a seamless repeating web wallpaper tile with tiny hand-drawn orange mushroom cloud badges and simple shelter-arrow icons on a pale green background. Homemade 1990s internet style, black outlines, sparse spacing, no text, no watermark, edges align seamlessly.",
    ),
]


def load_api_key() -> str:
    if os.environ.get("GEMINI_API_KEY"):
        return os.environ["GEMINI_API_KEY"]

    if not ENV_PATH.exists():
        raise RuntimeError(".env file not found")

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
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        request = urllib.request.Request(
            url,
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
            if exc.code in {404, 400}:
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

        raise RuntimeError(f"No image data returned for prompt: {prompt}")

    if last_error is None:
        raise RuntimeError("Gemini image request failed before reaching the API")
    raise RuntimeError(f"Gemini image request failed: {last_error}") from last_error


def normalize_tile(image_bytes: bytes, output_path: Path) -> None:
    image = Image.open(io.BytesIO(image_bytes))
    image = ImageOps.exif_transpose(image).convert("RGB")
    width, height = image.size
    square = min(width, height)
    left = max(0, int((width - square) / 2))
    top = max(0, int((height - square) / 2))
    image = image.crop((left, top, left + square, top + square))
    image = image.resize((320, 320), resample=Image.Resampling.LANCZOS)
    image.save(output_path, optimize=True)


def mime_suffix(mime_type: str) -> str:
    return {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
    }.get(mime_type, ".bin")


def save_raw_image(image_bytes: bytes, mime_type: str, stem: str) -> Path:
    RAW_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = RAW_OUTPUT_DIR / f"{stem}-raw{mime_suffix(mime_type)}"
    output_path.write_bytes(image_bytes)
    return output_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only-prefix", default="", help="Only generate entries whose background id starts with this prefix.")
    parser.add_argument("--force", action="store_true", help="Regenerate images even if the normalized output already exists.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    RAW_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    api_key = load_api_key()
    manifest = []
    for index, spec in enumerate(PROMPTS, start=1):
        output_path = OUTPUT_DIR / spec.filename
        should_generate = not args.only_prefix or spec.background_id.startswith(args.only_prefix)
        if should_generate:
            print(f"[{index}/{len(PROMPTS)}] {spec.label}", file=sys.stderr)
        if should_generate and (args.force or not output_path.exists()):
            try:
                image_bytes, mime_type = request_image_bytes(api_key, spec.prompt)
            except RuntimeError:
                if not spec.fallback_prompt:
                    raise
                image_bytes, mime_type = request_image_bytes(api_key, spec.fallback_prompt)
            save_raw_image(image_bytes, mime_type, Path(spec.filename).stem)
            normalize_tile(image_bytes, output_path)
            time.sleep(1.0)
        manifest.append(
            {
                "id": spec.background_id,
                "label": spec.label,
                "category": spec.category,
                "file": spec.filename,
            }
        )

    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(manifest)} Gemini backgrounds to {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
