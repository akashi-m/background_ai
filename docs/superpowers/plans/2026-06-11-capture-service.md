# Capture-service — план реализации (подпроект №1 Stellar Mirror Lux)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Python-сервис: источник кадров (файл/вебка/ZED-стаб) → нейроматтинг → side-by-side RGB|A → WebRTC-поток + WS-телеметрия; полностью работает на Mac M4 (dev-режим), готов к ZED/TensorRT на проде. Спека: `docs/superpowers/specs/2026-06-11-stellar-mirror-lux-design.md` (§3, §3.1, §3.2, §4, §10.1).

**Architecture:** Поток кадров крутится в фоновом потоке (источник → маттинг → presence → упаковка SBS), последний кадр лежит в потокобезопасном держателе. Поверх — aiohttp-сервер: `/offer` (WebRTC, aiortc отдаёт SBS как видеотрек), `/ws` (телеметрия 15 Гц), `/viewer` (страница проверки с WebGL-распаковкой), `/health`. Все компоненты за протоколами: источники и маттинг-движки взаимозаменяемы, прод-варианты (ZED, TensorRT, NVENC) подключаются без изменения контрактов.

**Tech Stack:** Python 3.11+, uv, numpy, OpenCV, MediaPipe (dev-маттинг), onnxruntime + RVM (качественный маттинг), aiortc + aiohttp (WebRTC/WS), pydantic (конфиг), pytest + mypy + ruff.

**Ветка:** `git checkout -b lux/capture-service` от `proto/stellar-window-2`.

## Структура файлов

```
capture/
├── pyproject.toml              проект uv: зависимости, pytest/mypy/ruff
├── README.md                   запуск, режимы, приёмка
├── scripts/get-models.sh       скачивание моделей (tflite, onnx) в capture/models/
├── src/capture/
│   ├── __init__.py
│   ├── config.py               pydantic-настройки + разбор CLI
│   ├── frames.py               Frame, протокол FrameSource
│   ├── sources/
│   │   ├── __init__.py         make_source(cfg) — фабрика
│   │   ├── file.py             видеофайл с лупом (детерминированные тесты)
│   │   ├── webcam.py           cv2.VideoCapture (dev на Маке)
│   │   └── zed.py              прод-стаб: понятная ошибка до интеграции ZED SDK
│   ├── matting/
│   │   ├── __init__.py         протокол MattingEngine + make_engine(cfg)
│   │   ├── mediapipe_engine.py dev-движок (selfie segmentation)
│   │   └── rvm_engine.py       RobustVideoMatting ONNX (CoreML/CPU/CUDA)
│   ├── compose.py              pack_sbs: [H,W,3]+[H,W] → [H,2W,3]
│   ├── presence.py             присутствие/дистанция с гистерезисом (чистая, TDD)
│   ├── pipeline.py             фоновый цикл кадров + держатель последнего кадра
│   ├── server.py               aiohttp: /offer /ws /viewer /health
│   └── main.py                 CLI-вход
├── viewer/viewer.html          проверочная страница: WebRTC + WebGL-распаковка
└── tests/
    ├── test_config.py
    ├── test_compose.py
    ├── test_presence.py
    ├── test_sources.py         сам генерирует mp4 — без бинарных фикстур
    ├── test_matting_contract.py контракт движков (skip без моделей)
    ├── test_pipeline.py        интеграция: файл → движок → SBS-кадры
    └── test_server.py          WS/health (+ WebRTC loopback)
```

Корень репо: `capture/` — отдельный Python-проект рядом с веб-частью; в корневой `.gitignore` добавляется `capture/models/` и `capture/.venv/`.

---

### Task 1: Каркас Python-проекта

**Files:**
- Create: `capture/pyproject.toml`, `capture/src/capture/__init__.py`, `capture/tests/test_smoke.py`, `capture/README.md`
- Modify: `.gitignore` (корень репо)

- [ ] **Step 1: Проверить uv**

Run: `uv --version || brew install uv`

- [ ] **Step 2: capture/pyproject.toml**

```toml
[project]
name = "capture"
version = "0.1.0"
description = "Stellar Mirror Lux: захват, маттинг, RGBA-стрим"
requires-python = ">=3.11"
dependencies = [
  "numpy>=1.26",
  "opencv-python>=4.9",
  "mediapipe>=0.10.14",
  "onnxruntime>=1.18",
  "aiortc>=1.9",
  "aiohttp>=3.9",
  "pydantic>=2.7",
]

[dependency-groups]
dev = [
  "pytest>=8.0",
  "pytest-asyncio>=0.23",
  "mypy>=1.10",
  "ruff>=0.4",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"

[tool.mypy]
python_version = "3.11"
strict = true
ignore_missing_imports = true   # cv2/mediapipe/aiortc без полных стабов

[tool.ruff]
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/capture"]
```

- [ ] **Step 3: пустой пакет и smoke-тест**

`capture/src/capture/__init__.py`:
```python
"""Stellar Mirror Lux — capture-сервис."""

__version__ = "0.1.0"
```

`capture/tests/test_smoke.py`:
```python
import capture


def test_package_importable() -> None:
    assert capture.__version__
```

- [ ] **Step 4: README-заглушка**

`capture/README.md`:
```markdown
# capture — захват и маттинг (Stellar Mirror Lux)

Сервис: камера/файл → вырезание человека → WebRTC RGB|A + WS-телеметрия.
Подпроект №1 мастер-спеки `../docs/superpowers/specs/2026-06-11-stellar-mirror-lux-design.md`.

## Команды

    uv sync                # окружение
    uv run pytest          # тесты
    uv run mypy src        # типы
    uv run ruff check .    # линт
```

- [ ] **Step 5: .gitignore (корень репо) — добавить строки**

```
capture/.venv/
capture/models/
__pycache__/
```

- [ ] **Step 6: Установка и проверка**

