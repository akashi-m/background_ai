"""Протокол маттинга и фабрика движков."""

from typing import Protocol

import numpy as np

from capture.config import CaptureConfig


class MattingEngine(Protocol):
    def process(self, rgb: np.ndarray) -> np.ndarray:
        """[H,W,3] uint8 RGB → альфа [H,W] float32 0..1."""
        ...


def make_engine(cfg: CaptureConfig) -> MattingEngine:
    if cfg.engine == "rvm":
        from capture.matting.rvm_engine import RvmEngine

        return RvmEngine(f"{cfg.models_dir}/rvm_mobilenetv3_fp32.onnx")
    from capture.matting.mediapipe_engine import MediapipeEngine

    return MediapipeEngine(f"{cfg.models_dir}/selfie_segmenter.tflite")
