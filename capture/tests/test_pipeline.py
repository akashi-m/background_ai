import time
from pathlib import Path

import cv2
import numpy as np

from capture.pipeline import Pipeline, PipelineStats
from capture.presence import PresenceConfig


def make_clip(path: Path, frames: int = 10, w: int = 64, h: int = 48) -> None:
    vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, (w, h))
    for i in range(frames):
        img = np.full((h, w, 3), i * 20 % 255, dtype=np.uint8)
        vw.write(img)
    vw.release()


class FakeEngine:
    """Движок-заглушка: альфа = яркость > 0.5 (детерминированно для теста)."""

    def process(self, rgb: np.ndarray) -> np.ndarray:
        return (rgb[:, :, 0] > 128).astype(np.float32)


def test_pipeline_produces_sbs_frames(tmp_path: Path) -> None:
    clip = tmp_path / "clip.mp4"
    make_clip(clip, frames=30, w=64, h=48)
    from capture.sources.file import FileSource

    p = Pipeline(FileSource(str(clip)), FakeEngine(), PresenceConfig())
    p.start()
    try:
        deadline = time.monotonic() + 5.0
        while p.latest_sbs() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        sbs = p.latest_sbs()
        assert sbs is not None
        assert sbs.shape == (48, 128, 3)        # двойная ширина
        stats = p.stats()
        assert isinstance(stats, PipelineStats)
        assert stats.frames > 0
        assert stats.fps >= 0
    finally:
        p.stop()


def test_pipeline_stop_is_idempotent(tmp_path: Path) -> None:
    clip = tmp_path / "c.mp4"
    make_clip(clip, frames=5)
    from capture.sources.file import FileSource

    p = Pipeline(FileSource(str(clip)), FakeEngine(), PresenceConfig())
    p.start()
    p.stop()
    p.stop()  # повторный stop не падает