Run: `cd capture && uv sync && uv run pytest && uv run mypy src && uv run ruff check .`
Expected: 1 passed; mypy Success; ruff чисто. (Установка mediapipe/aiortc может занять пару минут.)

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore(capture): каркас Python-проекта (uv, pytest, mypy, ruff)"
```

---

### Task 2: Конфиг и CLI

**Files:**
- Create: `capture/src/capture/config.py`
- Test: `capture/tests/test_config.py`

- [ ] **Step 1: Падающий тест**

```python
from capture.config import CaptureConfig, parse_args


def test_defaults() -> None:
    cfg = CaptureConfig()
    assert cfg.source == "webcam"
    assert cfg.engine == "mediapipe"
    assert cfg.port == 8765
    assert cfg.width == 1280
    assert cfg.height == 720


def test_parse_args_file_source() -> None:
    cfg = parse_args(["--source", "file:clip.mp4", "--engine", "rvm", "--port", "9000"])
    assert cfg.source == "file"
    assert cfg.file_path == "clip.mp4"
    assert cfg.engine == "rvm"
    assert cfg.port == 9000


def test_parse_args_zed() -> None:
    cfg = parse_args(["--source", "zed"])
    assert cfg.source == "zed"


def test_parse_args_bad_source() -> None:
    import pytest

    with pytest.raises(SystemExit):
        parse_args(["--source", "hologram"])
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd capture && uv run pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: capture.config`

- [ ] **Step 3: Реализация**

```python
"""Конфигурация capture-сервиса: pydantic-модель + разбор CLI."""

import argparse
from typing import Literal

from pydantic import BaseModel


class CaptureConfig(BaseModel):
    source: Literal["webcam", "file", "zed"] = "webcam"
    file_path: str = ""          # для source=file
    camera_index: int = 0        # для source=webcam
    engine: Literal["mediapipe", "rvm"] = "mediapipe"
    width: int = 1280
    height: int = 720
    fps: int = 30
    port: int = 8765             # aiohttp: /offer /ws /viewer /health
    models_dir: str = "models"   # куда скачаны модели (scripts/get-models.sh)


def parse_args(argv: list[str] | None = None) -> CaptureConfig:
    p = argparse.ArgumentParser(description="Stellar Mirror Lux capture-сервис")
    p.add_argument("--source", default="webcam",
                   help="webcam | file:путь.mp4 | zed")
    p.add_argument("--engine", default="mediapipe", choices=["mediapipe", "rvm"])
    p.add_argument("--camera-index", type=int, default=0)
    p.add_argument("--width", type=int, default=1280)
    p.add_argument("--height", type=int, default=720)
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--models-dir", default="models")
    a = p.parse_args(argv)

    source, file_path = a.source, ""
    if source.startswith("file:"):
        source, file_path = "file", source[len("file:"):]
    if source not in ("webcam", "file", "zed"):
        p.error(f"неизвестный источник: {a.source}")
    if source == "file" and not file_path:
        p.error("источник file требует путь: --source file:клип.mp4")

    return CaptureConfig(
        source=source, file_path=file_path, camera_index=a.camera_index,
        engine=a.engine, width=a.width, height=a.height, fps=a.fps,
        port=a.port, models_dir=a.models_dir,
    )
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd capture && uv run pytest -v && uv run mypy src`
Expected: PASS (5 тестов), mypy чисто

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(capture): конфиг и CLI (--source file:/webcam/zed, --engine)"
```

---

### Task 3: Упаковка side-by-side RGB|A

**Files:**
- Create: `capture/src/capture/compose.py`
- Test: `capture/tests/test_compose.py`

Контракт из спеки §3.1: кадр двойной ширины, слева RGB, справа альфа в трёх
каналах (альфа живёт в люме — H.264 4:2:0 не портит её точность).

- [ ] **Step 1: Падающий тест**

```python
import numpy as np

from capture.compose import pack_sbs, unpack_sbs


def test_pack_shape_and_layout() -> None:
    rgb = np.full((4, 6, 3), 200, dtype=np.uint8)
    alpha = np.zeros((4, 6), dtype=np.float32)
    alpha[:, :3] = 1.0
    sbs = pack_sbs(rgb, alpha)
    assert sbs.shape == (4, 12, 3)
    assert sbs.dtype == np.uint8
    assert (sbs[:, :6] == 200).all()              # слева RGB как есть
    assert (sbs[:, 6:9] == 255).all()             # альфа=1 → белый
    assert (sbs[:, 9:12] == 0).all()              # альфа=0 → чёрный


def test_roundtrip() -> None:
    rng = np.random.default_rng(7)
    rgb = rng.integers(0, 256, size=(8, 8, 3), dtype=np.uint8)
    alpha = rng.random((8, 8), dtype=np.float32)
    rgb2, alpha2 = unpack_sbs(pack_sbs(rgb, alpha))
    assert (rgb2 == rgb).all()
    assert np.abs(alpha2 - alpha).max() <= 1 / 255 + 1e-6  # квантование байтом


def test_rejects_mismatched_shapes() -> None:
    import pytest

    with pytest.raises(ValueError):
        pack_sbs(np.zeros((4, 6, 3), np.uint8), np.zeros((4, 5), np.float32))
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd capture && uv run pytest tests/test_compose.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Реализация**

```python
"""Упаковка кадра в side-by-side RGB|A (контракт с рендерером, спека §3.1)."""

import numpy as np


