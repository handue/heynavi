"""JPEG encoding and upload validation for model calls. Images are processed in memory only."""

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
JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,"
MAX_UPLOAD_JPEG_BYTES = 2_000_000
_JPEG_MAGIC = b"\xff\xd8\xff"
_HEIF_SUFFIXES = {".heic", ".heif"}


class InvalidImageError(ValueError):
    """Not strict, standard base64, or not a JPEG. The message never quotes the input."""


class ImageTooLargeError(ValueError):
    """The decoded image would be larger than the upload limit."""


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
    data_url = JPEG_DATA_URL_PREFIX + base64.b64encode(jpeg).decode("ascii")
    return EncodedImage(data_url, img.width, img.height, len(jpeg))


def base64_length(byte_count: int) -> int:
    """Length of the padded base64 text for byte_count bytes."""
    return 4 * -(-byte_count // 3)


def decode_base64_jpeg(value: str, max_bytes: int = MAX_UPLOAD_JPEG_BYTES) -> bytes:
    """Decode raw base64 (no "data:" prefix, no whitespace) that must hold a JPEG.

    A string too long to fit in max_bytes once decoded is rejected before decoding.
    """
    if len(value) > base64_length(max_bytes):
        raise ImageTooLargeError(f"image is larger than {max_bytes:,} bytes")
    if value.startswith("data:"):
        raise InvalidImageError("image_b64 must be raw base64, without a data: URL prefix")
    try:
        jpeg = base64.b64decode(value, validate=True)
    except ValueError:  # binascii.Error, or a non-ASCII character
        raise InvalidImageError("image_b64 is not valid base64") from None
    if len(jpeg) > max_bytes:
        raise ImageTooLargeError(f"image is larger than {max_bytes:,} bytes")
    if not jpeg.startswith(_JPEG_MAGIC):
        raise InvalidImageError("image_b64 is not a JPEG")
    return jpeg


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
