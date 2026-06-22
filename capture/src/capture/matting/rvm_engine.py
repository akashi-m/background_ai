"""RobustVideoMatting (ONNX): качественные края, рекуррентное состояние.

Провайдеры (по приоритету): CUDA (NVIDIA) → DirectML (любой GPU на Windows) → CPU.
GPU включается ВЫБОРОМ ПАКЕТА onnxruntime на устройстве: `onnxruntime-gpu` (CUDA) или
`onnxruntime-directml` (DML). Базовый `onnxruntime` = ТОЛЬКО CPU — отсюда CPU-нагрузка
даже на машине с видеокартой. CoreML на этой модели медленнее CPU (M4, 720p: 63 vs 53 мс —
граф рвётся на ~20 партиций), поэтому его не держим.
"""

import numpy as np
import onnxruntime as ort


class RvmEngine:
    def __init__(self, model_path: str, downsample_ratio: float = 0.25) -> None:
        # GPU-провайдер активен, ТОЛЬКО если на устройстве стоит соответствующий пакет
        # onnxruntime (gpu→CUDA / directml→DML); иначе фильтр оставит CPU. TensorRT можно
        # добавить первым при наличии — быстрее, но долгий прогрев движка на старте.
        providers = [
            p for p in ("CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider")
            if p in ort.get_available_providers()
        ]
        self._sess = ort.InferenceSession(model_path, providers=providers)
        self._ratio = np.array([downsample_ratio], dtype=np.float32)
        self._rec: list[np.ndarray] = [np.zeros((1, 1, 1, 1), dtype=np.float32)] * 4
        self._shape: tuple[int, int] | None = None

    def process(self, rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        if rgb.shape[:2] != self._shape:
            self._shape = (rgb.shape[0], rgb.shape[1])
            self.reset()
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
        # fgr — деконтаминированный цвет: модель вычищает фон из края (спилл)
        fg = (fgr[0].transpose(1, 2, 0) * 255.0 + 0.5).clip(0, 255).astype(np.uint8)
        return fg, np.ascontiguousarray(pha[0, 0], dtype=np.float32)

    def reset(self) -> None:
        """Сбросить рекуррентное состояние (смена сцены/источника)."""
        self._rec = [np.zeros((1, 1, 1, 1), dtype=np.float32)] * 4