def pack_sbs(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """[H,W,3] uint8 + [H,W] float32 0..1 → [H,2W,3] uint8: слева RGB, справа альфа."""
    if rgb.ndim != 3 or rgb.shape[2] != 3 or alpha.shape != rgb.shape[:2]:
        raise ValueError(f"несовместимые формы: rgb {rgb.shape}, alpha {alpha.shape}")
    h, w, _ = rgb.shape
    out = np.empty((h, w * 2, 3), dtype=np.uint8)
    out[:, :w] = rgb
    a8 = np.clip(alpha * 255.0 + 0.5, 0, 255).astype(np.uint8)
    out[:, w:] = a8[:, :, None]
    return out


def unpack_sbs(sbs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Обратная распаковка (эталон для тестов; в проде распаковывает шейдер)."""
    h, w2, _ = sbs.shape
    w = w2 // 2
    rgb = sbs[:, :w].copy()
    alpha = sbs[:, w:, 0].astype(np.float32) / 255.0
    return rgb, alpha
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd capture && uv run pytest tests/test_compose.py -v`
Expected: PASS (3)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(capture): упаковка side-by-side RGB|A (контракт §3.1)"
```

---

### Task 4: Presence — присутствие и дистанция

**Files:**
- Create: `capture/src/capture/presence.py`
- Test: `capture/tests/test_presence.py`

Чистая логика: по статистике альфы (доля покрытия, высота bbox) решаем
«посетитель есть/нет» с гистерезисом и дебаунсом, оцениваем дистанцию.
На проде дистанцию заменит глубина ZED — интерфейс уже готов к этому.

- [ ] **Step 1: Падающий тест**

```python
from capture.presence import PresenceConfig, PresenceTracker


CFG = PresenceConfig(enter_coverage=0.06, exit_coverage=0.03,
                     enter_frames=3, exit_frames=5, distance_k_cm=110.0)


def tick(t: PresenceTracker, coverage: float, bbox_h: float, n: int) -> None:
    for _ in range(n):
        t.update(coverage=coverage, bbox_height_ratio=bbox_h)


def test_starts_absent() -> None:
    t = PresenceTracker(CFG)
    assert t.state.present is False


def test_enter_needs_consecutive_frames() -> None:
    t = PresenceTracker(CFG)
    tick(t, 0.10, 0.5, 2)
    assert t.state.present is False      # ещё рано
    tick(t, 0.10, 0.5, 1)
    assert t.state.present is True       # 3-й подряд кадр


def test_flicker_does_not_enter() -> None:
    t = PresenceTracker(CFG)
    tick(t, 0.10, 0.5, 2)
    tick(t, 0.0, 0.0, 1)                 # разрыв сбрасывает счётчик
    tick(t, 0.10, 0.5, 2)
    assert t.state.present is False


def test_exit_hysteresis_and_debounce() -> None:
    t = PresenceTracker(CFG)
    tick(t, 0.10, 0.5, 3)
    assert t.state.present is True
    tick(t, 0.04, 0.4, 10)               # между exit(0.03) и enter(0.06) — держим
    assert t.state.present is True
    tick(t, 0.01, 0.1, 4)
    assert t.state.present is True       # ещё не 5 кадров ниже exit
    tick(t, 0.01, 0.1, 1)
    assert t.state.present is False


def test_distance_from_bbox_height() -> None:
    t = PresenceTracker(CFG)
    tick(t, 0.10, 0.55, 3)
    assert t.state.present is True
    assert abs(t.state.distance_cm - 110.0 / 0.55) < 1e-6


def test_distance_none_when_absent() -> None:
    t = PresenceTracker(CFG)
    assert t.state.distance_cm is None
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd capture && uv run pytest tests/test_presence.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Реализация**

```python
"""Присутствие посетителя: гистерезис + дебаунс по статистике маски.

Дистанция (dev): bbox человека ростом ~170 см занимает долю кадра
обратно пропорциональную расстоянию → distance_cm ≈ k / bbox_height_ratio.
k калибруется по месту (дефолт 110 ≈ вебка Mac на столе).
На проде источником дистанции станет глубина ZED — тот же интерфейс state.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class PresenceConfig:
    enter_coverage: float = 0.06   # доля кадра с альфой>0.5, чтобы «войти»
    exit_coverage: float = 0.03    # ниже — кандидат на «выход» (гистерезис)
    enter_frames: int = 3          # подряд кадров для входа (дебаунс)
    exit_frames: int = 5           # подряд кадров для выхода
    distance_k_cm: float = 110.0   # коэффициент дистанции по высоте bbox


@dataclass(frozen=True)
class PresenceState:
    present: bool
    distance_cm: float | None
    coverage: float


class PresenceTracker:
    def __init__(self, cfg: PresenceConfig | None = None) -> None:
        self.cfg = cfg or PresenceConfig()
        self._present = False
        self._enter_run = 0
        self._exit_run = 0
        self._last = PresenceState(False, None, 0.0)

    @property
    def state(self) -> PresenceState:
        return self._last

    def update(self, coverage: float, bbox_height_ratio: float) -> PresenceState:
        c = self.cfg
        if not self._present:
            if coverage >= c.enter_coverage:
                self._enter_run += 1
                if self._enter_run >= c.enter_frames:
                    self._present = True
                    self._exit_run = 0
            else:
                self._enter_run = 0
        else:
            if coverage < c.exit_coverage:
                self._exit_run += 1
                if self._exit_run >= c.exit_frames:
                    self._present = False
                    self._enter_run = 0
            else:
                self._exit_run = 0

        distance: float | None = None
        if self._present and bbox_height_ratio > 1e-3:
            distance = c.distance_k_cm / bbox_height_ratio
        self._last = PresenceState(self._present, distance, coverage)
        return self._last
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd capture && uv run pytest tests/test_presence.py -v && uv run mypy src`
Expected: PASS (6), mypy чисто

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(capture): presence — гистерезис, дебаунс, оценка дистанции"
```

---

### Task 5: Источники кадров (file / webcam / zed-стаб)

**Files:**
- Create: `capture/src/capture/frames.py`, `capture/src/capture/sources/__init__.py`, `capture/src/capture/sources/file.py`, `capture/src/capture/sources/webcam.py`, `capture/src/capture/sources/zed.py`
- Test: `capture/tests/test_sources.py`

Тест сам генерирует mp4 через OpenCV — никаких бинарных фикстур в репо.

- [ ] **Step 1: Падающий тест**

```python
from pathlib import Path

import cv2
import numpy as np
import pytest

from capture.config import CaptureConfig
from capture.frames import Frame
from capture.sources import make_source
from capture.sources.file import FileSource


def make_clip(path: Path, frames: int = 10, w: int = 64, h: int = 48) -> None:
    vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, (w, h))
    for i in range(frames):
        img = np.full((h, w, 3), i * 20 % 255, dtype=np.uint8)
        vw.write(img)
    vw.release()


def test_file_source_reads_frames(tmp_path: Path) -> None:
    clip = tmp_path / "clip.mp4"
    make_clip(clip)
    src = FileSource(str(clip), loop=False)
    frames = []
    while (f := src.read()) is not None:
        frames.append(f)
    src.close()
    assert len(frames) == 10
    assert isinstance(frames[0], Frame)
    assert frames[0].rgb.shape == (48, 64, 3)
    assert frames[0].rgb.dtype == np.uint8
    assert frames[1].t_ms > frames[0].t_ms


def test_file_source_loops(tmp_path: Path) -> None:
    clip = tmp_path / "clip.mp4"
    make_clip(clip, frames=3)
    src = FileSource(str(clip), loop=True)
    got = [src.read() for _ in range(7)]   # больше длины клипа
    src.close()
    assert all(f is not None for f in got)


def test_file_source_missing_file() -> None:
    with pytest.raises(FileNotFoundError):
        FileSource("/нет/такого.mp4")


def test_factory_zed_stub_raises() -> None:
    cfg = CaptureConfig(source="zed")
    with pytest.raises(RuntimeError, match="ZED"):
        make_source(cfg)


def test_factory_file(tmp_path: Path) -> None:
    clip = tmp_path / "c.mp4"
    make_clip(clip)
    cfg = CaptureConfig(source="file", file_path=str(clip))
    src = make_source(cfg)
    assert src.read() is not None
    src.close()
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd capture && uv run pytest tests/test_sources.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: capture/src/capture/frames.py**

```python
"""Кадр и протокол источника кадров."""

from typing import NamedTuple, Protocol

import numpy as np


class Frame(NamedTuple):
    rgb: np.ndarray   # [H,W,3] uint8, RGB
    t_ms: float       # отметка времени кадра, мс (монотонная)


class FrameSource(Protocol):
    def read(self) -> Frame | None:
        """Следующий кадр; None — поток закончился (file без loop)."""
        ...

    def close(self) -> None: ...
```

- [ ] **Step 4: capture/src/capture/sources/file.py**

```python
"""Источник из видеофайла: детерминированные тесты и golden-прогоны."""

import os
import time

import cv2

from capture.frames import Frame


class FileSource:
    def __init__(self, path: str, loop: bool = True) -> None:
        if not os.path.exists(path):
            raise FileNotFoundError(path)
        self._path = path
        self._loop = loop
        self._cap = cv2.VideoCapture(path)
        self._t0 = time.monotonic()

    def read(self) -> Frame | None:
        ok, bgr = self._cap.read()
        if not ok:
            if not self._loop:
                return None
            self._cap.release()
            self._cap = cv2.VideoCapture(self._path)
            ok, bgr = self._cap.read()
            if not ok:
                return None
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        return Frame(rgb=rgb, t_ms=(time.monotonic() - self._t0) * 1000.0)

    def close(self) -> None:
        self._cap.release()
```

- [ ] **Step 5: capture/src/capture/sources/webcam.py**

```python
"""Источник с вебкамеры (dev-режим на Маке, спека §3.2)."""

import time

import cv2

from capture.frames import Frame


class WebcamSource:
    def __init__(self, index: int = 0, width: int = 1280, height: int = 720) -> None:
        self._cap = cv2.VideoCapture(index)
        if not self._cap.isOpened():
            raise RuntimeError(f"вебкамера {index} не открылась — проверь доступ к камере")
        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self._t0 = time.monotonic()

    def read(self) -> Frame | None:
        ok, bgr = self._cap.read()
        if not ok:
            return None  # временный сбой камеры — пайплайн переживёт
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        return Frame(rgb=rgb, t_ms=(time.monotonic() - self._t0) * 1000.0)

    def close(self) -> None:
        self._cap.release()
```

- [ ] **Step 6: capture/src/capture/sources/zed.py**

```python
"""ZED 2i — прод-источник. Интеграция в подпроекте Ops (мастер-спека §10.5).

Стаб существует, чтобы контракт source=zed был зафиксирован уже сейчас,
а ошибка при случайном запуске была понятной, а не ImportError из глубин.
"""

from capture.frames import Frame


class ZedSource:
    def __init__(self) -> None:
        raise RuntimeError(
            "Источник ZED ещё не интегрирован: требуется ZED SDK + pyzed на прод-машине "
            "(Windows/RTX). Для разработки используй --source webcam или --source file:клип.mp4"
        )

    def read(self) -> Frame | None:  # pragma: no cover — недостижимо
        return None

    def close(self) -> None:  # pragma: no cover
        ...
```

- [ ] **Step 7: capture/src/capture/sources/__init__.py**

```python
"""Фабрика источников по конфигу."""

from capture.config import CaptureConfig
from capture.frames import FrameSource
from capture.sources.file import FileSource
from capture.sources.webcam import WebcamSource
from capture.sources.zed import ZedSource


def make_source(cfg: CaptureConfig) -> FrameSource:
    if cfg.source == "file":
        return FileSource(cfg.file_path)
    if cfg.source == "zed":
        return ZedSource()
    return WebcamSource(cfg.camera_index, cfg.width, cfg.height)
```

- [ ] **Step 8: Тесты зелёные**

Run: `cd capture && uv run pytest tests/test_sources.py -v && uv run mypy src`
Expected: PASS (5), mypy чисто

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(capture): источники кадров — file/webcam/zed-стаб + фабрика"
```

---

### Task 6: Маттинг-движки (MediaPipe + RVM) и скачивание моделей

**Files:**
- Create: `capture/src/capture/matting/__init__.py`, `capture/src/capture/matting/mediapipe_engine.py`, `capture/src/capture/matting/rvm_engine.py`, `capture/scripts/get-models.sh`
- Test: `capture/tests/test_matting_contract.py`

Контракт движка один: `process(rgb [H,W,3] uint8) → alpha [H,W] float32 0..1`.
Контрактные тесты гоняются для всех доступных движков; без скачанных моделей —
аккуратный skip с подсказкой.

- [ ] **Step 1: capture/scripts/get-models.sh**

```bash
#!/usr/bin/env bash
# Скачивание моделей маттинга в capture/models/ (папка в .gitignore)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p models

# MediaPipe selfie segmenter (dev-движок), ~16 МБ
[ -f models/selfie_segmenter.tflite ] || curl -L -o models/selfie_segmenter.tflite \
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite"

# RobustVideoMatting mobilenetv3 ONNX (качественный движок), ~100 МБ
[ -f models/rvm_mobilenetv3_fp32.onnx ] || curl -L -o models/rvm_mobilenetv3_fp32.onnx \
  "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx"

ls -la models/
```

Run: `chmod +x capture/scripts/get-models.sh && capture/scripts/get-models.sh`
Expected: обе модели в capture/models/. Если URL RVM недоступен — взять
rvm_mobilenetv3_fp32.onnx из релизов https://github.com/PeterL1n/RobustVideoMatting
(раздел Releases v1.0.0) и положить в capture/models/ под тем же именем.

- [ ] **Step 2: Падающий контрактный тест**

```python
from pathlib import Path

import numpy as np
import pytest

from capture.matting import MattingEngine, make_engine
from capture.config import CaptureConfig

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
```

- [ ] **Step 3: Убедиться, что падает**

Run: `cd capture && uv run pytest tests/test_matting_contract.py -v`
Expected: FAIL — `ModuleNotFoundError: capture.matting`

- [ ] **Step 4: capture/src/capture/matting/__init__.py**

```python
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
```

- [ ] **Step 5: capture/src/capture/matting/mediapipe_engine.py**

```python
"""Dev-движок: MediaPipe selfie segmentation (быстро, без GPU-зависимостей)."""

import numpy as np
import mediapipe as mp
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
        return np.ascontiguousarray(mask, dtype=np.float32)
```

- [ ] **Step 6: capture/src/capture/matting/rvm_engine.py**

```python
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
```

- [ ] **Step 7: Тесты зелёные (с моделями)**

Run: `cd capture && uv run pytest tests/test_matting_contract.py -v && uv run mypy src`
Expected: PASS — 2 теста × 2 движка = 4 (или skip с подсказкой, если моделей нет; для коммита модели должны быть скачаны и тесты зелёные)

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(capture): маттинг — MediaPipe (dev) и RVM ONNX, контрактные тесты"
```

---

### Task 7: Pipeline — фоновый цикл кадров

**Files:**
- Create: `capture/src/capture/pipeline.py`
- Test: `capture/tests/test_pipeline.py`

Поток: source.read → engine.process → presence.update → pack_sbs → держатель.
Сервер (Task 8–9) только читает из держателя — пайплайн не знает про сеть.

- [ ] **Step 1: Падающий тест**

```python
import time
from pathlib import Path

import numpy as np

import cv2

from capture.pipeline import Pipeline, PipelineStats
from capture.presence import PresenceConfig


def make_clip(path: Path, frames: int = 10, w: int = 64, h: int = 48) -> None:
    vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, (w, h))
    for i in range(frames):
        img = np.full((h, w, 3), i * 20 % 255, dtype=np.uint8)
        vw.write(img)
    vw.release()


class FakeEngine:
    """Движок-заглушка: альфа = яркость > 0.5 (детерминированно для теста)."""

    def process(self, rgb: np.ndarray) -> np.ndarray:
        return (rgb[:, :, 0] > 128).astype(np.float32)


def test_pipeline_produces_sbs_frames(tmp_path: Path) -> None:
    clip = tmp_path / "clip.mp4"
    make_clip(clip, frames=30, w=64, h=48)
    from capture.sources.file import FileSource

    p = Pipeline(FileSource(str(clip)), FakeEngine(), PresenceConfig())
    p.start()
    try:
        deadline = time.monotonic() + 5.0
        while p.latest_sbs() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        sbs = p.latest_sbs()
        assert sbs is not None
        assert sbs.shape == (48, 128, 3)        # двойная ширина
        stats = p.stats()
        assert isinstance(stats, PipelineStats)
        assert stats.frames > 0
        assert stats.fps >= 0
    finally:
        p.stop()


def test_pipeline_stop_is_idempotent(tmp_path: Path) -> None:
    clip = tmp_path / "c.mp4"
    make_clip(clip, frames=5)
    from capture.sources.file import FileSource

    p = Pipeline(FileSource(str(clip)), FakeEngine(), PresenceConfig())
    p.start()
    p.stop()
    p.stop()  # повторный stop не падает
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd capture && uv run pytest tests/test_pipeline.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Реализация**

```python
"""Фоновый цикл: источник → маттинг → presence → SBS-кадр в держателе."""

import threading
import time
from dataclasses import dataclass

import numpy as np

from capture.compose import pack_sbs
from capture.frames import FrameSource
from capture.matting import MattingEngine
from capture.presence import PresenceConfig, PresenceState, PresenceTracker


@dataclass(frozen=True)
class PipelineStats:
    frames: int
    fps: float
    presence: PresenceState
    # bbox фигуры в нормированных координатах (x0,y0,x1,y1) или None.
    # Нижняя кромка bbox = «ноги» — нужна контактной тени рендерера (спека §4).
    # Полные joints появятся с интеграцией ZED (подпроект Ops) — контракт уже учтён.
    bbox: tuple[float, float, float, float] | None = None


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
        self, source: FrameSource, engine: MattingEngine, presence_cfg: PresenceConfig
    ) -> None:
        self._source = source
        self._engine = engine
        self._presence = PresenceTracker(presence_cfg)
        self._lock = threading.Lock()
        self._sbs: np.ndarray | None = None
        self._bbox: tuple[float, float, float, float] | None = None
        self._frames = 0
        self._fps = 0.0
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
        self._source.close()

    def latest_sbs(self) -> np.ndarray | None:
        with self._lock:
            return self._sbs

    def stats(self) -> PipelineStats:
        with self._lock:
            return PipelineStats(self._frames, self._fps, self._presence.state, self._bbox)

    def _run(self) -> None:
        window_start = time.monotonic()
        window_frames = 0
        while not self._stop.is_set():
            frame = self._source.read()
            if frame is None:
                time.sleep(0.05)  # источник иссяк/сбоит — ждём, не падаем
                continue
            alpha = self._engine.process(frame.rgb)
            coverage, bbox_h, bbox = _mask_stats(alpha)
            self._presence.update(coverage=coverage, bbox_height_ratio=bbox_h)
            sbs = pack_sbs(frame.rgb, alpha)
            now = time.monotonic()
            window_frames += 1
            with self._lock:
                self._sbs = sbs
                self._bbox = bbox
                self._frames += 1
                if now - window_start >= 1.0:
                    self._fps = window_frames / (now - window_start)
                    window_start, window_frames = now, 0
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd capture && uv run pytest tests/test_pipeline.py -v && uv run mypy src`
Expected: PASS (2), mypy чисто

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(capture): pipeline — фоновый цикл кадров с держателем SBS"
```

---

### Task 8: Сервер — WS-телеметрия и health

**Files:**
- Create: `capture/src/capture/server.py`
- Test: `capture/tests/test_server.py`

- [ ] **Step 1: Падающий тест**

```python
import json

import numpy as np
import pytest
from aiohttp.test_utils import TestClient, TestServer

from capture.presence import PresenceState
from capture.pipeline import PipelineStats
from capture.server import build_app


class FakePipeline:
    """Подменяет Pipeline в тестах сервера — без камер и моделей."""

    def latest_sbs(self) -> np.ndarray | None:
        return np.zeros((8, 16, 3), dtype=np.uint8)

    def stats(self) -> PipelineStats:
        return PipelineStats(
            frames=42, fps=30.0,
            presence=PresenceState(present=True, distance_cm=150.0, coverage=0.2),
        )


@pytest.fixture
async def client() -> TestClient:
    app = build_app(FakePipeline(), telemetry_hz=50)
    c = TestClient(TestServer(app))
    await c.start_server()
    yield c
    await c.close()


async def test_health(client: TestClient) -> None:
    resp = await client.get("/health")
    assert resp.status == 200
    data = await resp.json()
    assert data["fps"] == 30.0
    assert data["frames"] == 42


async def test_ws_telemetry_stream(client: TestClient) -> None:
    ws = await client.ws_connect("/ws")
    msg = json.loads((await ws.receive(timeout=2)).data)
    assert msg["type"] == "presence"
    assert msg["present"] is True
    assert msg["distanceCm"] == 150.0
    msg2 = json.loads((await ws.receive(timeout=2)).data)  # поток, не одно сообщение
    assert msg2["type"] == "presence"
    await ws.close()


async def test_viewer_served(client: TestClient) -> None:
    resp = await client.get("/viewer")
    assert resp.status == 200
    assert "text/html" in resp.headers["Content-Type"]
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd capture && uv run pytest tests/test_server.py -v`
Expected: FAIL — `ModuleNotFoundError: capture.server`

- [ ] **Step 3: Реализация (WS/health/viewer; /offer добавится в Task 9)**

```python
"""HTTP/WS-сервер capture-сервиса: /health, /ws (телеметрия), /viewer, /offer."""

import asyncio
import json
from pathlib import Path
from typing import Protocol

import numpy as np
from aiohttp import WSMsgType, web

from capture.pipeline import PipelineStats

VIEWER_HTML = Path(__file__).resolve().parents[2] / "viewer" / "viewer.html"


class PipelineLike(Protocol):
    """Контракт пайплайна, нужный серверу (тестам хватает фейка)."""

    def latest_sbs(self) -> np.ndarray | None: ...
    def stats(self) -> PipelineStats: ...


def _telemetry_json(stats: PipelineStats) -> str:
    p = stats.presence
    return json.dumps(
        {
            "type": "presence",
            "present": p.present,
            "distanceCm": p.distance_cm,
            "coverage": round(p.coverage, 4),
            "bbox": stats.bbox,  # нормированный (x0,y0,x1,y1); низ = «ноги» для тени
            "fps": round(stats.fps, 1),
        }
    )


async def _health(request: web.Request) -> web.Response:
    pipeline: PipelineLike = request.app["pipeline"]
    s = pipeline.stats()
    return web.json_response(
        {"ok": True, "frames": s.frames, "fps": s.fps, "present": s.presence.present}
    )


async def _ws(request: web.Request) -> web.WebSocketResponse:
    pipeline: PipelineLike = request.app["pipeline"]
    hz: int = request.app["telemetry_hz"]
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    try:
        while not ws.closed:
            await ws.send_str(_telemetry_json(pipeline.stats()))
            try:
                msg = await asyncio.wait_for(ws.receive(), timeout=1.0 / hz)
                if msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.ERROR):
                    break
            except asyncio.TimeoutError:
                pass  # нет входящих — шлём следующий тик телеметрии
    finally:
        await ws.close()
    return ws


