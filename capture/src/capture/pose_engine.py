"""MediaPipe Pose-движок (v2-тень): 33 landmark'а на тот же frame.rgb, что и матте."""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import (
    PoseLandmarker,
    PoseLandmarkerOptions,
    RunningMode,
)

if TYPE_CHECKING:
    from capture.config import CaptureConfig

# Порог видимости joint'а для healthy-метрики (spec §3.3, контракт POSE_VIS_THRESH).
POSE_VIS_THRESH = 0.5


@dataclass(frozen=True)
class PosePacket:
    world: list[list[float]]   # 33 × [x,y,z,v], метры, hip-origin
    norm: list[list[float]]    # 33 × [x,y,z,v], [0,1] по кадру
    healthy: float             # доля joints с visibility ≥ POSE_VIS_THRESH


def healthy_fraction(visibilities: Sequence[float]) -> float:
    """Доля landmark'ов с visibility ≥ POSE_VIS_THRESH (0.0..1.0)."""
    n = len(visibilities)
    if n == 0:
        return 0.0
    return sum(1 for v in visibilities if v >= POSE_VIS_THRESH) / n


class PoseEngine:
    def __init__(self, model_path: str) -> None:
        # CPU-делегат (XNNPACK): GPU-делегат MediaPipe на macOS нестабилен (spec §3.2).
        options = PoseLandmarkerOptions(
            base_options=BaseOptions(
                model_asset_path=model_path,
                delegate=BaseOptions.Delegate.CPU,
            ),
            running_mode=RunningMode.VIDEO,
            num_poses=1,
            output_segmentation_masks=False,
        )
        self._detector = PoseLandmarker.create_from_options(options)
        self._last_ts = -1

    def _mk_image(self, rgb: np.ndarray) -> mp.Image:
        # rgb УЖЕ RGB (webcam.py:27) — подаём напрямую, БЕЗ cvtColor (spec §3.2, блокер).
        return mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

    def process(self, rgb: np.ndarray, t_ms: float) -> PosePacket | None:
        # VIDEO-режим требует монотонно растущий int (frame.t_ms — float, spec §3.2).
        ts = max(int(t_ms), self._last_ts + 1)
        self._last_ts = ts
        result = self._detector.detect_for_video(self._mk_image(rgb), ts)
        if not result.pose_world_landmarks or not result.pose_landmarks:
            return None
        world = [
            [lm.x, lm.y, lm.z, lm.visibility]
            for lm in result.pose_world_landmarks[0]
        ]
        norm = [
            [lm.x, lm.y, lm.z, lm.visibility]
            for lm in result.pose_landmarks[0]
        ]
        healthy = healthy_fraction([row[3] for row in world])
        return PosePacket(world=world, norm=norm, healthy=healthy)


def make_pose_engine(cfg: "CaptureConfig") -> "PoseEngine | None":
    if not cfg.pose_enabled:
        return None
    # импорт модуля, чтобы тесты подменяли PoseEngine через monkeypatch (как make_engine).
    import capture.pose_engine as pose_mod

    path = cfg.pose_model_path or f"{cfg.models_dir}/pose_landmarker_full.task"
    return pose_mod.PoseEngine(path)
