"""Фоновый цикл: источник → маттинг → presence → SBS-кадр в держателе."""

import threading
import time
from dataclasses import dataclass

import numpy as np

from capture.compose import pack_sbs
from capture.frames import FrameSource
from capture.matting import MattingEngine
from capture.presence import PresenceConfig, PresenceState, PresenceTracker


@dataclass(frozen=True)
class PipelineStats:
    frames: int
    fps: float
    presence: PresenceState
    # bbox фигуры в нормированных координатах (x0,y0,x1,y1) или None.
    # Нижняя кромка bbox = «ноги» — нужна контактной тени рендерера (спека §4).
    # Полные joints появятся с интеграцией ZED (подпроект Ops) — контракт уже учтён.
    bbox: tuple[float, float, float, float] | None = None
    errors: int = 0
    last_error: str | None = None


def _mask_stats(
    alpha: np.ndarray,
) -> tuple[float, float, tuple[float, float, float, float] | None]:
    """(coverage, bbox_height_ratio, bbox_norm) по альфе."""
    binary = alpha > 0.5
    coverage = float(binary.mean())
    rows = np.flatnonzero(binary.any(axis=1))
    cols = np.flatnonzero(binary.any(axis=0))
    if rows.size == 0 or cols.size == 0:
        return coverage, 0.0, None
    h, w = alpha.shape
    bbox = (cols[0] / w, rows[0] / h, (cols[-1] + 1) / w, (rows[-1] + 1) / h)
    bbox_h = float(rows[-1] - rows[0] + 1) / h
    return coverage, bbox_h, bbox


class Pipeline:
    def __init__(
        self, source: FrameSource, engine: MattingEngine, presence_cfg: PresenceConfig
    ) -> None:
        self._source = source
        self._engine = engine
        self._presence = PresenceTracker(presence_cfg)
        self._lock = threading.Lock()
        self._sbs: np.ndarray | None = None
        self._bbox: tuple[float, float, float, float] | None = None
        self._frames = 0
        self._fps = 0.0
        self._errors = 0
        self._last_error: str | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="capture-pipeline", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3.0)
            self._thread = None
        self._source.close()

    def latest_sbs(self) -> np.ndarray | None:
        with self._lock:
            return self._sbs

    def stats(self) -> PipelineStats:
        with self._lock:
            return PipelineStats(
                self._frames, self._fps, self._presence.state, self._bbox,
                self._errors, self._last_error,
            )

    def _run(self) -> None:
        window_start = time.monotonic()
        window_frames = 0
        while not self._stop.is_set():
            try:
                frame = self._source.read()
                if frame is None:
                    time.sleep(0.05)  # источник иссяк/сбоит — ждём, не падаем
                    now = time.monotonic()
                    elapsed = now - window_start
                    if elapsed >= 2.0:
                        with self._lock:
                            # Сбрасываем fps: если были кадры до зависания — показываем их,
                            # иначе 0 (источник висит без данных).
                            self._fps = window_frames / elapsed if window_frames > 0 else 0.0
                        window_start, window_frames = now, 0
                    continue
                fg, alpha = self._engine.process(frame.rgb)
                coverage, bbox_h, bbox = _mask_stats(alpha)
                self._presence.update(coverage=coverage, bbox_height_ratio=bbox_h)
                sbs = pack_sbs(fg, alpha)
                now = time.monotonic()
                window_frames += 1
                with self._lock:
                    self._sbs = sbs
                    self._bbox = bbox
                    self._frames += 1
                    if now - window_start >= 1.0:
                        self._fps = window_frames / (now - window_start)
                        window_start, window_frames = now, 0
            except Exception as exc:  # noqa: BLE001 — деградация без тихой смерти (спека §11)
                with self._lock:
                    self._errors += 1
                    self._last_error = f"{type(exc).__name__}: {exc}"
                time.sleep(0.05)  # не крутимся вхолостую при стабильном сбое
                now = time.monotonic()
                if now - window_start >= 2.0:
                    with self._lock:
                        self._fps = 0.0
                    window_start, window_frames = now, 0
                continue
