from pathlib import Path

import cv2
import numpy as np
import pytest

from capture.config import CaptureConfig
from capture.frames import Frame
from capture.sources import make_source
from capture.sources.file import FileSource


def make_clip(path: Path, frames: int = 10, w: int = 64, h: int = 48) -> None:
    vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, (w, h))
    for i in range(frames):
        img = np.full((h, w, 3), i * 20 % 255, dtype=np.uint8)
        vw.write(img)
    vw.release()


def test_file_source_reads_frames(tmp_path: Path) -> None:
    clip = tmp_path / "clip.mp4"
    make_clip(clip)
    src = FileSource(str(clip), loop=False)
    frames = []
    while (f := src.read()) is not None:
        frames.append(f)
    src.close()
    assert len(frames) == 10
    assert isinstance(frames[0], Frame)
    assert frames[0].rgb.shape == (48, 64, 3)
    assert frames[0].rgb.dtype == np.uint8
    assert frames[1].t_ms > frames[0].t_ms


def test_file_source_loops(tmp_path: Path) -> None:
    clip = tmp_path / "clip.mp4"
    make_clip(clip, frames=3)
    src = FileSource(str(clip), loop=True)
    got = [src.read() for _ in range(7)]   # больше длины клипа
    src.close()
    assert all(f is not None for f in got)


def test_file_source_missing_file() -> None:
    with pytest.raises(FileNotFoundError):
        FileSource("/нет/такого.mp4")


def test_factory_zed_stub_raises() -> None:
    cfg = CaptureConfig(source="zed")
    with pytest.raises(RuntimeError, match="ZED"):
        make_source(cfg)


def test_factory_file(tmp_path: Path) -> None:
    clip = tmp_path / "c.mp4"
    make_clip(clip)
    cfg = CaptureConfig(source="file", file_path=str(clip))
    src = make_source(cfg)
    assert src.read() is not None
    src.close()
