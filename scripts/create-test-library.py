#!/usr/bin/env python3
"""Create a small local GaLib library for reader UI testing."""

from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
LIBRARY = ROOT / "downloads"
SERIES = LIBRARY / "Reader Mode Test"


def page_image(page: int, chapter: int) -> bytes:
    width, height = 1200, 2400
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=46)
    small = ImageFont.load_default(size=28)

    draw.rectangle((30, 30, width - 30, height - 30), outline="black", width=12)
    draw.text((80, 90), f"CHAPTER {chapter} · PAGE {page}", fill="black", font=font)

    panels = [
        (90, 260, width - 90, 1020, "TOP HALF", "First forward tap should reveal the bottom half."),
        (90, 1240, width - 90, height - 120, "BOTTOM HALF", "Next forward tap should turn the page."),
    ]
    for left, top, right, bottom, heading, copy in panels:
        draw.rectangle((left, top, right, bottom), outline="black", width=8)
        draw.text((left + 45, top + 55), heading, fill="black", font=font)
        draw.multiline_text((left + 45, top + 150), copy, fill="black", font=small, spacing=16)

    out = BytesIO()
    image.save(out, "JPEG", quality=88)
    return out.getvalue()


def main() -> None:
    SERIES.mkdir(parents=True, exist_ok=True)
    for chapter in (1, 2):
        path = SERIES / f"Chapter {chapter:03d}.cbz"
        with ZipFile(path, "w", ZIP_DEFLATED) as archive:
            for page in range(1, 4):
                archive.writestr(f"{page:03d}.jpg", page_image(page, chapter))
    print(f"Created test library at {LIBRARY}")


if __name__ == "__main__":
    main()
