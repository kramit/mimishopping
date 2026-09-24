"""Composite the six transparent cat sprites over the static shop banner.

Requires Pillow. The sprite sheet has three 512 px cells per row, two rows.
Its order is neutral, lean, inspect, turn, blink, and return to neutral.
"""

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
PLATE = ASSETS / "mimi-encyclopedia-hero-plate.webp"
SPRITE = ASSETS / "hero-cat-sprite.png"
STILL = ASSETS / "mimi-encyclopedia-hero-still.webp"
ANIMATED = ASSETS / "mimi-encyclopedia-hero-animated.webp"
CELL = 512
CAT_SIZE = 461
CAT_POSITION = (1310, 50)
POSES = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0]
DURATIONS_MS = [1700, 440, 1060, 560, 340, 1300, 340, 560, 840, 440, 1700]


def main():
    plate = Image.open(PLATE).convert("RGBA")
    sprite = Image.open(SPRITE).convert("RGBA")
    if plate.size != (2172, 724) or sprite.size != (CELL * 3, CELL * 2):
        raise ValueError("Unexpected hero plate or cat sprite dimensions")
    if sprite.getpixel((0, 0))[3] != 0:
        raise ValueError("The cat sprite sheet needs a transparent background")

    cats = [
        sprite.crop((column * CELL, row * CELL, (column + 1) * CELL, (row + 1) * CELL))
        .resize((CAT_SIZE, CAT_SIZE), Image.Resampling.LANCZOS)
        for row in range(2)
        for column in range(3)
    ]
    frames = []
    for pose in POSES:
        frame = plate.copy()
        frame.alpha_composite(cats[pose], CAT_POSITION)
        frames.append(frame.convert("RGB"))

    frames[0].save(STILL, quality=90, method=6)
    frames[0].save(
        ANIMATED,
        save_all=True,
        append_images=frames[1:],
        duration=DURATIONS_MS,
        loop=0,
        quality=90,
        method=6,
        minimize_size=True,
    )


if __name__ == "__main__":
    main()
