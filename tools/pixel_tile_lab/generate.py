from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import random
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageOps


ROOT = Path(__file__).resolve().parents[2]
LAB_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = LAB_DIR / "output"
RAW_DIR = OUTPUT_DIR / "raw"
PROCESSED_DIR = OUTPUT_DIR / "processed"
TILES_DIR = OUTPUT_DIR / "tiles"
PREVIEWS_DIR = OUTPUT_DIR / "previews"
ENV_PATH = ROOT / ".env"

CANVAS_SIZE = 320
NOISE_GRID_STEP = 32

# Limited 8-bit-ish palette for this experiment.
PALETTE = [
    (0, 0, 0),
    (82, 82, 82),
    (126, 126, 126),
    (178, 178, 178),
    (214, 214, 214),
    (242, 242, 242),
    (255, 222, 92),
    (255, 166, 48),
    (222, 92, 42),
    (146, 152, 84),
    (118, 136, 154),
]

BACKGROUND_GRAYS = [
    (176, 176, 176),
    (226, 226, 226),
]

BAYER_4X4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
]

MODEL_CANDIDATES = [
    "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image-preview",
]


class Perlin3D:
    def __init__(self, seed: int) -> None:
        rng = random.Random(seed)
        permutation = list(range(256))
        rng.shuffle(permutation)
        self.permutation = permutation * 2

    @staticmethod
    def fade(value: float) -> float:
        return value * value * value * (value * (value * 6 - 15) + 10)

    @staticmethod
    def lerp(start: float, end: float, amount: float) -> float:
        return start + amount * (end - start)

    @staticmethod
    def grad(hash_value: int, x: float, y: float, z: float) -> float:
        h = hash_value & 15
        u = x if h < 8 else y
        v = y if h < 4 else (x if h in {12, 14} else z)
        return ((u if (h & 1) == 0 else -u) + (v if (h & 2) == 0 else -v))

    def noise(self, x: float, y: float, z: float) -> float:
        xi = math.floor(x) & 255
        yi = math.floor(y) & 255
        zi = math.floor(z) & 255
        xf = x - math.floor(x)
        yf = y - math.floor(y)
        zf = z - math.floor(z)
        u = self.fade(xf)
        v = self.fade(yf)
        w = self.fade(zf)

        aaa = self.permutation[self.permutation[self.permutation[xi] + yi] + zi]
        aba = self.permutation[self.permutation[self.permutation[xi] + yi + 1] + zi]
        aab = self.permutation[self.permutation[self.permutation[xi] + yi] + zi + 1]
        abb = self.permutation[self.permutation[self.permutation[xi] + yi + 1] + zi + 1]
        baa = self.permutation[self.permutation[self.permutation[xi + 1] + yi] + zi]
        bba = self.permutation[self.permutation[self.permutation[xi + 1] + yi + 1] + zi]
        bab = self.permutation[self.permutation[self.permutation[xi + 1] + yi] + zi + 1]
        bbb = self.permutation[self.permutation[self.permutation[xi + 1] + yi + 1] + zi + 1]

        x1 = self.lerp(self.grad(aaa, xf, yf, zf), self.grad(baa, xf - 1, yf, zf), u)
        x2 = self.lerp(self.grad(aba, xf, yf - 1, zf), self.grad(bba, xf - 1, yf - 1, zf), u)
        y1 = self.lerp(x1, x2, v)
        x3 = self.lerp(self.grad(aab, xf, yf, zf - 1), self.grad(bab, xf - 1, yf, zf - 1), u)
        x4 = self.lerp(self.grad(abb, xf, yf - 1, zf - 1), self.grad(bbb, xf - 1, yf - 1, zf - 1), u)
        y2 = self.lerp(x3, x4, v)
        return self.lerp(y1, y2, w)


@dataclass(frozen=True)
class ReferenceSpec:
    key: str
    label: str
    filename_stem: str
    prompt: str
    fallback_prompt: str