async def _viewer(request: web.Request) -> web.Response:
    return web.Response(text=VIEWER_HTML.read_text(), content_type="text/html")


def build_app(pipeline: PipelineLike, telemetry_hz: int = 15) -> web.Application:
    app = web.Application()
    app["pipeline"] = pipeline
    app["telemetry_hz"] = telemetry_hz
    app.router.add_get("/health", _health)
    app.router.add_get("/ws", _ws)
    app.router.add_get("/viewer", _viewer)
    return app
```

И минимальная заглушка viewer для теста (полная страница — Task 10):
`capture/viewer/viewer.html`:
```html
<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>capture viewer</title></head>
<body>заглушка — полная страница в Task 10</body></html>
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd capture && uv run pytest tests/test_server.py -v && uv run mypy src`
Expected: PASS (3), mypy чисто

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(capture): сервер — health, WS-телеметрия 15 Гц, viewer-роут"
```

---

### Task 9: WebRTC — SBS-видеотрек и /offer

**Files:**
- Modify: `capture/src/capture/server.py`
- Create: `capture/src/capture/webrtc.py`
- Test: `capture/tests/test_webrtc.py`

- [ ] **Step 1: capture/src/capture/webrtc.py**

```python
"""WebRTC-выдача SBS-кадров (aiortc). Один трек на соединение."""

import fractions

import numpy as np
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import VideoStreamTrack
from av import VideoFrame

from capture.server import PipelineLike


class SbsTrack(VideoStreamTrack):
    """Отдаёт последний SBS-кадр пайплайна; нет кадра — чёрный (рендерер в IDLE)."""

    def __init__(self, pipeline: PipelineLike, fps: int = 30) -> None:
        super().__init__()
        self._pipeline = pipeline
        self._fps = fps
        self._black = np.zeros((720, 2560, 3), dtype=np.uint8)

    async def recv(self) -> VideoFrame:
        pts, time_base = await self.next_timestamp()
        sbs = self._pipeline.latest_sbs()
        frame = VideoFrame.from_ndarray(sbs if sbs is not None else self._black, format="rgb24")
        frame.pts = pts
        frame.time_base = time_base
        return frame


async def handle_offer(
    pipeline: PipelineLike, offer_sdp: str, offer_type: str, pcs: set[RTCPeerConnection]
) -> RTCSessionDescription:
    pc = RTCPeerConnection()
    pcs.add(pc)

    @pc.on("connectionstatechange")
    async def _on_state() -> None:
        if pc.connectionState in ("failed", "closed"):
            await pc.close()
            pcs.discard(pc)

    pc.addTrack(SbsTrack(pipeline))
    await pc.setRemoteDescription(RTCSessionDescription(sdp=offer_sdp, type=offer_type))
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    assert pc.localDescription is not None
    return pc.localDescription
```

