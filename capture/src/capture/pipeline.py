"""Фоновый цикл: источник → маттинг → presence → SBS-кадр в держателе."""

import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np

from capture.compose import pack_sbs
from capture.frames import FrameSource
from capture.matting import MattingEngine
from capture.pose_engine import PosePacket
from capture.presence import PresenceConfig, PresenceState, PresenceTracker

if TYPE_CHECKING:
    from capture.pose_engine import PoseEngine


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
    landmarks: PosePacket | None = None


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
        self,
        source: FrameSource,
        engine: MattingEngine,
        presence_cfg: PresenceConfig,
        pose: "PoseEngine | None" = None,
        *,
        parallel_pose: bool = True,
        pose_every: int = 1,
        profile: bool = False,
    ) -> None:
        self._source = source
        self._engine = engine
        self._presence = PresenceTracker(presence_cfg)
        self._pose = pose
        self._pose_every = max(1, pose_every)
        self._profile = profile
        self._lock = threading.Lock()
        self._sbs: np.ndarray | None = None
        self._bbox: tuple[float, float, float, float] | None = None
        self._landmarks: PosePacket | None = None
        self._last_pose: PosePacket | None = None  # stride: переиспользуем на пропущенных кадрах
        self._frames = 0
        self._fps = 0.0
        self._errors = 0
        self._last_error: str | None = None
        self._prev_present = False  # для сброса recurrent-state матта при выходе посетителя
        # Параллель: позу считаем в отдельном single-worker потоке, пока матт (ONNX/RVM)
        # работает в основном. Оба отпускают GIL на C++-инференсе → реально перекрываются
        # на 2 ядрах, время кадра ≈ max(matte, pose), а не сумма. Single-worker = поза
        # всегда на одном потоке (MediaPipe VIDEO любит постоянный вызывающий поток).
        self._pose_pool: ThreadPoolExecutor | None = (
            ThreadPoolExecutor(max_workers=1, thread_name_prefix="pose")
            if (pose is not None and parallel_pose)
            else None
        )
        # профайл: EMA мс по стадиям (alpha=0.1), троттлинг лога в _run
        self._ema_matte = 0.0
        self._ema_pose = 0.0
        self._ema_pack = 0.0
        self._last_profile = 0.0
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
        if self._pose_pool is not None:
            self._pose_pool.shutdown(wait=False, cancel_futures=True)
        self._source.close()

    def latest_sbs(self) -> np.ndarray | None:
        with self._lock:
            return self._sbs

    def stats(self) -> PipelineStats:
        with self._lock:
            return PipelineStats(
                self._frames, self._fps, self._presence.state, self._bbox,
                self._errors, self._last_error, self._landmarks,
            )

    def _timed_pose(self, rgb: np.ndarray, t_ms: float) -> tuple[PosePacket | None, float]:
        """Поза + её длительность (мс). Зовётся в pose-потоке (parallel) или инлайн."""
        assert self._pose is not None
        t = time.perf_counter()
        pkt = self._pose.process(rgb, t_ms)
        return pkt, (time.perf_counter() - t) * 1000.0

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
                # Позу для ЭТОГО кадра (stride) сабмитим ДО матта → считается параллельно.
                # _frames пишет только этот поток, читать без лока безопасно.
                run_pose = self._pose is not None and (self._frames % self._pose_every == 0)
                pose_future: Future[tuple[PosePacket | None, float]] | None = None
                if run_pose and self._pose_pool is not None:
                    pose_future = self._pose_pool.submit(self._timed_pose, frame.rgb, frame.t_ms)

                t = time.perf_counter()
                fg, alpha = self._engine.process(frame.rgb)
                matte_ms = (time.perf_counter() - t) * 1000.0

                coverage, bbox_h, bbox = _mask_stats(alpha)
                state = self._presence.update(coverage=coverage, bbox_height_ratio=bbox_h)
                # посетитель ВЫШЕЛ → сброс recurrent-state матта: следующий войдёт без «госта»
                # (recurrent-память предыдущего не смажет первые кадры нового).
                if self._prev_present and not state.present:
                    self._engine.reset()
                self._prev_present = state.present

                t = time.perf_counter()
                sbs = pack_sbs(fg, alpha)
                pack_ms = (time.perf_counter() - t) * 1000.0

                # Поза: забрать из потока (parallel) либо посчитать инлайн (--no-parallel-pose).
                # На пропущенных stride-кадрах переиспользуем последнюю (она downstream сглажена).
                pose_pkt = self._last_pose
                pose_ms = 0.0
                if pose_future is not None:
                    try:
                        pose_pkt, pose_ms = pose_future.result()
                        self._last_pose = pose_pkt
                    except Exception as exc:  # noqa: BLE001 — поза не должна ронять кадр
                        self._last_error = f"pose: {type(exc).__name__}: {exc}"
                elif run_pose:  # серийный путь (parallel выключен)
                    try:
                        pose_pkt, pose_ms = self._timed_pose(frame.rgb, frame.t_ms)
                        self._last_pose = pose_pkt
                    except Exception as exc:  # noqa: BLE001
                        self._last_error = f"pose: {type(exc).__name__}: {exc}"

                now = time.monotonic()
                window_frames += 1
                with self._lock:
                    self._sbs = sbs
                    self._bbox = bbox
                    self._landmarks = pose_pkt
                    self._frames += 1
                    if now - window_start >= 1.0:
                        self._fps = window_frames / (now - window_start)
                        window_start, window_frames = now, 0

                if self._profile:
                    a = 0.1
                    self._ema_matte += a * (matte_ms - self._ema_matte)
                    if pose_ms > 0.0:
                        self._ema_pose += a * (pose_ms - self._ema_pose)
                    self._ema_pack += a * (pack_ms - self._ema_pack)
                    if now - self._last_profile >= 3.0:
                        mode = "parallel" if self._pose_pool is not None else "serial"
                        print(
                            f"[capture] perf fps={self._fps:.1f} matte={self._ema_matte:.1f}ms "
                            f"pose={self._ema_pose:.1f}ms pack={self._ema_pack:.1f}ms "
                            f"({mode}, pose_every={self._pose_every})",
                            file=sys.stderr,
                        )
                        self._last_profile = now
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
