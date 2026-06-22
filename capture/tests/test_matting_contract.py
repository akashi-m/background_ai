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
    fg, alpha = engine.process(rgb)
    assert alpha.shape == rgb.shape[:2]
    assert alpha.dtype == np.float32
    assert float(alpha.min()) >= 0.0 and float(alpha.max()) <= 1.0
    assert not np.isnan(alpha).any()
    assert fg.shape == rgb.shape         # цвет переднего плана — как входной кадр
    assert fg.dtype == np.uint8


def test_contract_stable_across_calls(engine: MattingEngine) -> None:
    rgb = synthetic_frame()
    _, a1 = engine.process(rgb)
    _, a2 = engine.process(rgb)
    assert a1.shape == a2.shape          # рекуррентное состояние не ломает форму


def test_mediapipe_fg_is_passthrough() -> None:
    """Mediapipe не умеет деконтаминацию — отдаёт вход без правок."""
    if "mediapipe" not in engines():
        pytest.skip("нет модели mediapipe")
    cfg = CaptureConfig(engine="mediapipe", models_dir=str(MODELS))
    rgb = synthetic_frame()
    fg, _ = make_engine(cfg).process(rgb)
    assert fg is rgb or np.array_equal(fg, rgb)


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
    _, a1 = e.process(synthetic_frame(320, 240))
    _, a2 = e.process(synthetic_frame(640, 480))  # раньше падало в ONNX Expand
    assert a1.shape == (240, 320)
    assert a2.shape == (480, 640)


def test_iobinding_matches_run_bit_exact() -> None:
    """io-binding путь (в проде GPU-гейтнут) == sess.run бит-в-бит. Форсим io-ветку на CPU.

    Страховка: на CPU io-ветка обычными тестами НЕ исполняется → её легко сломать молча
    будущей правкой. Тест ловит регресс там, где модели есть (dev-машины).
    """
    if not (MODELS / "rvm_resnet50_fp32.onnx").exists():
        pytest.skip("нет модели rvm_resnet50")
    from capture.matting.rvm_engine import RvmEngine

    model = str(MODELS / "rvm_resnet50_fp32.onnx")
    run_eng = RvmEngine(model, downsample_ratio=0.4)        # обычный sess.run (self._gpu=False)
    io_eng = RvmEngine(model, downsample_ratio=0.4)
    io_eng._io = io_eng._sess.io_binding()                  # форсим io-binding ветку на CPU
    for _ in range(4):                                      # рекуррентная последовательность
        rgb = synthetic_frame()
        fg_r, a_r = run_eng.process(rgb)
        fg_i, a_i = io_eng.process(rgb)
        assert np.array_equal(a_r, a_i)                     # альфа (край матта!) — бит-в-бит
        assert np.array_equal(fg_r, fg_i)


def test_u8_fallback_to_fp32_on_load_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """u8-граф не идёт на провайдере → движок честно откатывается на fp32, а НЕ падает.

    Симулируем отказ загрузки *_u8.onnx (как было бы при нехватке op-coverage в DML/CUDA).
    """
    if not (MODELS / "rvm_resnet50_fp32_u8.onnx").exists():
        pytest.skip("нет u8-модели — запусти scripts/optimize-rvm-model.py")
    import capture.matting.rvm_engine as rvm_mod

    real = rvm_mod.ort.InferenceSession

    def fake(path: str, *args: object, **kwargs: object) -> object:
        if str(path).endswith("_u8.onnx"):
            raise RuntimeError("симуляция: u8-граф не поддержан провайдером")
        return real(path, *args, **kwargs)

    monkeypatch.setattr(rvm_mod.ort, "InferenceSession", fake)
    eng = rvm_mod.RvmEngine(str(MODELS / "rvm_resnet50_fp32.onnx"), downsample_ratio=0.4)
    assert eng._u8 is False                                 # откатился на fp32
    _, a = eng.process(synthetic_frame())                   # и работает
    assert a.dtype == np.float32 and a.shape == (240, 320)
