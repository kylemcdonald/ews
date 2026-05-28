from __future__ import annotations

import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "client" / "public" / "backgrounds"
MANIFEST_DIR = ROOT / "client" / "src" / "generated"
MANIFEST_PATH = MANIFEST_DIR / "backgroundManifest.json"
SOURCE_PHOTO = ROOT / "client" / "src" / "assets" / "apocalypse-ocean.jpg"
TILE_SIZE = 240


def make_canvas(color: tuple[int, int, int]) -> Image.Image:
    return Image.new("RGBA", (TILE_SIZE, TILE_SIZE), color + (255,))


def add_paper_noise(image: Image.Image, seed: int, intensity: int = 14) -> None:
    rng = random.Random(seed)
    draw = ImageDraw.Draw(image)
    for _ in range(900):
        x = rng.randrange(TILE_SIZE)
        y = rng.randrange(TILE_SIZE)
        shade = max(220, 255 - rng.randrange(intensity))
        alpha = rng.randrange(18, 42)
        draw.point((x, y), fill=(shade, shade, shade, alpha))
    for y in range(0, TILE_SIZE, 7):
        alpha = rng.randrange(8, 18)
        draw.line((0, y, TILE_SIZE, y), fill=(255, 255, 255, alpha), width=1)


def add_checker(image: Image.Image, color: tuple[int, int, int], step: int = 24) -> None:
    draw = ImageDraw.Draw(image)
    for y in range(0, TILE_SIZE, step):
        for x in range(0, TILE_SIZE, step):
            if ((x // step) + (y // step)) % 2 == 0:
                draw.rectangle((x, y, x + step - 1, y + step - 1), outline=None, fill=color + (18,))


def add_rule_lines(image: Image.Image, color: tuple[int, int, int], step: int = 20) -> None:
    draw = ImageDraw.Draw(image)
    for x in range(0, TILE_SIZE, step):
        draw.line((x, 0, x, TILE_SIZE), fill=color + (22,), width=1)
    for y in range(0, TILE_SIZE, step):
        draw.line((0, y, TILE_SIZE, y), fill=color + (22,), width=1)


def paste_centered(base: Image.Image, overlay: Image.Image, center: tuple[int, int], angle: float = 0.0) -> None:
    rotated = overlay.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
    x = int(center[0] - rotated.width / 2)
    y = int(center[1] - rotated.height / 2)
    base.alpha_composite(rotated, dest=(x, y))


def build_warhead(body: tuple[int, int, int], tip: tuple[int, int, int], smoke: tuple[int, int, int]) -> Image.Image:
    image = Image.new("RGBA", (84, 96), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    smoke_alpha = 220
    draw.ellipse((10, 54, 36, 80), fill=smoke + (smoke_alpha,))
    draw.ellipse((24, 48, 56, 82), fill=smoke + (smoke_alpha,))
    draw.ellipse((40, 56, 70, 88), fill=smoke + (smoke_alpha,))

    draw.polygon(((42, 4), (26, 28), (58, 28)), fill=tip + (255,), outline=(0, 0, 0, 255))
    draw.rounded_rectangle((28, 24, 56, 74), radius=12, fill=body + (255,), outline=(0, 0, 0, 255), width=2)
    draw.rectangle((34, 28, 50, 32), fill=(255, 255, 255, 70))
    draw.polygon(((28, 58), (16, 76), (28, 70)), fill=(70, 70, 70, 255), outline=(0, 0, 0, 255))
    draw.polygon(((56, 58), (68, 76), (56, 70)), fill=(70, 70, 70, 255), outline=(0, 0, 0, 255))
    draw.line((18, 88, 26, 82), fill=(0, 0, 0, 180), width=2)
    draw.line((58, 84, 68, 90), fill=(0, 0, 0, 180), width=2)
    draw.line((12, 44, 18, 36), fill=(0, 0, 0, 120), width=2)
    draw.line((66, 40, 72, 32), fill=(0, 0, 0, 120), width=2)
    return image


def build_mushroom_cloud_line_art(seed: int, outline: tuple[int, int, int], fill_alpha: int = 0) -> Image.Image:
    rng = random.Random(seed)
    image = Image.new("RGBA", (90, 96), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    puff_boxes = [
        (10, 18, 34, 42),
        (24, 10, 52, 40),
        (42, 14, 68, 42),
        (56, 22, 82, 48),
        (24, 28, 60, 56),
    ]
    for box in puff_boxes:
        jitter = rng.randrange(-3, 4)
        x0, y0, x1, y1 = box
        fill = (255, 255, 255, fill_alpha)
        draw.ellipse((x0 + jitter, y0, x1 + jitter, y1), fill=fill, outline=outline + (255,), width=2)

    draw.rounded_rectangle((38, 48, 52, 80), radius=6, fill=(255, 255, 255, fill_alpha), outline=outline + (255,), width=2)
    draw.pieslice((28, 62, 62, 92), 10, 170, fill=(255, 255, 255, fill_alpha), outline=outline + (255,), width=2)
    for x0, y0, x1, y1 in ((12, 32, 0, 24), (80, 34, 90, 22), (28, 6, 22, 0), (60, 4, 70, 0)):
        draw.line((x0, y0, x1, y1), fill=outline + (255,), width=2)
    return image


def build_pixel_sprite(palette: dict[str, tuple[int, int, int]], rows: list[str], scale: int = 4) -> Image.Image:
    width = len(rows[0])
    height = len(rows)
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for y, row in enumerate(rows):
        for x, char in enumerate(row):
            if char == ".":
                continue
            image.putpixel((x, y), palette[char] + (255,))
    return image.resize((width * scale, height * scale), resample=Image.Resampling.NEAREST)


def add_drop_shadow(image: Image.Image, color: tuple[int, int, int] = (70, 70, 70)) -> Image.Image:
    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    mask = image.getchannel("A")
    ImageDraw.Draw(shadow).bitmap((4, 4), mask, fill=color + (90,))
    shadow = shadow.filter(ImageFilter.GaussianBlur(2))
    shadow.alpha_composite(image)
    return shadow


def build_radiation_doodle(fill: tuple[int, int, int], accent: tuple[int, int, int]) -> Image.Image:
    image = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    center = (48, 48)
    for start in (30, 150, 270):
        draw.pieslice((18, 18, 78, 78), start, start + 60, fill=fill + (255,), outline=(0, 0, 0, 255))
    draw.ellipse((40, 40, 56, 56), fill=(255, 255, 255, 255), outline=(0, 0, 0, 255), width=2)
    draw.ellipse((26, 70, 38, 82), fill=accent + (255,), outline=(0, 0, 0, 255))
    draw.ellipse((34, 66, 48, 80), fill=accent + (255,), outline=(0, 0, 0, 255))
    draw.ellipse((44, 70, 56, 82), fill=accent + (255,), outline=(0, 0, 0, 255))
    draw.line((52, 62, 52, 74), fill=(0, 0, 0, 255), width=2)
    return image


def build_fallout_shelter_badge(fill: tuple[int, int, int], accent: tuple[int, int, int]) -> Image.Image:
    image = Image.new("RGBA", (112, 82), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((6, 8, 106, 74), radius=8, fill=fill + (255,), outline=(0, 0, 0, 255), width=2)
    draw.rectangle((14, 16, 98, 66), outline=(0, 0, 0, 255), width=1)
    draw.polygon(((18, 40), (42, 26), (42, 34), (68, 34), (68, 22), (92, 40), (68, 58), (68, 46), (42, 46), (42, 54)), fill=accent + (255,), outline=(0, 0, 0, 255))
    cloud = build_mushroom_cloud_line_art(6, (0, 0, 0), fill_alpha=36).resize((38, 40), resample=Image.Resampling.BICUBIC)
    image.alpha_composite(cloud, dest=(35, 18))
    return image


def photo_variant_color() -> Image.Image:
    source = Image.open(SOURCE_PHOTO).convert("RGB")
    crop = source.crop((520, 34, 980, 520)).resize((180, 124), resample=Image.Resampling.LANCZOS)
    tile = Image.new("RGB", (TILE_SIZE, TILE_SIZE), (248, 246, 238))
    draw = ImageDraw.Draw(tile)
    draw.rectangle((0, 0, TILE_SIZE - 1, TILE_SIZE - 1), outline=(140, 140, 140))
    tile.paste(crop, (30, 40))
    draw.rectangle((30, 40, 209, 163), outline=(20, 20, 20), width=1)
    draw.line((22, 182, 218, 182), fill=(185, 185, 185))
    draw.line((22, 194, 218, 194), fill=(185, 185, 185))
    return tile


def photo_variant_halftone() -> Image.Image:
    source = Image.open(SOURCE_PHOTO).convert("RGB")
    crop = source.crop((560, 24, 1010, 520)).resize((160, 114), resample=Image.Resampling.LANCZOS)
    crop = ImageOps.grayscale(crop)
    crop = ImageOps.autocontrast(crop)
    crop = ImageOps.posterize(crop.convert("RGB"), 3)
    tile = Image.new("RGB", (TILE_SIZE, TILE_SIZE), (242, 242, 242))
    tile.paste(crop, (22, 24))
    tile.paste(crop.transpose(Image.Transpose.FLIP_LEFT_RIGHT).resize((120, 86), resample=Image.Resampling.BILINEAR), (92, 126))
    draw = ImageDraw.Draw(tile)
    for y in range(0, TILE_SIZE, 6):
        draw.line((0, y, TILE_SIZE, y), fill=(255, 255, 255), width=1)
    draw.rectangle((22, 24, 181, 137), outline=(0, 0, 0), width=1)
    draw.rectangle((92, 126, 211, 211), outline=(0, 0, 0), width=1)
    return ImageEnhance.Contrast(tile).enhance(1.15)


def save_image(image: Image.Image, output_path: Path, quality: int = 90) -> None:
    if output_path.suffix.lower() in {".jpg", ".jpeg"}:
        image.convert("RGB").save(output_path, quality=quality, optimize=True, progressive=True)
        return
    image.save(output_path, optimize=True)


def generate_backgrounds() -> list[dict[str, str]]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)

    manifest: list[dict[str, str]] = []

    def add_entry(background_id: str, label: str, category: str, filename: str, image: Image.Image) -> None:
        save_image(image, OUTPUT_DIR / filename)
        manifest.append(
            {
                "id": background_id,
                "label": label,
                "category": category,
                "file": filename,
            }
        )

    # 1. Falling warhead cartoons.
    warhead_a = make_canvas((246, 247, 255))
    add_paper_noise(warhead_a, 11)
    for center, angle in (((60, 58), 28), ((180, 166), 28)):
        paste_centered(warhead_a, build_warhead((185, 190, 196), (212, 62, 41), (250, 214, 118)), center, angle)
    add_entry("warhead-red-tip", "Falling warhead 1", "Falling warhead", "warhead-red-tip.png", warhead_a)

    warhead_b = make_canvas((251, 244, 229))
    add_checker(warhead_b, (245, 227, 193))
    add_paper_noise(warhead_b, 12)
    for center, angle in (((88, 82), -20), ((188, 184), -20)):
        paste_centered(warhead_b, build_warhead((146, 164, 140), (193, 66, 44), (255, 190, 92)), center, angle)
    add_entry("warhead-olive", "Falling warhead 2", "Falling warhead", "warhead-olive.png", warhead_b)

    # 2. Black and white cartoon explosions.
    ink_a = make_canvas((255, 255, 255))
    add_rule_lines(ink_a, (0, 0, 0), step=30)
    for center, angle in (((62, 66), -10), ((176, 174), 8)):
        paste_centered(ink_a, build_mushroom_cloud_line_art(4, (0, 0, 0), fill_alpha=0), center, angle)
    add_entry("ink-cloud-outline", "Ink cloud 1", "Black and white explosion", "ink-cloud-outline.png", ink_a)

    ink_b = make_canvas((250, 250, 250))
    add_paper_noise(ink_b, 13, intensity=8)
    motif_b = build_mushroom_cloud_line_art(9, (0, 0, 0), fill_alpha=18)
    for center, angle in (((74, 70), 0), ((178, 162), -12)):
        paste_centered(ink_b, motif_b, center, angle)
    draw_b = ImageDraw.Draw(ink_b)
    draw_b.line((18, 120, 54, 108), fill=(0, 0, 0, 160), width=2)
    draw_b.line((186, 38, 224, 22), fill=(0, 0, 0, 160), width=2)
    add_entry("ink-cloud-hatch", "Ink cloud 2", "Black and white explosion", "ink-cloud-hatch.png", ink_b)

    # 3. Colorful GIF-style low-fi explosions.
    sprite_rows_a = [
        ".....22.....",
        "....2332....",
        "...234432...",
        "..23455432..",
        ".2234554322.",
        ".2234664322.",
        "..23455432..",
        "...334433...",
        "....3223....",
        ".....22.....",
    ]
    sprite_a = add_drop_shadow(
        build_pixel_sprite(
            {
                "2": (255, 222, 0),
                "3": (255, 146, 0),
                "4": (255, 84, 0),
                "5": (255, 40, 0),
                "6": (255, 0, 112),
            },
            sprite_rows_a,
            scale=5,
        )
    )
    pixel_a = make_canvas((232, 246, 255))
    add_checker(pixel_a, (210, 236, 255))
    for center in ((58, 58), (180, 84), (118, 184)):
        paste_centered(pixel_a, sprite_a, center)
    add_entry("pixel-neon", "Pixel blast 1", "Colorful GIF-style explosion", "pixel-neon.png", pixel_a)

    sprite_rows_b = [
        ".....33.....",
        "....3443....",
        "...345543...",
        "..34566543..",
        ".3345665433.",
        ".3345775433.",
        "..34566543..",
        "...345543...",
        "....3443....",
        ".....33.....",
    ]
    sprite_b = add_drop_shadow(
        build_pixel_sprite(
            {
                "3": (255, 240, 120),
                "4": (255, 200, 80),
                "5": (255, 132, 68),
                "6": (222, 74, 44),
                "7": (124, 0, 255),
            },
            sprite_rows_b,
            scale=5,
        )
    )
    pixel_b = make_canvas((250, 236, 255))
    add_rule_lines(pixel_b, (188, 164, 206), step=24)
    for center in ((62, 78), (170, 52), (156, 186)):
        paste_centered(pixel_b, sprite_b, center)
    add_entry("pixel-violet", "Pixel blast 2", "Colorful GIF-style explosion", "pixel-violet.png", pixel_b)

    # 4. Tiled photo variants.
    add_entry("photo-postcard", "Photo tile 1", "Tiled mushroom cloud photo", "photo-postcard.jpg", photo_variant_color())
    add_entry("photo-halftone", "Photo tile 2", "Tiled mushroom cloud photo", "photo-halftone.jpg", photo_variant_halftone())

    # 5. Custom variants.
    rad_a = make_canvas((255, 248, 210))
    add_paper_noise(rad_a, 27)
    motif_rad = build_radiation_doodle((248, 228, 72), (255, 126, 44))
    for center, angle in (((58, 62), -10), ((176, 176), 10)):
        paste_centered(rad_a, motif_rad, center, angle)
    add_entry("radiation-doodle", "Radiation doodle", "Custom", "radiation-doodle.png", rad_a)

    shelter_b = make_canvas((236, 248, 236))
    add_checker(shelter_b, (220, 240, 220))
    badge = build_fallout_shelter_badge((230, 242, 230), (255, 116, 64))
    for center, angle in (((66, 72), -8), ((176, 176), 8)):
        paste_centered(shelter_b, badge, center, angle)
    add_entry("shelter-badge", "Shelter badge", "Custom", "shelter-badge.png", shelter_b)

    return manifest


def main() -> None:
    manifest = generate_backgrounds()
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {len(manifest)} tiled backgrounds in {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