- [ ] **Step 2: Подключить /offer в server.py**

В `build_app` добавить (и импорт `from capture.webrtc import handle_offer` внутри
функции `_offer`, чтобы тесты Task 8 не тянули aiortc):

```python
async def _offer(request: web.Request) -> web.Response:
    from capture.webrtc import handle_offer

    pipeline: PipelineLike = request.app["pipeline"]
    pcs = request.app["pcs"]
    body = await request.json()
    local = await handle_offer(pipeline, body["sdp"], body["type"], pcs)
    return web.json_response({"sdp": local.sdp, "type": local.type})


async def _on_shutdown(app: web.Application) -> None:
    for pc in set(app["pcs"]):
        await pc.close()
    app["pcs"].clear()
```

и в `build_app`:
```python
    app["pcs"] = set()
    app.router.add_post("/offer", _offer)
    app.on_shutdown.append(_on_shutdown)
```

- [ ] **Step 3: Loopback-тест WebRTC**

`capture/tests/test_webrtc.py`:
```python
import asyncio

import numpy as np
import pytest
from aiortc import RTCPeerConnection

from capture.presence import PresenceState
from capture.pipeline import PipelineStats
from capture.webrtc import handle_offer


class FakePipeline:
    def latest_sbs(self) -> np.ndarray | None:
        sbs = np.zeros((48, 128, 3), dtype=np.uint8)
        sbs[:, :64] = 200      # «RGB» слева
        sbs[:, 64:] = 255      # «альфа» справа
        return sbs

    def stats(self) -> PipelineStats:
        return PipelineStats(1, 30.0, PresenceState(True, 100.0, 0.5))


@pytest.mark.asyncio
async def test_offer_answer_and_frames_flow() -> None:
    pcs: set[RTCPeerConnection] = set()
    client = RTCPeerConnection()
    received = asyncio.Event()

    @client.on("track")
    def on_track(track):  # type: ignore[no-untyped-def]
        async def consume() -> None:
            for _ in range(3):
                await track.recv()
            received.set()

        asyncio.ensure_future(consume())

    client.addTransceiver("video", direction="recvonly")
    offer = await client.createOffer()
    await client.setLocalDescription(offer)

    answer = await handle_offer(
        FakePipeline(), client.localDescription.sdp, client.localDescription.type, pcs
    )
    await client.setRemoteDescription(answer)

    await asyncio.wait_for(received.wait(), timeout=10)
    await client.close()
    for pc in pcs:
        await pc.close()
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd capture && uv run pytest tests/test_webrtc.py tests/test_server.py -v && uv run mypy src`
Expected: PASS (4), mypy чисто. (Loopback-тест реально гоняет кодек — до ~10 с.)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(capture): WebRTC — SBS-трек и /offer с loopback-тестом"
```

---

### Task 10: main, viewer-страница, README — ручная приёмка

**Files:**
- Create: `capture/src/capture/main.py`
- Modify: `capture/viewer/viewer.html` (полная версия), `capture/README.md`, `capture/pyproject.toml` (script-вход)

- [ ] **Step 1: capture/src/capture/main.py**

```python
"""Вход capture-сервиса: собрать пайплайн по конфигу и поднять сервер."""

