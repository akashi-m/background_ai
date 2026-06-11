"""Dev-движок: MediaPipe selfie segmentation (быстро, без GPU-зависимостей)."""

import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import (
    ImageSegmenter,
    ImageSegmenterOptions,
    RunningMode,
)


class MediapipeEngine:
    def __init__(self, model_path: str) -> None:
        options = ImageSegmenterOptions(
            base_options=BaseOptions(model_asset_path=model_path),
            running_mode=RunningMode.VIDEO,
            output_confidence_masks=True,
            output_category_mask=False,
        )
        self._segmenter = ImageSegmenter.create_from_options(options)
        self._t_ms = 0

    def process(self, rgb: np.ndarray) -> np.ndarray:
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        self._t_ms += 33  # VIDEO-режим требует монотонные отметки
        result = self._segmenter.segment_for_video(image, self._t_ms)
        mask = result.confidence_masks[0].numpy_view()
        # numpy_view() возвращает [H,W,1] — убираем лишнее измерение
        if mask.ndim == 3:
            mask = mask[:, :, 0]
        return np.ascontiguousarray(mask, dtype=np.float32)
