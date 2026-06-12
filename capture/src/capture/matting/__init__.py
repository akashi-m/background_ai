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
        # импорт модуля (не имени): тесты подменяют RvmEngine через monkeypatch
        import capture.matting.rvm_engine as rvm_mod

        return rvm_mod.RvmEngine(
            f"{cfg.models_dir}/rvm_{cfg.model}_fp32.onnx", downsample_ratio=cfg.ratio
        )
    from capture.matting.mediapipe_engine import MediapipeEngine

    return MediapipeEngine(f"{cfg.models_dir}/selfie_segmenter.tflite")
