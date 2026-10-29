"""JPEG data-URL encoding for model calls. Images are processed in memory only."""

from __future__ import annotations

import base64
import io
import random
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import NamedTuple

from PIL import Image, ImageDraw, ImageOps, UnidentifiedImageError

DEFAULT_JPEG_QUALITY = 70
_HEIF_SUFFIXES = {".heic", ".heif"}


class EncodedImage(NamedTuple):
    data_url: str
    width: int
    height: int
    byte_size: int  # size of the JPEG bytes, before base64


def load_jpeg_data_url(
    path: str | Path, max_side: int, quality: int = DEFAULT_JPEG_QUALITY
) -> EncodedImage:
    """Open a photo, apply EXIF orientation, downscale so the longest side <= max_side,
    and return it as a base64 JPEG data URL."""
    with _open_image(Path(path)) as img:
        upright = ImageOps.exif_transpose(img)
        return encode_jpeg(upright.convert("RGB"), max_side, quality)


def make_synthetic_jpeg(
    max_side: int, *, seed: int = 0, quality: int = DEFAULT_JPEG_QUALITY
) -> EncodedImage:
    """A portrait 9:16 noise-and-shapes image with a realistic JPEG size, for latency-only runs."""
    width, height = max(1, round(max_side * 9 / 16)), max_side
    rng = random.Random(seed)
    img = Image.merge("RGB", [Image.effect_noise((width, height), 48) for _ in range(3)])
    draw = ImageDraw.Draw(img)
    for _ in range(12):
        x1, y1 = rng.randrange(width), rng.randrange(height)
        x2, y2 = x1 + rng.randrange(20, width // 2 + 21), y1 + rng.randrange(20, height // 3 + 21)
        color = (rng.randrange(256), rng.randrange(256), rng.randrange(256))
        draw.rectangle((x1, y1, x2, y2), fill=color)
    return encode_jpeg(img, max_side, quality)


def encode_jpeg(img: Image.Image, max_side: int, quality: int) -> EncodedImage:
    if max_side <= 0:
        raise ValueError("max_side must be positive")
    width, height = img.size
    longest = max(width, height)
    if longest > max_side:
        scale = max_side / longest
        size = (max(1, round(width * scale)), max(1, round(height * scale)))
        img = img.resize(size, Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=quality)
    jpeg = buffer.getvalue()
    data_url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
    return EncodedImage(data_url, img.width, img.height, len(jpeg))


def _open_image(path: Path) -> Image.Image:
    try:
        return Image.open(path)
    except UnidentifiedImageError:
        # Pillow has no HEIC decoder. On macOS, convert with the built-in `sips` tool into
        # a temporary file that is deleted right after it is read into memory.
        sips = shutil.which("sips")
        if path.suffix.lower() not in _HEIF_SUFFIXES or sips is None:
            raise
        with tempfile.TemporaryDirectory(prefix="heynavi-") as tmp:
            out = Path(tmp) / "converted.jpg"
            subprocess.run(
                [sips, "-s", "format", "jpeg", str(path), "--out", str(out)],
                check=True,
                capture_output=True,
            )
            with Image.open(out) as converted:
                converted.load()
                return converted.copy()
