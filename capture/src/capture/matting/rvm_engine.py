"""RobustVideoMatting (ONNX): качественные края, рекуррентное состояние.

Провайдеры: CoreML (Mac) → CUDA/TensorRT (прод) → CPU (фолбэк).
"""

import numpy as np
import onnxruntime as ort


class RvmEngine:
    def __init__(self, model_path: str, downsample_ratio: float = 0.25) -> None:
        providers = [
            p for p in ("CoreMLExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider")
            if p in ort.get_available_providers()
        ]
        self._sess = ort.InferenceSession(model_path, providers=providers)
        self._ratio = np.array([downsample_ratio], dtype=np.float32)
        self._rec: list[np.ndarray] = [np.zeros((1, 1, 1, 1), dtype=np.float32)] * 4

    def process(self, rgb: np.ndarray) -> np.ndarray:
        src = rgb.astype(np.float32) / 255.0
        src = src.transpose(2, 0, 1)[None]  # [1,3,H,W]
        fgr, pha, *rec = self._sess.run(
            None,
            {
                "src": src,
                "r1i": self._rec[0], "r2i": self._rec[1],
                "r3i": self._rec[2], "r4i": self._rec[3],
                "downsample_ratio": self._ratio,
            },
        )
        self._rec = list(rec)
        return np.ascontiguousarray(pha[0, 0], dtype=np.float32)

    def reset(self) -> None:
        """Сбросить рекуррентное состояние (смена сцены/источника)."""
        self._rec = [np.zeros((1, 1, 1, 1), dtype=np.float32)] * 4
