"""RobustVideoMatting (ONNX): качественные края, рекуррентное состояние.

Провайдеры (по приоритету): CUDA (NVIDIA) → DirectML (любой GPU на Windows) → CPU.
GPU включается ВЫБОРОМ ПАКЕТА onnxruntime на устройстве: `onnxruntime-gpu` (CUDA) или
`onnxruntime-directml` (DML). Базовый `onnxruntime` = ТОЛЬКО CPU — отсюда CPU-нагрузка
даже на машине с видеокартой. CoreML на этой модели медленнее CPU (M4, 720p: 63 vs 53 мс —
граф рвётся на ~20 партиций), поэтому его не держим.
"""

import sys
from pathlib import Path

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
        self._ratio = np.array([downsample_ratio], dtype=np.float32)
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        # *_u8.onnx (scripts/optimize-rvm-model.py): UINT8-вход NHWC, /255+transpose в графе.
        # По PCIe летит uint8 вместо float32 (в 4× меньше), CPU не кастит/транспонирует;
        # pha/fgr бит-в-бит те же. ROBUST: если u8-граф не грузится/не идёт на ЭТОМ провайдере
        # (op-coverage DML/CUDA) — ловим пробой и честно откатываемся на fp32, а не падаем.
        u8_path = Path(model_path).with_name(Path(model_path).stem + "_u8.onnx")
        self._u8 = u8_path.exists()
        sess = None
        if self._u8:
            try:
                sess = ort.InferenceSession(str(u8_path), sess_options=so, providers=providers)
                self._probe(sess)  # u8-граф реально исполняется на активном провайдере?
            except Exception:  # noqa: BLE001 — u8 не пошёл на провайдере → fp32
                print("[rvm] *_u8.onnx не пошёл на провайдере → fp32-путь", file=sys.stderr)
                self._u8 = False
                sess = None
        if sess is None:
            sess = ort.InferenceSession(model_path, sess_options=so, providers=providers)
        self._sess = sess
        # IO-binding включаем ТОЛЬКО на GPU: bind_cpu_input КОПИРУЕТ хост-буфер (без
        # lifetime-ловушки ortvalue_from_numpy, которая врапит и молча портит вход). На CPU
        # io-binding ~5% медленнее обычного run. На ЛЮБОЙ ошибке io-пути — откат на sess.run.
        active = self._sess.get_providers()[0]
        self._gpu = active in ("CUDAExecutionProvider", "DmlExecutionProvider")
        self._io = self._sess.io_binding() if self._gpu else None
        self._in_name = "src_u8" if self._u8 else "src"
        self._out_names = ["fgr", "pha", "r1o", "r2o", "r3o", "r4o"]
        self._rec: list[np.ndarray] = [np.zeros((1, 1, 1, 1), dtype=np.float32)] * 4
        self._shape: tuple[int, int] | None = None

    def _probe(self, sess: ort.InferenceSession) -> None:
        """Прогон u8-модели на dummy-кадре: убедиться, что граф идёт на активном провайдере."""
        z = np.zeros((1, 1, 1, 1), dtype=np.float32)
        sess.run(None, {"src_u8": np.zeros((1, 64, 64, 3), dtype=np.uint8),
                        "r1i": z, "r2i": z, "r3i": z, "r4i": z, "downsample_ratio": self._ratio})

    def process(self, rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        if rgb.shape[:2] != self._shape:
            self._shape = (rgb.shape[0], rgb.shape[1])
            self.reset()
        if self._u8:
            # uint8 NHWC как есть из камеры; transpose+cast+/255 делает граф на устройстве
            src = np.ascontiguousarray(rgb[None])  # [1,H,W,3] uint8
        else:
            src = (rgb.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]  # [1,3,H,W]
        feeds = {
            self._in_name: src,
            "r1i": self._rec[0], "r2i": self._rec[1],
            "r3i": self._rec[2], "r4i": self._rec[3],
            "downsample_ratio": self._ratio,
        }
        if self._io is not None:
            try:
                self._io.clear_binding_inputs()
                self._io.clear_binding_outputs()
                for name, arr in feeds.items():
                    self._io.bind_cpu_input(name, arr)   # копирует хост-буфер (безопасно)
                for name in self._out_names:
                    self._io.bind_output(name, "cpu")    # на GPU форсит нужный D2H
                self._sess.run_with_iobinding(self._io)
                fgr, pha, *rec = self._io.copy_outputs_to_cpu()  # порядок = bind_output
            except Exception:  # noqa: BLE001 — io-binding капризит на GPU → откат на run
                print("[rvm] io-binding отключён (ошибка) → sess.run", file=sys.stderr)
                self._io = None
                fgr, pha, *rec = self._sess.run(None, feeds)
        else:
            fgr, pha, *rec = self._sess.run(None, feeds)
        self._rec = list(rec)
        # fgr — деконтаминированный цвет: модель вычищает фон из края (спилл)
        fg = (fgr[0].transpose(1, 2, 0) * 255.0 + 0.5).clip(0, 255).astype(np.uint8)
        return fg, np.ascontiguousarray(pha[0, 0], dtype=np.float32)

    def reset(self) -> None:
        """Сбросить рекуррентное состояние (смена сцены/источника)."""
        self._rec = [np.zeros((1, 1, 1, 1), dtype=np.float32)] * 4