REFERENCE_SPECS = [
    ReferenceSpec(
        key="starburst",
        label="Starburst explosion",
        filename_stem="starburst",
        prompt=(
            "Create one single large 8-bit pixel art starburst explosion centered on a pure white background. "
            "Use a very limited retro palette with yellow, orange, red, and black outline. "
            "No extra objects, no shadows, no text, no watermark, no border. "
            "The sprite should fill most of the square but leave some white margin."
        ),
        fallback_prompt=(
            "Create one single large pixel art explosion sprite on a white background. "
            "Retro 8-bit style, limited palette, centered, no text, no watermark."
        ),
    ),
    ReferenceSpec(
        key="mushroom",
        label="Mushroom cloud",
        filename_stem="mushroom",
        prompt=(
            "Create one single large 8-bit pixel art mushroom cloud explosion centered on a pure white background. "
            "Use a limited retro palette with pale yellow, orange, red, gray, and black outline. "
            "No extra scenery, no shadows, no text, no watermark, no border. "
            "Keep it as a clean sprite sheet style drawing."
        ),
        fallback_prompt=(
            "Create one single large pixel art mushroom cloud sprite on a white background. "
            "Retro 8-bit style, limited palette, centered, no text, no watermark."
        ),
    ),
    ReferenceSpec(
        key="warhead",
        label="Warhead",
        filename_stem="warhead",
        prompt=(
            "Create one single large 8-bit pixel art falling warhead centered on a pure white background. "
            "Red nose cone, gray body, simple fins, limited retro palette, black outline. "
            "No extra objects, no smoke trail, no text, no watermark, no border."
        ),
        fallback_prompt=(
            "Create one single large pixel art bomb sprite on a white background. "
            "Retro 8-bit style, limited palette, centered, no text, no watermark."
        ),
    ),
]

