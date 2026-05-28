Pixel Tile Lab
==============

This folder contains a small image-generation and compositing pipeline for
building seamless 320x320 retro wallpaper tiles from Gemini-generated source
art.

What it does
------------

1. Requests three large reference images from Gemini on white backgrounds:
   - starburst explosion
   - mushroom cloud explosion
   - warhead
2. Saves the raw Gemini responses under `output/raw/`.
3. Removes the white background and crops the subject.
4. Runs adaptive k-means clustering to estimate the sprite's own limited color
   palette.
5. Snaps the sprite to that palette with no blended colors.
6. Tries many candidate native sprite sizes and scores each one by
   nearest-neighbor downsample -> nearest-neighbor upsample reconstruction
   error against the snapped source.
7. Uses the lowest-error native size, preserving the sprite at its inferred
   pixel resolution.
8. Builds four seamless tile variations on top of a dithered gray noise field.

Outputs
-------

- `output/raw/`: unmodified Gemini returns
- `output/processed/`: cleaned source art, snapped source art, native previews,
  and inferred native-size sprites
- `output/processed/*-metadata.json`: detected palette and inferred grid size
- `output/tiles/`: final 320x320 seamless backgrounds
- `output/previews/`: contact sheets for quick review

Usage
-----

Generate or refresh everything:

```bash
python3 tools/pixel_tile_lab/generate.py --refresh-refs
```

Regenerate tiles only, reusing existing references:

```bash
python3 tools/pixel_tile_lab/generate.py
```

Notes
-----

- The script reads `GEMINI_API_KEY` from the repo `.env` file.
- The final tiles are meant to stay pixel-sharp. Downsampling and rotations use
  nearest-neighbor interpolation.
