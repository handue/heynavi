from __future__ import annotations

import base64
import io
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from app.images import load_jpeg_data_url, make_synthetic_jpeg

PREFIX = "data:image/jpeg;base64,"


def decode(data_url: str) -> Image.Image:
    assert data_url.startswith(PREFIX)
    return Image.open(io.BytesIO(base64.b64decode(data_url[len(PREFIX) :])))


def write_jpeg(path: Path, size: tuple[int, int], orientation: int | None = None) -> Path:
    exif = Image.Exif()
    if orientation is not None:
        exif[0x0112] = orientation  # EXIF Orientation tag
    Image.new("RGB", size, "red").save(path, format="JPEG", exif=exif)
    return path


def test_downscales_longest_side_and_keeps_aspect(tmp_path: Path) -> None:
    photo = write_jpeg(tmp_path / "room.jpg", (4032, 3024))
    result = load_jpeg_data_url(photo, 768, 60)
    assert (result.width, result.height) == (768, 576)
    img = decode(result.data_url)
    assert img.format == "JPEG" and img.size == (768, 576)
    assert result.byte_size == len(base64.b64decode(result.data_url[len(PREFIX) :]))


def test_never_upscales(tmp_path: Path) -> None:
    photo = write_jpeg(tmp_path / "small.jpg", (300, 200))
    assert load_jpeg_data_url(photo, 768, 60)[1:3] == (300, 200)


def test_applies_exif_orientation(tmp_path: Path) -> None:
    # Orientation 6 = rotate 90 degrees: a landscape-stored iPhone photo shown as portrait.
    photo = write_jpeg(tmp_path / "rotated.jpg", (400, 300), orientation=6)
    result = load_jpeg_data_url(photo, 1000, 80)
    assert (result.width, result.height) == (300, 400)


def test_png_with_alpha_becomes_rgb_jpeg(tmp_path: Path) -> None:
    path = tmp_path / "shot.png"
    Image.new("RGBA", (100, 50), (0, 0, 255, 128)).save(path)
    result = load_jpeg_data_url(path, 768)
    assert decode(result.data_url).mode == "RGB"


def test_unreadable_file_raises(tmp_path: Path) -> None:
    bad = tmp_path / "notes.jpg"
    bad.write_text("not an image")
    with pytest.raises(Exception):
        load_jpeg_data_url(bad, 768)


@pytest.mark.skipif(shutil.which("sips") is None, reason="macOS sips not available")
def test_heic_is_converted_with_sips(tmp_path: Path) -> None:
    jpg = write_jpeg(tmp_path / "src.jpg", (640, 480))
    heic = tmp_path / "photo.heic"
    made = subprocess.run(
        ["sips", "-s", "format", "heic", str(jpg), "--out", str(heic)], capture_output=True
    )
    if made.returncode != 0 or not heic.exists():
        pytest.skip("this macOS cannot write HEIC")
    result = load_jpeg_data_url(heic, 320)
    assert (result.width, result.height) == (320, 240)


@pytest.mark.parametrize("size", [768, 1008])
def test_synthetic_jpeg(size: int) -> None:
    result = make_synthetic_jpeg(size)
    assert max(result.width, result.height) == size
    assert result.height > result.width  # portrait, like the phone preview
    assert decode(result.data_url).size == (result.width, result.height)
    assert result.byte_size > 10_000  # noisy enough to be a realistic upload
    assert make_synthetic_jpeg(size, seed=1).data_url != result.data_url