VARIATIONS = [
    {
        "name": "variation-a",
        "seed": 1001,
        "starburst_count": 9,
        "mushroom_count": 3,
        "warhead_count": 0,
    },
    {
        "name": "variation-b",
        "seed": 1002,
        "starburst_count": 6,
        "mushroom_count": 4,
        "warhead_count": 2,
    },
    {
        "name": "variation-c",
        "seed": 1003,
        "starburst_count": 8,
        "mushroom_count": 2,
        "warhead_count": 3,
    },
    {
        "name": "variation-d",
        "seed": 1004,
        "starburst_count": 4,
        "mushroom_count": 4,
        "warhead_count": 5,
    },
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh-refs", action="store_true", help="Force new Gemini reference images.")
    return parser.parse_args()


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


def nearest_palette_color(rgb: tuple[int, int, int], palette: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    best = palette[0]
    best_score = None
    for candidate in palette:
        score = sum((channel - target) ** 2 for channel, target in zip(rgb, candidate))
        if best_score is None or score < best_score:
            best_score = score
            best = candidate
    return best


def save_reference_image(image_bytes: bytes, mime_type: str, stem: str) -> Path:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    output_path = RAW_DIR / f"{stem}-raw{mime_suffix(mime_type)}"
    output_path.write_bytes(image_bytes)
    return output_path


def load_raw_reference(spec: ReferenceSpec) -> Path | None:
    matches = sorted(RAW_DIR.glob(f"{spec.filename_stem}-raw.*"))
    return matches[0] if matches else None


def remove_white_background(image: Image.Image, threshold: int = 244) -> Image.Image:
    image = image.convert("RGBA")
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, alpha = pixels[x, y]
            if red >= threshold and green >= threshold and blue >= threshold:
                pixels[x, y] = (255, 255, 255, 0)
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if bbox:
        image = image.crop(bbox)
    return image


def quantize_rgba_to_palette(image: Image.Image, palette: list[tuple[int, int, int]]) -> Image.Image:
    image = image.convert("RGBA")
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, alpha = pixels[x, y]
            if alpha <= 8:
                pixels[x, y] = (0, 0, 0, 0)
                continue
            mapped = nearest_palette_color((red, green, blue), palette)
            pixels[x, y] = (*mapped, 255)
    return image


def choose_palette_count(inertias: list[float], ks: list[int]) -> int:
    if len(ks) <= 2:
        return ks[-1]

    x0, y0 = ks[0], inertias[0]
    x1, y1 = ks[-1], inertias[-1]
    denominator = math.hypot(x1 - x0, y1 - y0) or 1.0
    best_k = ks[0]
    best_distance = -1.0
    for k, inertia in zip(ks[1:-1], inertias[1:-1], strict=False):
        distance = abs((y1 - y0) * k - (x1 - x0) * inertia + x1 * y0 - y1 * x0) / denominator
        if distance > best_distance:
            best_distance = distance
            best_k = k
    return best_k


def kmeans(points: np.ndarray, k: int, seed: int, iterations: int = 20) -> tuple[np.ndarray, float]:
    rng = np.random.default_rng(seed)
    centers = np.empty((k, points.shape[1]), dtype=np.float32)
    centers[0] = points[rng.integers(len(points))]

    distances = np.full(len(points), np.inf, dtype=np.float32)
    for index in range(1, k):
        diff = points - centers[index - 1]
        distances = np.minimum(distances, np.sum(diff * diff, axis=1))
        if np.all(distances <= 1e-6):
            centers[index:] = centers[index - 1]
            break
        probabilities = distances / distances.sum()
        centers[index] = points[rng.choice(len(points), p=probabilities)]

    for _ in range(iterations):
        squared = np.sum((points[:, None, :] - centers[None, :, :]) ** 2, axis=2)
        labels = np.argmin(squared, axis=1)
        next_centers = centers.copy()
        for cluster_index in range(k):
            cluster_points = points[labels == cluster_index]
            if len(cluster_points):
                next_centers[cluster_index] = cluster_points.mean(axis=0)
        if np.allclose(next_centers, centers, atol=0.5):
            centers = next_centers
            break
        centers = next_centers

    squared = np.sum((points[:, None, :] - centers[None, :, :]) ** 2, axis=2)
    labels = np.argmin(squared, axis=1)
    inertia = float(np.sum(squared[np.arange(len(points)), labels]))
    return centers, inertia


def adaptive_palette(image: Image.Image, seed: int = 0, min_k: int = 3, max_k: int = 8) -> list[tuple[int, int, int]]:
    rgba = np.array(image.convert("RGBA"))
    mask = rgba[:, :, 3] > 8
    pixels = rgba[mask][:, :3].astype(np.float32)
    if len(pixels) == 0:
        return [(0, 0, 0)]

    sample_limit = min(5000, len(pixels))
    rng = np.random.default_rng(seed)
    sample_indices = rng.choice(len(pixels), size=sample_limit, replace=False) if len(pixels) > sample_limit else np.arange(len(pixels))
    sample = pixels[sample_indices]

    unique = np.unique(sample.astype(np.uint8), axis=0)
    if len(unique) <= max_k:
        return [tuple(int(channel) for channel in color) for color in unique]

    ks = list(range(min_k, max_k + 1))
    inertia_values = []
    center_sets = []
    for k in ks:
        centers, inertia = kmeans(sample, k, seed + k)
        inertia_values.append(inertia)
        center_sets.append(centers)

    chosen_k = choose_palette_count(inertia_values, ks)
    chosen_centers = center_sets[ks.index(chosen_k)]
    palette = [tuple(int(round(channel)) for channel in center) for center in chosen_centers]
    palette = sorted(set(palette), key=lambda color: sum(color))
    return palette


def mask_iou(left: Image.Image, right: Image.Image) -> float:
    left_alpha = np.array(left.convert("RGBA"))[:, :, 3] > 8
    right_alpha = np.array(right.convert("RGBA"))[:, :, 3] > 8
    union = np.logical_or(left_alpha, right_alpha).sum()
    if union == 0:
        return 1.0
    intersection = np.logical_and(left_alpha, right_alpha).sum()
    return float(intersection / union)


def outline_thinness_score(sprite: Image.Image, outline_color: tuple[int, int, int]) -> float:
    rgba = np.array(sprite.convert("RGBA"))
    opaque = rgba[:, :, 3] > 8
    outline = opaque & np.all(rgba[:, :, :3] == np.array(outline_color, dtype=np.uint8), axis=2)
    outline_pixels = int(outline.sum())
    if outline_pixels == 0:
        return 0.0

    up = np.pad(outline[:-1, :], ((1, 0), (0, 0)), constant_values=False)
    down = np.pad(outline[1:, :], ((0, 1), (0, 0)), constant_values=False)
    left = np.pad(outline[:, :-1], ((0, 0), (1, 0)), constant_values=False)
    right = np.pad(outline[:, 1:], ((0, 0), (0, 1)), constant_values=False)
    eroded = outline & up & down & left & right

    block_2x2 = outline[:-1, :-1] & outline[1:, :-1] & outline[:-1, 1:] & outline[1:, 1:]
    eroded_ratio = float(eroded.sum() / outline_pixels)
    block_ratio = float(block_2x2.sum() / outline_pixels)
    return max(0.0, 1.0 - (0.75 * eroded_ratio + 0.25 * block_ratio))


def infer_native_resolution(image: Image.Image, palette: list[tuple[int, int, int]], min_width: int = 16, max_width: int = 64) -> dict[str, object]:
    width, height = image.size
    upper_width = min(max_width, width)
    outline_color = min(palette, key=lambda color: sum(color))
    best_score = None
    best_width = min_width
    best_height = max(1, round(min_width * height / width))
    top_candidates: list[dict[str, float | int]] = []

    for candidate_width in range(min_width, upper_width + 1):
        candidate_height = max(1, int(round(candidate_width * height / width)))
        downsampled = image.resize((candidate_width, candidate_height), resample=Image.Resampling.NEAREST)
        reconstructed = downsampled.resize(image.size, resample=Image.Resampling.NEAREST)
        shape_score = mask_iou(image, reconstructed)
        outline_score = outline_thinness_score(downsampled, outline_color)
        score = outline_score * 0.7 + shape_score * 0.3
        top_candidates.append(
            {
                "width": candidate_width,
                "height": candidate_height,
                "score": round(score, 4),
                "outline_score": round(outline_score, 4),
                "shape_score": round(shape_score, 4),
            }
        )
        if (
            best_score is None
            or score > best_score + 1e-6
            or (abs(score - best_score) <= 1e-6 and candidate_width < best_width)
        ):
            best_score = score
            best_width = candidate_width
            best_height = candidate_height

    top_candidates.sort(key=lambda entry: (-entry["score"], entry["width"]))
    return {
        "width": best_width,
        "height": best_height,
        "score": round(float(best_score or 0.0), 4),
        "outline_color": list(outline_color),
        "top_candidates": top_candidates[:8],
    }


def downsample_to_native_grid(image: Image.Image, inferred_size: dict[str, object]) -> Image.Image:
    downsampled = image.resize(
        (int(inferred_size["width"]), int(inferred_size["height"])),
        resample=Image.Resampling.NEAREST,
    )
    bbox = downsampled.getchannel("A").getbbox()
    if bbox:
        downsampled = downsampled.crop(bbox)
    return downsampled


def upscale_preview(image: Image.Image, scale: int = 8) -> Image.Image:
    return image.resize((image.width * scale, image.height * scale), resample=Image.Resampling.NEAREST)


def save_metadata(metadata_path: Path, payload: dict[str, object]) -> None:
    metadata_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def fetch_or_reuse_reference(api_key: str, spec: ReferenceSpec, refresh: bool) -> Path:
    existing = load_raw_reference(spec)
    if existing and not refresh:
        return existing

    try:
        image_bytes, mime_type = request_image_bytes(api_key, spec.prompt)
    except RuntimeError:
        image_bytes, mime_type = request_image_bytes(api_key, spec.fallback_prompt)
    return save_reference_image(image_bytes, mime_type, spec.filename_stem)


def process_reference(spec: ReferenceSpec, raw_path: Path) -> dict[str, Path]:
    raw_image = Image.open(raw_path)
    clean = remove_white_background(ImageOps.exif_transpose(raw_image))
    palette = adaptive_palette(clean, seed=sum(ord(character) for character in spec.key))
    snapped = quantize_rgba_to_palette(clean, palette)
    inferred_size = infer_native_resolution(snapped, palette)
    sprite = downsample_to_native_grid(snapped, inferred_size)
    preview = upscale_preview(sprite, scale=8)

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    clean_path = PROCESSED_DIR / f"{spec.filename_stem}-clean.png"
    snapped_path = PROCESSED_DIR / f"{spec.filename_stem}-snapped.png"
    large_path = PROCESSED_DIR / f"{spec.filename_stem}-native-preview.png"
    sprite_path = PROCESSED_DIR / f"{spec.filename_stem}-sprite.png"
    metadata_path = PROCESSED_DIR / f"{spec.filename_stem}-metadata.json"

    clean.save(clean_path)
    snapped.save(snapped_path)
    preview.save(large_path)
    sprite.save(sprite_path)
    save_metadata(
        metadata_path,
        {
            "label": spec.label,
            "palette": palette,
            "inferred_size": inferred_size,
            "native_size": [sprite.width, sprite.height],
        },
    )

    return {
        "clean": clean_path,
        "snapped": snapped_path,
        "large": large_path,
        "sprite": sprite_path,
        "metadata": metadata_path,
    }


def build_dithered_noise(seed: int) -> Image.Image:
    image = Image.new("RGB", (CANVAS_SIZE, CANVAS_SIZE), BACKGROUND_GRAYS[0])
    noise = Perlin3D(seed)
    major_radius = 2.2
    minor_radius = 0.95
    octave_scales = [
        (1.50, 0.40),
        (2.90, 0.24),
        (5.80, 0.16),
        (11.60, 0.10),
        (19.20, 0.06),
        (30.40, 0.04),
    ]
    pixels = image.load()

    for y in range(CANVAS_SIZE):
        for x in range(CANVAS_SIZE):
            theta = 2.0 * math.pi * x / CANVAS_SIZE
            phi = 2.0 * math.pi * y / CANVAS_SIZE
            torus_x = (major_radius + minor_radius * math.cos(theta)) * math.cos(phi)
            torus_y = (major_radius + minor_radius * math.cos(theta)) * math.sin(phi)
            torus_z = minor_radius * math.sin(theta)

            value = 0.0
            for scale, amplitude in octave_scales:
                value += amplitude * noise.noise(torus_x * scale, torus_y * scale, torus_z * scale)
            value = 0.5 + value * 0.75
            threshold = (BAYER_4X4[y % 4][x % 4] + 0.5) / 16.0 - 0.5
            value = max(0.0, min(1.0, value + threshold * 0.22))
            palette_index = 1 if value >= 0.5 else 0
            pixels[x, y] = BACKGROUND_GRAYS[palette_index]
    return image


def rotate_sprite(sprite: Image.Image, angle: float) -> Image.Image:
    rotated = sprite.rotate(angle, resample=Image.Resampling.NEAREST, expand=True)
    bbox = rotated.getchannel("A").getbbox()
    if bbox:
        rotated = rotated.crop(bbox)
    return rotated


def composite_wrapped(base: Image.Image, sprite: Image.Image, x: int, y: int) -> None:
    for offset_x in (-CANVAS_SIZE, 0, CANVAS_SIZE):
        for offset_y in (-CANVAS_SIZE, 0, CANVAS_SIZE):
            dest_x = x + offset_x
            dest_y = y + offset_y
            if dest_x >= CANVAS_SIZE or dest_y >= CANVAS_SIZE:
                continue
            if dest_x + sprite.width <= 0 or dest_y + sprite.height <= 0:
                continue
            base.alpha_composite(sprite, dest=(dest_x, dest_y))


def distribute_sprites(
    base: Image.Image,
    sprite: Image.Image,
    count: int,
    rng: random.Random,
    rotate_mode: str = "none",
) -> None:
    for _ in range(count):
        scaled = sprite
        if rotate_mode == "cardinal":
            scaled = rotate_sprite(scaled, rng.choice((0, 90, 180, 270)))
        x = rng.randrange(CANVAS_SIZE)
        y = rng.randrange(CANVAS_SIZE)
        composite_wrapped(base, scaled, x, y)


def build_variation(name: str, config: dict[str, object], sprites: dict[str, Image.Image]) -> Path:
    rng = random.Random(config["seed"])
    background = build_dithered_noise(config["seed"]).convert("RGBA")

    distribute_sprites(
        background,
        sprites["starburst"],
        int(config["starburst_count"]),
        rng,
        rotate_mode="cardinal",
    )
    distribute_sprites(
        background,
        sprites["mushroom"],
        int(config["mushroom_count"]),
        rng,
        rotate_mode="none",
    )
    distribute_sprites(
        background,
        sprites["warhead"],
        int(config["warhead_count"]),
        rng,
        rotate_mode="cardinal",
    )

    TILES_DIR.mkdir(parents=True, exist_ok=True)
    output_path = TILES_DIR / f"{name}.png"
    background.save(output_path)
    return output_path


def build_preview_sheet(paths: list[Path], output_path: Path, thumb_size: int = 200) -> None:
    thumbs = []
    for path in paths:
        image = Image.open(path).convert("RGB").resize((thumb_size, thumb_size), resample=Image.Resampling.NEAREST)
        canvas = Image.new("RGB", (thumb_size + 32, thumb_size + 42), "white")
        canvas.paste(image, (16, 10))
        draw = ImageDraw.Draw(canvas)
        draw.rectangle((15, 9, 16 + thumb_size, 10 + thumb_size), outline="black")
        draw.text((16, thumb_size + 18), path.stem[:28], fill="black")
        thumbs.append(canvas)

    cols = 2
    rows = (len(thumbs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (thumb_size + 32), rows * (thumb_size + 42)), (240, 240, 240))
    for index, thumb in enumerate(thumbs):
        x = (index % cols) * (thumb_size + 32)
        y = (index // cols) * (thumb_size + 42)
        sheet.paste(thumb, (x, y))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path)


def main() -> None:
    args = parse_args()
    api_key = load_api_key()

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    TILES_DIR.mkdir(parents=True, exist_ok=True)
    PREVIEWS_DIR.mkdir(parents=True, exist_ok=True)

    processed_paths = {}
    sprites = {}
    raw_paths = []

    for spec in REFERENCE_SPECS:
        raw_path = fetch_or_reuse_reference(api_key, spec, refresh=args.refresh_refs)
        raw_paths.append(raw_path)
        processed = process_reference(spec, raw_path)
        processed_paths[spec.key] = processed
        sprites[spec.key] = Image.open(processed["sprite"]).convert("RGBA")

    tile_paths = []
    for variation in VARIATIONS:
        tile_paths.append(build_variation(variation["name"], variation, sprites))

    build_preview_sheet(raw_paths, PREVIEWS_DIR / "raw-references-sheet.png", thumb_size=180)
    build_preview_sheet([paths["large"] for paths in processed_paths.values()], PREVIEWS_DIR / "processed-large-sheet.png", thumb_size=180)
    build_preview_sheet([paths["sprite"] for paths in processed_paths.values()], PREVIEWS_DIR / "sprite-sheet.png", thumb_size=120)
    build_preview_sheet(tile_paths, PREVIEWS_DIR / "tile-variations-sheet.png", thumb_size=200)

    print(f"Generated {len(tile_paths)} seamless tile variations in {TILES_DIR}")


if __name__ == "__main__":
    main()