import sys

from aiohttp import web

from capture.config import parse_args
from capture.matting import make_engine
from capture.pipeline import Pipeline
from capture.presence import PresenceConfig
from capture.server import build_app
from capture.sources import make_source


def main(argv: list[str] | None = None) -> None:
    cfg = parse_args(argv)
    try:
        source = make_source(cfg)
    except (RuntimeError, FileNotFoundError) as e:
        print(f"источник: {e}", file=sys.stderr)
        raise SystemExit(2) from e
    engine = make_engine(cfg)
    pipeline = Pipeline(source, engine, PresenceConfig())
    pipeline.start()

    app = build_app(pipeline)

    async def _cleanup(_: web.Application) -> None:
        pipeline.stop()

    app.on_cleanup.append(_cleanup)
    print(f"capture: источник={cfg.source} движок={cfg.engine}")
    print(f"viewer:  http://localhost:{cfg.port}/viewer")
    web.run_app(app, host="127.0.0.1", port=cfg.port)


if __name__ == "__main__":
    main()
```

В `capture/pyproject.toml` добавить:
```toml
[project.scripts]
capture = "capture.main:main"
```

- [ ] **Step 2: Полный viewer/viewer.html (заменить заглушку)**

```html
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>capture viewer — проверка RGBA-потока</title>
<style>
  body { margin: 0; background: #111; color: #9f9; font: 13px monospace; }
  #stats { position: fixed; top: 8px; left: 8px; background: rgba(0,0,0,.6); padding: 6px; white-space: pre; }
  canvas { display: block; width: 100vw; height: 100vh; object-fit: contain; }
</style>
</head>
<body>
<div id="stats">подключение...</div>
<canvas id="gl"></canvas>
<video id="v" autoplay playsinline muted style="display:none"></video>
<script>
// Распаковка SBS в WebGL: слева RGB, справа альфа; композит поверх шахматки —
// дыры в альфе видны сразу.
const canvas = document.getElementById('gl')
const video = document.getElementById('v')
const stats = document.getElementById('stats')
const gl = canvas.getContext('webgl2')

const vs = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = p*0.5+0.5; uv.y = 1.0-uv.y; gl_Position = vec4(p,0,1); }`
const fs = `#version 300 es
precision highp float;
uniform sampler2D tex; in vec2 uv; out vec4 o;
void main(){
  vec3 rgb = texture(tex, vec2(uv.x*0.5, uv.y)).rgb;
  float a  = texture(tex, vec2(0.5+uv.x*0.5, uv.y)).r;
  float ch = mod(floor(gl_FragCoord.x/16.0)+floor(gl_FragCoord.y/16.0), 2.0);
  vec3 bg = mix(vec3(0.35), vec3(0.55), ch);
  o = vec4(mix(bg, rgb, a), 1.0);
}`
function shader(type, src){ const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s);
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(s); return s }
const prog = gl.createProgram()
gl.attachShader(prog, shader(gl.VERTEX_SHADER, vs))
gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, fs))
gl.linkProgram(prog); gl.useProgram(prog)
const buf = gl.createBuffer()
gl.bindBuffer(gl.ARRAY_BUFFER, buf)
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW)
const loc = gl.getAttribLocation(prog, 'p')
gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
const tex = gl.createTexture()
gl.bindTexture(gl.TEXTURE_2D, tex)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

let frames = 0, fps = 0, last = performance.now()
function draw(){
  if (video.readyState >= 2) {
    canvas.width = video.videoWidth / 2; canvas.height = video.videoHeight
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    frames++
    const now = performance.now()
    if (now - last > 1000) { fps = frames; frames = 0; last = now }
  }
  requestAnimationFrame(draw)
}

let telemetry = {}
async function start(){
  const pc = new RTCPeerConnection()
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.ontrack = (e) => { video.srcObject = new MediaStream([e.track]) }
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  const resp = await fetch('/offer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sdp: pc.localDescription.sdp, type: pc.localDescription.type }),
  })
  await pc.setRemoteDescription(await resp.json())

  const ws = new WebSocket(`ws://${location.host}/ws`)
  ws.onmessage = (e) => { telemetry = JSON.parse(e.data) }

  setInterval(() => {
    stats.textContent =
      `viewer fps: ${fps}\n` +
      `pipeline fps: ${telemetry.fps ?? '—'}\n` +
      `присутствие: ${telemetry.present ? 'да' : 'нет'}  дистанция: ${telemetry.distanceCm ? Math.round(telemetry.distanceCm) + ' см' : '—'}\n` +
      `покрытие: ${telemetry.coverage ?? '—'}`
  }, 250)
  draw()
}
start().catch((e) => { stats.textContent = 'ошибка: ' + e })
</script>
</body>
</html>
```

- [ ] **Step 3: README — полная версия**

```markdown
# capture — захват и маттинг (Stellar Mirror Lux)

