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


class StallingSource:
    """N кадров, затем вечный None (камера зависла)."""

    def __init__(self, frames: int = 20, w: int = 64, h: int = 48) -> None:
        self._left = frames
        self._w, self._h = w, h

    def read(self):  # type: ignore[no-untyped-def]
        import numpy as np

        from capture.frames import Frame

        if self._left <= 0:
            return None
        self._left -= 1
        return Frame(rgb=np.full((self._h, self._w, 3), 200, dtype=np.uint8), t_ms=0.0)

    def close(self) -> None: ...


def test_fps_decays_when_source_stalls() -> None:
    p = Pipeline(StallingSource(frames=40), FakeEngine(), PresenceConfig())
    p.start()
    try:
        deadline = time.monotonic() + 5.0
        while p.stats().fps == 0.0 and time.monotonic() < deadline:
            time.sleep(0.02)
        assert p.stats().fps > 0.0      # кадры шли — fps живой
        time.sleep(2.6)                  # источник завис
        assert p.stats().fps == 0.0      # fps затух → /health увидит стойло
    finally:
        p.stop()


class FlakyEngine:
    def __init__(self) -> None:
        self.calls = 0

    def process(self, rgb: np.ndarray) -> np.ndarray:
        self.calls += 1
        if self.calls % 2 == 0:
            raise RuntimeError("boom")
        return (rgb[:, :, 0] > 128).astype(np.float32)


def test_pipeline_survives_engine_errors(tmp_path: Path) -> None:
    clip = tmp_path / "flaky.mp4"
    make_clip(clip, frames=60)
    from capture.sources.file import FileSource

    p = Pipeline(FileSource(str(clip)), FlakyEngine(), PresenceConfig())
    p.start()
    try:
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            s = p.stats()
            if s.errors > 0 and s.frames > 1:
                break
            time.sleep(0.01)
        s = p.stats()
        assert s.errors > 0                      # ошибка видима
        assert s.last_error is not None and "boom" in s.last_error
        assert s.frames > 1                      # поток жив, кадры идут
        assert p.latest_sbs() is not None
    finally:
        p.stop()
