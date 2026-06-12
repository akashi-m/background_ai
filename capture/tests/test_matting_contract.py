from pathlib import Path

import numpy as np
import pytest

from capture.config import CaptureConfig
from capture.matting import MattingEngine, make_engine

MODELS = Path(__file__).resolve().parents[1] / "models"


def synthetic_frame(w: int = 320, h: int = 240) -> np.ndarray:
    """Кадр с «человеком»: тёплый овал на сером фоне (моделям хватает, чтобы не упасть)."""
    img = np.full((h, w, 3), 128, dtype=np.uint8)
    yy, xx = np.mgrid[0:h, 0:w]
    oval = ((xx - w / 2) / (w * 0.15)) ** 2 + ((yy - h / 2) / (h * 0.35)) ** 2 < 1
    img[oval] = (205, 170, 145)
    return img


def engines() -> list[str]:
    found = []
    if (MODELS / "selfie_segmenter.tflite").exists():
        found.append("mediapipe")
    if (MODELS / "rvm_mobilenetv3_fp32.onnx").exists():
        found.append("rvm")
    return found


@pytest.fixture(params=engines() or ["none"])
def engine(request: pytest.FixtureRequest) -> MattingEngine:
    if request.param == "none":
        pytest.skip("нет моделей — запусти capture/scripts/get-models.sh")
    cfg = CaptureConfig(engine=request.param, models_dir=str(MODELS))
    return make_engine(cfg)


def test_contract_shape_dtype_range(engine: MattingEngine) -> None:
    rgb = synthetic_frame()
    alpha = engine.process(rgb)
    assert alpha.shape == rgb.shape[:2]
    assert alpha.dtype == np.float32
    assert float(alpha.min()) >= 0.0 and float(alpha.max()) <= 1.0
    assert not np.isnan(alpha).any()


def test_contract_stable_across_calls(engine: MattingEngine) -> None:
    rgb = synthetic_frame()
    a1 = engine.process(rgb)
    a2 = engine.process(rgb)
    assert a1.shape == a2.shape          # рекуррентное состояние не ломает форму


def test_make_engine_selects_model_file(monkeypatch: pytest.MonkeyPatch) -> None:
    """--model выбирает файл модели; --ratio доходит до движка (без onnx-сессии)."""
    captured: dict[str, object] = {}

    class FakeRvm:
        def __init__(self, model_path: str, downsample_ratio: float = 0.25) -> None:
            captured["path"] = model_path
            captured["ratio"] = downsample_ratio

    import capture.matting.rvm_engine as rvm_mod

    monkeypatch.setattr(rvm_mod, "RvmEngine", FakeRvm)
    cfg = CaptureConfig(engine="rvm", model="resnet50", ratio=0.4, models_dir="models")
    make_engine(cfg)
    assert captured["path"] == "models/rvm_resnet50_fp32.onnx"
    assert captured["ratio"] == 0.4


def test_rvm_survives_resolution_change() -> None:
    if "rvm" not in engines():
        pytest.skip("нет модели rvm")
    cfg = CaptureConfig(engine="rvm", models_dir=str(MODELS))
    e = make_engine(cfg)
    a1 = e.process(synthetic_frame(320, 240))
    a2 = e.process(synthetic_frame(640, 480))  # раньше падало в ONNX Expand
    assert a1.shape == (240, 320)
    assert a2.shape == (480, 640)