Источник кадров → нейроматтинг → side-by-side RGB|A → WebRTC + WS-телеметрия.
Подпроект №1 мастер-спеки `../docs/superpowers/specs/2026-06-11-stellar-mirror-lux-design.md`.

## Установка

    uv sync
    scripts/get-models.sh        # модели маттинга (~120 МБ, в .gitignore)

## Запуск (dev на Маке)

    uv run capture --source webcam --engine mediapipe   # быстрый dev
    uv run capture --source webcam --engine rvm         # качественные края
    uv run capture --source file:клип.mp4 --engine rvm  # детерминированный прогон

Проверка: http://localhost:8765/viewer — ты на шахматном фоне.
Шахматка проверяет альфу: дыры/бахрома видны сразу.

## Контракты (спека §3.1)

- Видео: WebRTC, кадр двойной ширины [RGB | A], альфа в люме.
- Телеметрия: WS `/ws`, JSON presence 15 Гц.
- `/health` — fps/кадры; `/offer` — WebRTC-сигналинг.

## Прод (после приезда железа)

`--source zed` (ZED SDK), TensorRT-провайдер для RVM, NVENC — подпроект Ops.

## Тесты

    uv run pytest        # юниты + контракты + WebRTC-loopback
    uv run mypy src
    uv run ruff check .

## Ручная приёмка (спека §10.1)

- [ ] `uv run capture --source webcam --engine rvm` → /viewer
- [ ] Ты на шахматке, края волос аккуратные, без «дыхания»
- [ ] viewer fps ≥ 30 на M4 (720p)
- [ ] Отойти из кадра → присутствие: нет (через ~5 кадров), вернуться → да
- [ ] Закрыть крышку/выдернуть камеру → сервис жив, /health отвечает
```

- [ ] **Step 4: Проверка всего пакета**

Run: `cd capture && uv sync && uv run pytest -v && uv run mypy src && uv run ruff check .`
Expected: все тесты PASS, mypy/ruff чисто.

Run (smoke): `cd capture && timeout 10 uv run capture --source file:../images/3d/png3d_circle.mp4 --engine mediapipe || true`
Expected: печатает `viewer: http://localhost:8765/viewer`, живёт до таймаута без трейсбеков.

- [ ] **Step 5: Ручная приёмка (человеком, по чек-листу README)** — SKIP для агента.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(capture): main, viewer с WebGL-распаковкой, README с приёмкой"
```



