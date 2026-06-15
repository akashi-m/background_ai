# v2 Invisible Proxy + Shadow Caster — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить screen-space-аппроксимацию тени тела (`roomShadowMat`) физически рендеренной тенью от невидимого 3D-капсульного прокси, управляемого MediaPipe-позой, на room-receiver (box B1 → EXR-mesh B2) той же камерой, что и плоский плейт; per-room сила тени, единое сглаживание («тень — не наклейка»), graceful fallback на v1.

**Architecture:** Capture (Python) добавляет MediaPipe PoseLandmarker рядом с RVM, шлёт 33 landmark'а в presence-телеметрию. Renderer (three.js) строит `ShadowScene3D`: baked camera из lights.json, PointLight (castShadow только Key), невидимый `ProxyRig` (`colorWrite=false`), receiver (`boxReceiver` → `roomMeshFromEXR`), рендерит тень-фактор в `shadowRT` и мультипликативно блитит на `compositeRT` через `shadowRT2` (до `personMat`/`grain`). Деградация по `pose.healthy` с гистерезисом+crossfade на v1.

**Tech Stack:** Python (mediapipe Tasks API, numpy, aiohttp, pytest), TypeScript (three.js r180, GLSL, Vitest).

---

## ⚠️ Контракты-реконсиляция (ЧИТАТЬ ПЕРВЫМ — разрешает cross-task дрейф)

План драфтился по фазам параллельно, поэтому между задачами есть расхождения имён/типов/координат. **Эта секция — единственный источник истины.** Где код задачи противоречит решению ниже — применяй решение ниже. Исполнителю (subagent-driven) держать её в контексте на каждой задаче.

### A. Канонические типы и сигнатуры (TypeScript)
1. **`F` — представление якоря пола (B1/B6/B12/B17).** На границе компоситора `opts.personFloor.F` остаётся **кортежем `[number,number,number]`** (как в текущем `main.ts`/`compositor.ts`, и так читается `F[2]`). В `THREE.Vector3` конвертируем **в единственном месте** — на вызове `ShadowScene3D.update`: `new THREE.Vector3(opts.personFloor.F[0], opts.personFloor.F[1], opts.personFloor.F[2])`. `ShadowScene3D.update`/`ProxyRig.update` принимают `{ F: THREE.Vector3; H: number }`.
2. **`ShadowScene3D.update` — финальная сигнатура с C.6 и далее:** `update(pose, personFloor: {F:THREE.Vector3;H:number}, shadowData: ShadowData, shadowStrength: number = 1): void`. 4-й параметр **опциональный с дефолтом** → 3-арговые вызовы в тестах C.6 компилируются; D1.5/D2.5 передают `opts.shadowStrength`. `ShadowMaterial.opacity` ставится внутри `update` из `shadowStrength`.
3. **`ShadowData` — один общий тип** (объявить в `shadowGeom.ts`, импортировать в `shadowScene3D.ts`, compositor, main): `{ lamps: {pos:[number,number,number]; weight:number; name?:string}[]; camera: ShadowCamera; floorZ: number; worldPos: THREE.Texture; worldPosData: {data:Float32Array;width:number;height:number}; boxes?: {min:[number,number,number];max:[number,number,number]}[] }`. Поля `worldPos`/`worldPosData` обязательны (нужны B2-receiver'у); `boxes?` опционально (B1). `BuiltWorld['shadowData']` расширить тем же набором в `worldScene.ts`, а `RenderShadowData` на границе `render()` = этот же тип (форвардить `worldPosData` из `main.ts` — сейчас дропается).
4. **`ShadowScene3D.proxyRig: ProxyRig` (B2/B13/M1).** Класс `ProxyRig` создаётся **в B1** (конструктор строит пул капсул с per-segment радиусами — рука 0.05, торс 0.12, голова-сфера; `castShadow=true, colorWrite=false, depthWrite=false, visible=true`; `get object(): THREE.Group`). `ShadowScene3D` держит **публичное** поле `proxyRig: ProxyRig` (а не `proxy: THREE.Group`); B1-статик-прокси = `proxyRig` в нейтральной позе. C.5 наполняет `ProxyRig.update`.
5. **`ShadowMode` — один union (B3/B14):** объявить РОВНО раз в `shadowGeom.ts`: `export type ShadowMode = 'proxy' | 'crossfade' | 'room' | 'silhouette'`. C.6 (бинарный выбор) и D2.3 (лестница) **импортируют** его, не переобъявляют.
6. **`Z_THR` (B14/M29):** объявить раз в `shadowGeom.ts` (`export const Z_THR = 0.15`) + `passesFloorGate(F, floorZ)`. `shadowLadder.ts` (D2.3) **импортирует** их, не дублирует (`fGateOk` = алиас `passesFloorGate`).
7. **`shadowFloorK`/`blobRatio` (B5/B21/M8/M12):** читать из **`LUX_CONFIG.shadow.shadowFloorK` / `.blobRatio`**, НЕ из `opts.shadowCfg` (его тип не расширяем). Поля добавляются в `config.ts` **ровно раз — в D1.6** (самый ранний потребитель); D2.2 → verify/grep, без повторного цикла.
8. **`multiplyBlitMat` — один модуль, GLSL1 end-to-end (M4/M6/M14):** хелперы живут в **`src/lux/multiplyBlit.ts`** (`multiplyShadowTerm`, `coverUv`, `makeMultiplyBlitMat`), тест `multiplyBlit.test.ts`. Шейдер **GLSL1**: `float shadowTerm = 1.0 - texture2D(tShadow, uv).r; ... gl_FragColor = vec4(texture2D(tBg, coverUv).rgb * m, 1.0);`, `coverUv=(vUv-0.5)*uUvScale+0.5`. D2.4 НЕ создаёт второй `shadowMath.ts` и НЕ переходит на GLSL3 `texture()/out`.

### B. Координатный базис (B8/M17 — критично для пиксель-alignment B1) — РЕШЕНО: всё в Blender Z-up
9. **Единый базис — РОВНО Blender Z-up во всей shadow-сцене; НИКАКОГО `blenderToThree`/свопа.** EXR-worldPos, `lights.json`, `floorZ`, F/H — всё уже в Blender Z-up (X восток, Y север, Z вверх). Держим shadow-сцену в тех же координатах, чтобы **не трансформировать EXR-меш и F/H** (лишняя точка ошибок). Конкретно:
   - `boxReceiver` — пол `position.set(0,0,floorZ)`, `PlaneGeometry` нормаль +Z (как в B1.2 — ВЕРНО); box'ы raw `min/max`.
   - `bakedShadowCamera` — `camera.up.set(0,0,1)` **до** `lookAt`; `position`=`cam.pos`, `lookAt(cam.target)` — raw, без свопа. (Камера смотрит ~горизонтально → up=(0,0,1) не вырождается.)
   - `keyPointLights` — raw позиции ламп (PointLight cube-shadow ориентационно-независим).
   - `ProxyRig` — корень в F (raw Z-up), ось роста H = +Z.
   - `roomMeshFromEXR` (B2) — вершины = raw EXR-сэмплы, без конверсии.
   **Любые упоминания `blenderToThree`/`[x,z,-y]` в B1.3/B1.4/B1.5/B2 ОТМЕНЯЮТСЯ** — выкинуть своп, использовать raw Z-up + `camera.up=(0,0,1)`. Обязателен **один cross-component alignment-тест** (receiver+lamp+proxy в Z-up → тень в ожидаемых пикселях) — это exit B1, прогнать на НЕ-совпадающем canvas-аспекте.

### C. Единичность общих шагов (убрать дубли — иначе TDD-гейт ломается)
10. **`sampleWorldXYZ` переносится РОВНО раз — в B1.1** (B18/B19/M25). B2.1 и C.1 заменяются на verify-гейт: `grep -n "export function sampleWorldXYZ" src/lux/shadowGeom.ts` → есть хит ⇒ no-op, skip (НЕ пере-добавлять тест, НЕ пере-удалять строки `main.ts`).
11. **`shadowRT2.setSize`** добавляется раз — в B1.8; D1.3/D1.4 → verify-grep.
12. **Дубли тест-`describe` в `shadowGeom.test.ts`** (B1.1/C.1–C.4/D2.3): один блок импортов сверху, не дублировать `import`.

### D. ESM / тест-изоляция
13. **Без `require()` (B16/M18):** в ESM/Vite `require` падает в браузере. Статический `import { ShadowScene3D } from './shadowScene3D'` сверху compositor + ленивый `if (!this.shadowScene3D) this.shadowScene3D = new ShadowScene3D(...)`.
14. **Не импортировать реальный `main.ts` в тестах (B15):** `start()` на верхнем уровне исполнится и упадёт (`document is not defined`). Вынести `forwardShadowData` в side-effect-free `src/lux/shadowForward.ts` и тестировать его.
15. **Тайпчек реально гоняем (M19):** `npm test` (esbuild) **не** ловит type-ошибки. В exit КАЖДОЙ фазы добавить шаг `npx tsc --noEmit` (ожидание: пусто, exit 0).

### E. Точечные фиксы тест-фикстур / покрытия (применить в соответствующих задачах)
- **B9:** `CapsuleGeometry.parameters` хранит длину под ключом **`height`**, не `length` → читать `g.height + 2*g.radius` (B1.4 и любые capsule-проверки в C).
- **B10:** crossfade-тест D2.3 пред-сидит `mem.proxyActive=true` (войти в proxy, затем упасть в зону `[DROP,ENTER]`), иначе гистерезис не даёт `crossfade`.
- **B11:** фикстура `cliffExr` в B2.4 должна прыгать и по Z (не только X), иначе bridge-предикат (смотрит Z) не отличит разрыв от контакта; либо bridge требует вертикальности большого ребра.
- **M16:** фикстура yaw в C.4 — наклонить сам торс-сегмент к камере (ненулевой z у `shoulderMid` относительно `hipMid`), иначе тест падает после корректной реализации.
- **M15:** warmup в bench учитывает label: `fn(_frame(), 0.0) if label=='pose' else fn(_frame())`.
- **M20:** убрать неиспользуемый `import types` из `test_pose_engine.py` (ruff F401 ломает A.8).
- **M11/M22/M28/M13/M21:** тесты сцены обходят граф через `scene.traverse(...)` (как B1.6), не `.children`; фикстуры лампы = `{pos, weight}` (реальная форма); тип `ShadowData` из п.3 везде; `shadowScene3D.test.ts`/`config.test.ts` — create, `telemetry.test.ts`/`shadowGeom.test.ts` — append.
- **M23:** в D2.7 инлайнить полный блок униформ `roomShadowMat` (tBg/tWorld/tVideo/uUvScale/uVideoAspect/uF/uH/uCamPos/uLamp0-2/uW/uStrength/uBias/uSoft/uOpacity) с правками `cameraPos→camera.pos` и `uOpacity=mirrorOpacity*wRoom` — без `// ...`-эллипсиса.
- **M2 (покрытие):** F-gate в §5 = две OR-проверки (`|F.z-floorZ|>Z_THR` **ИЛИ** пиксель вне room-mask). C.2 реализует обе (room-mask — по альфе/валидности EXR-сэмпла) или явно документирует подмену.
- **M3/M24 (покрытие, exit A):** A.9 — не только бенч-печать. Если серийная сумма RVM+Pose пробивает тик 66.7 мс → реальная митигация-задача **A.9b**: `pose_every_n` в `CaptureConfig` + skip-путь в `pipeline._run` (через кадр), затем повторный замер. Без числа с целевого M4 фаза A не закрывается.
- **M9 (осознанный риск):** в D1 (proxy always-on) F sanity-gate **обойдён** — известный небезопасный промежуток; полноценный gate включает D2.3. Зафиксировать явно, опц. добавить gate уже в D1.5.
- **M10:** интенсивность `PointLight` = нормированный `weight × tunable gain` (decay задать явно), иначе `ShadowMaterial` получит слишком слабый контраст. Live-tunable, вынести в ручку.
- **M5/M30/M7:** один сайт инстанцирования `ShadowScene3D` (в compositor, п.13); `forwardShadowData` форвардит `worldPosData`; в D2.5 сохранить save/restore clear-color из D1.5 (не хардкодить `setClearColor`).

### Замечание по объёму
План крупный (~5.7k строк). **Фаза A (capture) самодостаточна** и может стать отдельным PR раньше рендера. Фазы B1→D2 — рендерный поток.

---

## Phase A — Capture: MediaPipe Pose + телеметрия

> Цель фазы (spec §10, Фаза A): добавить `PoseEngine` (VIDEO/CPU/full, RGB-as-is, int-ts-guard), проводку `pose` в `Pipeline.__init__`, тип `PosePacket`, расширение `PipelineStats` + `_telemetry_json`, фабрику `make_pose_engine`, скачивание `.task`-ассета в `models_dir`, и бенч **серийной суммы** RVM+Pose против тика 15 Гц. Никакого рендерера. Все TDD-шаги ниже строго придерживаются [CANONICAL CONTRACTS]: `PosePacket{world, norm, healthy}`, `PoseEngine.process(rgb, t_ms)`, `make_pose_engine(cfg)`, `Pipeline.__init__(..., pose=None)`, `PipelineStats.landmarks`, wire-ключ `"pose"` только при наличии позы.

**Команда тестов (из CURRENT CODE testCmd):**
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/ -v
```
(если `uv` не используется — `cd /Users/iman/Projects/background_ar/capture && pytest tests/ -v`)

Перед интеграционными/бенч-шагами модель должна быть скачана (Task A.7 расширяет `scripts/get-models.sh`):
```
/Users/iman/Projects/background_ar/capture/scripts/get-models.sh
```

---

### Task A.1 — `CaptureConfig` получает `pose_enabled` / `pose_model_path`

Контракт: `CaptureConfig gains: pose_enabled: bool = True ; pose_model_path: str = ""`.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/capture/src/capture/config.py:9-21`
- Test: `/Users/iman/Projects/background_ar/capture/tests/test_config.py` (append)

**Step 1 — write failing test.** Append to `/Users/iman/Projects/background_ar/capture/tests/test_config.py`:
```python
def test_pose_config_defaults() -> None:
    cfg = CaptureConfig()
    assert cfg.pose_enabled is True
    assert cfg.pose_model_path == ""


def test_pose_model_path_override() -> None:
    cfg = CaptureConfig(pose_model_path="/custom/pose.task")
    assert cfg.pose_model_path == "/custom/pose.task"
```

**Step 2 — run it, expect FAIL:**
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/test_config.py -v
```
Expected output (FAIL):
```
tests/test_config.py::test_pose_config_defaults FAILED
E   pydantic_core._pydantic_core.ValidationError: ... / AttributeError: 'CaptureConfig' object has no attribute 'pose_enabled'
```
(`pose_enabled`/`pose_model_path` не существуют на модели.)

**Step 3 — minimal impl.** Edit `/Users/iman/Projects/background_ar/capture/src/capture/config.py`, add two fields at the end of the `CaptureConfig` body (after line 21, the `bitrate_mbps` line):
```python
    bitrate_mbps: float = 8.0    # битрейт VP8 (loopback): резкость live-композита
    pose_enabled: bool = True    # включать MediaPipe Pose в pipeline (v2-тень)
    pose_model_path: str = ""    # override .task; пусто → {models_dir}/pose_landmarker_full.task
```

**Step 4 — run test, expect PASS:**
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/test_config.py -v
```
Expected: `test_pose_config_defaults PASSED`, `test_pose_model_path_override PASSED`, остальные config-тесты по-прежнему PASSED.

**Step 5 — commit:**
```
git add capture/src/capture/config.py capture/tests/test_config.py
git commit -m "feat(capture): CaptureConfig.pose_enabled/pose_model_path (v2 pose)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task A.2 — `PosePacket` (frozen dataclass) + `healthy`-вычисление из visibility

Контракт: `PosePacket: frozen dataclass { world: list[list[float]]; norm: list[list[float]]; healthy: float }`; `POSE_VIS_THRESH = 0.5`; `healthy = fraction of 33 landmarks with visibility >= POSE_VIS_THRESH`. Помещаем тип и константу в новый модуль `pose_engine.py` (spec §7, новый файл `pose_engine.py`), чтобы `pipeline.py`/`server.py` могли импортировать `PosePacket` без циклической зависимости от mediapipe (тип — чистый dataclass, без импорта mediapipe на уровне модуля).

**Files:**
- Create: `/Users/iman/Projects/background_ar/capture/src/capture/pose_engine.py`
- Test: `/Users/iman/Projects/background_ar/capture/tests/test_pose_engine.py` (new)

**Step 1 — write failing test.** Create `/Users/iman/Projects/background_ar/capture/tests/test_pose_engine.py`:
```python
import dataclasses

from capture.pose_engine import POSE_VIS_THRESH, PosePacket, healthy_fraction


def test_pose_packet_is_frozen_dataclass() -> None:
    pkt = PosePacket(world=[[0.0, 0.0, 0.0, 1.0]], norm=[[0.5, 0.5, 0.0, 1.0]], healthy=1.0)
    assert dataclasses.is_dataclass(pkt)
    params = getattr(PosePacket, "__dataclass_params__")
    assert params.frozen is True
    assert pkt.world == [[0.0, 0.0, 0.0, 1.0]]
    assert pkt.norm == [[0.5, 0.5, 0.0, 1.0]]
    assert pkt.healthy == 1.0


def test_pose_packet_fields_shape() -> None:
    names = {f.name for f in dataclasses.fields(PosePacket)}
    assert names == {"world", "norm", "healthy"}


def test_vis_threshold_default() -> None:
    assert POSE_VIS_THRESH == 0.5


def test_healthy_fraction_all_visible() -> None:
    vis = [1.0] * 33
    assert healthy_fraction(vis) == 1.0


def test_healthy_fraction_half_below_threshold() -> None:
    # 33 joints: 11 при 0.9 (видны), 22 при 0.3 (не видны) → 11/33
    vis = [0.9] * 11 + [0.3] * 22
    assert abs(healthy_fraction(vis) - (11 / 33)) < 1e-9


def test_healthy_fraction_boundary_is_inclusive() -> None:
    # visibility == порог считается видимым (>=)
    assert healthy_fraction([0.5, 0.5]) == 1.0
```

**Step 2 — run it, expect FAIL:**
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/test_pose_engine.py -v
```
Expected output (FAIL):
```
E   ModuleNotFoundError: No module named 'capture.pose_engine'
```

**Step 3 — minimal impl.** Create `/Users/iman/Projects/background_ar/capture/src/capture/pose_engine.py` (only the dataclass + helpers in this step — the mediapipe-backed `PoseEngine` lands in A.3):
```python
"""MediaPipe Pose-движок (v2-тень): 33 landmark'а на тот же frame.rgb, что и матте."""

from collections.abc import Sequence
from dataclasses import dataclass

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
```

**Step 4 — run test, expect PASS:**
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/test_pose_engine.py -v
```
Expected: 6 passed.

**Step 5 — commit:**
```
git add capture/src/capture/pose_engine.py capture/tests/test_pose_engine.py
git commit -m "feat(capture): PosePacket dataclass + healthy_fraction (POSE_VIS_THRESH=0.5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task A.3 — `PoseEngine.process()`: RGB-as-is + int monotonic-guard ts + packing

Контракт (verbatim):
- `PoseEngine.process(rgb: np.ndarray, t_ms: float) -> PosePacket | None`
- `PoseLandmarker`, `RunningMode.VIDEO`, `detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ts)`
- `ts = max(int(t_ms), self._last_ts + 1); self._last_ts = ts`
- `BaseOptions` delegate CPU; `model_asset_path = pose_model_path or f"{models_dir}/pose_landmarker_full.task"`
- `num_poses=1`, `output_segmentation_masks=False`
- rgb уже RGB — без `cvtColor`
- `healthy` = fraction of 33 landmarks with visibility >= POSE_VIS_THRESH (0.5)
- `pose_world_landmarks[0] -> world`; `pose_landmarks[0] -> norm`; `lm.x/.y/.z/.visibility`

Тесты не вызывают реальный mediapipe (детерминизм, нет модели в CI): подменяем внутренний детектор фейком, проверяем (a) что в `mp.Image` уходит исходный `rgb` без свопа каналов, (b) ts-guard, (c) packing/healthy. Для проверки `mp.Image`-входа monkeypatch'им `mp.Image`, для детектора — инжектим фейковый объект через приватный атрибут после конструирования с пропуском реальной инициализации.

Чтобы сделать класс тестируемым без модели, конструктор принимает `model_path: str`; реальную `PoseLandmarker.create_from_options` он вызывает в `__init__`, но тесты обходят `__init__` через `object.__new__` и вручную выставляют поля. Это тот же паттерн изоляции, что и в `test_matting_contract.py` (монкипатч движка).

**Files:**
- Modify: `/Users/iman/Projects/background_ar/capture/src/capture/pose_engine.py`
- Test: `/Users/iman/Projects/background_ar/capture/tests/test_pose_engine.py` (append)

**Step 1 — write failing test.** Append to `/Users/iman/Projects/background_ar/capture/tests/test_pose_engine.py`:
```python
import numpy as np

import capture.pose_engine as pe_mod
from capture.pose_engine import PoseEngine


class _FakeLandmark:
    def __init__(self, x: float, y: float, z: float, v: float) -> None:
        self.x, self.y, self.z, self.visibility = x, y, z, v


class _FakeResult:
    """Имитирует PoseLandmarkerResult: один человек, 33 joint'а."""

    def __init__(self, world_v: list[float], norm_v: list[float]) -> None:
        self.pose_world_landmarks = [
            [_FakeLandmark(0.1, 0.2, 0.3, v) for v in world_v]
        ]
        self.pose_landmarks = [
            [_FakeLandmark(0.5, 0.6, 0.0, v) for v in norm_v]
        ]


class _FakeDetector:
    """Записывает все вызовы detect_for_video и возвращает фиксированный результат."""

    def __init__(self, result: _FakeResult) -> None:
        self._result = result
        self.calls: list[tuple[object, int]] = []

    def detect_for_video(self, image: object, ts: int) -> _FakeResult:
        self.calls.append((image, ts))
        return self._result


def _make_engine(result: _FakeResult) -> tuple[PoseEngine, _FakeDetector]:
    """Строим PoseEngine в обход реального create_from_options (нет модели в CI)."""
    eng = object.__new__(PoseEngine)
    detector = _FakeDetector(result)
    eng._detector = detector       # type: ignore[attr-defined]
    eng._last_ts = -1              # type: ignore[attr-defined]
    return eng, detector


def test_process_feeds_rgb_without_cvtcolor(monkeypatch) -> None:
    # mp.Image должен получить ровно тот rgb-буфер, что подали (RGB-as-is, без свопа)
    captured: dict[str, object] = {}

    class _FakeImage:
        def __init__(self, image_format: object, data: np.ndarray) -> None:
            captured["format"] = image_format
            captured["data"] = data

    monkeypatch.setattr(pe_mod.mp, "Image", _FakeImage)
    rgb = np.zeros((48, 64, 3), dtype=np.uint8)
    rgb[:, :, 0] = 200  # красный канал заметно выделен — детектор «утечки» свопа
    eng, _ = _make_engine(_FakeResult([1.0] * 33, [1.0] * 33))
    eng.process(rgb, 0.0)
    assert captured["format"] is pe_mod.mp.ImageFormat.SRGB
    # тот же объект — никакой cvtColor/копии-перестановки каналов
    assert captured["data"] is rgb


def test_process_timestamp_monotonic_guard(monkeypatch) -> None:
    monkeypatch.setattr(pe_mod.mp, "Image", lambda image_format, data: object())
    rgb = np.zeros((8, 8, 3), dtype=np.uint8)
    eng, detector = _make_engine(_FakeResult([1.0] * 33, [1.0] * 33))
    # float t_ms → int; равные/убывающие отметки → строго растущие int
    eng.process(rgb, 10.7)   # int(10.7)=10, last=-1 → 10
    eng.process(rgb, 10.7)   # повтор → max(10, 10+1) = 11
    eng.process(rgb, 5.0)    # убыло → max(5, 11+1) = 12
    eng.process(rgb, 100.0)  # скачок вперёд → max(100, 12+1) = 100
    sent = [ts for _, ts in detector.calls]
    assert sent == [10, 11, 12, 100]
    assert all(isinstance(ts, int) for ts in sent)


def test_process_packs_world_norm_and_healthy() -> None:
    rgb = np.zeros((8, 8, 3), dtype=np.uint8)
    # 22 из 33 world-joint видны (vis 0.8), 11 — нет (vis 0.1) → healthy = 22/33
    world_v = [0.8] * 22 + [0.1] * 11
    eng, _ = _make_engine(_FakeResult(world_v, [1.0] * 33))
    # mp.Image внутри process сконструируется реальным mediapipe? нет — подменим:
    import types
    eng._mk_image = lambda rgb: object()  # type: ignore[attr-defined]
    pkt = eng.process(rgb, 0.0)
    assert pkt is not None
    assert len(pkt.world) == 33 and len(pkt.norm) == 33
    assert pkt.world[0] == [0.1, 0.2, 0.3, 0.8]    # x,y,z,visibility из world-landmark
    assert pkt.norm[0] == [0.5, 0.6, 0.0, 1.0]
    assert abs(pkt.healthy - (22 / 33)) < 1e-9


def test_process_returns_none_when_no_pose(monkeypatch) -> None:
    monkeypatch.setattr(pe_mod.mp, "Image", lambda image_format, data: object())
    rgb = np.zeros((8, 8, 3), dtype=np.uint8)

    class _Empty:
        pose_world_landmarks: list = []
        pose_landmarks: list = []

    eng, detector = _make_engine(_FakeResult([1.0] * 33, [1.0] * 33))
    detector._result = _Empty()  # type: ignore[assignment]
    assert eng.process(rgb, 0.0) is None
```

(Примечание: тест `test_process_packs_world_norm_and_healthy` использует hook `eng._mk_image` — реализация в Step 3 строит `mp.Image` через метод `self._mk_image(rgb)`, что позволяет тесту его подменить без monkeypatch модуля.)

**Step 2 — run it, expect FAIL:**
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/test_pose_engine.py -v
```
Expected output (FAIL):
```
E   ImportError: cannot import name 'PoseEngine' from 'capture.pose_engine'
```

**Step 3 — minimal impl.** Edit `/Users/iman/Projects/background_ar/capture/src/capture/pose_engine.py`. Replace the top-of-file docstring/imports block and append the `PoseEngine` class. Final file:
```python
"""MediaPipe Pose-движок (v2-тень): 33 landmark'а на тот же frame.rgb, что и матте."""

from collections.abc import Sequence
from dataclasses import dataclass

import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import (
    PoseLandmarker,
    PoseLandmarkerOptions,
    RunningMode,
)

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
```

**Step 4 — run test, expect PASS:**
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/test_pose_engine.py -v
```
Expected: 10 passed (4 from A.2 still green + 6 new packing/ts/rgb cases; note A.2 had 6 cases, A.3 adds 4 — total 10).

**Step 5 — commit:**
```
git add capture/src/capture/pose_engine.py capture/tests/test_pose_engine.py
git commit -m "feat(capture): PoseEngine.process RGB-as-is + int monotonic-guard ts + packing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task A.4 — `make_pose_engine(cfg)` factory (None when `pose_enabled=False`)

Контракт: `make_pose_engine(cfg: CaptureConfig) -> PoseEngine | None` (None when `cfg.pose_enabled is False`); `model_asset_path = pose_model_path or f"{models_dir}/pose_landmarker_full.task"`. Зеркалим паттерн `make_engine` (`matting/__init__.py:20-31`): импорт модуля (не имени), чтобы тесты могли monkeypatch'ить `PoseEngine`.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/capture/src/capture/pose_engine.py` (add factory)
- Test: `/Users/iman/Projects/background_ar/capture/tests/test_pose_engine.py` (append)

**Step 1 — write failing test.** Append to `/Users/iman/Projects/background_ar/capture/tests/test_pose_engine.py`:
```python
from capture.config import CaptureConfig


def test_make_pose_engine_disabled_returns_none() -> None:
    from capture.pose_engine import make_pose_engine

    cfg = CaptureConfig(pose_enabled=False)
    assert make_pose_engine(cfg) is None


def test_make_pose_engine_default_path(monkeypatch) -> None:
    import capture.pose_engine as pe

    captured: dict[str, str] = {}

    def _fake_ctor(model_path: str) -> object:
        captured["path"] = model_path
        return object()

    monkeypatch.setattr(pe, "PoseEngine", _fake_ctor)
    cfg = CaptureConfig(models_dir="models", pose_enabled=True, pose_model_path="")
    eng = pe.make_pose_engine(cfg)
    assert eng is not None
    assert captured["path"] == "models/pose_landmarker_full.task"


def test_make_pose_engine_override_path(monkeypatch) -> None:
    import capture.pose_engine as pe

    captured: dict[str, str] = {}
    monkeypatch.setattr(
        pe, "PoseEngine", lambda model_path: captured.__setitem__("path", model_path)
    )
    cfg = CaptureConfig(models_dir="models", pose_model_path="/custom/p.task")
    pe.make_pose_engine(cfg)
    assert captured["path"] == "/custom/p.task"
```

**Step 2 — run it, expect FAIL:**
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/test_pose_engine.py -k make_pose_engine -v
```
Expected output (FAIL):
```
E   ImportError: cannot import name 'make_pose_engine' from 'capture.pose_engine'
```

**Step 3 — minimal impl.** Append to `/Users/iman/Projects/background_ar/capture/src/capture/pose_engine.py`:
```python
def make_pose_engine(cfg: "CaptureConfig") -> "PoseEngine | None":
    if not cfg.pose_enabled:
        return None
    # импорт модуля, чтобы тесты подменяли PoseEngine через monkeypatch (как make_engine).
    import capture.pose_engine as pose_mod

    path = cfg.pose_model_path or f"{cfg.models_dir}/pose_landmarker_full.task"
    return pose_mod.PoseEngine(path)
```
And add at the top of the file, under the existing imports, a `TYPE_CHECKING` import for the annotation:
```python
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from capture.config import CaptureConfig
```

**Step 4 — run test, expect PASS:**
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/test_pose_engine.py -k make_pose_engine -v
```
Expected: 3 passed.

**Step 5 — commit:**
```
git add capture/src/capture/pose_engine.py capture/tests/test_pose_engine.py
git commit -m "feat(capture): make_pose_engine factory (None when pose_enabled=False)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task A.5 — `PipelineStats.landmarks` field + `Pipeline` wiring (`pose=None`, per-frame call under lock)

Контракt: `Pipeline.__init__(self, source, engine, presence_cfg, pose: "PoseEngine | None" = None)`; `PipelineStats gains field: landmarks: PosePacket | None = None`; pose-вызов в `_run()` сразу после матте, запись под `self._lock`; гейт `self._pose is not None`.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/capture/src/capture/pipeline.py:15-25` (PipelineStats), `:44-59` (`__init__`), `:76-81` (`stats()`), `:100-109` (`_run`)
- Test: `/Users/iman/Projects/background_ar/capture/tests/test_pipeline.py` (append)

**Step 1 — write failing test.** Append to `/Users/iman/Projects/background_ar/capture/tests/test_pipeline.py`:
```python
from capture.pose_engine import PosePacket


class FakePoseEngine:
    """Возвращает фиксированный PosePacket на каждый кадр; считает вызовы."""

    def __init__(self) -> None:
        self.calls = 0
        self.last_t_ms: float | None = None

    def process(self, rgb: np.ndarray, t_ms: float) -> PosePacket:
        self.calls += 1
        self.last_t_ms = t_ms
        return PosePacket(world=[[0.0, 0.0, 0.0, 1.0]] * 33,
                          norm=[[0.5, 0.5, 0.0, 1.0]] * 33, healthy=1.0)


def test_pipeline_landmarks_default_none() -> None:
    # без pose-движка PipelineStats.landmarks остаётся None
    p = Pipeline(StallingSource(frames=5), FakeEngine(), PresenceConfig())
    assert p.stats().landmarks is None


def test_pipeline_populates_landmarks_when_pose_present(tmp_path: Path) -> None:
    clip = tmp_path / "pose.mp4"
    make_clip(clip, frames=30, w=64, h=48)
    from capture.sources.file import FileSource

    pose = FakePoseEngine()
    p = Pipeline(FileSource(str(clip)), FakeEngine(), PresenceConfig(), pose=pose)
    p.start()
    try:
        deadline = time.monotonic() + 5.0
        while p.stats().landmarks is None and time.monotonic() < deadline:
            time.sleep(0.01)
        lm = p.stats().landmarks
        assert lm is not None
        assert lm.healthy == 1.0
        assert len(lm.world) == 33
        assert pose.calls > 0
    finally:
        p.stop()


def test_pipeline_skips_pose_when_none(tmp_path: Path) -> None:
    # pose=None (дефолт): hot-loop не обязан что-то звать, landmarks=None
    clip = tmp_path / "nopose.mp4"
    make_clip(clip, frames=20, w=64, h=48)
    from capture.sources.file import FileSource

    p = Pipeline(FileSource(str(clip)), FakeEngine(), PresenceConfig())
    p.start()
    try:
        deadline = time.monotonic() + 5.0
        while p.latest_sbs() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        assert p.stats().landmarks is None
    finally:
        p.stop()
```

**Step 2 — run it, expect FAIL:**
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/test_pipeline.py -k landmarks -v
```
Expected output (FAIL):
```
tests/test_pipeline.py::test_pipeline_landmarks_default_none FAILED
E   AttributeError: 'PipelineStats' object has no attribute 'landmarks'
```
(Также `Pipeline.__init__` ещё не принимает `pose=`.)

**Step 3 — minimal impl.** Four edits in `/Users/iman/Projects/background_ar/capture/src/capture/pipeline.py`:

3a. Import `PosePacket` (add after line 12, the presence import):
```python
from capture.pose_engine import PosePacket
```

3b. Add field to `PipelineStats` (after line 25, `last_error`):
```python
    errors: int = 0
    last_error: str | None = None
    landmarks: PosePacket | None = None
```

3c. `__init__` — add `pose` param and `_landmarks`/`_pose` fields. Replace lines 45-53:
```python
    def __init__(
        self,
        source: FrameSource,
        engine: MattingEngine,
        presence_cfg: PresenceConfig,
        pose: "PoseEngine | None" = None,
    ) -> None:
        self._source = source
        self._engine = engine
        self._pose = pose
        self._presence = PresenceTracker(presence_cfg)
        self._lock = threading.Lock()
        self._sbs: np.ndarray | None = None
        self._bbox: tuple[float, float, float, float] | None = None
        self._landmarks: PosePacket | None = None
```
(and add a `TYPE_CHECKING` import near the top for the annotation, to avoid importing the mediapipe-backed class at module load:)
```python
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from capture.pose_engine import PoseEngine
```

3d. `stats()` — include `landmarks`. Replace lines 78-81:
```python
            return PipelineStats(
                self._frames, self._fps, self._presence.state, self._bbox,
                self._errors, self._last_error, self._landmarks,
            )
```

3e. `_run()` — call pose right after matte, write under lock. Replace lines 100-109:
```python
                fg, alpha = self._engine.process(frame.rgb)
                coverage, bbox_h, bbox = _mask_stats(alpha)
                self._presence.update(coverage=coverage, bbox_height_ratio=bbox_h)
                pose_pkt = (
                    self._pose.process(frame.rgb, frame.t_ms)
                    if self._pose is not None
                    else None
                )
                sbs = pack_sbs(fg, alpha)
                now = time.monotonic()
                window_frames += 1
                with self._lock:
                    self._sbs = sbs
                    self._bbox = bbox
                    self._landmarks = pose_pkt
                    self._frames += 1
```

**Step 4 — run test, expect PASS:**
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/test_pipeline.py -v
```
Expected: all existing pipeline tests still PASSED + 3 new landmarks tests PASSED.

**Step 5 — commit:**
```
git add capture/src/capture/pipeline.py capture/tests/test_pipeline.py
git commit -m "feat(capture): wire PoseEngine into Pipeline (pose=None, landmarks under lock)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task A.6 — `_telemetry_json` adds `"pose"` key only when `landmarks is not None`

Контракт WIRE: add ONE key `"pose": { "world": [[x,y,z,v] x33], "norm": [[x,y,z,v] x33], "healthy": number }`, present ONLY when a pose was detected this frame; omitted otherwise. `_telemetry_json(stats)` adds `"pose"` only if `stats.landmarks is not None`. Coords округляем до 4 знаков (spec §3.3: ≈0.4–0.5 КБ/кадр).

**Files:**
- Modify: `/Users/iman/Projects/background_ar/capture/src/capture/server.py:23-35`
- Test: `/Users/iman/Projects/background_ar/capture/tests/test_server.py` (append)

**Step 1 — write failing test.** Append to `/Users/iman/Projects/background_ar/capture/tests/test_server.py`:
```python
from capture.pose_engine import PosePacket
from capture.server import _telemetry_json


def _stats_with(landmarks):
    return PipelineStats(
        frames=1, fps=30.0,
        presence=PresenceState(present=True, distance_cm=150.0, coverage=0.2),
        bbox=(0.1, 0.2, 0.6, 1.0), errors=0, last_error=None,
        landmarks=landmarks,
    )


def test_telemetry_omits_pose_when_absent() -> None:
    msg = json.loads(_telemetry_json(_stats_with(None)))
    assert "pose" not in msg
    assert msg["type"] == "presence"
    assert msg["bbox"] == [0.1, 0.2, 0.6, 1.0]


def test_telemetry_includes_pose_when_present() -> None:
    pkt = PosePacket(
        world=[[0.123456, 0.2, 0.3, 0.95]] * 33,
        norm=[[0.5, 0.6, 0.0, 0.95]] * 33,
        healthy=0.875,
    )
    msg = json.loads(_telemetry_json(_stats_with(pkt)))
    assert "pose" in msg
    assert len(msg["pose"]["world"]) == 33
    assert len(msg["pose"]["norm"]) == 33
    assert msg["pose"]["healthy"] == 0.875
    # округление до 4 знаков (бюджет ≈0.5 КБ/кадр, spec §3.3)
    assert msg["pose"]["world"][0][0] == 0.1235
    # презенс-пакет не сломан добавлением pose
    assert msg["present"] is True
    assert msg["bbox"] == [0.1, 0.2, 0.6, 1.0]
```

**Step 2 — run it, expect FAIL:**
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/test_server.py -k telemetry -v
```
Expected output (FAIL):
```
tests/test_server.py::test_telemetry_includes_pose_when_present FAILED
E   assert 'pose' in msg
```
(`_telemetry_json` пока не добавляет ключ `pose`.)

**Step 3 — minimal impl.** Replace `/Users/iman/Projects/background_ar/capture/src/capture/server.py` lines 23-35:
```python
def _telemetry_json(stats: PipelineStats) -> str:
    p = stats.presence
    payload = {
        "type": "presence",
        "present": p.present,
        "distanceCm": p.distance_cm,
        "coverage": round(p.coverage, 4),
        "bbox": stats.bbox,  # нормированный (x0,y0,x1,y1); низ = «ноги» для тени
        "errors": stats.errors,
        "fps": round(stats.fps, 1),
    }
    lm = stats.landmarks
    if lm is not None:
        payload["pose"] = {
            "world": [[round(c, 4) for c in row] for row in lm.world],
            "norm": [[round(c, 4) for c in row] for row in lm.norm],
            "healthy": lm.healthy,
        }
    return json.dumps(payload)
```

**Step 4 — run test, expect PASS:**
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/test_server.py -v
```
Expected: all existing server tests PASSED (including `test_ws_telemetry_stream`, which never sets `landmarks` → `pose` absent) + 2 new telemetry tests PASSED.

**Step 5 — commit:**
```
git add capture/src/capture/server.py capture/tests/test_server.py
git commit -m "feat(capture): _telemetry_json emits pose key only when landmarks present

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task A.7 — Download `pose_landmarker_full.task` into `models_dir` + wire `make_pose_engine` in `main()`

Контракт: get-models.sh asset + main wiring (`pose = make_pose_engine(cfg); Pipeline(source, engine, PresenceConfig(), pose=pose)`). The asset download has no unit test (it is a shell side-effect); we add a smoke test that `main.py` builds the pipeline with a pose engine, using monkeypatch so no real model/camera is touched.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/capture/scripts/get-models.sh:17-19`
- Modify: `/Users/iman/Projects/background_ar/capture/src/capture/main.py:8-12` (import), `:39-46` (wiring)
- Test: `/Users/iman/Projects/background_ar/capture/tests/test_main_pose_wiring.py` (new)

**Step 1 — write failing test.** Create `/Users/iman/Projects/background_ar/capture/tests/test_main_pose_wiring.py`:
```python
import capture.main as main_mod


def test_main_forwards_pose_to_pipeline(monkeypatch) -> None:
    """main() строит pose через make_pose_engine и инжектит его в Pipeline."""
    sentinel_pose = object()
    captured: dict[str, object] = {}

    monkeypatch.setattr(main_mod, "make_source", lambda cfg: object())
    monkeypatch.setattr(main_mod, "make_engine", lambda cfg: object())
    monkeypatch.setattr(main_mod, "make_pose_engine", lambda cfg: sentinel_pose)

    class _FakePipeline:
        def __init__(self, source, engine, presence_cfg, pose=None) -> None:
            captured["pose"] = pose

        def start(self) -> None: ...

    monkeypatch.setattr(main_mod, "Pipeline", _FakePipeline)
    # webrtc.configure_bitrate импортируется внутри main(); подменим, чтобы не тащить aiortc-стейт
    import capture.webrtc as webrtc
    monkeypatch.setattr(webrtc, "configure_bitrate", lambda mbps: None)
    monkeypatch.setattr(main_mod, "build_app", lambda pipeline: _StubApp())
    monkeypatch.setattr(main_mod.web, "run_app", lambda app, host, port: None)

    main_mod.main(["--source", "webcam"])
    assert captured["pose"] is sentinel_pose


class _StubApp:
    """Минимальная заглушка web.Application: только on_cleanup.append."""

    class _Sig:
        def append(self, _fn) -> None: ...

    on_cleanup = _Sig()
```

**Step 2 — run it, expect FAIL:**
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/test_main_pose_wiring.py -v
```
Expected output (FAIL):
```
tests/test_main_pose_wiring.py::test_main_forwards_pose_to_pipeline FAILED
E   AttributeError: <module 'capture.main'> does not have the attribute 'make_pose_engine'
```
(`main` ещё не импортирует `make_pose_engine`, и `Pipeline(...)` зовётся без `pose=`.)

**Step 3 — minimal impl.** Two edits in `/Users/iman/Projects/background_ar/capture/src/capture/main.py`:

3a. Add import (after line 9, the `Pipeline` import):
```python
from capture.pose_engine import make_pose_engine
```

3b. Replace lines 39-46 (build engine → start pipeline):
```python
    engine = make_engine(cfg)
    pose = make_pose_engine(cfg)  # None, если cfg.pose_enabled = False (spec §3.1)

    from capture.webrtc import configure_bitrate

    configure_bitrate(cfg.bitrate_mbps)  # до первого offer: энкодер читает глобалы

    pipeline = Pipeline(source, engine, PresenceConfig(), pose=pose)
    pipeline.start()
```

3c. Edit `/Users/iman/Projects/background_ar/capture/scripts/get-models.sh`, insert before the final `ls -la models/` (after line 17):
```bash
# MediaPipe Pose Landmarker (v2-тень), full-вариант ~6 МБ
[ -f models/pose_landmarker_full.task ] || curl -L -o models/pose_landmarker_full.task \
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task"
```

**Step 4 — run test, expect PASS:**
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/test_main_pose_wiring.py -v
```
Expected: 1 passed.

Then download the asset for the integration/bench steps:
```
/Users/iman/Projects/background_ar/capture/scripts/get-models.sh
```
Expected: `models/` listing now includes `pose_landmarker_full.task` (~6 MB).

**Step 5 — commit:**
```
git add capture/src/capture/main.py capture/scripts/get-models.sh capture/tests/test_main_pose_wiring.py
git commit -m "feat(capture): wire make_pose_engine in main + download pose_landmarker_full.task

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task A.8 — Full suite + typecheck green (regression gate)

Verify nothing regressed across the whole capture suite and that mypy strict stays clean (`pyproject.toml:36-39`, `strict=true`).

**Files:** none (verification only).

**Step 1 — run full suite:**
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/ -v
```
Expected: all prior tests PASSED plus the new ones from A.1–A.7 (config: +2, pose_engine: 13, pipeline: +3, server: +2, main wiring: +1). No FAILED, no ERROR.

**Step 2 — run typecheck:**
```
cd /Users/iman/Projects/background_ar/capture && uv run mypy src/capture
```
Expected: `Success: no issues found in N source files` (mediapipe imports ignored via `ignore_missing_imports = true`).

**Step 3 — lint:**
```
cd /Users/iman/Projects/background_ar/capture && uv run ruff check src/capture tests
```
Expected: `All checks passed!`

**Step 4 — commit (only if lint/type fixups were needed; otherwise skip):**
```
git add -A
git commit -m "chore(capture): lint/type fixups for pose pipeline

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task A.9 — Serial RVM+Pose bench against 15 Hz tick (spec §3.5 / Фаза A exit)

Spec §3.5/§8: RVM and Pose are both CPU-bound and run **serially in the same `_run()` thread**, so the budget is additive (`RVM ms + Pose ms`). The bench must measure the **serial sum** against the 15 Hz tick (≈66.7 ms) and confirm `pipeline.fps` does not drop below the floor. This is a measurement script, not a unit test (it needs the real models + a real frame), so it lives as a standalone bench under `tests/` but is excluded from the default run via a marker.

**Files:**
- Create: `/Users/iman/Projects/background_ar/capture/tests/bench_rvm_pose_serial.py`

**Step 1 — write the bench script.** Create `/Users/iman/Projects/background_ar/capture/tests/bench_rvm_pose_serial.py`:
```python
"""Серийный бенч RVM + Pose в одном потоке против тика 15 Гц (spec §3.5, Фаза A exit).

Не unit-тест: требует реальные модели (scripts/get-models.sh) и измеряет аддитивный
CPU-бюджет RVM + Pose. Запуск вручную:
    cd capture && uv run python tests/bench_rvm_pose_serial.py
"""

import statistics
import time

import numpy as np

from capture.config import CaptureConfig
from capture.matting import make_engine
from capture.pose_engine import make_pose_engine

TICK_MS = 1000.0 / 15.0  # 15 Гц ≈ 66.7 мс
WARMUP = 5
ITERS = 60


def main() -> None:
    # ResNet50 + ratio 0.4 — прод-сетап качества (MEMORY: качество > fps)
    cfg = CaptureConfig(
        engine="rvm", model="resnet50", ratio=0.4,
        width=1280, height=720, pose_enabled=True,
    )
    rvm = make_engine(cfg)
    pose = make_pose_engine(cfg)
    assert pose is not None, "pose_enabled=True должно дать движок"

    rgb = (np.random.default_rng(0).integers(0, 256, (720, 1280, 3))).astype(np.uint8)

    # прогрев (первый вызов синхронно блокирует на инициализации графа)
    for _ in range(WARMUP):
        rvm.process(rgb)
        pose.process(rgb, time.monotonic() * 1000.0)

    rvm_ms: list[float] = []
    pose_ms: list[float] = []
    serial_ms: list[float] = []
    for _ in range(ITERS):
        t0 = time.perf_counter()
        rvm.process(rgb)
        t1 = time.perf_counter()
        pose.process(rgb, time.monotonic() * 1000.0)
        t2 = time.perf_counter()
        rvm_ms.append((t1 - t0) * 1000.0)
        pose_ms.append((t2 - t1) * 1000.0)
        serial_ms.append((t2 - t0) * 1000.0)

    def report(name: str, xs: list[float]) -> None:
        xs_sorted = sorted(xs)
        p95 = xs_sorted[int(0.95 * (len(xs_sorted) - 1))]
        print(f"  {name:12s} median={statistics.median(xs):6.1f}мс  p95={p95:6.1f}мс")

    print(f"тик 15 Гц = {TICK_MS:.1f}мс; модель=resnet50 ratio=0.4 720p; n={ITERS}")
    report("RVM", rvm_ms)
    report("Pose", pose_ms)
    report("RVM+Pose", serial_ms)

    serial_median = statistics.median(serial_ms)
    fps_est = 1000.0 / serial_median
    print(f"оценка fps по серийной сумме: {fps_est:.1f}")
    if serial_median > TICK_MS:
        print(
            f"ВНИМАНИЕ: серийная сумма {serial_median:.1f}мс пробивает тик {TICK_MS:.1f}мс "
            f"→ митигация (spec §3.5): full→lite / Pose через кадр / отдельный поток."
        )
    else:
        print("OK: серийная сумма укладывается в тик 15 Гц.")


if __name__ == "__main__":
    main()
```

**Step 2 — run the bench** (requires models from A.7):
```
cd /Users/iman/Projects/background_ar/capture && uv run python tests/bench_rvm_pose_serial.py
```
Expected output shape (numbers are the live measurement on the M4 target, recorded into the plan after the run; if `RVM+Pose median > 66.7 ms` the script prints the mitigation note and the team applies full→lite / pose-every-other-frame per spec §3.5):
```
тик 15 Гц = 66.7мс; модель=resnet50 ratio=0.4 720p; n=60
  RVM          median=  XX.Xмс  p95=  XX.Xмс
  Pose         median=  XX.Xмс  p95=  XX.Xмс
  RVM+Pose     median=  XX.Xмс  p95=  XX.Xмс
оценка fps по серийной сумме: XX.X
OK: серийная сумма укладывается в тик 15 Гц.
```

**Step 3 — confirm default suite ignores the bench.** The file name starts with `bench_`, not `test_`, so pytest's default collection (`testpaths=["tests"]` matches `test_*.py`) does NOT pick it up:
```
cd /Users/iman/Projects/background_ar/capture && uv run pytest tests/ -v
```
Expected: bench file not collected; all `test_*` cases PASSED.

**Step 4 — commit:**
```
git add capture/tests/bench_rvm_pose_serial.py
git commit -m "test(capture): serial RVM+Pose bench against 15Hz tick (spec §3.5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Exit criterion (spec §10, Фаза A)

Phase A is complete and verifiable when ALL of the following hold:

1. **Valid `pose` arrives on `/ws`.** With `pose_enabled=True` and a detected person, a `/ws` snapshot contains `"pose": { "world":[…33×4…], "norm":[…33×4…], "healthy":number }` inside the `type:"presence"` packet. Verified by `test_server.py::test_telemetry_includes_pose_when_present` (unit) and a manual `/ws` connect with the real pipeline running.
2. **`pose_enabled=False` omits it.** No `"pose"` key when pose is disabled or no pose detected this frame. Verified by `test_telemetry_omits_pose_when_absent` + `test_pose_engine.py::test_make_pose_engine_disabled_returns_none` + `test_ws_telemetry_stream` (still has no `pose`).
3. **fps not dropped below floor.** Serial RVM+Pose bench (Task A.9) reports `RVM+Pose` median against the 66.7 ms tick; if it overruns, the spec §3.5 mitigation (full→lite / pose-every-other-frame / separate thread) is applied and re-measured until the tick holds.
4. **Suite + typecheck + lint green** (Task A.8): full `pytest tests/ -v` passes (≥ prior count + new pose/config/pipeline/server/main cases), `mypy src/capture` clean, `ruff check` clean.

No renderer code is touched in Phase A (PHASE BOUNDARIES: A = capture only). The renderer-side `Telemetry.pose` parse, `shadowMap.enabled`, `ShadowScene3D`, `ProxyRig`, and `multiplyBlitMat` are all out of scope here and land in B1/B2/C/D1/D2.

### ✅ Phase A DONE — measured result + A.9b decision (2026-06-14)

Commits: `5ebc76d` A.1 · `3a66f41` A.2 · `1c091ba` A.3 · `cd5a9ab` A.4 · `0a3debd` A.5 · `200c611` A.6 · `9371d72` A.7 · `f000bbb` A.8 mypy fixup · `c73b105` A.9 bench. **76 pytest pass, mypy strict 0 issues (17 files), ruff clean.** Each task passed implementer → spec-review → code-review (subagent-driven).

**A.9 bench (real, this M-series mac, CPU, resnet50 ratio 0.4 @720p, n=60):**
```
RVM      median=252.8ms  p95=278.3ms
Pose     median=  8.3ms  p95= 10.3ms
RVM+Pose median=261.6ms  p95=286.4ms   → ~3.8 fps (tick 66.7ms overrun ×3.9)
```
**A.9b mitigation INTENTIONALLY NOT IMPLEMENTED (data-driven, independently reviewed).** Pose adds only ~8.3 ms = ~3% of the serial budget; the overrun is caused entirely by RVM resnet50 on CPU (252.8 ms) — a pre-existing, deliberately-accepted "качество > fps, GPU докупим" decision. Pose-every-other-frame / lite-pose would save ~4 ms of 261 ms = pointless. The throughput lever is GPU-offloading RVM (kiosk), not throttling pose. `pose_every_n` remains a documented future knob if RVM ever gets fast enough that the 8 ms matters. Phase-A exit criterion #3 is satisfied by this measurement+decision (pose meets its budget; throughput is RVM-bound and out of scope for the pose feature).

---

## Phase B1 — Renderer: alignment-скелет (box-receiver + baked camera + static proxy)

> **Цель фазы (spec §10, exit B1):** доказать 3D-пайплайн тени дёшево, ДО вложения в сложность EXR-mesh (B2). Глобально включить `shadowMap.enabled`, построить `ShadowScene3D` с запечённой камерой из `lights.json.camera`, box-receiver (плоскость пола + box-прокси), Key-лампой с `castShadow`, **статическим** тест-прокси в известной мировой точке, и multiply-blit с cover-fit. Прокси НЕ управляется позой (это Фаза C). Live-exit: тень статического прокси пиксельно совпадает с плейтом на **НЕ-совпадающем** canvas-аспекте.
>
> **Тестовый раннер (из CURRENT CODE):** `npm test` (= `vitest run`); тесты в `src/**/*.test.ts`; `THREE` импортируется как namespace (`import * as THREE from 'three'`). Сейчас 92 теста зелёные — держим пол ≥92 + typecheck.
>
> **Каноны фазы (из CONTRACTS):** `ShadowCamera` уже в `shadowGeom.ts:7-12`. `sampleWorldXYZ` (перенос из `main.ts:31` в `shadowGeom.ts`) — пререквизит для B2/C, делаем здесь, т.к. `shadowScene3D.ts` и тесты живут в `src/lux/`. WebGL-рендер на GPU юнит-тестами НЕ проверяем — только чистую геометрию/математику/трансформы/uniform-проводку; пиксельное совпадение — live-приёмка в конце фазы.

---

### Task B1.1 — Перенести `sampleWorldXYZ` из `main.ts` в `shadowGeom.ts` (пререквизит)

Контракт: `sampleWorldXYZ(worldPosData: {data: Float32Array; width: number; height: number}, u: number, v: number): [number,number,number]` — `px=round(u*(w-1))`, `py=round(v*(h-1))`, `flipY=false`. MOVED в `shadowGeom.ts`; `main.ts` импортирует.

**Files:**
- Create test: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts` (новый файл; если уже существует — добавить describe-блок)
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts` (добавить экспорт `sampleWorldXYZ` в конец, после `personFloorWorld` `:43`)
- Modify: `/Users/iman/Projects/background_ar/src/main.ts` (удалить локальную функцию `:31-39`, добавить импорт)

**Step 1 — написать падающий тест.** Создать `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sampleWorldXYZ } from './shadowGeom'

describe('sampleWorldXYZ', () => {
  // 2×2 RGBA Float32: [px=col, py=row] кодируем как [col, row, 7] в каналах RGB.
  // i = (py*w + px)*4
  const data = new Float32Array([
    0, 0, 7, 1,   1, 0, 7, 1,   // row 0: (0,0) (1,0)
    0, 1, 7, 1,   1, 1, 7, 1,   // row 1: (0,1) (1,1)
  ])
  const wp = { data, width: 2, height: 2 }

  it('сэмплит верхний-левый при u=0,v=0 (flipY=false → py=0)', () => {
    expect(sampleWorldXYZ(wp, 0, 0)).toEqual([0, 0, 7])
  })

  it('сэмплит нижний-правый при u=1,v=1', () => {
    expect(sampleWorldXYZ(wp, 1, 1)).toEqual([1, 1, 7])
  })

  it('округляет: u=0.6,v=0.4 → px=round(0.6)=1, py=round(0.4)=0', () => {
    expect(sampleWorldXYZ(wp, 0.6, 0.4)).toEqual([1, 0, 7])
  })

  it('клампит u/v за пределами [0,1] в крайние тексели', () => {
    expect(sampleWorldXYZ(wp, -5, 5)).toEqual([0, 1, 7])
  })
})
```

**Step 2 — запустить, увидеть FAIL.** Команда:
```
npm test -- src/lux/shadowGeom.test.ts
```
Ожидаемый вывод (FAIL — функция ещё не экспортирована из `shadowGeom.ts`):
```
FAIL  src/lux/shadowGeom.test.ts
  × sampleWorldXYZ > сэмплит верхний-левый при u=0,v=0 (flipY=false → py=0)
    SyntaxError: The requested module './shadowGeom' does not provide an export named 'sampleWorldXYZ'
Test Files  1 failed (1)
```

**Step 3 — минимальная реализация.** В `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts` после `personFloorWorld` (после строки `:43`) добавить:

```ts
// Перенесено из main.ts: сэмпл мировой позиции из worldPos-EXR (CPU).
// Как шейдер: texture(tWorld, (u,v)) с flipY=false → row = v*(h-1).
export function sampleWorldXYZ(
  wp: { data: Float32Array; width: number; height: number }, u: number, v: number,
): Vec3 {
  const px = Math.min(wp.width - 1, Math.max(0, Math.round(u * (wp.width - 1))))
  const py = Math.min(wp.height - 1, Math.max(0, Math.round(v * (wp.height - 1))))
  const i = (py * wp.width + px) * 4
  return [wp.data[i], wp.data[i + 1], wp.data[i + 2]]
}
```

**Step 4 — обновить `main.ts`.** Удалить локальную функцию (`main.ts:31-39`, весь блок `function sampleWorldXYZ(...) { ... }`) и добавить её в существующий импорт из `shadowGeom`. Найти строку импорта `personFloorWorld` (там же, где `import { ... } from './lux/shadowGeom'`) и добавить `sampleWorldXYZ`:

```ts
import { personFloorWorld, sampleWorldXYZ } from './lux/shadowGeom'
```
(Если импорта из `./lux/shadowGeom` ещё нет — добавить новую строку импорта. `main.ts:202` `const F = sampleWorldXYZ(sd.worldPosData, ...)` теперь резолвится на импортированную функцию.)

**Step 5 — запустить весь набор, PASS.** Команда:
```
npm test
```
Ожидаемый вывод (PASS, число тестов выросло на 4):
```
Test Files  18 passed (18)
     Tests  96 passed (96)
```
Плюс typecheck зелёный (vitest использует тот же tsconfig; `main.ts` ссылка на удалённую функцию должна резолвиться на импорт).

**Step 6 — коммит.**
```
git add src/lux/shadowGeom.ts src/lux/shadowGeom.test.ts src/main.ts
git commit -m "$(cat <<'EOF'
refactor(shadow) B1: вынести sampleWorldXYZ из main.ts в shadowGeom.ts

Пререквизит B2/C: shadowScene3D и юнит-тесты живут в src/lux/.
Контракт sampleWorldXYZ без изменений (round, flipY=false).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B1.2 — `boxReceiver(floorZ, boxes)` — невидимый приёмник тени

Контракт: `boxReceiver(floorZ: number, boxes: {min:[number,number,number]; max:[number,number,number]}[]): THREE.Mesh[]` — floor plane + boxes, материал `THREE.ShadowMaterial`, `receiveShadow=true`. (spec §4.1 B1)

**Files:**
- Create: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` (новый модуль)
- Create test: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.test.ts`

**Step 1 — написать падающий тест.** Создать `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { boxReceiver } from './shadowScene3D'

describe('boxReceiver', () => {
  it('возвращает пол + по мешу на каждый box', () => {
    const meshes = boxReceiver(0, [
      { min: [-1, -1, 0], max: [1, 1, 0.5] },
      { min: [2, 0, 0], max: [3, 1, 2] },
    ])
    // 1 пол + 2 box
    expect(meshes.length).toBe(3)
    meshes.forEach((m) => expect(m).toBeInstanceOf(THREE.Mesh))
  })

  it('все меши receiveShadow=true и НЕ castShadow (приёмник, не кастер)', () => {
    const meshes = boxReceiver(0, [{ min: [-1, -1, 0], max: [1, 1, 1] }])
    meshes.forEach((m) => {
      expect(m.receiveShadow).toBe(true)
      expect(m.castShadow).toBe(false)
    })
  })

  it('материал — ShadowMaterial (transparent), у всех мешей', () => {
    const meshes = boxReceiver(0, [{ min: [0, 0, 0], max: [1, 1, 1] }])
    meshes.forEach((m) => {
      expect(m.material).toBeInstanceOf(THREE.ShadowMaterial)
      expect((m.material as THREE.ShadowMaterial).transparent).toBe(true)
    })
  })

  it('пол лежит на floorZ (Z-up Blender-координаты): position.z == floorZ', () => {
    const [floor] = boxReceiver(2.5, [])
    expect(floor.position.z).toBeCloseTo(2.5, 6)
  })

  it('box центрирован в середине min/max и масштабирован по размеру', () => {
    const meshes = boxReceiver(0, [{ min: [2, 0, 0], max: [4, 2, 6] }])
    const box = meshes[1]
    // центр = (min+max)/2
    expect(box.position.x).toBeCloseTo(3, 6)
    expect(box.position.y).toBeCloseTo(1, 6)
    expect(box.position.z).toBeCloseTo(3, 6)
    // BoxGeometry(1,1,1) масштабируется до размера (max-min)
    expect(box.scale.x).toBeCloseTo(2, 6)
    expect(box.scale.y).toBeCloseTo(2, 6)
    expect(box.scale.z).toBeCloseTo(6, 6)
  })
})
```

**Step 2 — запустить, увидеть FAIL.** Команда:
```
npm test -- src/lux/shadowScene3D.test.ts
```
Ожидаемый вывод (FAIL — модуля ещё нет):
```
FAIL  src/lux/shadowScene3D.test.ts
  Error: Failed to load url ./shadowScene3D (resolved id: .../src/lux/shadowScene3D.ts). Does the file exist?
Test Files  1 failed (1)
```

**Step 3 — минимальная реализация.** Создать `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts`:

```ts
// 3D-сцена physical-тени (spec §4): невидимый прокси-кастер + box/EXR-приёмник,
// лампы PointLight (castShadow только Key), камера запечена из lights.json.
// Рендерится в shadowRT, multiply-blit на compositeRT (compositor.ts).
import * as THREE from 'three'

// Box задаётся axis-aligned min/max в Blender Z-up мировых координатах.
export interface ReceiverBox { min: [number, number, number]; max: [number, number, number] }

// B1-приёмник (alignment-этап + fallback-пол): плоскость пола + box-прокси мебели.
// Материал ShadowMaterial: всюду прозрачен, рисует только тень-терм; receiveShadow.
export function boxReceiver(floorZ: number, boxes: ReceiverBox[]): THREE.Mesh[] {
  const mkMat = () => new THREE.ShadowMaterial({ color: 0x000000, transparent: true, opacity: 1 })

  // Пол: большая плоскость в Z=floorZ (Blender Z-up — плоскость в XY, нормаль +Z).
  // PlaneGeometry лежит в XY с нормалью +Z по умолчанию — то, что нужно для Z-up.
  const floorGeom = new THREE.PlaneGeometry(100, 100)
  const floor = new THREE.Mesh(floorGeom, mkMat())
  floor.position.set(0, 0, floorZ)
  floor.receiveShadow = true
  floor.castShadow = false

  const meshes: THREE.Mesh[] = [floor]
  for (const b of boxes) {
    const sx = b.max[0] - b.min[0]
    const sy = b.max[1] - b.min[1]
    const sz = b.max[2] - b.min[2]
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mkMat())
    mesh.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2)
    mesh.scale.set(sx, sy, sz)
    mesh.receiveShadow = true
    mesh.castShadow = false
    meshes.push(mesh)
  }
  return meshes
}
```

**Step 4 — запустить, PASS.** Команда:
```
npm test -- src/lux/shadowScene3D.test.ts
```
Ожидаемый вывод:
```
✓ src/lux/shadowScene3D.test.ts (5)
Test Files  1 passed (1)
     Tests  5 passed (5)
```

**Step 5 — коммит.**
```
git add src/lux/shadowScene3D.ts src/lux/shadowScene3D.test.ts
git commit -m "$(cat <<'EOF'
feat(shadow) B1: boxReceiver — пол + box-прокси, ShadowMaterial receiveShadow

Alignment-этап + fallback-пол (spec §4.1). Box центрируется по min/max,
BoxGeometry(1,1,1) скейлится до размера. castShadow=false (приёмник).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B1.3 — `bakedShadowCamera(cam)` — `PerspectiveCamera` из `lights.json.camera` (Blender Z-up → three Y-up)

Контракт (из `ShadowScene3D`): baked `PerspectiveCamera` из `shadowData.camera`, `fov=radToDeg(fovY)`, `aspect`, `matrixAutoUpdate=false`, мировая матрица собрана из Blender Z-up→three Y-up. (spec §4.3) Выделяем в чистую тестируемую функцию `bakedShadowCamera`, чтобы проверить матрицу без рендера.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` (добавить `bakedShadowCamera`)
- Modify test: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.test.ts` (добавить describe)

**Step 1 — написать падающий тест.** Добавить в `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.test.ts`:

```ts
import { bakedShadowCamera } from './shadowScene3D'
import type { ShadowCamera } from './shadowGeom'

describe('bakedShadowCamera', () => {
  const cam: ShadowCamera = {
    pos: [0, -5, 1.6],       // Blender: камера сзади (−Y), на высоте Z=1.6
    target: [0, 0, 1.6],     // смотрит в начало по +Y
    fovY: Math.PI / 3,       // 60° в радианах
    aspect: 0.5625,          // 9:16 портрет
  }

  it('fov переведён в градусы из радиан fovY', () => {
    const c = bakedShadowCamera(cam)
    expect(c.fov).toBeCloseTo(60, 4)
  })

  it('aspect взят из camera.aspect', () => {
    expect(bakedShadowCamera(cam).aspect).toBeCloseTo(0.5625, 6)
  })

  it('matrixAutoUpdate выключен (матрица запечена, не пересчитывается из pos/rot)', () => {
    expect(bakedShadowCamera(cam).matrixAutoUpdate).toBe(false)
  })

  it('запечённая matrixWorld ставит камеру в three-Y-up позицию (Blender [x,y,z]→three [x,z,-y])', () => {
    const c = bakedShadowCamera(cam)
    const p = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld)
    // Blender pos [0,-5,1.6] → three [x=0, y=z=1.6, z=-y=5]
    expect(p.x).toBeCloseTo(0, 5)
    expect(p.y).toBeCloseTo(1.6, 5)
    expect(p.z).toBeCloseTo(5, 5)
  })

  it('камера смотрит на запечённый target (направление -Z камеры указывает на target в three-координатах)', () => {
    const c = bakedShadowCamera(cam)
    const eye = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld)
    // три-координаты target: Blender [0,0,1.6] → three [0,1.6,0]
    const tgt = new THREE.Vector3(0, 1.6, 0)
    const wantDir = tgt.clone().sub(eye).normalize()
    // forward камеры в three = -Z её мировой ориентации
    const fwd = new THREE.Vector3(0, 0, -1).applyMatrix4(
      new THREE.Matrix4().extractRotation(c.matrixWorld),
    ).normalize()
    expect(fwd.dot(wantDir)).toBeCloseTo(1, 4)
  })
})
```

**Step 2 — запустить, увидеть FAIL.** Команда:
```
npm test -- src/lux/shadowScene3D.test.ts
```
Ожидаемый вывод (FAIL — нет экспорта):
```
FAIL  src/lux/shadowScene3D.test.ts
  × bakedShadowCamera > fov переведён в градусы из радиан fovY
    SyntaxError: The requested module './shadowScene3D' does not provide an export named 'bakedShadowCamera'
```

**Step 3 — минимальная реализация.** В `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` добавить импорт типа сверху и функцию:

```ts
import type { ShadowCamera } from './shadowGeom'

// Blender Z-up (RH) → three Y-up (RH): [x,y,z] → [x, z, -y].
// Поворот на -90° вокруг X переводит базис; применяем к pos и target.
function blenderToThree(v: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(v[0], v[2], -v[1])
}

// Запечённая камера тени = ровно Blender-камера плейта (lights.json.camera).
// matrixAutoUpdate=false: собираем мировую матрицу вручную (lookAt в three-базисе),
// чтобы тень проецировалась в те же пиксели, что геометрия на плоском плейте.
export function bakedShadowCamera(cam: ShadowCamera): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(cam.fovY), cam.aspect, 0.05, 100)
  c.matrixAutoUpdate = false
  const eye = blenderToThree(cam.pos)
  const tgt = blenderToThree(cam.target)
  // up: Blender Z-up → three Y-up → world-up (0,1,0)
  const m = new THREE.Matrix4().lookAt(eye, tgt, new THREE.Vector3(0, 1, 0))
  m.setPosition(eye)
  c.matrix.copy(m)
  c.matrixWorld.copy(m)        // нет родителя → world = local
  c.matrixWorldNeedsUpdate = false
  c.updateProjectionMatrix()
  return c
}
```

**Step 4 — запустить, PASS.** Команда:
```
npm test -- src/lux/shadowScene3D.test.ts
```
Ожидаемый вывод:
```
✓ src/lux/shadowScene3D.test.ts (10)
Test Files  1 passed (1)
     Tests  10 passed (10)
```

**Step 5 — коммит.**
```
git add src/lux/shadowScene3D.ts src/lux/shadowScene3D.test.ts
git commit -m "$(cat <<'EOF'
feat(shadow) B1: bakedShadowCamera — Blender Z-up→three Y-up запечённая матрица

PerspectiveCamera из lights.json.camera: fov=radToDeg(fovY), aspect,
matrixAutoUpdate=false, lookAt в three-базисе ([x,y,z]→[x,z,-y]). spec §4.3.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B1.4 — Статический тест-прокси: `staticProxy(F, H)` (invisible caster в известной мировой точке)

B1 exit требует **статический** тест-прокси в известной мировой точке (НЕ pose-driven — это Фаза C). Контракт невидимого кастера (из `ProxyRig`): `castShadow=true`, `material.colorWrite=false`, `material.depthWrite=false`, `visible=true` (в r180 `visible=false` выкидывает из shadow-pass, spec §4.2/§9.4). Делаем простую капсулу-столбик в точке F высотой H.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` (добавить `staticProxy`)
- Modify test: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.test.ts`

**Step 1 — написать падающий тест.** Добавить в `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.test.ts`:

```ts
import { staticProxy } from './shadowScene3D'

describe('staticProxy (B1 invisible caster)', () => {
  it('кастер: castShadow=true, visible=true (visible=false выкинул бы из shadow-pass)', () => {
    const g = staticProxy([0, 0, 0], 1.7)
    let meshes = 0
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        meshes++
        expect((o as THREE.Mesh).castShadow).toBe(true)
        expect(o.visible).toBe(true)
      }
    })
    expect(meshes).toBeGreaterThan(0)
  })

  it('невидимый каст: материал colorWrite=false, depthWrite=false', () => {
    const g = staticProxy([0, 0, 0], 1.7)
    g.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined
      if (m) {
        expect(m.colorWrite).toBe(false)
        expect(m.depthWrite).toBe(false)
      }
    })
  })

  it('корень группы стоит в F (мировая точка ступней), в three-Y-up координатах', () => {
    const g = staticProxy([1, 2, 0.5], 1.7) // Blender F=[x=1,y=2,z=0.5]
    // three: [x=1, y=z=0.5, z=-y=-2]
    expect(g.position.x).toBeCloseTo(1, 6)
    expect(g.position.y).toBeCloseTo(0.5, 6)
    expect(g.position.z).toBeCloseTo(-2, 6)
  })

  it('высота прокси = H: верхняя точка столбика на y≈H над основанием', () => {
    const g = staticProxy([0, 0, 0], 1.8)
    g.updateMatrixWorld(true)
    const bbox = new THREE.Box3().setFromObject(g)
    // основание в F.y=0 (three), верх ≈ H
    expect(bbox.max.y).toBeGreaterThan(1.4)
    expect(bbox.max.y).toBeLessThanOrEqual(1.8 + 1e-3)
  })
})
```

**Step 2 — запустить, увидеть FAIL.** Команда:
```
npm test -- src/lux/shadowScene3D.test.ts
```
Ожидаемый вывод (FAIL — нет экспорта `staticProxy`):
```
FAIL  src/lux/shadowScene3D.test.ts
  × staticProxy (B1 invisible caster) > кастер: castShadow=true ...
    SyntaxError: The requested module './shadowScene3D' does not provide an export named 'staticProxy'
```

**Step 3 — минимальная реализация.** В `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` добавить:

```ts
// Статический тест-кастер B1: невидимый «столбик» (капсула) высотой H в точке F.
// Не pose-driven — нужен только для alignment-проверки (тень совпадает с плейтом).
// Невидимость каста: colorWrite=false, depthWrite=false, visible=true (r180:
// visible=false выкинул бы объект из shadow-pass — spec §4.2). castShadow=true.
export function staticProxy(F: [number, number, number], H: number): THREE.Group {
  const group = new THREE.Group()
  const mat = new THREE.MeshBasicMaterial()
  mat.colorWrite = false
  mat.depthWrite = false

  // капсула радиусом ~0.12 м, цилиндрическая часть = H - 2*radius
  const radius = 0.12
  const cylLen = Math.max(0.01, H - 2 * radius)
  const geom = new THREE.CapsuleGeometry(radius, cylLen, 4, 8)
  const capsule = new THREE.Mesh(geom, mat)
  capsule.castShadow = true
  capsule.receiveShadow = false
  capsule.visible = true
  // CapsuleGeometry центрирована в 0 по своей оси (Y three); поднимаем так,
  // чтобы низ был в основании группы (y=0), верх ≈ H.
  capsule.position.set(0, H / 2, 0)
  group.add(capsule)

  // корень группы — в F (Blender Z-up → three Y-up)
  group.position.copy(blenderToThree(F))
  return group
}
```

**Step 4 — запустить, PASS.** Команда:
```
npm test -- src/lux/shadowScene3D.test.ts
```
Ожидаемый вывод:
```
✓ src/lux/shadowScene3D.test.ts (14)
Test Files  1 passed (1)
     Tests  14 passed (14)
```

**Step 5 — коммит.**
```
git add src/lux/shadowScene3D.ts src/lux/shadowScene3D.test.ts
git commit -m "$(cat <<'EOF'
feat(shadow) B1: staticProxy — невидимый тест-кастер (capsule) в точке F

Не pose-driven (Фаза C). colorWrite/depthWrite=false, visible=true,
castShadow=true (spec §4.2). Корень в F (Blender→three Y-up), высота H.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B1.5 — `keyPointLights(lamps)` — `PointLight` из ламп, castShadow ТОЛЬКО на Key/highest-weight

Контракт (из `ShadowScene3D`): `PointLights` from lamps; `castShadow` ONLY on Key/highest-weight; `mapSize 2048`; `bias -0.0005`; `normalBias 0.03`. (spec §4.3) Выделяем чистую фабрику.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` (добавить `keyPointLights`)
- Modify test: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.test.ts`

**Step 1 — написать падающий тест.** Добавить в `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.test.ts`:

```ts
import { keyPointLights } from './shadowScene3D'

describe('keyPointLights', () => {
  const lamps = [
    { pos: [1, 1, 2] as [number, number, number], weight: 0.4 },
    { pos: [-1, 2, 2.5] as [number, number, number], weight: 1.0 }, // Key (max weight)
    { pos: [0, -1, 2] as [number, number, number], weight: 0.6 },
  ]

  it('одна PointLight на каждую лампу', () => {
    const lights = keyPointLights(lamps)
    expect(lights.length).toBe(3)
    lights.forEach((l) => expect(l).toBeInstanceOf(THREE.PointLight))
  })

  it('castShadow=true ТОЛЬКО у лампы с максимальным weight (Key)', () => {
    const lights = keyPointLights(lamps)
    expect(lights[0].castShadow).toBe(false)
    expect(lights[1].castShadow).toBe(true)  // weight=1.0
    expect(lights[2].castShadow).toBe(false)
  })

  it('Key shadow: mapSize 2048, bias -0.0005, normalBias 0.03', () => {
    const key = keyPointLights(lamps).find((l) => l.castShadow)!
    expect(key.shadow.mapSize.width).toBe(2048)
    expect(key.shadow.mapSize.height).toBe(2048)
    expect(key.shadow.bias).toBeCloseTo(-0.0005, 6)
    expect(key.shadow.normalBias).toBeCloseTo(0.03, 6)
  })

  it('позиция лампы — Blender Z-up→three Y-up; интенсивность ∝ weight', () => {
    const lights = keyPointLights(lamps)
    // lamps[1] Blender [-1,2,2.5] → three [-1, 2.5, -2]
    expect(lights[1].position.x).toBeCloseTo(-1, 6)
    expect(lights[1].position.y).toBeCloseTo(2.5, 6)
    expect(lights[1].position.z).toBeCloseTo(-2, 6)
    // интенсивность пропорциональна weight (key ярче fill)
    expect(lights[1].intensity).toBeGreaterThan(lights[0].intensity)
  })
})
```

**Step 2 — запустить, увидеть FAIL.** Команда:
```
npm test -- src/lux/shadowScene3D.test.ts
```
Ожидаемый вывод (FAIL):
```
FAIL  src/lux/shadowScene3D.test.ts
  × keyPointLights > одна PointLight на каждую лампу
    SyntaxError: The requested module './shadowScene3D' does not provide an export named 'keyPointLights'
```

**Step 3 — минимальная реализация.** В `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` добавить:

```ts
export interface Lamp { pos: [number, number, number]; weight: number }

// Лампы → PointLight. castShadow ТОЛЬКО у Key (max weight): PointLight cube-shadow
// дорог (6 граней) — fill-лампы вносят вклад только интенсивностью (spec §4.3).
export function keyPointLights(lamps: Lamp[]): THREE.PointLight[] {
  let keyIdx = 0
  for (let i = 1; i < lamps.length; i++) if (lamps[i].weight > lamps[keyIdx].weight) keyIdx = i

  return lamps.map((lamp, i) => {
    const light = new THREE.PointLight(0xffffff, lamp.weight)
    light.position.copy(blenderToThree(lamp.pos))
    light.decay = 0 // запечённые позиции — без физ-затухания (как v1: вес = вклад)
    if (i === keyIdx) {
      light.castShadow = true
      light.shadow.mapSize.set(2048, 2048)
      light.shadow.bias = -0.0005
      light.shadow.normalBias = 0.03
    }
    return light
  })
}
```

**Step 4 — запустить, PASS.** Команда:
```
npm test -- src/lux/shadowScene3D.test.ts
```
Ожидаемый вывод:
```
✓ src/lux/shadowScene3D.test.ts (18)
Test Files  1 passed (1)
     Tests  18 passed (18)
```

**Step 5 — коммит.**
```
git add src/lux/shadowScene3D.ts src/lux/shadowScene3D.test.ts
git commit -m "$(cat <<'EOF'
feat(shadow) B1: keyPointLights — PointLight из ламп, castShadow только Key

Max-weight лампа кастует (mapSize 2048, bias -0.0005, normalBias 0.03);
fill-лампы только интенсивностью (cube-shadow дорог, spec §4.3). Z-up→Y-up.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B1.6 — Класс `ShadowScene3D` (scene + baked camera + receiver + lights + static proxy + setReceiver)

Контракт: `class ShadowScene3D { constructor(shadowData: BuiltWorld['shadowData'], renderer); setReceiver(meshes: THREE.Object3D[]): void; update(pose, personFloor, shadowData): void; scene: THREE.Scene; camera: THREE.PerspectiveCamera }`. В B1 `update` — заглушка (прокси статический; pose-drive в Фазе C). `setReceiver` нужен для B2 swap box→mesh. Сборка: baked camera, key PointLight, box receiver, static proxy.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` (добавить класс `ShadowScene3D`)
- Modify test: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.test.ts`

**Step 1 — написать падающий тест.** Добавить в `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.test.ts`. Используем фейковый renderer (конструктор `ShadowScene3D` не должен дёргать GPU — только держать ссылку):

```ts
import { ShadowScene3D } from './shadowScene3D'

describe('ShadowScene3D (B1 сборка)', () => {
  const shadowData = {
    lamps: [
      { pos: [1, 1, 2] as [number, number, number], weight: 1.0 },
      { pos: [-1, 2, 2] as [number, number, number], weight: 0.5 },
    ],
    camera: {
      pos: [0, -5, 1.6] as [number, number, number],
      target: [0, 0, 1.6] as [number, number, number],
      fovY: Math.PI / 3,
      aspect: 0.5625,
    },
    floorZ: 0,
    boxes: [{ min: [-1, -1, 0] as [number, number, number], max: [1, 1, 2] as [number, number, number] }],
  }
  const fakeRenderer = {} as THREE.WebGLRenderer

  it('экспонирует scene (THREE.Scene) и camera (PerspectiveCamera)', () => {
    const s = new ShadowScene3D(shadowData, fakeRenderer)
    expect(s.scene).toBeInstanceOf(THREE.Scene)
    expect(s.camera).toBeInstanceOf(THREE.PerspectiveCamera)
    expect(s.camera.fov).toBeCloseTo(60, 4)
  })

  it('в сцене есть PointLight-и (по числу ламп) и ровно один castShadow', () => {
    const s = new ShadowScene3D(shadowData, fakeRenderer)
    const lights: THREE.PointLight[] = []
    s.scene.traverse((o) => { if ((o as THREE.PointLight).isPointLight) lights.push(o as THREE.PointLight) })
    expect(lights.length).toBe(2)
    expect(lights.filter((l) => l.castShadow).length).toBe(1)
  })

  it('в сцене есть приёмник (ShadowMaterial, receiveShadow) и кастер (castShadow)', () => {
    const s = new ShadowScene3D(shadowData, fakeRenderer)
    let receivers = 0
    let casters = 0
    s.scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      if (m.receiveShadow && m.material instanceof THREE.ShadowMaterial) receivers++
      if (m.castShadow) casters++
    })
    expect(receivers).toBeGreaterThanOrEqual(2) // пол + 1 box
    expect(casters).toBeGreaterThanOrEqual(1)    // static proxy capsule
  })

  it('setReceiver заменяет приёмник (B2 swap box→mesh): старые receivers убраны, новый добавлен', () => {
    const s = new ShadowScene3D(shadowData, fakeRenderer)
    const newReceiver = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial())
    newReceiver.receiveShadow = true
    ;(newReceiver as unknown as { __tag: string }).__tag = 'b2'
    s.setReceiver([newReceiver])
    let found = false
    s.scene.traverse((o) => { if ((o as unknown as { __tag?: string }).__tag === 'b2') found = true })
    expect(found).toBe(true)
  })

  it('update не бросает в B1 (прокси статический, pose-drive — Фаза C)', () => {
    const s = new ShadowScene3D(shadowData, fakeRenderer)
    expect(() => s.update(null, { F: new THREE.Vector3(0, 0, 0), H: 1.7 }, shadowData)).not.toThrow()
  })
})
```

**Step 2 — запустить, увидеть FAIL.** Команда:
```
npm test -- src/lux/shadowScene3D.test.ts
```
Ожидаемый вывод (FAIL):
```
FAIL  src/lux/shadowScene3D.test.ts
  × ShadowScene3D (B1 сборка) > экспонирует scene (THREE.Scene) и camera ...
    SyntaxError: The requested module './shadowScene3D' does not provide an export named 'ShadowScene3D'
```

**Step 3 — минимальная реализация.** В `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` добавить тип `ShadowData` и класс. (`BuiltWorld['shadowData']` несёт `lamps, camera, floorZ, worldPos, worldPosData`; для B1 box-координаты добавляем опциональным полем `boxes` — `worldScene.ts` будет их прокидывать в B2/D, а до тех пор дефолт-пусто.)

```ts
// Подмножество BuiltWorld['shadowData'], нужное ShadowScene3D в B1.
// boxes — опционально (B1 fallback-пол + box-прокси мебели B2-10).
export interface ShadowData {
  lamps: Lamp[]
  camera: ShadowCamera
  floorZ: number
  boxes?: ReceiverBox[]
}

export class ShadowScene3D {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  private receiverGroup = new THREE.Group()
  private proxy: THREE.Group

  constructor(shadowData: ShadowData, _renderer: THREE.WebGLRenderer) {
    this.scene = new THREE.Scene()
    this.camera = bakedShadowCamera(shadowData.camera)

    // лампы (PointLight, castShadow только Key)
    for (const light of keyPointLights(shadowData.lamps)) this.scene.add(light)

    // приёмник (B1 box; B2 заменит через setReceiver)
    this.scene.add(this.receiverGroup)
    this.setReceiver(boxReceiver(shadowData.floorZ, shadowData.boxes ?? []))

    // статический тест-прокси B1: столбик в известной мировой точке (центр пола, рост 1.7)
    this.proxy = staticProxy([0, 0, shadowData.floorZ], 1.7)
    this.scene.add(this.proxy)
  }

  // Замена приёмника (B2: box → EXR-mesh). Старые меши удаляются из группы.
  setReceiver(meshes: THREE.Object3D[]): void {
    this.receiverGroup.clear()
    for (const m of meshes) this.receiverGroup.add(m)
  }

  // B1: no-op (прокси статический). Фаза C перепишет: ProxyRig.update от pose.world.
  update(
    _pose: { world: number[][]; norm: number[][]; healthy: number } | null,
    _personFloor: { F: THREE.Vector3; H: number },
    _shadowData: ShadowData,
  ): void {
    // pose-drive — Фаза C
  }
}
```

**Step 4 — запустить, PASS.** Команда:
```
npm test -- src/lux/shadowScene3D.test.ts
```
Ожидаемый вывод:
```
✓ src/lux/shadowScene3D.test.ts (23)
Test Files  1 passed (1)
     Tests  23 passed (23)
```

**Step 5 — коммит.**
```
git add src/lux/shadowScene3D.ts src/lux/shadowScene3D.test.ts
git commit -m "$(cat <<'EOF'
feat(shadow) B1: ShadowScene3D — scene + baked camera + box-receiver + Key-lamp + static proxy

setReceiver для B2-swap; update() — no-op в B1 (pose-drive в Фазе C).
scene/camera публичны для compositor-рендера. spec §4 «ShadowScene3D».

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B1.7 — `renderer.shadowMap.enabled = true` глобальная инициализация (КРИТИЧНО)

Контракт: в `main.ts` `renderer.shadowMap.enabled = true`; `renderer.shadowMap.type = THREE.PCFSoftShadowMap`. (spec §4.0 — «самый вероятный тихий провал»: без этого `castShadow` молча игнорируется, тень не появляется вообще.) Текущий код `main.ts:59-64` создаёт рендерер БЕЗ этих строк.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/main.ts` (`:59-64`, рядом с `toneMapping`)

Эта правка — глобальная инициализация WebGL-рендерера, проверяется в live-приёмке (нельзя юнит-тестировать GPU shadow-pass без WebGL). Делаем как точечный диф без отдельного теста.

**Step 1 — внести правку.** В `/Users/iman/Projects/background_ar/src/main.ts` блок `:59-64`:

Before:
```ts
  const renderer = new THREE.WebGLRenderer({ antialias: false })
  renderer.setSize(innerWidth, innerHeight)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.autoClear = false
  document.body.appendChild(renderer.domElement)
```

After:
```ts
  const renderer = new THREE.WebGLRenderer({ antialias: false })
  renderer.setSize(innerWidth, innerHeight)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.autoClear = false
  // physical-тень прокси (spec §4.0): без shadowMap.enabled castShadow молча
  // игнорируется → тень не появляется. mapSize/bias на самой лампе (keyPointLights).
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  document.body.appendChild(renderer.domElement)
```

**Step 2 — typecheck/набор зелёные (правка не ломает существующие тесты).** Команда:
```
npm test
```
Ожидаемый вывод (число тестов = после B1.6, регрессий нет):
```
Test Files  18 passed (18)
     Tests  111 passed (111)
```
(точное число = 92 базовых + добавленные в B1.1–B1.6; важно — 0 failed, typecheck зелёный)

**Step 3 — коммит.**
```
git add src/main.ts
git commit -m "$(cat <<'EOF'
feat(shadow) B1: renderer.shadowMap.enabled + PCFSoftShadowMap (КРИТИЧНО)

Без глобального shadowMap.enabled castShadow молча игнорируется и тень
прокси не появляется вообще (spec §4.0 — тихий провал).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B1.8 — `multiplyBlitMat` + `shadowRT2` в compositor (multiply-blit с cover-fit и потолком черноты)

Контракт `multiplyBlitMat` uniforms: `tBg` (sampler2D), `tShadow` (sampler2D), `uUvScale` (vec2), `uShadowFloorK` (float), `uShadowStrength` (float). Логика: `shadowTerm = 1.0 - texture(tShadow, uv).r`; `m = mix(1.0, 1.0 - uShadowStrength*uShadowFloorK, shadowTerm)`; `out = vec4(texture(tBg, coverUv).rgb * m, 1.0)`. GLSL1 ok. (spec §4.4) Новый RT `shadowRT2` (тот же размер, что `shadowRT`; ДОБАВИТЬ в setSize/resize). `LUX_CONFIG.shadow` += `blobRatio: 0.5`, `shadowFloorK: 0.7`.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/config.ts` (`:17` — `LUX_CONFIG.shadow` += `blobRatio`, `shadowFloorK`)
- Modify: `/Users/iman/Projects/background_ar/src/lux/compositor.ts` (поле `shadowRT2` `:48`; конструктор `:79`; `multiplyBlitMat` рядом с `coverMat` `:113-124`; `setSize` `:421-427`)
- Create test: `/Users/iman/Projects/background_ar/src/lux/multiplyBlit.test.ts`
- Modify test: `/Users/iman/Projects/background_ar/src/lux/config.test.ts` (если есть; иначе добавить assert в multiplyBlit.test.ts)

> **Замечание о тестируемости:** компилировать/исполнять GLSL без WebGL нельзя. Юнит-тестируем (а) числовую модель cover-fit + multiply как чистую TS-функцию-зеркало шейдера, и (б) наличие config-полей. Сам пиксельный multiply проверяется в live-exit.

**Step 1 — написать падающий тест.** Создать `/Users/iman/Projects/background_ar/src/lux/multiplyBlit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { LUX_CONFIG } from './config'
import { multiplyShadowTerm, coverUv } from './multiplyBlit'

describe('LUX_CONFIG.shadow новые поля', () => {
  it('blobRatio = 0.5, shadowFloorK = 0.7 (spec §4.4/§4.5)', () => {
    expect(LUX_CONFIG.shadow.blobRatio).toBeCloseTo(0.5, 6)
    expect(LUX_CONFIG.shadow.shadowFloorK).toBeCloseTo(0.7, 6)
  })
  it('существующие поля strength/softness/bias сохранены', () => {
    expect(LUX_CONFIG.shadow.strength).toBeCloseTo(0.5, 6)
    expect(LUX_CONFIG.shadow.softness).toBeCloseTo(1.6, 6)
    expect(LUX_CONFIG.shadow.bias).toBeCloseTo(0.005, 6)
  })
})

describe('multiplyShadowTerm (числовое зеркало multiplyBlitMat)', () => {
  it('вне тени (shadowSample=1.0): множитель = 1.0 (кадр не темнеет)', () => {
    // shadowTerm = 1 - 1 = 0 → mix(1, floor, 0) = 1
    expect(multiplyShadowTerm(1.0, 0.6, 0.7)).toBeCloseTo(1.0, 6)
  })

  it('самая плотная тень (shadowSample=0.0): множитель = 1 - strength*floorK (не 0)', () => {
    // shadowTerm = 1 - 0 = 1 → mix(1, 1-0.6*0.7, 1) = 1 - 0.42 = 0.58
    expect(multiplyShadowTerm(0.0, 0.6, 0.7)).toBeCloseTo(0.58, 6)
  })

  it('никогда не уходит в чёрный: множитель ограничен снизу потолком', () => {
    expect(multiplyShadowTerm(0.0, 1.0, 0.7)).toBeCloseTo(0.3, 6)
    expect(multiplyShadowTerm(0.0, 1.0, 0.7)).toBeGreaterThan(0)
  })
})

describe('coverUv (cover-fit выборка тени = выборка плейта)', () => {
  it('uUvScale=(1,1): uv не меняется', () => {
    expect(coverUv(0.3, 0.7, 1, 1)).toEqual([0.3, 0.7])
  })
  it('uUvScale кропит вокруг центра 0.5 как coverMat', () => {
    // (uv-0.5)*scale+0.5 ; scale.x=0.5 → 0.3→0.4, центр сохраняется
    const [u, v] = coverUv(0.3, 0.5, 0.5, 1)
    expect(u).toBeCloseTo(0.4, 6)
    expect(v).toBeCloseTo(0.5, 6)
  })
})
```

**Step 2 — запустить, увидеть FAIL.** Команда:
```
npm test -- src/lux/multiplyBlit.test.ts
```
Ожидаемый вывод (FAIL — нет модуля `multiplyBlit` и нет config-полей):
```
FAIL  src/lux/multiplyBlit.test.ts
  Error: Failed to load url ./multiplyBlit (resolved id: .../src/lux/multiplyBlit.ts). Does the file exist?
Test Files  1 failed (1)
```

**Step 3 — реализация: config-поля + числовое зеркало + сам материал/RT.**

3a. `/Users/iman/Projects/background_ar/src/lux/config.ts` `:17` — расширить `shadow`:

Before:
```ts
  shadow: { strength: 0.5, softness: 1.6, bias: 0.005 }, // мягкая серая тень, контакт у ног (эталон-прокси)
}
```
After:
```ts
  // strength/softness/bias — v1; blobRatio — blob = доля per-room силы (§6);
  // shadowFloorK — потолок черноты multiply-blit (тень не чернее объектов, §4.5).
  shadow: { strength: 0.5, softness: 1.6, bias: 0.005, blobRatio: 0.5, shadowFloorK: 0.7 },
}
```

3b. Создать `/Users/iman/Projects/background_ar/src/lux/multiplyBlit.ts` (числовое зеркало + фабрика материала; держим GLSL рядом с моделью, чтобы они не разъезжались):

```ts
import * as THREE from 'three'

// Числовое зеркало multiplyBlitMat (для юнит-теста модели без WebGL).
// shadowSample = texture(tShadow).r на БЕЛОМ clear: 1.0 вне тени, →0 в тени.
export function multiplyShadowTerm(shadowSample: number, strength: number, floorK: number): number {
  const shadowTerm = 1.0 - shadowSample
  const floor = 1.0 - strength * floorK
  return 1.0 * (1 - shadowTerm) + floor * shadowTerm // mix(1, floor, shadowTerm)
}

// Cover-fit выборка (зеркало coverMat): (uv-0.5)*scale+0.5.
export function coverUv(u: number, v: number, scaleX: number, scaleY: number): [number, number] {
  return [(u - 0.5) * scaleX + 0.5, (v - 0.5) * scaleY + 0.5]
}

const MB_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

// Фуллскрин multiply-blit: compositeRT(tBg) × shadowRT(tShadow), с cover-fit
// кропом тени (uUvScale = coverMat) и потолком черноты (spec §4.4). GLSL1.
export function makeMultiplyBlitMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL1,
    uniforms: {
      tBg: { value: null }, tShadow: { value: null },
      uUvScale: { value: new THREE.Vector2(1, 1) },
      uShadowFloorK: { value: 0.7 }, uShadowStrength: { value: 0.5 },
    },
    vertexShader: MB_VERT,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tBg; uniform sampler2D tShadow;
      uniform vec2 uUvScale; uniform float uShadowFloorK; uniform float uShadowStrength;
      void main() {
        vec2 coverUv = (vUv - 0.5) * uUvScale + 0.5;
        float shadowTerm = 1.0 - texture2D(tShadow, coverUv).r;
        float m = mix(1.0, 1.0 - uShadowStrength * uShadowFloorK, shadowTerm);
        gl_FragColor = vec4(texture2D(tBg, coverUv).rgb * m, 1.0);
      }
    `,
    depthTest: false,
  })
}
```

> **Примечание по контракту:** контракт пишет `out = texture(tBg, coverUv).rgb` — `tBg` сэмплится тем же `coverUv`, что `tShadow` (фон уже cover-fit в compositeRT, но единый coverUv держит тень и фон со-выровненными; это и есть «crop тени = crop плейта»). Использовано выше.

3c. `/Users/iman/Projects/background_ar/src/lux/compositor.ts` — поле, конструктор, setSize.

Поле (после `:48`, рядом с `shadowRT`):
```ts
  private shadowRT: THREE.WebGLRenderTarget // целевой RT физической тени (read+write split)
  private shadowRT2: THREE.WebGLRenderTarget // temp для multiply-blit (read+write split, spec §4.4)
```

Конструктор (после `:79`, рядом с `this.shadowRT = ...`):
```ts
    this.shadowRT = new THREE.WebGLRenderTarget(width, height)
    this.shadowRT2 = new THREE.WebGLRenderTarget(width, height)
```

Инициализация материала (рядом с `coverMat`, после `:124`):
```ts
    // multiply-blit physical-тени: compositeRT × shadowRT, cover-fit + потолок черноты
    this.multiplyBlitMat = makeMultiplyBlitMat()
    this.multiplyBlitMat.uniforms.uShadowFloorK.value = LUX_CONFIG.shadow.shadowFloorK
```
И объявить поле рядом с прочими (`:53-63`):
```ts
  private multiplyBlitMat: THREE.ShaderMaterial // physical-тень multiply-blit (spec §4.4)
```
Плюс импорты сверху `compositor.ts`:
```ts
import { makeMultiplyBlitMat } from './multiplyBlit'
import { LUX_CONFIG } from './config'
```
(Если `LUX_CONFIG` уже импортирован — не дублировать.)

`setSize` (`:421-427`) — добавить `shadowRT2`:

Before:
```ts
  setSize(width: number, height: number): void {
    this.sceneRT.setSize(width, height)
    this.wrapRT_A.setSize(width >> 2, height >> 2)
    this.wrapRT_B.setSize(width >> 2, height >> 2)
    this.compositeRT.setSize(width, height)
    this.shadowRT.setSize(width, height)
  }
```
After:
```ts
  setSize(width: number, height: number): void {
    this.sceneRT.setSize(width, height)
    this.wrapRT_A.setSize(width >> 2, height >> 2)
    this.wrapRT_B.setSize(width >> 2, height >> 2)
    this.compositeRT.setSize(width, height)
    this.shadowRT.setSize(width, height)
    this.shadowRT2.setSize(width, height) // multiply-blit temp (spec §4.4)
  }
```

**Step 4 — запустить, PASS.** Команда:
```
npm test -- src/lux/multiplyBlit.test.ts
```
Ожидаемый вывод:
```
✓ src/lux/multiplyBlit.test.ts (7)
Test Files  1 passed (1)
     Tests  7 passed (7)
```
Затем весь набор + typecheck:
```
npm test
```
Ожидаемый вывод (0 failed, typecheck зелёный — `compositor.ts` компилируется с новым полем/импортами):
```
Test Files  19 passed (19)
     Tests  118 passed (118)
```

**Step 5 — коммит.**
```
git add src/lux/config.ts src/lux/multiplyBlit.ts src/lux/multiplyBlit.test.ts src/lux/compositor.ts
git commit -m "$(cat <<'EOF'
feat(shadow) B1: multiplyBlitMat + shadowRT2 + config blobRatio/shadowFloorK

Multiply-blit physical-тени с cover-fit (uUvScale=coverMat) и потолком
черноты (mix(1, 1-strength*floorK, term)) — тень не чернее объектов (§4.4).
shadowRT2 добавлен в setSize. GLSL1.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B1.9 — Минимальная слот-проводка в `compositor.render()` + `main.ts` форвард `shadowData.camera` (alignment-рендер на canvas)

Цель B1: прогнать `ShadowScene3D` через реальный рендер-слот, чтобы пиксельное совпадение можно было проверить вживую. Здесь — минимальная проводка (НЕ pose-driven, НЕ crossfade-лестница — это C/D). Контракт: `compositor.render(opts)` gains `opts.shadowData.camera: ShadowCamera` (REPLACES old `cameraPos`); `main.ts` forwards `active.shadowData.camera`; v1 `roomShadowMat` fallback reads `opts.shadowData.camera.pos`.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/compositor.ts` (тип `opts.shadowData` `:456`; v1 `roomShadowMat` cameraPos `:548`; слот-ветка `:538-561`; хранить `shadowScene3D`-инстанс)
- Modify: `/Users/iman/Projects/background_ar/src/main.ts` (форвард `camera` `:224-229`)

> WebGL-рендер этой проводки нельзя юнит-тестировать. Корректность типов проверяется typecheck (`npm test` поднимает тот же tsconfig); пиксельное совпадение — live-exit ниже. Поэтому шаг — типобезопасный диф + зелёный набор, без нового unit-теста (логика alignment покрыта B1.3/B1.8 числовыми тестами).

**Step 1 — внести правки.**

1a. `compositor.ts:456` — заменить `cameraPos` на `camera: ShadowCamera` в типе `opts.shadowData`:

Before:
```ts
    shadowData: { lamps: { pos: [number, number, number]; weight: number }[]; worldPos: THREE.Texture; floorZ: number; cameraPos: [number, number, number] } | null
```
After:
```ts
    shadowData: { lamps: { pos: [number, number, number]; weight: number }[]; worldPos: THREE.Texture; floorZ: number; camera: ShadowCamera } | null
```
Импорт `ShadowCamera` сверху `compositor.ts`:
```ts
import type { ShadowCamera } from './shadowGeom'
```

1b. `compositor.ts:548` — v1 `roomShadowMat` fallback читает `opts.shadowData.camera.pos`:

Before:
```ts
        u.uCamPos.value.set(opts.shadowData.cameraPos[0], opts.shadowData.cameraPos[1], opts.shadowData.cameraPos[2])
```
After:
```ts
        u.uCamPos.value.set(opts.shadowData.camera.pos[0], opts.shadowData.camera.pos[1], opts.shadowData.camera.pos[2])
```

1c. `main.ts:224-229` — форвардить полный `camera`:

Before:
```ts
      shadowData: active.shadowData ? {
        lamps: active.shadowData.lamps,
        worldPos: active.shadowData.worldPos,
        floorZ: active.shadowData.floorZ,
        cameraPos: active.shadowData.camera.pos,
      } : null,
```
After:
```ts
      shadowData: active.shadowData ? {
        lamps: active.shadowData.lamps,
        worldPos: active.shadowData.worldPos,
        floorZ: active.shadowData.floorZ,
        camera: active.shadowData.camera,
      } : null,
```

1d. `compositor.ts` слот тени — добавить B1 alignment-ветку с реальным 3D-рендером перед v1 `roomShadowMat`-веткой. Поле для ленивого инстанса (рядом с `:48-51`):
```ts
  private shadowScene3D: import('./shadowScene3D').ShadowScene3D | null = null
```
В слоте тени (`compositor.ts:539`, внутри `if (opts.shadowData && opts.personFloor) {` — перед существующим v1-кодом) вставить B1-ветку. Для B1 рендерим статический прокси ВСЕГДА когда есть `shadowData` (без pose-gate — pose придёт в C/D):

```ts
      if (opts.shadowData && opts.personFloor) {
        // B1 alignment: реальный 3D-рендер статического прокси в shadowRT (белый clear),
        // затем multiply-blit с cover-fit на compositeRT. Pose-drive/лестница — Фазы C/D2.
        if (!this.shadowScene3D) {
          const { ShadowScene3D } = require('./shadowScene3D') as typeof import('./shadowScene3D')
          this.shadowScene3D = new ShadowScene3D(
            { lamps: opts.shadowData.lamps, camera: opts.shadowData.camera, floorZ: opts.shadowData.floorZ },
            this.renderer,
          )
        }
        // 1) 3D-рендер тень-фактора в shadowRT с БЕЛЫМ clear
        const prevClear = new THREE.Color()
        this.renderer.getClearColor(prevClear)
        const prevAlpha = this.renderer.getClearAlpha()
        this.renderer.setRenderTarget(this.shadowRT)
        this.renderer.setClearColor(0xffffff, 1)
        this.renderer.clear()
        this.renderer.render(this.shadowScene3D.scene, this.shadowScene3D.camera)
        this.renderer.setRenderTarget(null)
        this.renderer.setClearColor(prevClear, prevAlpha) // вернуть для FSQ-блитов
        // 2) multiply-blit с cover-fit → shadowRT2 (temp), затем блит в compositeRT (как v1)
        const m = this.multiplyBlitMat.uniforms
        m.tBg.value = this.compositeRT.texture
        m.tShadow.value = this.shadowRT.texture
        m.uUvScale.value.copy(this.coverMat.uniforms.uUvScale.value)
        m.uShadowStrength.value = opts.shadowStrength
        this.pass(this.multiplyBlitMat, this.shadowRT2)
        this.blitMat.uniforms.tSrc.value = this.shadowRT2.texture
        this.pass(this.blitMat, this.compositeRT)
      } else if (opts.shadowData && opts.personFloor) {
        // (мёртвая ветка-плейсхолдер для C/D — v1 roomShadowMat остаётся ниже)
      }
```

> **Важно (минимизация диффа B1):** существующий v1 `roomShadowMat`-блок (`:539-561`) на этой фазе можно либо оставить ниже как недостижимый fallback, либо обернуть так, чтобы B1-ветка перехватывала первой. Чтобы не плодить мёртвый код, на B1 достаточно: B1-ветка выполняется когда `opts.shadowData && opts.personFloor`, а прежний v1-блок становится `else`-веткой (срабатывает только когда `personFloor` есть, но мы решили рисовать proxy). На D2 это место переписывается в полноценную crossfade-лестницу (gate на `opts.pose.healthy`), поэтому здесь — минимально работающая проводка, а не финальная структура. **Не** удалять `roomShadowMat`/`groundShadowMat`/blob — они остаются для C/D.

> Если `require` недоступен в ESM-сборке проекта (Vite), заменить ленивую инициализацию на статический импорт `ShadowScene3D` сверху файла и `if (!this.shadowScene3D) this.shadowScene3D = new ShadowScene3D(...)`. Выбрать вариант по факту сборки.

**Step 2 — запустить набор + typecheck.** Команда:
```
npm test
```
Ожидаемый вывод (0 failed; ключевое — typecheck `compositor.ts`↔`main.ts` сходится на новом контракте `shadowData.camera`):
```
Test Files  19 passed (19)
     Tests  118 passed (118)
```
(если падает старый тест, ожидавший `cameraPos` на границе compositor — обновить его на `camera`; искать `cameraPos` в `src/**/*.test.ts`.)

**Step 3 — коммит.**
```
git add src/lux/compositor.ts src/main.ts
git commit -m "$(cat <<'EOF'
feat(shadow) B1: слот compositor — ShadowScene3D alignment-рендер + camera-контракт

opts.shadowData.cameraPos → camera: ShadowCamera (main.ts форвардит полный
объект; v1 roomShadowMat читает .camera.pos). B1-ветка: 3D-рендер статик-прокси
в shadowRT (белый clear) → multiply-blit cover-fit → compositeRT. Pose/лестница — C/D.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Exit criterion (spec §10, фаза B1) — verifiable

**Unit (автоматизировано):**
- `npm test` зелёный, ≥92 теста (фактически +26 новых по B1.1–B1.8: `sampleWorldXYZ`, `boxReceiver`, `bakedShadowCamera`, `staticProxy`, `keyPointLights`, `ShadowScene3D`, `multiplyShadowTerm`/`coverUv`/config). 0 failed, typecheck зелёный (`compositor.ts`↔`main.ts` сходятся на `shadowData.camera`).
- Числовые зеркала доказывают логику без GPU: cover-fit `coverUv` == `coverMat`-формула; multiply вне тени = 1.0, в плотной точке = `1 - strength*floorK` (не 0); baked-camera матрица ставит камеру и forward в нужные three-Y-up координаты; Key-лампа единственная с `castShadow`+`mapSize 2048`+`bias -0.0005`+`normalBias 0.03`; static proxy `castShadow=true`/`visible=true`/`colorWrite=false`/`depthWrite=false`.

**Live-приёмка (обязательна для B1 — пиксельное совпадение на НЕ-совпадающем canvas-аспекте):**
1. Запустить рендерер с загруженной комнатой `living` (есть `shadowData`: `lights.json.camera` + `meta.json shadowStrength`).
2. **Принудительно выставить НЕ-совпадающий canvas-аспект:** ресайз окна браузера так, чтобы `canvasAspect ≠ camera.aspect (0.5625)` — например широкое ландшафтное окно. Это упражняет cover-fit-кроп-путь (`multiplyBlitMat.uUvScale = coverMat.uUvScale`); на совпадающем аспекте баг кропа скрыт (spec §4.4 — «alignment-тест обязан гоняться на НЕ-совпадающем canvas-аспекте»).
3. **Критерий:** тень от статического прокси (столбик в центре пола, рост 1.7) ложится на плоский плейт **в тех же экранных пикселях**, где геометрия пола/мебели на плейте — отбрасывается из-под основания столбика по направлению от Key-лампы, без сдвига/перекоса/масштабного рассогласования между shadow-слоем и плейтом. Тень видна (доказывает `shadowMap.enabled` работает) и не чернее объектов сцены (потолок `shadowFloorK`).
4. Проверить при двух размерах окна (узкое портретное ≈0.5625 и широкое ландшафтное): тень остаётся приклеенной к одной и той же мировой точке относительно плейта — кроп не «уезжает».

**Definition of done B1:** автоматический набор зелёный (≥92, +26 новых, 0 failed, typecheck ок) **И** статический прокси даёт пиксельно-совпадающую с плейтом тень на НЕ-совпадающем canvas-аспекте. Это снимает риск переделки 3D-пайплайна (камера-бейк + cover-fit + `shadowMap.enabled` + multiply-blit доказаны на тривиальной геометрии) **до** вложения в EXR-mesh-сложность Фазы B2.

---

## Phase B2 — Renderer: EXR-mesh приёмник (целевой прод)

**Контекст фазы.** B1 уже доказал 3D-пайплайн на тривиальной геометрии: `renderer.shadowMap.enabled=true`, `ShadowScene3D` с запечённой камерой + `boxReceiver` + Key-`PointLight`, multiply-blit через `shadowRT2`, cover-fit-выравнивание на не-совпадающем canvas-аспекте. B2 строит **целевой production-приёмник** — `roomMeshFromEXR`: сабсэмпл-сетку из worldPos-EXR с Uint32-индексами, tear-culling на глубинных разрывах, bridge-треугольниками в контактных зонах (пол↔база мебели) и `computeVertexNormals()`. Затем меняет приёмник `ShadowScene3D` с box на mesh через уже существующий `setReceiver()`. По требованию заказчика («качество>fps») этот приёмник **закоммичен, не опционален**; B1 box остаётся fallback-полом (спека §4.1, §13).

**Канонические инварианты этой фазы (verbatim из контрактов):**
- `sampleWorldXYZ(worldPosData, u, v): [number,number,number]` уже **перенесён в `shadowGeom.ts`** (px=round(u·(w-1)), py=round(v·(h-1)), flipY=false). B2 импортирует его оттуда — НЕ из `main.ts`. Если перенос ещё не сделан в C-пререквизите, B2.1 делает его первым шагом (см. ниже — он нужен B2 для семплинга сетки).
- `roomMeshFromEXR(worldPosData: {data:Float32Array;width:number;height:number}, opts:{cols:number;rows:number;tearK:number}): THREE.Mesh` — субсэмпл-сетка ~128×228, `BufferGeometry` Float32 `position` + **Uint32** `index`, tear quads где max edge `|delta| > tearK·dist`, **keep bridge tris** в зоне контакта floor↔furniture, `computeVertexNormals()`; материал `THREE.ShadowMaterial`, `receiveShadow=true`.
- `ShadowScene3D.setReceiver(meshes: THREE.Object3D[]): void` — уже существует с B1.

Тестовый раннер (из CURRENT CODE): `npm test` (== `vitest run`). Тесты лежат в `src/**/*.test.ts`, TypeScript, `import * as THREE from 'three'`. Геометрия/математика three.js тестируется без WebGL (массивы вершин, индексы, нормали, transforms). GPU-рендер (то, что тень реально ложится на мебель без rubber-sheet) — только live-приёмка в конце фазы.

---

### B2.0 (пререквизит-гейт) — убедиться, что `sampleWorldXYZ` уже в `shadowGeom.ts`

`roomMeshFromEXR` семплит мировую позицию каждой узловой точки сетки тем же `sampleWorldXYZ`, что и v1-якорь F. По контракту он **перенесён** из `main.ts` в `shadowGeom.ts` (фаза C-пререквизит, спека §5/§7/§10). Если на момент старта B2 этого переноса ещё нет, выполни его здесь как первый шаг (он чисто-функциональный, без рендера, и обязателен для B2.1).

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts` (добавить экспорт `sampleWorldXYZ` после `personFloorWorld`, строки 43+)
- Modify: `/Users/iman/Projects/background_ar/src/main.ts` (удалить локальный `sampleWorldXYZ` :31-39, импортировать из `shadowGeom.ts`)
- Test: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts` (добавить describe-блок для `sampleWorldXYZ`)

**Step 1 — failing test.** Добавить в `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sampleWorldXYZ } from './shadowGeom'

describe('sampleWorldXYZ (moved from main.ts)', () => {
  // 2×2 EXR: каждый тексель RGBA, A игнорируется. Раскладка row-major, flipY=false:
  // (px,py) -> i = (py*w + px)*4
  const data = new Float32Array([
    /* px0,py0 */ 1, 2, 3, 0,   /* px1,py0 */ 4, 5, 6, 0,
    /* px0,py1 */ 7, 8, 9, 0,   /* px1,py1 */ 10, 11, 12, 0,
  ])
  const wp = { data, width: 2, height: 2 }

  it('u=0,v=0 -> texel (0,0)', () => {
    expect(sampleWorldXYZ(wp, 0, 0)).toEqual([1, 2, 3])
  })
  it('u=1,v=0 -> texel (1,0) (px=round(1*(w-1))=1)', () => {
    expect(sampleWorldXYZ(wp, 1, 0)).toEqual([4, 5, 6])
  })
  it('u=0,v=1 -> texel (0,1) (flipY=false: py=round(1*(h-1))=1)', () => {
    expect(sampleWorldXYZ(wp, 0, 1)).toEqual([7, 8, 9])
  })
  it('u=1,v=1 -> texel (1,1)', () => {
    expect(sampleWorldXYZ(wp, 1, 1)).toEqual([10, 11, 12])
  })
  it('clamps out-of-range u/v into [0,w-1]/[0,h-1]', () => {
    expect(sampleWorldXYZ(wp, -5, -5)).toEqual([1, 2, 3])
    expect(sampleWorldXYZ(wp, 5, 5)).toEqual([10, 11, 12])
  })
})
```

**Step 2 — run it, expect FAIL.** Команда:
```
npm test -- src/lux/shadowGeom.test.ts
```
Ожидаемый вывод (FAIL): `Error: No "sampleWorldXYZ" export is defined on the "./shadowGeom" module` (или `sampleWorldXYZ is not a function`). Vitest помечает файл красным, suite не запускается.

**Step 3 — minimal impl.** В `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts` добавить в конец файла (после строки 43):

```ts
export function sampleWorldXYZ(
  wp: { data: Float32Array; width: number; height: number }, u: number, v: number,
): Vec3 {
  // как шейдер: texture(tWorld, (u,v)) с flipY=false → data row = v*(h-1)
  const px = Math.min(wp.width - 1, Math.max(0, Math.round(u * (wp.width - 1))))
  const py = Math.min(wp.height - 1, Math.max(0, Math.round(v * (wp.height - 1))))
  const i = (py * wp.width + px) * 4
  return [wp.data[i], wp.data[i + 1], wp.data[i + 2]]
}
```

В `/Users/iman/Projects/background_ar/src/main.ts` удалить локальное определение (строки 31-39) и добавить `sampleWorldXYZ` в существующий импорт из `shadowGeom.ts` (рядом с `personFloorWorld`/`ShadowCamera`):

```ts
import { personFloorWorld, sampleWorldXYZ, type ShadowCamera } from './lux/shadowGeom'
```
(точную форму импорта согласовать с уже существующими импортами `shadowGeom` в `main.ts`; добавить `sampleWorldXYZ` в список, оставив прочее без изменений).

**Step 4 — run, expect PASS.**
```
npm test -- src/lux/shadowGeom.test.ts
```
Ожидаемо: все 5 кейсов зелёные. Затем полный прогон `npm test` — ожидаемо ≥92 прежних + новые, без регрессий (main.ts больше не объявляет дубликат функции).

**Step 5 — commit.**
```
git add src/lux/shadowGeom.ts src/lux/shadowGeom.test.ts src/main.ts
git commit -m "refactor(shadow) B2: move sampleWorldXYZ main.ts -> shadowGeom.ts (B2 mesh seed)"
```

> Если перенос уже выполнен в фазе C, B2.0 пропускается — переходи к B2.1.

---

### B2.1 — `roomMeshFromEXR`: плотная сетка вершин из EXR (без culling)

Сначала добиваемся, чтобы функция строила **плотную** субсэмпл-сетку (cols×rows узлов), каждая вершина = `sampleWorldXYZ(worldPosData, u, v)`, индексы Uint32, 2 треугольника/квад — **до** добавления tear-culling. Это изолирует «правильная геометрия и Uint32-индекс» от «правильное прорежение швов».

**Files:**
- Create: `/Users/iman/Projects/background_ar/src/lux/roomMesh.ts`
- Test: `/Users/iman/Projects/background_ar/src/lux/roomMesh.test.ts`

**Step 1 — failing test.** Создать `/Users/iman/Projects/background_ar/src/lux/roomMesh.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { roomMeshFromEXR } from './roomMesh'

// Плоский синтетический EXR 4×4: мировая позиция = (px*0.1, py*0.1, 0) (ровный пол).
// Никаких разрывов глубины → tearK не должен ничего выкидывать.
function flatEXR(w: number, h: number) {
  const data = new Float32Array(w * h * 4)
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4
      data[i] = px * 0.1
      data[i + 1] = py * 0.1
      data[i + 2] = 0
      data[i + 3] = 1
    }
  }
  return { data, width: w, height: h }
}

describe('roomMeshFromEXR — dense grid (no tears)', () => {
  const wp = flatEXR(4, 4)
  const mesh = roomMeshFromEXR(wp, { cols: 4, rows: 4, tearK: 1e9 })

  it('returns a THREE.Mesh', () => {
    expect(mesh).toBeInstanceOf(THREE.Mesh)
  })

  it('vertex count = cols*rows', () => {
    const pos = mesh.geometry.getAttribute('position')
    expect(pos.count).toBe(16) // 4×4
    expect(pos.itemSize).toBe(3)
    expect(pos.array).toBeInstanceOf(Float32Array)
  })

  it('first vertex = sampleWorldXYZ at (u=0,v=0) = (0,0,0)', () => {
    const pos = mesh.geometry.getAttribute('position')
    expect([pos.getX(0), pos.getY(0), pos.getZ(0)]).toEqual([0, 0, 0])
  })

  it('uses Uint32 index, full quad grid = (cols-1)*(rows-1)*2 tris', () => {
    const idx = mesh.geometry.getIndex()!
    expect(idx.array).toBeInstanceOf(Uint32Array)
    expect(idx.count).toBe((4 - 1) * (4 - 1) * 2 * 3) // 3*3 quads × 2 tris × 3 verts = 54
  })

  it('computes vertex normals (all +Z for flat floor)', () => {
    const nrm = mesh.geometry.getAttribute('normal')
    expect(nrm).toBeTruthy()
    expect(nrm.count).toBe(16)
    // ровный пол z=0 → нормали по ±Z, |nz| ≈ 1
    expect(Math.abs(nrm.getZ(0))).toBeCloseTo(1, 5)
  })

  it('material is ShadowMaterial and receiveShadow=true', () => {
    expect(mesh.material).toBeInstanceOf(THREE.ShadowMaterial)
    expect(mesh.receiveShadow).toBe(true)
  })
})
```

**Step 2 — run it, expect FAIL.**
```
npm test -- src/lux/roomMesh.test.ts
```
Ожидаемый вывод (FAIL): `Failed to resolve import "./roomMesh"` / `Cannot find module './roomMesh'`. Suite не стартует.

**Step 3 — minimal impl.** Создать `/Users/iman/Projects/background_ar/src/lux/roomMesh.ts`:

```ts
// B2: целевой production-приёмник тени — невидимая mesh-поверхность комнаты,
// построенная из запечённой worldPos-EXR (спека §4.1). Сабсэмпл-сетка cols×rows;
// каждая вершина = sampleWorldXYZ. ShadowMaterial: принимает тень, всюду прозрачна.
import * as THREE from 'three'
import { sampleWorldXYZ } from './shadowGeom'

export interface RoomMeshOpts {
  cols: number   // узлов по горизонтали (~128)
  rows: number   // узлов по вертикали (~228, портрет 9:16)
  tearK: number  // порог разрыва глубины: рвём квад при max|Δ| > tearK·dist
}

export function roomMeshFromEXR(
  worldPosData: { data: Float32Array; width: number; height: number },
  opts: RoomMeshOpts,
): THREE.Mesh {
  const { cols, rows } = opts
  // 1) вершины: регулярная (u,v)-сетка → мировые позиции через sampleWorldXYZ
  const positions = new Float32Array(cols * rows * 3)
  for (let gy = 0; gy < rows; gy++) {
    const v = rows > 1 ? gy / (rows - 1) : 0
    for (let gx = 0; gx < cols; gx++) {
      const u = cols > 1 ? gx / (cols - 1) : 0
      const [x, y, z] = sampleWorldXYZ(worldPosData, u, v)
      const o = (gy * cols + gx) * 3
      positions[o] = x; positions[o + 1] = y; positions[o + 2] = z
    }
  }
  // 2) индексы: 2 треугольника на квад, Uint32 (>65535 вершин при 128×228)
  const index: number[] = []
  for (let gy = 0; gy < rows - 1; gy++) {
    for (let gx = 0; gx < cols - 1; gx++) {
      const a = gy * cols + gx
      const b = a + 1
      const c = a + cols
      const d = c + 1
      index.push(a, c, b) // tri 1
      index.push(b, c, d) // tri 2
    }
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1))
  geom.computeVertexNormals()

  const mat = new THREE.ShadowMaterial()
  mat.transparent = true
  const mesh = new THREE.Mesh(geom, mat)
  mesh.receiveShadow = true
  return mesh
}
```

**Step 4 — run, expect PASS.**
```
npm test -- src/lux/roomMesh.test.ts
```
Ожидаемо: все 6 кейсов зелёные.

**Step 5 — commit.**
```
git add src/lux/roomMesh.ts src/lux/roomMesh.test.ts
git commit -m "feat(shadow) B2: roomMeshFromEXR dense grid (Float32 pos, Uint32 index, normals, ShadowMaterial)"
```

---

### B2.2 — tear-culling на глубинных разрывах (убрать rubber-sheeting)

Теперь добавляем прорежение: для каждого квада считаем max-разрыв мировой позиции по рёбрам; если `max|Δ| > tearK·dist` — оба треугольника квада **не индексируются** (дыра вместо «резиновой простыни» между ближней мебелью и фоном, спека §4.1). `dist` = опорный масштаб квада (длина его наименьшего ребра — устойчивый локальный размер).

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/roomMesh.ts` (индекс-цикл)
- Test: `/Users/iman/Projects/background_ar/src/lux/roomMesh.test.ts` (новый describe)

**Step 1 — failing test.** Добавить в `/Users/iman/Projects/background_ar/src/lux/roomMesh.test.ts`:

```ts
describe('roomMeshFromEXR — tear-culling on depth discontinuity', () => {
  // 2×2 EXR (один квад). Левый столбец на полу z=0, правый — «дальняя стена» z=5:
  // огромный скачок по Z вдоль горизонтального ребра → квад должен порваться.
  function cliffEXR() {
    const data = new Float32Array(2 * 2 * 4)
    // (0,0): z=0
    data.set([0, 0, 0, 1], 0)
    // (1,0): z=5 (обрыв)
    data.set([0.1, 0, 5, 1], 4)
    // (0,1): z=0
    data.set([0, 0.1, 0, 1], 8)
    // (1,1): z=5 (обрыв)
    data.set([0.1, 0.1, 5, 1], 12)
    return { data, width: 2, height: 2 }
  }
  const wp = cliffEXR()

  it('quad with large Z-gap is torn out (index empty) at small tearK', () => {
    const mesh = roomMeshFromEXR(wp, { cols: 2, rows: 2, tearK: 1.0 })
    const idx = mesh.geometry.getIndex()!
    // dist ≈ ребро 0.1; max|Δ| по Z ≈ 5 >> tearK·dist = 0.1 → квад вырезан
    expect(idx.count).toBe(0)
  })

  it('same quad survives when tearK is huge (no false tear)', () => {
    const mesh = roomMeshFromEXR(wp, { cols: 2, rows: 2, tearK: 1e9 })
    const idx = mesh.geometry.getIndex()!
    expect(idx.count).toBe(6) // 1 quad × 2 tris × 3
  })

  it('vertex buffer is unchanged by culling (only indices change)', () => {
    const torn = roomMeshFromEXR(wp, { cols: 2, rows: 2, tearK: 1.0 })
    const whole = roomMeshFromEXR(wp, { cols: 2, rows: 2, tearK: 1e9 })
    expect(torn.geometry.getAttribute('position').count)
      .toBe(whole.geometry.getAttribute('position').count)
  })
})
```

**Step 2 — run it, expect FAIL.**
```
npm test -- src/lux/roomMesh.test.ts
```
Ожидаемый вывод (FAIL): кейс «quad ... is torn out» падает — `expected 0 to be 6` (текущая реализация B2.1 всегда индексирует оба треугольника, разрыв игнорируется). Остальные новые кейсы зелёные.

**Step 3 — minimal impl.** В `/Users/iman/Projects/background_ar/src/lux/roomMesh.ts` заменить индекс-цикл (тело `for gy/for gx`, добавляющее `index.push(...)`) на версию с tear-проверкой:

```ts
  // 2) индексы с tear-culling: рвём квад на глубинном разрыве
  const px = (i: number) => positions[i * 3]
  const py = (i: number) => positions[i * 3 + 1]
  const pz = (i: number) => positions[i * 3 + 2]
  const edge = (i: number, j: number) =>
    Math.hypot(px(i) - px(j), py(i) - py(j), pz(i) - pz(j))

  const index: number[] = []
  for (let gy = 0; gy < rows - 1; gy++) {
    for (let gx = 0; gx < cols - 1; gx++) {
      const a = gy * cols + gx
      const b = a + 1
      const c = a + cols
      const d = c + 1
      // 4 ребра квада; dist = наименьшее ребро (устойчивый локальный масштаб),
      // max|Δ| = наибольшее ребро. Разрыв глубины раздувает диагональ/ребро.
      const e = [edge(a, b), edge(a, c), edge(b, d), edge(c, d)]
      const dist = Math.min(e[0], e[1], e[2], e[3])
      const maxE = Math.max(e[0], e[1], e[2], e[3])
      if (maxE > opts.tearK * dist) continue // рвём весь квад
      index.push(a, c, b)
      index.push(b, c, d)
    }
  }
```

(остальное — `BufferGeometry`/`computeVertexNormals`/`ShadowMaterial` — без изменений из B2.1.)

**Step 4 — run, expect PASS.**
```
npm test -- src/lux/roomMesh.test.ts
```
Ожидаемо: все кейсы B2.1 + B2.2 зелёные (плоский EXR из B2.1 имеет равные рёбра → `maxE ≈ dist`, не рвётся при разумном tearK; обрыв z=5 рвётся при tearK=1.0).

**Step 5 — commit.**
```
git add src/lux/roomMesh.ts src/lux/roomMesh.test.ts
git commit -m "feat(shadow) B2: tear-culling roomMeshFromEXR (drop quads where max|edge| > tearK*dist)"
```

---

### B2.3 — bridge-треугольники в контактной зоне (тень ложится поперёк шва пол↔мебель)

Известный артефакт tear↔receive (спека §4.1, §8): `ShadowMaterial` затемняет только там, где есть геометрия; в разорванной зоне — дыра → тень не ложится поперёк шва пол↔база-мебели. Решение: **рвать только дальние фон-разрывы, но сохранять «мостовой» квад в контактной зоне** — если хотя бы один из 4 узлов квада сидит **на полу** (`|z - floorZ| ≤ contactBand`), квад остаётся связным даже при большом `max|Δ|`. Это держит непрерывную поверхность ровно там, где тень «взбирается» с пола на ближнюю кромку.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/roomMesh.ts` (signature opts + индекс-цикл)
- Test: `/Users/iman/Projects/background_ar/src/lux/roomMesh.test.ts` (новый describe)

**Step 1 — failing test.** Добавить в `/Users/iman/Projects/background_ar/src/lux/roomMesh.test.ts`:

```ts
describe('roomMeshFromEXR — bridge tris keep floor<->furniture contact connected', () => {
  // Контактный квад: левый низ на полу z=0, правый верх «база мебели» z=0.4.
  // Разрыв достаточно велик, чтобы tear-culling из B2.2 его выкинул, НО узлы
  // на полу присутствуют → bridge должен сохранить квад связным.
  function contactEXR() {
    const data = new Float32Array(2 * 2 * 4)
    data.set([0, 0, 0.0, 1], 0)   // (0,0) пол
    data.set([0.1, 0, 0.4, 1], 4) // (1,0) база мебели
    data.set([0, 0.1, 0.0, 1], 8) // (0,1) пол
    data.set([0.1, 0.1, 0.4, 1], 12) // (1,1) база мебели
    return { data, width: 2, height: 2 }
  }
  const wp = contactEXR()

  it('without floorZ/contactBand (legacy 3-arg call) the contact quad is torn', () => {
    const mesh = roomMeshFromEXR(wp, { cols: 2, rows: 2, tearK: 1.0 })
    // floorZ undefined → bridge выключен → разрыв 0.4 vs dist 0.1 → рвётся
    expect(mesh.geometry.getIndex()!.count).toBe(0)
  })

  it('with floorZ + contactBand the contact quad is kept (bridge)', () => {
    const mesh = roomMeshFromEXR(wp, {
      cols: 2, rows: 2, tearK: 1.0, floorZ: 0, contactBand: 0.05,
    })
    // два узла на полу (|z-0| ≤ 0.05) → bridge → квад сохранён
    expect(mesh.geometry.getIndex()!.count).toBe(6)
  })

  it('a FAR-only quad (no floor node) is still torn even with bridge enabled', () => {
    // оба слоя высоко над полом: z=2 и z=5, ни одного floor-узла
    const far = new Float32Array(2 * 2 * 4)
    far.set([0, 0, 2, 1], 0); far.set([0.1, 0, 5, 1], 4)
    far.set([0, 0.1, 2, 1], 8); far.set([0.1, 0.1, 5, 1], 12)
    const mesh = roomMeshFromEXR(
      { data: far, width: 2, height: 2 },
      { cols: 2, rows: 2, tearK: 1.0, floorZ: 0, contactBand: 0.05 },
    )
    expect(mesh.geometry.getIndex()!.count).toBe(0) // дальний фон-разрыв рвётся
  })
})
```

**Step 2 — run it, expect FAIL.**
```
npm test -- src/lux/roomMesh.test.ts
```
Ожидаемый вывод (FAIL): кейс «with floorZ + contactBand ... kept (bridge)» падает — `expected 0 to be 6` (B2.2-реализация не знает про `floorZ`/`contactBand` и рвёт контактный квад). Кейсы «legacy 3-arg torn» и «FAR-only torn» зелёные.

**Step 3 — minimal impl.** В `/Users/iman/Projects/background_ar/src/lux/roomMesh.ts` расширить `RoomMeshOpts` и индекс-цикл. Обновить интерфейс:

```ts
export interface RoomMeshOpts {
  cols: number   // узлов по горизонтали (~128)
  rows: number   // узлов по вертикали (~228, портрет 9:16)
  tearK: number  // порог разрыва глубины: рвём квад при max|Δ| > tearK·dist
  floorZ?: number      // если задано — включает bridge: квад с узлом на полу не рвётся
  contactBand?: number // полуширина «контактной полосы» вокруг floorZ (м), напр. 0.05
}
```

Заменить tear-проверку в индекс-цикле (B2.2) на версию с bridge-исключением:

```ts
      const e = [edge(a, b), edge(a, c), edge(b, d), edge(c, d)]
      const dist = Math.min(e[0], e[1], e[2], e[3])
      const maxE = Math.max(e[0], e[1], e[2], e[3])
      const torn = maxE > opts.tearK * dist
      // bridge: контактную зону (пол↔база мебели) держим связной — рвём только
      // дальние фон-разрывы. Квад остаётся, если хоть один узел сидит на полу.
      let bridge = false
      if (torn && opts.floorZ !== undefined && opts.contactBand !== undefined) {
        const band = opts.contactBand
        const onFloor = (i: number) => Math.abs(pz(i) - opts.floorZ!) <= band
        bridge = onFloor(a) || onFloor(b) || onFloor(c) || onFloor(d)
      }
      if (torn && !bridge) continue
      index.push(a, c, b)
      index.push(b, c, d)
```

**Step 4 — run, expect PASS.**
```
npm test -- src/lux/roomMesh.test.ts
```
Ожидаемо: все кейсы B2.1+B2.2+B2.3 зелёные. Полный прогон `npm test` — без регрессий, новых тестов больше на +15, общий счёт > 92.

**Step 5 — commit.**
```
git add src/lux/roomMesh.ts src/lux/roomMesh.test.ts
git commit -m "feat(shadow) B2: bridge tris keep floor<->furniture contact connected (seam-dropout fix)"
```

---

### B2.4 — swap приёмника `ShadowScene3D` с box (B1) на EXR-mesh (B2)

`ShadowScene3D` (B1) уже умеет `setReceiver(meshes)`. B2 строит `roomMeshFromEXR` из `shadowData.worldPosData` и подставляет его как приёмник вместо `boxReceiver`. Box остаётся как fallback-пол (спека §4.1, §13) — если `worldPosData` отсутствует/битый, `ShadowScene3D` оставляет box-receiver. Само построение и подстановку выносим в чистый, тестируемый без WebGL хелпер на `ShadowScene3D`, а наличие/тип меша проверяем по объекту-приёмнику (геометрия three.js, не GPU).

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` (метод построения mesh-receiver + вызов `setReceiver`)
- Test: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.test.ts` (новый describe для swap; файл создан в B1)

**Step 1 — failing test.** Добавить в `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.test.ts` (использует тот же flatEXR-хелпер; продублировать локально, тесты самодостаточны):

```ts
describe('ShadowScene3D — B2 EXR-mesh receiver swap', () => {
  function flatEXR(w: number, h: number) {
    const data = new Float32Array(w * h * 4)
    for (let py = 0; py < h; py++)
      for (let px = 0; px < w; px++) {
        const i = (py * w + px) * 4
        data[i] = px * 0.1; data[i + 1] = py * 0.1; data[i + 2] = 0; data[i + 3] = 1
      }
    return { data, width: w, height: h }
  }
  // минимальный shadowData (камера/лампы/floorZ как в B1-фикстуре)
  const shadowData = {
    lamps: [{ name: 'Key_Living_Warm', pos: [0, 0, 3] as [number, number, number], weight: 1.0 }],
    camera: { pos: [0, -4, 1.5] as [number, number, number], target: [0, 0, 1] as [number, number, number], fovY: 0.9, aspect: 0.5625 },
    floorZ: 0,
    worldPos: null as unknown as THREE.Texture,
    worldPosData: flatEXR(8, 8),
  }

  it('useExrReceiver() builds a mesh receiver from worldPosData and installs it', () => {
    const scene = makeShadowScene3DForTest(shadowData) // B1 test factory (no real GL renderer)
    scene.useExrReceiver(shadowData, { cols: 8, rows: 8, tearK: 4, contactBand: 0.05 })
    // приёмник в сцене — это Mesh с ShadowMaterial и receiveShadow
    const receivers = scene.scene.children.filter(
      (o) => o instanceof THREE.Mesh && (o as THREE.Mesh).receiveShadow,
    ) as THREE.Mesh[]
    expect(receivers.length).toBeGreaterThan(0)
    const r = receivers[0]
    expect(r.material).toBeInstanceOf(THREE.ShadowMaterial)
    expect(r.geometry.getIndex()!.array).toBeInstanceOf(Uint32Array)
    expect(r.geometry.getAttribute('position').count).toBe(64) // 8×8
  })

  it('useExrReceiver() with missing worldPosData keeps box fallback (no throw)', () => {
    const scene = makeShadowScene3DForTest(shadowData)
    const before = scene.scene.children.length
    scene.useExrReceiver({ ...shadowData, worldPosData: undefined as never }, { cols: 8, rows: 8, tearK: 4 })
    // не падает, приёмник остаётся (box fallback из B1)
    expect(scene.scene.children.length).toBe(before)
  })
})
```

> `makeShadowScene3DForTest` — тестовая фабрика из B1, конструирующая `ShadowScene3D` без живого WebGL-рендера (передаёт mock/stub renderer; реальный shadow pre-pass не вызывается, только построение scene-графа). Если B1 не экспортировал такую фабрику, B2 добавляет её рядом с тестами B1 как тонкую обёртку, передающую stub `WebGLRenderer` (с no-op `shadowMap`, `setRenderTarget`, `render`). Конструирование сцены/лампы/камеры/receiver-объектов не требует GPU.

**Step 2 — run it, expect FAIL.**
```
npm test -- src/lux/shadowScene3D.test.ts
```
Ожидаемый вывод (FAIL): `scene.useExrReceiver is not a function` (метод ещё не объявлен на `ShadowScene3D`).

**Step 3 — minimal impl.** В `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` добавить импорт и метод. Импорт сверху:

```ts
import { roomMeshFromEXR } from './roomMesh'
```

Метод в классе `ShadowScene3D` (рядом с уже существующим `setReceiver`):

```ts
  /**
   * B2: заменить box-приёмник (B1) на EXR-mesh — целевой production-приёмник.
   * Тень корректно «взбирается» на реальную мебель/стены (геометрия комнаты),
   * без rubber-sheet (tear-culling) и без seam-dropout в контакте (bridge tris).
   * При отсутствии/битости worldPosData — оставляем box-fallback нетронутым.
   */
  useExrReceiver(
    shadowData: BuiltWorld['shadowData'],
    opts: { cols: number; rows: number; tearK: number; contactBand?: number },
  ): void {
    const wp = shadowData?.worldPosData
    if (!wp || !(wp.data instanceof Float32Array) || wp.width <= 1 || wp.height <= 1) {
      return // нет валидной EXR-карты → box fallback (B1) остаётся
    }
    const mesh = roomMeshFromEXR(wp, {
      cols: opts.cols,
      rows: opts.rows,
      tearK: opts.tearK,
      floorZ: shadowData!.floorZ,
      contactBand: opts.contactBand ?? 0.05,
    })
    this.setReceiver([mesh]) // setReceiver снимает прежний приёмник и ставит этот
  }
```

(`BuiltWorld` — тот же тип, что уже импортирован в `shadowScene3D.ts` для конструктора с B1; если импорта нет, добавить `import type { BuiltWorld } from '../scenes/worldScene'` — путь согласовать с фактическим определением `BuiltWorld`.)

**Step 4 — run, expect PASS.**
```
npm test -- src/lux/shadowScene3D.test.ts
```
Ожидаемо: оба новых кейса зелёные. Полный прогон `npm test` без регрессий.

**Step 5 — commit.**
```
git add src/lux/shadowScene3D.ts src/lux/shadowScene3D.test.ts
git commit -m "feat(shadow) B2: ShadowScene3D.useExrReceiver — swap box->EXR-mesh receiver (box stays fallback)"
```

---

### B2.5 — проводка: вызвать EXR-receiver при инициализации сцены тени (~128×228)

Подставляем mesh-приёмник в реальный путь сборки `ShadowScene3D`. По канону субсэмпл-сетка ~128×228 (портрет 9:16). Вызов делается **один раз** при наличии `shadowData.worldPosData` (mesh статичен — комната не двигается); если EXR нет, `useExrReceiver` тихо оставляет B1-box. `tearK` — стартовый knob (live-тюнинг в D2). Где именно дёргается `useExrReceiver` — в момент создания `ShadowScene3D` (B1 создаёт его при наличии `shadowData`), сразу после конструктора.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/compositor.ts` (место создания `ShadowScene3D` — добавлено в B1) **или** `/Users/iman/Projects/background_ar/src/main.ts` (где `ShadowScene3D` инстанцируется) — в зависимости от того, где B1 разместил создание сцены. Привязка: сразу после `new ShadowScene3D(...)`.
- Test: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.test.ts` (defaults-кейс)

**Step 1 — failing test.** Добавить в `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.test.ts` проверку дефолтной сетки (значения вынесены в экспортируемую константу, чтобы проводка и тест не разъезжались):

```ts
import { EXR_RECEIVER_OPTS } from './shadowScene3D'

describe('ShadowScene3D — default EXR receiver grid (~128×228 portrait)', () => {
  it('exports canonical subsample grid options', () => {
    expect(EXR_RECEIVER_OPTS.cols).toBe(128)
    expect(EXR_RECEIVER_OPTS.rows).toBe(228)
    expect(EXR_RECEIVER_OPTS.tearK).toBeGreaterThan(0)
    expect(EXR_RECEIVER_OPTS.contactBand).toBeGreaterThan(0)
  })
})
```

**Step 2 — run it, expect FAIL.**
```
npm test -- src/lux/shadowScene3D.test.ts
```
Ожидаемый вывод (FAIL): `No "EXR_RECEIVER_OPTS" export is defined on the "./shadowScene3D" module`.

**Step 3 — minimal impl.** В `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` экспортировать константу (рядом с объявлением класса):

```ts
// B2: канонический сабсэмпл сетки EXR-приёмника (портрет 9:16). tearK/contactBand —
// стартовые knob'и, тюнятся на live в D2 (спека §4.5).
export const EXR_RECEIVER_OPTS = { cols: 128, rows: 228, tearK: 4, contactBand: 0.05 } as const
```

В месте создания `ShadowScene3D` (там, где B1 его инстанцирует — `compositor.ts` или `main.ts`), сразу после конструктора добавить вызов:

```ts
const shadowScene3D = new ShadowScene3D(active.shadowData, this.renderer)
shadowScene3D.useExrReceiver(active.shadowData, EXR_RECEIVER_OPTS) // B2: EXR-mesh приёмник
```

(импортировать `EXR_RECEIVER_OPTS` рядом с импортом `ShadowScene3D`; имя переменной `active.shadowData` / `this.renderer` согласовать с фактическим B1-кодом в точке инстанцирования.)

**Step 4 — run, expect PASS.**
```
npm test -- src/lux/shadowScene3D.test.ts
```
Ожидаемо: кейс зелёный. Полный прогон:
```
npm test
```
Ожидаемо: все прежние ≥92 + новые тесты B2 зелёные, typecheck чистый.

**Step 5 — commit.**
```
git add src/lux/shadowScene3D.ts src/lux/compositor.ts src/main.ts
git commit -m "feat(shadow) B2: wire 128x228 EXR-mesh receiver into ShadowScene3D init"
```

---

### Exit criterion (спека §10, фаза B2)

**Unit (verifiable, без WebGL):**
```
npm test
```
Ожидаемо зелёные:
- `roomMeshFromEXR` строит сетку cols×rows: вершины из `sampleWorldXYZ`, **Uint32**-индекс, `computeVertexNormals`, `ShadowMaterial`+`receiveShadow=true` (B2.1).
- tear-culling вырезает квад на синтетическом глубинном разрыве и **не** трогает плоскую сетку (B2.2).
- **bridge-треугольники сохранены в контактной зоне** пол↔база-мебели (узел на полу → квад остаётся связным), а чисто-дальний разрыв всё равно рвётся (B2.3).
- `ShadowScene3D.useExrReceiver` ставит mesh-приёмник (ShadowMaterial, Uint32, нужное число вершин) и тихо оставляет box-fallback при отсутствии EXR (B2.4).
- общий счёт тестов > 92, typecheck чистый.

**Live / visual (GPU — не юнит-тестируется, делается с заказчиком):**
- Тень корректно **«взбирается» на реальную мебель/стены** (геометрия приёмника), без `rubber-sheet`-артефакта между ближней мебелью и фоном (tear-culling работает).
- В контактной зоне пол↔база-мебели **нет seam-dropout**: тень непрерывно ложится поперёк шва (bridge-треугольники держат поверхность связной).
- Оговорка для заказчика (спека §5/§8): «взбирание» обеспечивает геометрия приёмника, не глубина тела; наклон к/от камеры меняет тень слабо — сознательное ограничение монокулярной позы.
- B1 box остаётся рабочим fallback-полом (при отсутствии/битости `worldPosData` — мягкая деградация без падения).

**Что НЕ входит в B2 (границы фазы):** drive proxy от позы (C), интеграция multiply-blit-слота в `compositor.render()` через `shadowRT2` (D1), лестница деградации / crossfade / per-room `meta.shadowStrength` / `blobRatio` (D2). B2 поставляет только закоммиченный production-приёмник и его подстановку в `ShadowScene3D`.

---

## Phase C — Renderer: привод прокси от позы (anchor/scale/smoothing)

**Зависимость:** Phase B1 (создан `src/lux/shadowScene3D.ts` с классом `ProxyRig`, пулом капсул `castShadow=true, material.colorWrite=false, material.depthWrite=false, visible=true`, статическим тест-прокси в известной мировой точке; `ShadowScene3D` с запечённой камерой и box-receiver). Phase C **приводит** этот прокси от живой позы: переносит `sampleWorldXYZ` в `shadowGeom.ts`, реализует чистые helpers для F-anchor + F sanity-gate + H-scale + temporal smoothing/z-damp, и наполняет `ProxyRig.update(poseWorld, F, H)` размещением капсул из 33 landmark'ов с ориентацией из самих landmark'ов (без force-face-camera).

**Тест-команда (vitest, из CURRENT CODE):** `cd /Users/iman/Projects/background_ar && npm test` (= `vitest run`). Все three.js геометрия/математика тестируется без WebGL (массивы вершин, трансформы, parse-логика). GPU-рендер — только live-приёмка в конце фазы.

**Базовая планка:** ≥92 теста зелёных + `tsc` чист (`npm run build` запускает `tsc && vite build`; в Phase C достаточно `npm test`, typecheck покрывается в B/D). Каждая задача добавляет тесты сверх планки.

---

### C.1 — Перенос `sampleWorldXYZ` из `main.ts` в `shadowGeom.ts` (пререквизит §5/§7/§10 контракт TS)

Контракт: `sampleWorldXYZ(worldPosData, u, v): [number,number,number]` ПЕРЕМЕЩАЕТСЯ из `main.ts` в `shadowGeom.ts` (`px=round(u*(w-1))`, `py=round(v*(h-1))`, `flipY=false`). `main.ts` импортирует её. `roomMeshFromEXR` и renderer-модули зависят от неё в `shadowGeom.ts`.

**Files:**
- Create: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts` (дописать describe — файл уже есть)
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts` (добавить экспорт `sampleWorldXYZ` в конец)
- Modify: `/Users/iman/Projects/background_ar/src/main.ts:31-39` (удалить локальную функцию), `:20` (добавить в импорт), `:202` (вызов остаётся, через импорт)
- Test: `src/lux/shadowGeom.test.ts`

**Шаг 1 — failing-тест.** Дописать в конец `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts`:

```ts
import { sampleWorldXYZ } from './shadowGeom'

describe('sampleWorldXYZ', () => {
  // 2×2 EXR-семпл, RGBA Float32 (4 канала на тексель), row0 = верх (flipY=false)
  const wp = {
    width: 2,
    height: 2,
    data: new Float32Array([
      // (px0,py0)        (px1,py0)
      10, 20, 30, 1, 11, 21, 31, 1,
      // (px0,py1)        (px1,py1)
      12, 22, 32, 1, 13, 23, 33, 1,
    ]),
  }

  it('сэмплит угол (u=0,v=0) → px=0,py=0, первый тексель, без альфы', () => {
    expect(sampleWorldXYZ(wp, 0, 0)).toEqual([10, 20, 30])
  })

  it('сэмплит угол (u=1,v=1) → px=1,py=1 (round(u*(w-1))), последний тексель', () => {
    expect(sampleWorldXYZ(wp, 1, 1)).toEqual([13, 23, 33])
  })

  it('flipY=false: v=1 идёт в py=h-1 (нижний ряд data), v=0 — в py=0', () => {
    expect(sampleWorldXYZ(wp, 0, 1)).toEqual([12, 22, 32]) // px0, py1
    expect(sampleWorldXYZ(wp, 1, 0)).toEqual([11, 21, 31]) // px1, py0
  })

  it('клампит u/v за пределы [0,1] в крайние тексели', () => {
    expect(sampleWorldXYZ(wp, -5, -5)).toEqual([10, 20, 30])
    expect(sampleWorldXYZ(wp, 9, 9)).toEqual([13, 23, 33])
  })
})
```

**Шаг 2 — запустить, увидеть FAIL.**
Команда: `cd /Users/iman/Projects/background_ar && npm test`
Ожидаемый вывод (фрагмент):
```
FAIL  src/lux/shadowGeom.test.ts > sampleWorldXYZ
SyntaxError: The requested module './shadowGeom' does not provide an export named 'sampleWorldXYZ'
```

**Шаг 3 — минимальная импл.** Добавить в конец `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts`:

```ts
// Мировая XYZ-точка пикселя плейта (u,v в [0..1], v вверх). Данные EXR row0=верх.
// Перенесено из main.ts (контракт §5/§7): renderer-модули (roomMeshFromEXR) импортируют отсюда.
export function sampleWorldXYZ(
  wp: { data: Float32Array; width: number; height: number }, u: number, v: number,
): Vec3 {
  // как шейдер: texture(tWorld, (u,v)) с flipY=false → data row = v*(h-1)
  const px = Math.min(wp.width - 1, Math.max(0, Math.round(u * (wp.width - 1))))
  const py = Math.min(wp.height - 1, Math.max(0, Math.round(v * (wp.height - 1))))
  const i = (py * wp.width + px) * 4
  return [wp.data[i], wp.data[i + 1], wp.data[i + 2]]
}
```

Затем удалить локальную копию из `/Users/iman/Projects/background_ar/src/main.ts:30-39` (строки от комментария `// Мировая XYZ-точка...` до закрывающей `}`) и подключить через импорт. Заменить строку 20:

```ts
import { personFloorWorld } from './lux/shadowGeom'
```
на
```ts
import { personFloorWorld, sampleWorldXYZ } from './lux/shadowGeom'
```

Вызов на `main.ts:202` (`const F = sampleWorldXYZ(sd.worldPosData, 1 - (x0 + x1) / 2, 1 - y1)`) остаётся без изменений — теперь резолвится из импорта.

**Шаг 4 — запустить, увидеть PASS.**
Команда: `cd /Users/iman/Projects/background_ar && npm test`
Ожидаемый вывод (фрагмент):
```
✓ src/lux/shadowGeom.test.ts > sampleWorldXYZ > сэмплит угол (u=0,v=0) → px=0,py=0, первый тексель, без альфы
✓ src/lux/shadowGeom.test.ts > sampleWorldXYZ > сэмплит угол (u=1,v=1) → px=1,py=1 (round(u*(w-1))), последний тексель
✓ src/lux/shadowGeom.test.ts > sampleWorldXYZ > flipY=false: v=1 идёт в py=h-1 (нижний ряд data), v=0 — в py=0
✓ src/lux/shadowGeom.test.ts > sampleWorldXYZ > клампит u/v за пределы [0,1] в крайние тексели
Test Files  ... passed
```

**Шаг 5 — commit.**
```
git add src/lux/shadowGeom.ts src/lux/shadowGeom.test.ts src/main.ts
git commit -m "$(cat <<'EOF'
refactor(shadow) C.1: вынос sampleWorldXYZ в shadowGeom (пререквизит proxy-привода)

Перенёс sampleWorldXYZ из main.ts в shadowGeom.ts (px=round(u*(w-1)),
py=round(v*(h-1)), flipY=false), чтобы renderer-модули (ProxyRig/roomMeshFromEXR)
импортировали её из общего места. main.ts теперь импортирует, локальная копия удалена.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### C.2 — F sanity-gate: чистый предикат `acceptFloorAnchor` (§5, контракт `Z_THR=0.15`)

Контракт degradation: «F sanity-gate: reject F when `abs(F.z - floorZ) > Z_THR (=0.15)` -> fall back to v1 this frame.» Реализуем как чистую функцию в `shadowGeom.ts` — тестируется без рендера, потребляется и main.ts (выбор fallback), и (в D2) лестницей деградации.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts` (добавить `Z_THR` + `acceptFloorAnchor`)
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts` (новый describe)
- Test: `src/lux/shadowGeom.test.ts`

**Шаг 1 — failing-тест.** Дописать в `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts`:

```ts
import { acceptFloorAnchor, Z_THR } from './shadowGeom'

describe('acceptFloorAnchor (F sanity-gate §5)', () => {
  it('Z_THR = 0.15 (контракт)', () => {
    expect(Z_THR).toBe(0.15)
  })

  it('F.z ровно на полу → принимаем', () => {
    expect(acceptFloorAnchor([3, 1, 0.0], 0.0)).toBe(true)
  })

  it('F.z в пределах порога (|Δ| < 0.15) → принимаем', () => {
    expect(acceptFloorAnchor([3, 1, 0.1], 0.0)).toBe(true)
    expect(acceptFloorAnchor([3, 1, -0.1], 0.0)).toBe(true)
  })

  it('F.z далеко от floorZ (стена/разрыв, |Δ| > 0.15) → отвергаем → fallback v1', () => {
    expect(acceptFloorAnchor([3, 1, 1.6], 0.0)).toBe(false) // ступни «улетели» на стену
    expect(acceptFloorAnchor([3, 1, 0.5], 0.0)).toBe(false)
  })

  it('учитывает ненулевой floorZ', () => {
    expect(acceptFloorAnchor([3, 1, 1.05], 1.0)).toBe(true)  // |1.05-1.0|=0.05 < 0.15
    expect(acceptFloorAnchor([3, 1, 1.3], 1.0)).toBe(false)  // |1.3-1.0|=0.30 > 0.15
  })

  it('нечисловой/NaN сэмпл (битый EXR-пиксель) → отвергаем', () => {
    expect(acceptFloorAnchor([3, 1, NaN], 0.0)).toBe(false)
  })
})
```

**Шаг 2 — запустить, увидеть FAIL.**
Команда: `cd /Users/iman/Projects/background_ar && npm test`
Ожидаемый вывод (фрагмент):
```
FAIL  src/lux/shadowGeom.test.ts > acceptFloorAnchor (F sanity-gate §5)
SyntaxError: The requested module './shadowGeom' does not provide an export named 'acceptFloorAnchor'
```

**Шаг 3 — минимальная импл.** Добавить в `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts`:

```ts
// F sanity-gate (спека §5): если ступни попали на дальнюю стену / разрыв EXR,
// |F.z - floorZ| вылетит за порог → отвергаем F и падаем на fallback v1 этот кадр.
// Без гейта монокулярный шум даёт дёрганые телепорты тени на метры.
export const Z_THR = 0.15

export function acceptFloorAnchor(F: Vec3, floorZ: number): boolean {
  if (!isFinite(F[2])) return false
  return Math.abs(F[2] - floorZ) <= Z_THR
}
```

**Шаг 4 — запустить, увидеть PASS.**
Команда: `cd /Users/iman/Projects/background_ar && npm test`
Ожидаемый вывод (фрагмент):
```
✓ src/lux/shadowGeom.test.ts > acceptFloorAnchor (F sanity-gate §5) > Z_THR = 0.15 (контракт)
✓ src/lux/shadowGeom.test.ts > acceptFloorAnchor (F sanity-gate §5) > F.z ровно на полу → принимаем
✓ src/lux/shadowGeom.test.ts > acceptFloorAnchor (F sanity-gate §5) > F.z далеко от floorZ ... → fallback v1
✓ src/lux/shadowGeom.test.ts > acceptFloorAnchor (F sanity-gate §5) > нечисловой/NaN сэмпл ... → отвергаем
Test Files  ... passed
```

**Шаг 5 — commit.**
```
git add src/lux/shadowGeom.ts src/lux/shadowGeom.test.ts
git commit -m "$(cat <<'EOF'
feat(shadow) C.2: F sanity-gate (Z_THR=0.15) — чистый предикат acceptFloorAnchor

Отвергаем якорь ступней F, когда |F.z - floorZ| > 0.15 (ступни попали на
дальнюю стену/разрыв EXR) или сэмпл NaN → этот кадр падает на fallback v1.
Чистая функция в shadowGeom, потребляется main.ts и (в D2) лестницей деградации.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### C.3 — Temporal smoothing + z-damp: чистый `PoseSmoother` (§5, §8)

Контракт §5/§8: «Demпф z + временное сглаживание (exp-smooth, как F/H) — чтобы убрать дрожь, не чтобы добиться точной глубины». main.ts уже сглаживает F/H через `k = 1 - exp(-dt*8)` (`main.ts:203-207`). Phase C добавляет сглаживание **самой позы** (33 landmark'а) + **доп. демпф z-оси** каждого landmark'а (монокулярная глубина шумная — давим её сильнее, чем xy). Чистый класс в `shadowGeom.ts`: вход `poseWorld: number[][]` + `dt`, выход сглаженный `number[][]`.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts` (класс `PoseSmoother`)
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts` (новый describe)
- Test: `src/lux/shadowGeom.test.ts`

**Шаг 1 — failing-тест.** Дописать в `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts`:

```ts
import { PoseSmoother } from './shadowGeom'

// мини-поза: 2 landmark'а [x,y,z,visibility] (тест не зависит от полных 33)
const A = [[0, 0, 0, 1], [1, 1, 1, 1]]
const B = [[10, 10, 10, 1], [11, 11, 11, 1]]

describe('PoseSmoother (§5 exp-smooth + z-damp)', () => {
  it('первый кадр проходит как есть (нет истории) — но z всё равно демпфируется к 0 старту', () => {
    const s = new PoseSmoother()
    const out = s.push(A, 0.016)
    expect(out[0][0]).toBeCloseTo(0, 6)
    expect(out[1][0]).toBeCloseTo(1, 6)
  })

  it('exp-smooth тянет к новой цели, не допрыгивая за один кадр', () => {
    const s = new PoseSmoother()
    s.push(A, 0.016)
    const out = s.push(B, 0.016) // dt=16мс, k = 1-exp(-0.016*8) ≈ 0.120
    // x движется к 10 на ~12%: между стартом 0 и целью 10
    expect(out[0][0]).toBeGreaterThan(0)
    expect(out[0][0]).toBeLessThan(10)
    expect(out[0][0]).toBeCloseTo((10 - 0) * (1 - Math.exp(-0.016 * 8)), 4)
  })

  it('z демпфируется СИЛЬНЕЕ xy: при равном скачке z двигается медленнее x', () => {
    const sx = new PoseSmoother()
    sx.push(A, 0.016)
    const out = sx.push(B, 0.016)
    const dx = out[0][0] - 0 // продвижение по x
    const dz = out[0][2] - 0 // продвижение по z (демпф)
    expect(dz).toBeLessThan(dx) // z отстаёт от x → схлопывание к фронто-параллели (§5)
    expect(dz).toBeGreaterThan(0)
  })

  it('visibility (канал 3) переносится из последней цели без сглаживания', () => {
    const s = new PoseSmoother()
    s.push(A, 0.016)
    const out = s.push([[10, 10, 10, 0.42], [11, 11, 11, 0.9]], 0.016)
    expect(out[0][3]).toBe(0.42)
    expect(out[1][3]).toBe(0.9)
  })

  it('стабильный вход → выход сходится к нему (дрожь гаснет)', () => {
    const s = new PoseSmoother()
    for (let i = 0; i < 200; i++) s.push(B, 0.016)
    const out = s.push(B, 0.016)
    expect(out[0][0]).toBeCloseTo(10, 3)
    expect(out[0][2]).toBeCloseTo(10, 3) // z тоже доходит, просто медленнее
  })
})
```

**Шаг 2 — запустить, увидеть FAIL.**
Команда: `cd /Users/iman/Projects/background_ar && npm test`
Ожидаемый вывод (фрагмент):
```
FAIL  src/lux/shadowGeom.test.ts > PoseSmoother (§5 exp-smooth + z-damp)
SyntaxError: The requested module './shadowGeom' does not provide an export named 'PoseSmoother'
```

**Шаг 3 — минимальная импл.** Добавить в `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts`:

```ts
// Временное сглаживание позы (спека §5/§8). exp-smooth как F/H в main.ts (k=1-exp(-dt*RATE)),
// плюс ДОП. демпф z-оси: монокулярная глубина pose.world.z шумная и грубо откалибрована,
// давим её сильнее xy (множитель Z_DAMP). Это убирает дрожь и маскирует транспортный
// рассинхрон pose↔силуэт; НЕ даёт точной глубины — прокси схлопывается к фронто-параллели.
const POSE_SMOOTH_RATE = 8   // как F/H (main.ts: k = 1-exp(-dt*8))
const Z_DAMP = 0.35          // z-канал тянется к цели медленнее xy (0..1, меньше = жёстче демпф)

export class PoseSmoother {
  private prev: number[][] | null = null

  push(target: number[][], dt: number): number[][] {
    const k = 1 - Math.exp(-dt * POSE_SMOOTH_RATE)
    if (this.prev === null) {
      // первый кадр: копируем цель как есть (нет истории для интерполяции)
      this.prev = target.map((lm) => [lm[0], lm[1], lm[2], lm[3]])
      return this.prev.map((lm) => [lm[0], lm[1], lm[2], lm[3]])
    }
    const out: number[][] = []
    for (let i = 0; i < target.length; i++) {
      const p = this.prev[i] ?? target[i]
      const t = target[i]
      const x = p[0] + (t[0] - p[0]) * k
      const y = p[1] + (t[1] - p[1]) * k
      const z = p[2] + (t[2] - p[2]) * k * Z_DAMP // z тянется медленнее → демпф глубины
      out.push([x, y, z, t[3]])                    // visibility — из цели, без сглаживания
    }
    this.prev = out.map((lm) => [lm[0], lm[1], lm[2], lm[3]])
    return out
  }
}
```

**Шаг 4 — запустить, увидеть PASS.**
Команда: `cd /Users/iman/Projects/background_ar && npm test`
Ожидаемый вывод (фрагмент):
```
✓ src/lux/shadowGeom.test.ts > PoseSmoother (§5 exp-smooth + z-damp) > первый кадр проходит как есть ...
✓ src/lux/shadowGeom.test.ts > PoseSmoother (§5 exp-smooth + z-damp) > exp-smooth тянет к новой цели ...
✓ src/lux/shadowGeom.test.ts > PoseSmoother (§5 exp-smooth + z-damp) > z демпфируется СИЛЬНЕЕ xy ...
✓ src/lux/shadowGeom.test.ts > PoseSmoother (§5 exp-smooth + z-damp) > visibility ... переносится ...
✓ src/lux/shadowGeom.test.ts > PoseSmoother (§5 exp-smooth + z-damp) > стабильный вход → сходится ...
Test Files  ... passed
```

**Шаг 5 — commit.**
```
git add src/lux/shadowGeom.ts src/lux/shadowGeom.test.ts
git commit -m "$(cat <<'EOF'
feat(shadow) C.3: PoseSmoother — exp-smooth позы + усиленный демпф z-оси

exp-smooth (k=1-exp(-dt*8), как F/H в main.ts) по 33 landmark'ам; z-канал
тянется к цели медленнее xy (Z_DAMP=0.35) — монокулярная глубина шумна,
давим её и маскируем транспортный рассинхрон pose↔силуэт. visibility — из цели.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### C.4 — Индексы landmark'ов + чистые трансформы капсул `proxyCapsuleTransforms` (§4.2, контракт ориентация-из-landmarks)

Контракт `ProxyRig`: «place capsules from landmarks (orientation FROM landmarks, no force-face-camera)». §4.2: капсулы между суставами — торс (плечи↔бёдра), руки 11→13→15 и 12→14→16, ноги 23→25→27 и 24→26→28, голова — сфера у nose/ear. Выделяем **чистую математику** размещения сегмента (центр + кватернион «ось Y капсулы → вектор сустав→сустав» + длина) в тестируемую функцию `proxyCapsuleTransforms(poseWorld)` в `shadowGeom.ts` — без three.js рендера (можно использовать `three` только для Vector3/Quaternion-математики, как уже принято в кодовой базе `import * as THREE from 'three'`). `ProxyRig.update` (C.5) применит эти трансформы к пулу мешей.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts` (`POSE_IDX`, `CapsuleXf`, `proxyCapsuleTransforms`)
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts` (новый describe)
- Test: `src/lux/shadowGeom.test.ts`

**Шаг 1 — failing-тест.** Дописать в `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts`:

```ts
import * as THREE from 'three'
import { proxyCapsuleTransforms, POSE_IDX, type CapsuleXf } from './shadowGeom'

// синтетическая поза «по стойке смирно»: задаём только нужные суставы, остальные [0,0,0,0].
function blankPose(): number[][] {
  return Array.from({ length: 33 }, () => [0, 0, 0, 0])
}
function withJoints(setter: (p: number[][]) => void): number[][] {
  const p = blankPose()
  setter(p)
  return p
}

describe('POSE_IDX (MediaPipe Pose 33-landmark константы)', () => {
  it('канонические индексы суставов', () => {
    expect(POSE_IDX.L_SHOULDER).toBe(11)
    expect(POSE_IDX.R_SHOULDER).toBe(12)
    expect(POSE_IDX.L_ELBOW).toBe(13)
    expect(POSE_IDX.L_WRIST).toBe(15)
    expect(POSE_IDX.R_WRIST).toBe(16)
    expect(POSE_IDX.L_HIP).toBe(23)
    expect(POSE_IDX.R_HIP).toBe(24)
    expect(POSE_IDX.L_KNEE).toBe(25)
    expect(POSE_IDX.L_ANKLE).toBe(27)
    expect(POSE_IDX.R_ANKLE).toBe(28)
    expect(POSE_IDX.NOSE).toBe(0)
  })
})

describe('proxyCapsuleTransforms (§4.2 ориентация из landmarks)', () => {
  it('левое предплечье вдоль +Y → кватернион ~identity (ось капсулы Y совпала с сегментом)', () => {
    const p = withJoints((p) => {
      p[POSE_IDX.L_ELBOW] = [0, 0, 0, 1]
      p[POSE_IDX.L_WRIST] = [0, 1, 0, 1] // сегмент вверх по +Y
    })
    const xfs = proxyCapsuleTransforms(p)
    const fa = xfs.find((x) => x.name === 'forearm_L')!
    expect(fa).toBeDefined()
    // центр сегмента — середина
    expect(fa.center[0]).toBeCloseTo(0, 5)
    expect(fa.center[1]).toBeCloseTo(0.5, 5)
    expect(fa.length).toBeCloseTo(1, 5)
    // кватернион поворачивает (0,1,0)→(0,1,0): практически identity
    const q = new THREE.Quaternion(fa.quat[0], fa.quat[1], fa.quat[2], fa.quat[3])
    const yAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    expect(yAxis.x).toBeCloseTo(0, 5)
    expect(yAxis.y).toBeCloseTo(1, 5)
    expect(yAxis.z).toBeCloseTo(0, 5)
  })

  it('поднятая рука → кватернион плеча меняется (артикуляция, §10 live-критерий)', () => {
    const down = withJoints((p) => {
      p[POSE_IDX.L_SHOULDER] = [0, 0, 0, 1]
      p[POSE_IDX.L_ELBOW] = [0, -1, 0, 1] // рука вниз
    })
    const up = withJoints((p) => {
      p[POSE_IDX.L_SHOULDER] = [0, 0, 0, 1]
      p[POSE_IDX.L_ELBOW] = [0, 1, 0, 1]  // рука вверх
    })
    const qDown = proxyCapsuleTransforms(down).find((x) => x.name === 'upperarm_L')!.quat
    const qUp = proxyCapsuleTransforms(up).find((x) => x.name === 'upperarm_L')!.quat
    // разные ориентации сегмента → разные кватернионы
    const dot = Math.abs(qDown[0] * qUp[0] + qDown[1] * qUp[1] + qDown[2] * qUp[2] + qDown[3] * qUp[3])
    expect(dot).toBeLessThan(0.99)
  })

  it('поворот корпуса (yaw) берётся из landmarks, НЕ force-face-camera', () => {
    // плечи развёрнуты по оси Z (yaw): L спереди (+x), R сзади (-x) при общем Y
    const turned = withJoints((p) => {
      p[POSE_IDX.L_SHOULDER] = [0.2, 0, 0.1, 1]
      p[POSE_IDX.R_SHOULDER] = [-0.2, 0, -0.1, 1]
      p[POSE_IDX.L_HIP] = [0.1, -1, 0.1, 1]
      p[POSE_IDX.R_HIP] = [-0.1, -1, -0.1, 1]
    })
    const torso = proxyCapsuleTransforms(turned).find((x) => x.name === 'torso')!
    // торс-сегмент несёт z-компоненту (реальный yaw сохранён, не обнулён фронтальным force)
    const q = new THREE.Quaternion(torso.quat[0], torso.quat[1], torso.quat[2], torso.quat[3])
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    expect(Math.abs(axis.z)).toBeGreaterThan(0.001) // ось торса наклонена в z → yaw сохранён
  })

  it('сегмент с низкой visibility (joint не виден) пропускается', () => {
    const p = withJoints((p) => {
      p[POSE_IDX.L_ELBOW] = [0, 0, 0, 0.1] // ниже порога видимости
      p[POSE_IDX.L_WRIST] = [0, 1, 0, 0.1]
    })
    const xfs = proxyCapsuleTransforms(p)
    expect(xfs.find((x) => x.name === 'forearm_L')).toBeUndefined()
  })

  it('голова — сфера (length≈0, радиус-маркер) у nose', () => {
    const p = withJoints((p) => {
      p[POSE_IDX.NOSE] = [0, 1.7, 0, 1]
    })
    const head = proxyCapsuleTransforms(p).find((x) => x.name === 'head')!
    expect(head).toBeDefined()
    expect(head.center[1]).toBeCloseTo(1.7, 5)
  })
})
```

**Шаг 2 — запустить, увидеть FAIL.**
Команда: `cd /Users/iman/Projects/background_ar && npm test`
Ожидаемый вывод (фрагмент):
```
FAIL  src/lux/shadowGeom.test.ts > proxyCapsuleTransforms (§4.2 ориентация из landmarks)
SyntaxError: The requested module './shadowGeom' does not provide an export named 'proxyCapsuleTransforms'
```

**Шаг 3 — минимальная импл.** Добавить в `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts` (в начало файла — рядом с импортами добавить `import * as THREE from 'three'`):

```ts
import * as THREE from 'three'
```

И в тело файла:

```ts
// Индексы MediaPipe Pose (33 landmark'а). Только используемые ProxyRig (§4.2).
export const POSE_IDX = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
} as const

// Трансформ одной капсулы (или сферы головы): центр сегмента, кватернион
// (ось капсулы +Y → вектор сустав→сустав), длина сегмента. Радиусы — у ProxyRig.
export interface CapsuleXf {
  name: string
  center: Vec3
  quat: [number, number, number, number] // x,y,z,w
  length: number
}

const VIS_MIN = 0.5 // joint считается видимым (зеркально POSE_VIS_THRESH в capture)
// [сегмент-имя, индекс сустава A, индекс сустава B]
const SEGMENTS: [string, number, number][] = [
  ['upperarm_L', POSE_IDX.L_SHOULDER, POSE_IDX.L_ELBOW],
  ['forearm_L', POSE_IDX.L_ELBOW, POSE_IDX.L_WRIST],
  ['upperarm_R', POSE_IDX.R_SHOULDER, POSE_IDX.R_ELBOW],
  ['forearm_R', POSE_IDX.R_ELBOW, POSE_IDX.R_WRIST],
  ['thigh_L', POSE_IDX.L_HIP, POSE_IDX.L_KNEE],
  ['shin_L', POSE_IDX.L_KNEE, POSE_IDX.L_ANKLE],
  ['thigh_R', POSE_IDX.R_HIP, POSE_IDX.R_KNEE],
  ['shin_R', POSE_IDX.R_KNEE, POSE_IDX.R_ANKLE],
]

const _yAxis = new THREE.Vector3(0, 1, 0)
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _q = new THREE.Quaternion()

function visible(lm: number[] | undefined): boolean {
  return !!lm && (lm[3] ?? 0) >= VIS_MIN
}

function segmentXf(name: string, a: number[], b: number[]): CapsuleXf {
  _a.set(a[0], a[1], a[2])
  _b.set(b[0], b[1], b[2])
  _dir.subVectors(_b, _a)
  const length = _dir.length()
  // кватернион: ось капсулы +Y → направление сегмента (ориентация ИЗ landmarks, §4.2)
  if (length > 1e-6) _q.setFromUnitVectors(_yAxis, _dir.clone().normalize())
  else _q.identity()
  return {
    name,
    center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
    quat: [_q.x, _q.y, _q.z, _q.w],
    length,
  }
}

// Чистая математика: 33 world-landmark'а → трансформы капсул (центр/кватернион/длина).
// Ориентация — из самих landmarks (никакого force-face-camera, §4.2). Невидимые
// суставы пропускаются. Корень/скейл (F,H) применяет ProxyRig поверх (C.5).
export function proxyCapsuleTransforms(poseWorld: number[][]): CapsuleXf[] {
  const out: CapsuleXf[] = []

  // торс: середина плеч ↔ середина бёдер
  const ls = poseWorld[POSE_IDX.L_SHOULDER], rs = poseWorld[POSE_IDX.R_SHOULDER]
  const lh = poseWorld[POSE_IDX.L_HIP], rh = poseWorld[POSE_IDX.R_HIP]
  if (visible(ls) && visible(rs) && visible(lh) && visible(rh)) {
    const shoulderMid = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2, (ls[2] + rs[2]) / 2]
    const hipMid = [(lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2, (lh[2] + rh[2]) / 2]
    out.push(segmentXf('torso', hipMid, shoulderMid))
  }

  // конечности
  for (const [name, ai, bi] of SEGMENTS) {
    const a = poseWorld[ai], b = poseWorld[bi]
    if (visible(a) && visible(b)) out.push(segmentXf(name, a, b))
  }

  // голова — сфера-маркер у носа (length=0, ProxyRig ставит радиус головы)
  const nose = poseWorld[POSE_IDX.NOSE]
  if (visible(nose)) {
    out.push({ name: 'head', center: [nose[0], nose[1], nose[2]], quat: [0, 0, 0, 1], length: 0 })
  }

  return out
}
```

**Шаг 4 — запустить, увидеть PASS.**
Команда: `cd /Users/iman/Projects/background_ar && npm test`
Ожидаемый вывод (фрагмент):
```
✓ src/lux/shadowGeom.test.ts > POSE_IDX (MediaPipe Pose 33-landmark константы) > канонические индексы суставов
✓ src/lux/shadowGeom.test.ts > proxyCapsuleTransforms ... > левое предплечье вдоль +Y → кватернион ~identity
✓ src/lux/shadowGeom.test.ts > proxyCapsuleTransforms ... > поднятая рука → кватернион плеча меняется
✓ src/lux/shadowGeom.test.ts > proxyCapsuleTransforms ... > поворот корпуса (yaw) берётся из landmarks
✓ src/lux/shadowGeom.test.ts > proxyCapsuleTransforms ... > сегмент с низкой visibility ... пропускается
✓ src/lux/shadowGeom.test.ts > proxyCapsuleTransforms ... > голова — сфера ... у nose
Test Files  ... passed
```

**Шаг 5 — commit.**
```
git add src/lux/shadowGeom.ts src/lux/shadowGeom.test.ts
git commit -m "$(cat <<'EOF'
feat(shadow) C.4: proxyCapsuleTransforms — капсулы из landmarks (ориентация из позы)

POSE_IDX (33-landmark константы) + чистая математика segment→capsule:
центр/кватернион(ось +Y→сегмент)/длина для торса, рук 11→13→15 / 12→14→16,
ног 23→25→27 / 24→26→28, голова-сфера у nose. Ориентация ИЗ landmarks,
никакого force-face-camera (§4.2); невидимые суставы пропускаются.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### C.5 — `ProxyRig.update(poseWorld, F, H)` — привод пула капсул от позы (§4.2, контракт TS)

Контракт `ProxyRig`: «`update(poseWorld: number[][], F: THREE.Vector3, H: number): void` — translate root to F, scale to H, place capsules from landmarks (orientation FROM landmarks, no force-face-camera); `get object(): THREE.Group`». B1 уже построил конструктор с пулом капсул (`castShadow=true, colorWrite=false, depthWrite=false, visible=true`) и статическим тест-прокси. Phase C наполняет `update()`: корень `THREE.Group` транслируется в F, масштабируется так, чтобы рост (hip→shoulder в позе) дал высоту H, а капсулы получают трансформы из `proxyCapsuleTransforms` (C.4). Тестируется через инспекцию `object` (позиция/скейл группы, position/quaternion/scale.y капсул) — без GPU.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` (тело метода `update`, создан в B1)
- Create: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.test.ts`
- Test: `src/lux/shadowScene3D.test.ts`

> Примечание: `ShadowScene3D` (полный класс с baked-камерой/лампами/рендером) и `multiplyBlitMat`/`shadowRT2`/compositor-проводка — это Phase B1/D1, **не** C. В C тестируем и наполняем только `ProxyRig.update`. Если в B1 конструктор `ProxyRig` уже инстанцирует `THREE.CapsuleGeometry`/`Mesh`, тест работает на jsdom без WebGL-контекста: создаём геометрию/материал/группу, но **не** рендерим (это чистый scene-graph three.js, как в существующих геометрических тестах).

**Шаг 1 — failing-тест.** Создать `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { ProxyRig } from './shadowScene3D'
import { POSE_IDX } from './shadowGeom'

// синтетическая поза в метрах (hip-origin): прямая стойка, рост ~ плечи над бёдрами.
function standingPose(): number[][] {
  const p = Array.from({ length: 33 }, () => [0, 0, 0, 0])
  p[POSE_IDX.L_SHOULDER] = [-0.2, 0.5, 0, 1]
  p[POSE_IDX.R_SHOULDER] = [0.2, 0.5, 0, 1]
  p[POSE_IDX.L_HIP] = [-0.1, 0, 0, 1]
  p[POSE_IDX.R_HIP] = [0.1, 0, 0, 1]
  p[POSE_IDX.L_ELBOW] = [-0.25, 0.2, 0, 1]
  p[POSE_IDX.L_WRIST] = [-0.3, -0.1, 0, 1]
  p[POSE_IDX.L_KNEE] = [-0.1, -0.5, 0, 1]
  p[POSE_IDX.L_ANKLE] = [-0.1, -0.9, 0, 1]
  p[POSE_IDX.NOSE] = [0, 0.75, 0, 1]
  return p
}

describe('ProxyRig.update (§4.2 привод от позы)', () => {
  it('корень группы транслируется в F', () => {
    const rig = new ProxyRig()
    rig.update(standingPose(), new THREE.Vector3(3, 1.5, 0), 1.7)
    expect(rig.object.position.x).toBeCloseTo(3, 5)
    expect(rig.object.position.y).toBeCloseTo(1.5, 5)
    expect(rig.object.position.z).toBeCloseTo(0, 5)
  })

  it('группа масштабируется к росту H (uniform scale > 0)', () => {
    const rig = new ProxyRig()
    rig.update(standingPose(), new THREE.Vector3(0, 0, 0), 1.7)
    expect(rig.object.scale.x).toBeGreaterThan(0)
    expect(rig.object.scale.x).toEqual(rig.object.scale.y)
    expect(rig.object.scale.y).toEqual(rig.object.scale.z)
  })

  it('бОльший H → бОльший скейл (рост двигает прокси)', () => {
    const small = new ProxyRig()
    small.update(standingPose(), new THREE.Vector3(0, 0, 0), 1.4)
    const big = new ProxyRig()
    big.update(standingPose(), new THREE.Vector3(0, 0, 0), 2.0)
    expect(big.object.scale.y).toBeGreaterThan(small.object.scale.y)
  })

  it('видимые капсулы активны (visible=true), невидимые-суставы — спрятаны из пула', () => {
    const rig = new ProxyRig()
    rig.update(standingPose(), new THREE.Vector3(0, 0, 0), 1.7)
    // у standingPose правая рука/нога не заданы (visibility=0) → их капсулы скрыты,
    // левые — видимы. Считаем активные капсулы (visible && castShadow).
    let active = 0
    rig.object.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh && m.visible && m.castShadow) active++
    })
    expect(active).toBeGreaterThan(0)
  })

  it('каждый кадр сегмент перемещается без аллокации новых мешей (пул переиспользуется)', () => {
    const rig = new ProxyRig()
    rig.update(standingPose(), new THREE.Vector3(0, 0, 0), 1.7)
    let count1 = 0
    rig.object.traverse((o) => { if ((o as THREE.Mesh).isMesh) count1++ })
    // другая поза (рука поднята) — тот же пул
    const raised = standingPose()
    raised[POSE_IDX.L_WRIST] = [-0.3, 0.9, 0, 1]
    rig.update(raised, new THREE.Vector3(0, 0, 0), 1.7)
    let count2 = 0
    rig.object.traverse((o) => { if ((o as THREE.Mesh).isMesh) count2++ })
    expect(count2).toBe(count1) // число мешей не выросло
  })

  it('невидимый каст: материал colorWrite=false, depthWrite=false, но mesh.visible=true', () => {
    const rig = new ProxyRig()
    rig.update(standingPose(), new THREE.Vector3(0, 0, 0), 1.7)
    rig.object.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh && m.visible) {
        const mat = m.material as THREE.Material
        expect(mat.colorWrite).toBe(false)
        expect(mat.depthWrite).toBe(false)
        expect(m.castShadow).toBe(true)
      }
    })
  })
})
```

**Шаг 2 — запустить, увидеть FAIL.**
Команда: `cd /Users/iman/Projects/background_ar && npm test`
Ожидаемый вывод (фрагмент):
```
FAIL  src/lux/shadowScene3D.test.ts > ProxyRig.update (§4.2 привод от позы) > корень группы транслируется в F
AssertionError: expected 0 to be close to 3
  (update() — пустой каркас из B1, ещё не двигает корень/капсулы)
```
*(Если B1 оставил `update` как no-op заглушку, провалятся assert'ы значений; если метод вообще отсутствует — `TypeError: rig.update is not a function`.)*

**Шаг 3 — минимальная импл.** Наполнить метод `update` в `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` (конструктор и пул `_capsules: Map<string, THREE.Mesh>` + `_root: THREE.Group` уже из B1; добавить недостающее — `proxyCapsuleTransforms` import + reuse-объекты):

```ts
import { proxyCapsuleTransforms } from './shadowGeom'

// ... внутри class ProxyRig (поля _root, _capsules, _headRadius заданы в B1) ...

private _q = new THREE.Quaternion()

// Привод прокси от живой позы (§4.2). Корень → F, uniform-скейл → рост H,
// капсулы — из proxyCapsuleTransforms (ориентация из landmarks). Пул переиспользуется.
update(poseWorld: number[][], F: THREE.Vector3, H: number): void {
  this._root.position.copy(F)

  // рост позы в её же метрике: вертикальный размах bbox суставов (ankle→nose, либо hip→shoulder).
  // Скейлим так, чтобы прокси стал высотой H. Защита от вырожденной/нулевой позы.
  const poseH = this._poseHeight(poseWorld)
  const s = poseH > 1e-3 ? H / poseH : 1
  this._root.scale.setScalar(s)

  const xfs = proxyCapsuleTransforms(poseWorld)
  const used = new Set<string>()
  for (const xf of xfs) {
    const mesh = this._capsules.get(xf.name)
    if (!mesh) continue
    mesh.position.set(xf.center[0], xf.center[1], xf.center[2])
    this._q.set(xf.quat[0], xf.quat[1], xf.quat[2], xf.quat[3])
    mesh.quaternion.copy(this._q)
    if (xf.name !== 'head') {
      // капсула: базовая геометрия высотой 1 (B1) → масштаб Y до длины сегмента
      mesh.scale.set(1, Math.max(1e-3, xf.length), 1)
    }
    mesh.visible = true
    used.add(xf.name)
  }
  // суставы без видимости/данных в этом кадре — прячем (visible=false → выпадут из shadow-pass,
  // что корректно: их вклад в тень не нужен, см. §4.2 — здесь это ОСОЗНАННОЕ сокрытие,
  // в отличие от запрета прятать активные касты).
  for (const [name, mesh] of this._capsules) {
    if (!used.has(name)) mesh.visible = false
  }
}

// высота позы в метрах (hip-origin): от нижней лодыжки до носа; fallback — hip↔shoulder размах.
private _poseHeight(p: number[][]): number {
  const ys: number[] = []
  for (let i = 0; i < p.length; i++) if ((p[i][3] ?? 0) >= 0.5) ys.push(p[i][1])
  if (ys.length < 2) return 0
  return Math.max(...ys) - Math.min(...ys)
}
```

> Примечание о пуле: B1-конструктор создаёт по одному `THREE.Mesh` на каждое имя из набора (`torso`, `upperarm_L/R`, `forearm_L/R`, `thigh_L/R`, `shin_L/R`, `head`) с `CapsuleGeometry(radius, 1)` (высота 1 → масштабируется в `update`), сферой для `head`, добавляет их в `_root`, и материал у всех — `MeshBasicMaterial({ colorWrite:false, depthWrite:false })`, `castShadow=true`, `visible=true`. `get object(): THREE.Group { return this._root }`. Если B1 ещё не положил `mesh.scale`-конвенцию (геометрия высотой 1), C.5 закрепляет её этим методом.

**Шаг 4 — запустить, увидеть PASS.**
Команда: `cd /Users/iman/Projects/background_ar && npm test`
Ожидаемый вывод (фрагмент):
```
✓ src/lux/shadowScene3D.test.ts > ProxyRig.update (§4.2 привод от позы) > корень группы транслируется в F
✓ src/lux/shadowScene3D.test.ts > ProxyRig.update ... > группа масштабируется к росту H
✓ src/lux/shadowScene3D.test.ts > ProxyRig.update ... > бОльший H → бОльший скейл
✓ src/lux/shadowScene3D.test.ts > ProxyRig.update ... > видимые капсулы активны, невидимые-суставы спрятаны
✓ src/lux/shadowScene3D.test.ts > ProxyRig.update ... > пул переиспользуется
✓ src/lux/shadowScene3D.test.ts > ProxyRig.update ... > невидимый каст: colorWrite=false, depthWrite=false, visible=true
Test Files  ... passed
```

**Шаг 5 — commit.**
```
git add src/lux/shadowScene3D.ts src/lux/shadowScene3D.test.ts
git commit -m "$(cat <<'EOF'
feat(shadow) C.5: ProxyRig.update — привод пула капсул от живой позы

Корень группы → F, uniform-скейл к росту H (по размаху видимых суставов),
капсулы из proxyCapsuleTransforms (ориентация из landmarks). Пул мешей
переиспользуется (без аллокаций в hot loop); суставы без видимости прячутся.
Тесты — инспекция scene-graph без GPU.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### C.6 — Проводка привода в main.ts: F sanity-gate + PoseSmoother + ProxyRig.update в render-loop

Контракт §5/§6: в render-loop, при здоровой позе и прошедшем F-gate, гнать сглаженную позу в прокси; при отвергнутом F или отсутствии позы — оставлять текущий v1-путь (без визуальной регрессии). Этот шаг **только** наполняет данные/гейт в main.ts — фактическая отрисовка proxy-тени через `shadowRT2`/`multiplyBlitMat` и ladder — это Phase D1/D2. Здесь логика гейта изолируется в тестируемую чистую функцию `selectShadowMode` в `shadowGeom.ts`, а main.ts её зовёт. (POSE_ENTER/POSE_DROP-гистерезис и crossfade — целиком в D2; в C достаточно бинарного выбора по факту наличия позы + F-gate, чтобы привод не показывал некогерентную тень.)

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts` (`selectShadowMode`)
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts` (новый describe)
- Modify: `/Users/iman/Projects/background_ar/src/main.ts:184-211` (привязать gate + smoother + rig.update; держать `personFloor` для v1)
- Test: `src/lux/shadowGeom.test.ts`

**Шаг 1 — failing-тест.** Дописать в `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts`:

```ts
import { selectShadowMode } from './shadowGeom'

describe('selectShadowMode (§5/§6 выбор пути тени в C — бинарный, ladder в D2)', () => {
  it('есть поза + F прошёл gate → proxy', () => {
    expect(selectShadowMode({ hasPose: true, F: [3, 1, 0.0], floorZ: 0, hasShadowData: true }))
      .toBe('proxy')
  })

  it('есть поза, но F отвергнут gate (стена) → fallback room (v1)', () => {
    expect(selectShadowMode({ hasPose: true, F: [3, 1, 1.6], floorZ: 0, hasShadowData: true }))
      .toBe('room')
  })

  it('нет позы, но есть shadowData + F валиден → room (v1)', () => {
    expect(selectShadowMode({ hasPose: false, F: [3, 1, 0.0], floorZ: 0, hasShadowData: true }))
      .toBe('room')
  })

  it('нет shadowData вовсе → силуэт groundShadowMat', () => {
    expect(selectShadowMode({ hasPose: true, F: [3, 1, 0.0], floorZ: 0, hasShadowData: false }))
      .toBe('silhouette')
  })

  it('нет F (null) → не proxy', () => {
    expect(selectShadowMode({ hasPose: true, F: null, floorZ: 0, hasShadowData: true }))
      .toBe('room')
  })
})
```

**Шаг 2 — запустить, увидеть FAIL.**
Команда: `cd /Users/iman/Projects/background_ar && npm test`
Ожидаемый вывод (фрагмент):
```
FAIL  src/lux/shadowGeom.test.ts > selectShadowMode ...
SyntaxError: The requested module './shadowGeom' does not provide an export named 'selectShadowMode'
```

**Шаг 3 — минимальная импл.** Добавить в `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts`:

```ts
export type ShadowMode = 'proxy' | 'room' | 'silhouette'

// Выбор пути тени (§5/§6). В Phase C — бинарный по факту позы + F sanity-gate;
// crossfade/гистерезис (POSE_ENTER/POSE_DROP) добавляет Phase D2 поверх.
export function selectShadowMode(s: {
  hasPose: boolean
  F: Vec3 | null
  floorZ: number
  hasShadowData: boolean
}): ShadowMode {
  if (!s.hasShadowData) return 'silhouette'
  if (s.hasPose && s.F !== null && acceptFloorAnchor(s.F, s.floorZ)) return 'proxy'
  return 'room'
}
```

В `/Users/iman/Projects/background_ar/src/main.ts` — добавить в импорт (строка 20):

```ts
import {
  personFloorWorld, sampleWorldXYZ, acceptFloorAnchor, selectShadowMode, PoseSmoother,
} from './lux/shadowGeom'
```

Завести smoother рядом с другими per-loop состояниями (рядом с `smoothF`/`smoothH`, ~`main.ts:183`):

```ts
const poseSmoother = new PoseSmoother()
```

В блоке `main.ts:184-211`, после вычисления `F` и сглаживания `smoothF/smoothH`, добавить gate + привод (не ломая существующий `personFloor` для v1):

```ts
// ... existing: const F = sampleWorldXYZ(...); smoothF/smoothH exp-smooth ...
personFloor = { F: smoothF, H: smoothH }

// C: F sanity-gate + привод прокси сглаженной позой (отрисовка proxy-тени — Phase D1/D2)
const mode = selectShadowMode({
  hasPose: !!t?.pose,
  F: smoothF,
  floorZ: sd.floorZ,
  hasShadowData: !!sd,
})
if (mode === 'proxy' && t?.pose && shadowScene3D) {
  const smoothedPose = poseSmoother.push(t.pose.world, dt)
  shadowScene3D.proxyRig.update(
    smoothedPose, new THREE.Vector3(smoothF[0], smoothF[1], smoothF[2]), smoothH,
  )
}
```

> Замечание о связности фаз: `shadowScene3D` и `t.pose` появляются как символы в B1 (инстанс сцены) и D1 (`opts.pose` форвард / `Telemetry.pose` парсинг). В Phase C привязка стоит за `selectShadowMode(...) === 'proxy'` и optional-chaining (`t?.pose`, `shadowScene3D` truthy-гейт), поэтому до D1 ветка просто не выполняется (поза ещё не доезжает в `Telemetry`) — регрессии v1 нет. `personFloor` для fallback-веток сохраняется без изменений.

**Шаг 4 — запустить, увидеть PASS.**
Команда: `cd /Users/iman/Projects/background_ar && npm test`
Ожидаемый вывод (фрагмент):
```
✓ src/lux/shadowGeom.test.ts > selectShadowMode ... > есть поза + F прошёл gate → proxy
✓ src/lux/shadowGeom.test.ts > selectShadowMode ... > F отвергнут gate (стена) → fallback room (v1)
✓ src/lux/shadowGeom.test.ts > selectShadowMode ... > нет позы ... → room (v1)
✓ src/lux/shadowGeom.test.ts > selectShadowMode ... > нет shadowData → силуэт groundShadowMat
✓ src/lux/shadowGeom.test.ts > selectShadowMode ... > нет F (null) → не proxy
Test Files  ... passed
Tests  ... passed (≥92 + новые C.1–C.6)
```

**Шаг 5 — commit.**
```
git add src/lux/shadowGeom.ts src/lux/shadowGeom.test.ts src/main.ts
git commit -m "$(cat <<'EOF'
feat(shadow) C.6: проводка привода — F-gate + PoseSmoother + ProxyRig.update в render-loop

selectShadowMode (proxy/room/silhouette) по факту позы + F sanity-gate (бинарный;
crossfade/гистерезис — D2). main.ts: сглаживает позу PoseSmoother, при mode=proxy
гонит её в shadowScene3D.proxyRig.update(F,H). v1 personFloor/fallback не тронут;
до D1 ветка не активна (поза ещё не в Telemetry) — регрессии нет.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Exit criterion (Phase C, спека §10)

**Verifiable exit:** «тень повторяет позу вживую на box-receiver'е» (§10, фаза C).

**Unit-приёмка (автоматизируемо, `npm test`):**
- `sampleWorldXYZ` живёт в `shadowGeom.ts`, `main.ts` импортирует (C.1).
- F sanity-gate `acceptFloorAnchor` отвергает F при `|F.z-floorZ| > 0.15` и NaN (C.2).
- `PoseSmoother` exp-smooth'ит позу и демпфирует z сильнее xy (C.3).
- `proxyCapsuleTransforms`: поднятая рука → меняется кватернион плеча; поворот корпуса берётся из landmarks (не force-face-camera); невидимые суставы пропущены (C.4).
- `ProxyRig.update`: корень в F, скейл к H, пул переиспользуется, касты невидимы (colorWrite/depthWrite=false, visible=true, castShadow=true) (C.5).
- `selectShadowMode`: proxy / room / silhouette по позе+gate (C.6).
- Все ≥92 ранее зелёных теста остаются зелёными; новые C.1–C.6 добавлены.

**Live/visual-проверка (GPU — нельзя в unit, делается в браузере на box-receiver из B1):**
1. Запустить рендерер с активным capture-pose-потоком (Phase A) и box-receiver-сценой (Phase B1).
2. **Поднять руку → тень руки поднимается** (артикуляция из landmarks, §10 «работает уверенно»).
3. **Наклон вбок / поворот корпуса → тень повторяет** (ориентация из landmarks, не фронтальная заглушка).
4. **Ступни на полу: F садится под ногами; шаг к стене → F отвергается gate (`|F.z-floorZ|>0.15`), прокси НЕ телепортируется** на метры — этот кадр на fallback v1, без дёрганых прыжков.
5. **Сглаживание гасит дрожь**: при неподвижной позе тень не дрожит; при движении нет рывков (PoseSmoother + z-damp).
6. **Честное ограничение (проговорить заказчику, §5/§8):** наклон **к/от камеры** меняет тень **слабо** — монокулярная глубина, прокси схлопывается к фронто-параллели; «взбирание» обеспечивает геометрия приёмника, не глубина тела.

> Композитинг через `shadowRT2`/`multiplyBlitMat`, cover-fit-выравнивание на не-совпадающем canvas-аспекте, ladder с crossfade+гистерезисом и per-room `meta.shadowStrength` — это Phase D1/D2; в C проверяется только корректность привода прокси (поза→капсулы→тень) на статически выверенной B1-сцене.

---

## Phase D1 — Compositor: интеграция слота тени (interface + multiply-blit)

> **Scope (из §10 PHASE BOUNDARIES):** слот в `compositor.render()` — контракт-смена `shadowData.camera`; `multiplyBlitMat` + `shadowRT2`; multiply-blit round-trip в `compositeRT`; resize-hook; proxy **ALWAYS-ON** (без лестницы деградации/crossfade/hysteresis — это D2). На вход D1 уже существуют (из B1/B2/C): `ShadowScene3D` (с `scene`/`camera`/`update`), `boxReceiver`/`roomMeshFromEXR`, `ProxyRig`, `sampleWorldXYZ` уже в `shadowGeom.ts`. D1 НЕ трогает `Telemetry.pose` независимый парсинг (это D2) — но добавляет проброс `opts.pose` сквозь `render()` как опциональное поле.
>
> **Pre-req для D1 (зависимость, не задача D1):** `ShadowScene3D` из фазы B уже инстанцируется в compositor и доступен как `this.shadowScene3D` к началу D1. Если ещё нет — это блокер C/B, не D1.
>
> Все renderer-тесты: `npm test` (= `vitest run`), TypeScript, без WebGL. GPU-рендер (реальный shadow-pass + multiply на канвасе) проверяется только в live-acceptance в конце фазы.

---

### Task D1.1 — Контракт `opts.shadowData.camera: ShadowCamera` (замена `cameraPos`) в типе `render()`

Меняем сигнатуру `compositor.render()`: вместо `cameraPos: [number,number,number]` поле `shadowData` несёт полный `camera: ShadowCamera`. Это контракт-смена `main.ts ↔ compositor.ts`, фиксированная канон-контрактами. v1-ветка `roomShadowMat` после этого читает `opts.shadowData.camera.pos`.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/compositor.ts` (тип `opts.shadowData` на `:456`; чтение `cameraPos` на `:548`; импорт `ShadowCamera`)
- Test: `/Users/iman/Projects/background_ar/src/lux/compositor.shadowdata-contract.test.ts` (новый)

**Step 1 — failing test.** Этот тест проверяет тип-контракт через компиляцию: мы строим объект `shadowData` в новой форме (с `camera: ShadowCamera`) и убеждаемся, что код собирается. Так как тип ещё несёт `cameraPos`, typecheck в тесте упадёт. Создать `/Users/iman/Projects/background_ar/src/lux/compositor.shadowdata-contract.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { ShadowCamera } from './shadowGeom'

// D1.1 — контракт shadowData.camera: ShadowCamera (НЕ cameraPos).
// Тип RenderShadowData экспортируется из compositor.ts (вынесен из inline-типа render()).
import type { RenderShadowData } from './compositor'

describe('compositor shadowData contract', () => {
  it('shadowData несёт полный ShadowCamera, а не cameraPos', () => {
    const camera: ShadowCamera = {
      pos: [1, 2, 3], target: [0, 0, 0], fovY: 0.8, aspect: 0.5625,
    }
    const sd: RenderShadowData = {
      lamps: [{ pos: [0, 0, 3], weight: 1 }],
      worldPos: null as unknown as import('three').Texture,
      floorZ: 0,
      camera,
    }
    expect(sd.camera.pos).toEqual([1, 2, 3])
    expect(sd.camera.fovY).toBeCloseTo(0.8)
    // @ts-expect-error — старое поле cameraPos удалено из контракта
    const _legacy = sd.cameraPos
    void _legacy
  })
})
```

**Step 2 — run, expect FAIL.**
Command: `cd /Users/iman/Projects/background_ar && npm test -- compositor.shadowdata-contract`
Expected FAIL (RenderShadowData ещё не экспортируется, и `@ts-expect-error` сработает не туда):
```
FAIL  src/lux/compositor.shadowdata-contract.test.ts
  > Module '"./compositor"' has no exported member 'RenderShadowData'.
  > Unused '@ts-expect-error' directive.  (cameraPos ещё существует → ошибки нет → директива висит)
Test Files  1 failed
```

**Step 3 — minimal impl.** Вынести inline-тип `shadowData` в именованный экспорт и сменить `cameraPos` → `camera: ShadowCamera`. В `compositor.ts` добавить импорт и экспорт типа; правок шейдеров нет.

Импорт (рядом с существующими импортами в начале `compositor.ts`):
```ts
import type { ShadowCamera } from './shadowGeom'
```

Экспорт типа (над `export class LuxCompositor`):
```ts
export interface RenderShadowData {
  lamps: { pos: [number, number, number]; weight: number }[]
  worldPos: THREE.Texture
  floorZ: number
  camera: ShadowCamera   // D1.1: полный ShadowCamera (было cameraPos)
}
```

В `render(opts: { ... })` (`compositor.ts:456`) заменить строку:
```ts
    shadowData: { lamps: { pos: [number, number, number]; weight: number }[]; worldPos: THREE.Texture; floorZ: number; cameraPos: [number, number, number] } | null
```
на:
```ts
    shadowData: RenderShadowData | null
```

В v1-ветке `roomShadowMat` (`compositor.ts:548`) заменить:
```ts
        u.uCamPos.value.set(opts.shadowData.cameraPos[0], opts.shadowData.cameraPos[1], opts.shadowData.cameraPos[2])
```
на:
```ts
        u.uCamPos.value.set(opts.shadowData.camera.pos[0], opts.shadowData.camera.pos[1], opts.shadowData.camera.pos[2])
```

**Step 4 — run, expect PASS.**
Command: `cd /Users/iman/Projects/background_ar && npm test -- compositor.shadowdata-contract`
Expected:
```
✓ src/lux/compositor.shadowdata-contract.test.ts (1 test)
  ✓ shadowData несёт полный ShadowCamera, а не cameraPos
Test Files  1 passed
```

**Step 5 — commit.**
```
git add src/lux/compositor.ts src/lux/compositor.shadowdata-contract.test.ts
git commit -m "$(cat <<'EOF'
feat(shadow) D1.1: compositor shadowData.camera contract (ShadowCamera, was cameraPos)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D1.2 — Форвард `camera` из `main.ts` (полный объект вместо `.camera.pos`)

`main.ts:224-229` сейчас сужает `shadowData` до `{ lamps, worldPos, floorZ, cameraPos }`, отбрасывая `target/fovY/aspect`. Меняем на `camera: active.shadowData.camera` (полный объект уже лежит на `BuiltWorld.shadowData.camera`, `worldScene.ts:126`).

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/main.ts` (`:224-229`)
- Test: `/Users/iman/Projects/background_ar/src/main.shadow-forward.test.ts` (новый)

**Step 1 — failing test.** `main.ts` не юнит-тестируется напрямую (зависит от DOM/WebGL), поэтому тест проверяет чистую функцию-сборщик, которую мы извлечём из inline-объекта. Создать `/Users/iman/Projects/background_ar/src/main.shadow-forward.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { forwardShadowData } from './main'
import type { ShadowCamera } from './lux/shadowGeom'

describe('main forwardShadowData', () => {
  const camera: ShadowCamera = { pos: [1, 2, 3], target: [4, 5, 6], fovY: 0.7, aspect: 0.5625 }

  it('форвардит полный camera-объект (target/fovY/aspect сохранены)', () => {
    const built = {
      shadowData: {
        lamps: [{ pos: [0, 0, 3] as [number, number, number], weight: 1 }],
        worldPos: { id: 'tex' } as unknown,
        floorZ: 0,
        camera,
      },
    }
    const fwd = forwardShadowData(built.shadowData)
    expect(fwd).not.toBeNull()
    expect(fwd!.camera).toBe(camera)        // тот же объект, не сужение
    expect(fwd!.camera.target).toEqual([4, 5, 6])
    expect(fwd!.camera.fovY).toBeCloseTo(0.7)
    expect(fwd!.floorZ).toBe(0)
    expect(fwd!.lamps).toHaveLength(1)
  })

  it('null shadowData → null', () => {
    expect(forwardShadowData(null)).toBeNull()
  })
})
```

**Step 2 — run, expect FAIL.**
Command: `cd /Users/iman/Projects/background_ar && npm test -- main.shadow-forward`
Expected FAIL (функция `forwardShadowData` не экспортируется из `main.ts`):
```
FAIL  src/main.shadow-forward.test.ts
  > Module './main' has no exported member 'forwardShadowData'.
Test Files  1 failed
```

**Step 3 — minimal impl.** Извлечь сборку `shadowData` в экспортируемую чистую функцию и вызвать её в `render()`-вызове. В `main.ts` добавить (рядом с другими top-level помощниками, например после `sampleWorldXYZ`-импорта):

```ts
import type { RenderShadowData } from './lux/compositor'

export function forwardShadowData(
  sd: {
    lamps: { pos: [number, number, number]; weight: number }[]
    worldPos: import('three').Texture
    floorZ: number
    camera: import('./lux/shadowGeom').ShadowCamera
  } | null,
): RenderShadowData | null {
  if (!sd) return null
  return { lamps: sd.lamps, worldPos: sd.worldPos, floorZ: sd.floorZ, camera: sd.camera }
}
```

Заменить блок `main.ts:224-229`:
```ts
      shadowData: active.shadowData ? {
        lamps: active.shadowData.lamps,
        worldPos: active.shadowData.worldPos,
        floorZ: active.shadowData.floorZ,
        cameraPos: active.shadowData.camera.pos,
      } : null,
```
на:
```ts
      shadowData: forwardShadowData(active.shadowData ?? null),
```

**Step 4 — run, expect PASS.**
Command: `cd /Users/iman/Projects/background_ar && npm test -- main.shadow-forward`
Expected:
```
✓ src/main.shadow-forward.test.ts (2 tests)
  ✓ форвардит полный camera-объект (target/fovY/aspect сохранены)
  ✓ null shadowData → null
Test Files  1 passed
```

**Step 5 — commit.**
```
git add src/main.ts src/main.shadow-forward.test.ts
git commit -m "$(cat <<'EOF'
feat(shadow) D1.2: main forwards full shadowData.camera (target/fovY/aspect)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D1.3 — `multiplyBlitMat`: фуллскрин multiply фон×тень с потолком черноты (GLSL1)

Новый ShaderMaterial: читает `tBg` (compositeRT), `tShadow` (shadowRT, белый clear), применяет cover-fit `uUvScale` к выборке тени, считает `shadowTerm = 1.0 - texture(tShadow).r`, умножает фон на `m = mix(1.0, 1.0 - uShadowStrength*uShadowFloorK, shadowTerm)`. Юнит-тестируем то, что не требует GPU: материал создан, GLSL1, набор uniforms точно по канон-контракту.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/compositor.ts` (поле + конструктор; рядом с `blobMat` `:397-414`)
- Test: `/Users/iman/Projects/background_ar/src/lux/multiplyBlitMat.test.ts` (новый)

**Step 1 — failing test.** Создать `/Users/iman/Projects/background_ar/src/lux/multiplyBlitMat.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { LuxCompositor } from './compositor'

// Мок WebGLRenderer: конструктор LuxCompositor только создаёт RT/материалы,
// рендер не дёргается → достаточно заглушек.
function fakeRenderer(): THREE.WebGLRenderer {
  return {
    setRenderTarget: vi.fn(), render: vi.fn(), setClearColor: vi.fn(),
    clear: vi.fn(), getClearColor: vi.fn(() => new THREE.Color()),
    getClearAlpha: vi.fn(() => 1), autoClear: false,
  } as unknown as THREE.WebGLRenderer
}

const TUNING = {
  wrapStrength: 0.6, grainAmount: 0.04, feather: [0.4, 0.8] as [number, number],
  colorMatch: { cast: 0.35, exposure: 0.15 }, shadeAmount: 0.18,
}

describe('multiplyBlitMat', () => {
  it('создан как GLSL1 с точным набором uniforms', () => {
    const c = new LuxCompositor(fakeRenderer(), 64, 64, TUNING)
    const mat = (c as unknown as { multiplyBlitMat: THREE.ShaderMaterial }).multiplyBlitMat
    expect(mat).toBeInstanceOf(THREE.ShaderMaterial)
    expect(mat.glslVersion).toBe(THREE.GLSL1)
    const keys = Object.keys(mat.uniforms).sort()
    expect(keys).toEqual(
      ['tBg', 'tShadow', 'uShadowFloorK', 'uShadowStrength', 'uUvScale'].sort(),
    )
    expect(mat.uniforms.uUvScale.value).toBeInstanceOf(THREE.Vector2)
    expect(mat.depthTest).toBe(false)
  })

  it('шейдер реализует потолок черноты mix(1.0, 1.0 - K*S, term)', () => {
    const c = new LuxCompositor(fakeRenderer(), 64, 64, TUNING)
    const mat = (c as unknown as { multiplyBlitMat: THREE.ShaderMaterial }).multiplyBlitMat
    const fs = mat.fragmentShader
    expect(fs).toContain('1.0 - texture2D(tShadow')
    expect(fs).toContain('mix(1.0, 1.0 - uShadowStrength * uShadowFloorK, shadowTerm)')
  })
})
```

**Step 2 — run, expect FAIL.**
Command: `cd /Users/iman/Projects/background_ar && npm test -- multiplyBlitMat`
Expected FAIL (`multiplyBlitMat` поля ещё нет):
```
FAIL  src/lux/multiplyBlitMat.test.ts
  ✗ создан как GLSL1 с точным набором uniforms
    → expected undefined to be instance of ShaderMaterial
Test Files  1 failed
```

**Step 3 — minimal impl.** Объявить поле и создать материал в конструкторе. В блоке полей (`compositor.ts:53-63`) добавить:
```ts
  private multiplyBlitMat: THREE.ShaderMaterial // фуллскрин фон×тень (proxy multiply-blit, GLSL1)
```

В конструкторе, сразу после `blobMat` (после `compositor.ts:414`), добавить:
```ts
    // D1.3 — multiply-blit proxy-тени: фон(tBg) × тень-фактор(tShadow, белый clear),
    // cover-fit-кроп тени = кроп плейта (uUvScale из coverMat), с потолком черноты:
    // shadowTerm=0 вне тени → m=1.0 (кадр не темнеет); в плотной точке m → 1-K*S (не 0).
    this.multiplyBlitMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL1,
      uniforms: {
        tBg: { value: null }, tShadow: { value: null },
        uUvScale: { value: new THREE.Vector2(1, 1) },
        uShadowFloorK: { value: 0.7 }, uShadowStrength: { value: 0.5 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tBg, tShadow;
        uniform vec2 uUvScale;
        uniform float uShadowFloorK, uShadowStrength;
        void main() {
          vec2 suv = (vUv - 0.5) * uUvScale + 0.5;            // cover-fit-кроп тени = плейта
          float shadowTerm = 1.0 - texture2D(tShadow, suv).r; // белый clear → вне тени term=0
          float m = mix(1.0, 1.0 - uShadowStrength * uShadowFloorK, shadowTerm);
          gl_FragColor = vec4(texture2D(tBg, vUv).rgb * m, 1.0);
        }
      `,
      depthTest: false,
    })
```
(`VERT` — тот же GLSL1-vertex shader, что использует `blobMat`/`coverMat`; уже определён в модуле.)

**Step 4 — run, expect PASS.**
Command: `cd /Users/iman/Projects/background_ar && npm test -- multiplyBlitMat`
Expected:
```
✓ src/lux/multiplyBlitMat.test.ts (2 tests)
  ✓ создан как GLSL1 с точным набором uniforms
  ✓ шейдер реализует потолок черноты mix(1.0, 1.0 - K*S, term)
Test Files  1 passed
```

**Step 5 — commit.**
```
git add src/lux/compositor.ts src/lux/multiplyBlitMat.test.ts
git commit -m "$(cat <<'EOF'
feat(shadow) D1.3: multiplyBlitMat (fg×shadow, cover-fit, black-floor ceiling, GLSL1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D1.4 — `shadowRT2` render-target + добавление в `setSize`

Новый temp RT той же размерности, что `shadowRT` — приёмник результата multiply-blit (read+write split: `compositeRT` нельзя читать и писать одновременно). Обязательно добавить в `setSize`, иначе stale-размер при resize.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/compositor.ts` (поле `:48`; конструктор `:79`; `setSize` `:421-427`)
- Test: `/Users/iman/Projects/background_ar/src/lux/shadowRT2.test.ts` (новый)

**Step 1 — failing test.** Создать `/Users/iman/Projects/background_ar/src/lux/shadowRT2.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { LuxCompositor } from './compositor'

function fakeRenderer(): THREE.WebGLRenderer {
  return {
    setRenderTarget: vi.fn(), render: vi.fn(), setClearColor: vi.fn(),
    clear: vi.fn(), getClearColor: vi.fn(() => new THREE.Color()),
    getClearAlpha: vi.fn(() => 1), autoClear: false,
  } as unknown as THREE.WebGLRenderer
}
const TUNING = {
  wrapStrength: 0.6, grainAmount: 0.04, feather: [0.4, 0.8] as [number, number],
  colorMatch: { cast: 0.35, exposure: 0.15 }, shadeAmount: 0.18,
}

describe('shadowRT2', () => {
  it('создан с тем же размером, что shadowRT', () => {
    const c = new LuxCompositor(fakeRenderer(), 128, 256, TUNING) as unknown as {
      shadowRT: THREE.WebGLRenderTarget; shadowRT2: THREE.WebGLRenderTarget
    }
    expect(c.shadowRT2).toBeInstanceOf(THREE.WebGLRenderTarget)
    expect(c.shadowRT2.width).toBe(c.shadowRT.width)
    expect(c.shadowRT2.height).toBe(c.shadowRT.height)
    expect(c.shadowRT2.width).toBe(128)
    expect(c.shadowRT2.height).toBe(256)
  })

  it('setSize ресайзит shadowRT2 вместе с shadowRT', () => {
    const c = new LuxCompositor(fakeRenderer(), 128, 256, TUNING) as unknown as {
      shadowRT: THREE.WebGLRenderTarget; shadowRT2: THREE.WebGLRenderTarget
      setSize(w: number, h: number): void
    }
    c.setSize(64, 64)
    expect(c.shadowRT2.width).toBe(64)
    expect(c.shadowRT2.height).toBe(64)
    expect(c.shadowRT2.width).toBe(c.shadowRT.width)
  })
})
```

**Step 2 — run, expect FAIL.**
Command: `cd /Users/iman/Projects/background_ar && npm test -- shadowRT2`
Expected FAIL (`shadowRT2` поля ещё нет):
```
FAIL  src/lux/shadowRT2.test.ts
  ✗ создан с тем же размером, что shadowRT
    → expected undefined to be instance of WebGLRenderTarget
Test Files  1 failed
```

**Step 3 — minimal impl.** В блоке полей (рядом с `shadowRT`, `compositor.ts:48`) добавить:
```ts
  private shadowRT2: THREE.WebGLRenderTarget // temp для multiply-blit (read+write split)
```
В конструкторе, сразу после `this.shadowRT = new THREE.WebGLRenderTarget(width, height)` (`compositor.ts:79`):
```ts
    this.shadowRT2 = new THREE.WebGLRenderTarget(width, height)
```
В `setSize` (`compositor.ts:421-427`), после `this.shadowRT.setSize(width, height)`:
```ts
    this.shadowRT2.setSize(width, height)
```

**Step 4 — run, expect PASS.**
Command: `cd /Users/iman/Projects/background_ar && npm test -- shadowRT2`
Expected:
```
✓ src/lux/shadowRT2.test.ts (2 tests)
  ✓ создан с тем же размером, что shadowRT
  ✓ setSize ресайзит shadowRT2 вместе с shadowRT
Test Files  1 passed
```

**Step 5 — commit.**
```
git add src/lux/compositor.ts src/lux/shadowRT2.test.ts
git commit -m "$(cat <<'EOF'
feat(shadow) D1.4: shadowRT2 temp render-target wired into setSize

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D1.5 — `opts.pose` проброс сквозь `render()` (опциональное поле, без логики ладдера)

Добавить в сигнатуру `render()` опциональный `opts.pose?: { world: number[][]; norm: number[][]; healthy: number }` (точно по канон-контракту) и пробрасывать его из `main.ts`. В D1 это поле просто доходит до слота; ветвление по `healthy` (POSE_ENTER/DROP) — D2. В D1 proxy ALWAYS-ON: слот выбирает 3D-путь, если `opts.pose` присутствует И есть `shadowData`+`personFloor`.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/compositor.ts` (сигнатура `render()` `:445-467`)
- Modify: `/Users/iman/Projects/background_ar/src/main.ts` (`render()`-вызов `:213-240`)
- Test: `/Users/iman/Projects/background_ar/src/lux/compositor.pose-opt.test.ts` (новый)

**Step 1 — failing test.** Тест проверяет тип-контракт `opts.pose` через экспортируемый тип параметра. Создать `/Users/iman/Projects/background_ar/src/lux/compositor.pose-opt.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { RenderPose } from './compositor'

describe('compositor opts.pose', () => {
  it('RenderPose имеет world/norm/healthy форму канон-контракта', () => {
    const pose: RenderPose = {
      world: [[0, 0, 0, 1], [0.1, 0.2, 0.3, 0.9]],
      norm: [[0.5, 0.5, 0, 1]],
      healthy: 0.8,
    }
    expect(pose.healthy).toBeCloseTo(0.8)
    expect(pose.world[0]).toHaveLength(4)
    expect(pose.norm).toHaveLength(1)
  })
})
```

**Step 2 — run, expect FAIL.**
Command: `cd /Users/iman/Projects/background_ar && npm test -- compositor.pose-opt`
Expected FAIL (тип `RenderPose` не экспортируется):
```
FAIL  src/lux/compositor.pose-opt.test.ts
  > Module '"./compositor"' has no exported member 'RenderPose'.
Test Files  1 failed
```

**Step 3 — minimal impl.** В `compositor.ts` экспортировать тип и добавить поле в сигнатуру `render()`. Над классом (рядом с `RenderShadowData` из D1.1):
```ts
export interface RenderPose { world: number[][]; norm: number[][]; healthy: number }
```
В сигнатуре `render(opts: { ... })` (`compositor.ts:445-467`), добавить строку рядом с `shadowData`:
```ts
    pose?: RenderPose
```

В `main.ts` `render()`-вызове (`main.ts:213-240`), добавить поле (рядом с `shadowData`):
```ts
      pose: t?.pose,
```
(`t` — текущая распарсенная телеметрия; `t.pose` будет `undefined` пока D2 не добавит независимый парсинг в `telemetry.ts` — это допустимо, поле опционально, и в D1 fallback v1-ветка отрабатывает при `undefined`.)

**Step 4 — run, expect PASS.**
Command: `cd /Users/iman/Projects/background_ar && npm test -- compositor.pose-opt`
Expected:
```
✓ src/lux/compositor.pose-opt.test.ts (1 test)
  ✓ RenderPose имеет world/norm/healthy форму канон-контракта
Test Files  1 passed
```

**Step 5 — commit.**
```
git add src/lux/compositor.ts src/main.ts src/lux/compositor.pose-opt.test.ts
git commit -m "$(cat <<'EOF'
feat(shadow) D1.5: thread opts.pose (RenderPose) through compositor.render

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D1.6 — Чистый помощник `selectShadowPath`: выбор 3D-proxy vs v1 (always-on, без ладдера)

Слот тени должен решить, какую ветку рисовать. В D1 правило простое (proxy always-on, без гистерезиса): `'proxy3d'` если есть `pose` И `shadowData` И `personFloor`; иначе `'roomV1'` если есть `shadowData`+`personFloor`; иначе `'groundV1'` если есть `shadowData`; иначе `'none'`. Выносим как чистую функцию, тестируемую без WebGL. (D2 заменит `pose`-условие на `healthy ≥ POSE_ENTER`+F-gate+crossfade.)

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/compositor.ts` (экспорт чистой функции `selectShadowPath`)
- Test: `/Users/iman/Projects/background_ar/src/lux/selectShadowPath.test.ts` (новый)

**Step 1 — failing test.** Создать `/Users/iman/Projects/background_ar/src/lux/selectShadowPath.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { selectShadowPath } from './compositor'

describe('selectShadowPath (D1 always-on, без ладдера)', () => {
  const sd = {} as object
  const pf = {} as object
  const pose = {} as object

  it('pose + shadowData + personFloor → proxy3d', () => {
    expect(selectShadowPath({ hasPose: true, hasShadowData: true, hasPersonFloor: true }))
      .toBe('proxy3d')
  })
  it('нет pose, есть shadowData+personFloor → roomV1', () => {
    expect(selectShadowPath({ hasPose: false, hasShadowData: true, hasPersonFloor: true }))
      .toBe('roomV1')
  })
  it('pose есть, но нет personFloor → roomV1 (proxy без якоря не строим)', () => {
    expect(selectShadowPath({ hasPose: true, hasShadowData: true, hasPersonFloor: false }))
      .toBe('groundV1')
  })
  it('есть shadowData, нет personFloor → groundV1', () => {
    expect(selectShadowPath({ hasPose: false, hasShadowData: true, hasPersonFloor: false }))
      .toBe('groundV1')
  })
  it('нет shadowData → none', () => {
    expect(selectShadowPath({ hasPose: true, hasShadowData: false, hasPersonFloor: true }))
      .toBe('none')
    void sd; void pf; void pose
  })
})
```

**Step 2 — run, expect FAIL.**
Command: `cd /Users/iman/Projects/background_ar && npm test -- selectShadowPath`
Expected FAIL (функция не экспортирована):
```
FAIL  src/lux/selectShadowPath.test.ts
  > Module '"./compositor"' has no exported member 'selectShadowPath'.
Test Files  1 failed
```

**Step 3 — minimal impl.** В `compositor.ts` (top-level, рядом с другими экспортами):
```ts
export type ShadowPath = 'proxy3d' | 'roomV1' | 'groundV1' | 'none'

// D1: proxy ALWAYS-ON (нет гистерезиса/crossfade — это D2). Proxy требует якорь
// (personFloor) и shadowData. Без personFloor (нет F-якоря) → screen-space groundV1.
export function selectShadowPath(s: {
  hasPose: boolean; hasShadowData: boolean; hasPersonFloor: boolean
}): ShadowPath {
  if (!s.hasShadowData) return 'none'
  if (!s.hasPersonFloor) return 'groundV1'
  if (s.hasPose) return 'proxy3d'
  return 'roomV1'
}
```

**Step 4 — run, expect PASS.**
Command: `cd /Users/iman/Projects/background_ar && npm test -- selectShadowPath`
Expected:
```
✓ src/lux/selectShadowPath.test.ts (5 tests)
  ✓ pose + shadowData + personFloor → proxy3d
  ✓ нет pose, есть shadowData+personFloor → roomV1
  ✓ pose есть, но нет personFloor → groundV1
  ✓ есть shadowData, нет personFloor → groundV1
  ✓ нет shadowData → none
Test Files  1 passed
```

**Step 5 — commit.**
```
git add src/lux/compositor.ts src/lux/selectShadowPath.test.ts
git commit -m "$(cat <<'EOF'
feat(shadow) D1.6: selectShadowPath helper (proxy always-on, no ladder yet)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D1.7 — Слот тени в `render()`: 3D-рендер → multiply-blit round-trip → `compositeRT` (proxy always-on)

Собираем всё вместе в слоте тени (`compositor.ts:538-582`). Когда `selectShadowPath(...) === 'proxy3d'`: `shadowScene3D.update(...)` → 3D-рендер в `shadowRT` (белый clear, с восстановлением clear-color/render-target/depthTest для последующих FSQ-блитов) → multiply-blit (`tBg=compositeRT`, `tShadow=shadowRT`, `uUvScale` из `coverMat`) → `shadowRT2` → блит `shadowRT2`→`compositeRT` (канон, как v1 round-trip). Иначе — существующие v1-ветки (`roomShadowMat`/`groundShadowMat`). Blob (`compositor.ts:571-581`) остаётся ВСЕГДА, не трогаем (его перетюн — D2). GPU-часть не юнит-тестируется; покрываем тестом порядок пассов через инструментированный рендерер.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/compositor.ts` (слот тени `:538-582`; восстановление clear-color)
- Test: `/Users/iman/Projects/background_ar/src/lux/compositor.proxy-slot.test.ts` (новый)

**Step 1 — failing test.** Тест инструментирует fake-renderer: записывает последовательность `setRenderTarget`-целей и `render`-вызовов, передаёт минимальный `opts` с `pose`+`shadowData`+`personFloor`, и проверяет, что (а) 3D-сцена тени рендерится в `shadowRT` с белым clear, (б) финальный канон — `compositeRT`. Создать `/Users/iman/Projects/background_ar/src/lux/compositor.proxy-slot.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { LuxCompositor } from './compositor'

const TUNING = {
  wrapStrength: 0.6, grainAmount: 0.04, feather: [0.4, 0.8] as [number, number],
  colorMatch: { cast: 0.35, exposure: 0.15 }, shadeAmount: 0.18,
}

function instrumentedRenderer() {
  const calls: { type: 'setRT' | 'render' | 'clearColor' | 'clear'; arg?: unknown }[] = []
  const r = {
    autoClear: false,
    setRenderTarget: (t: unknown) => calls.push({ type: 'setRT', arg: t }),
    render: (s: unknown) => calls.push({ type: 'render', arg: s }),
    setClearColor: (c: unknown) => calls.push({ type: 'clearColor', arg: c }),
    clear: () => calls.push({ type: 'clear' }),
    getClearColor: (tgt: THREE.Color) => tgt.set(0x000000),
    getClearAlpha: () => 0,
  } as unknown as THREE.WebGLRenderer
  return { r, calls }
}

describe('compositor proxy-тень слот (D1)', () => {
  it('proxy3d-путь: 3D-сцена тени рендерится с белым clear, compositeRT финальный канон', () => {
    const { r, calls } = instrumentedRenderer()
    const c = new LuxCompositor(r, 64, 64, TUNING) as unknown as {
      shadowScene3D: { scene: THREE.Scene; camera: THREE.Camera; update: (...a: unknown[]) => void }
      shadowRT: THREE.WebGLRenderTarget; shadowRT2: THREE.WebGLRenderTarget
      compositeRT: THREE.WebGLRenderTarget
      render(o: unknown): void
    }
    // stub ShadowScene3D (B-фаза инстанцирует реальный; в юните мокаем поведение)
    const updateSpy = vi.fn()
    c.shadowScene3D = { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), update: updateSpy }

    const tex = (rt: THREE.WebGLRenderTarget) => rt.texture
    void tex
    c.render({
      scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
      backplate: null, backplateAspect: null,
      person: new THREE.Texture(), personAspect: 0.5625,
      lightDirX: 0, mirrorOpacity: 1,
      shadow: null, shadowStrength: 0.6,
      shadowData: {
        lamps: [{ pos: [0, 0, 3], weight: 1 }],
        worldPos: new THREE.Texture(), floorZ: 0,
        camera: { pos: [0, -3, 1.5], target: [0, 0, 1], fovY: 0.8, aspect: 0.5625 },
      },
      pose: { world: [[0, 0, 0, 1]], norm: [[0.5, 0.5, 0, 1]], healthy: 0.9 },
      personFloor: { F: [0, 0, 0], H: 1.7 },
      feetUV: { u: 0.5, v: 0.1, halfW: 0.1 },
      shadowCfg: { strength: 0.5, softness: 1.6, bias: 0.005 },
      lut: new THREE.Data3DTexture(), lutSize: 32,
      toggles: { shadow: true, grain: false, harmonize: true } as never,
      fade: 1, slides: { update: () => ({}) } as never,
      timeSec: 0, canvasAspect: 1.0, // НЕ-совпадающий аспект: упражняем cover-fit-кроп
    })

    expect(updateSpy).toHaveBeenCalledOnce()
    // белый clear перед 3D-рендером тени
    const cleared = calls.some((x) => x.type === 'clearColor')
    expect(cleared).toBe(true)
    // 3D-сцену рендерили хотя бы раз (PerspectiveCamera-путь)
    const rendered3D = calls.some((x) => x.type === 'render')
    expect(rendered3D).toBe(true)
  })

  it('без pose → НЕ дёргает shadowScene3D.update (v1-ветка)', () => {
    const { r } = instrumentedRenderer()
    const c = new LuxCompositor(r, 64, 64, TUNING) as unknown as {
      shadowScene3D: { scene: THREE.Scene; camera: THREE.Camera; update: (...a: unknown[]) => void }
      render(o: unknown): void
    }
    const updateSpy = vi.fn()
    c.shadowScene3D = { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), update: updateSpy }
    c.render({
      scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
      backplate: null, backplateAspect: null,
      person: new THREE.Texture(), personAspect: 0.5625,
      lightDirX: 0, mirrorOpacity: 1, shadow: null, shadowStrength: 0.6,
      shadowData: {
        lamps: [{ pos: [0, 0, 3], weight: 1 }], worldPos: new THREE.Texture(), floorZ: 0,
        camera: { pos: [0, -3, 1.5], target: [0, 0, 1], fovY: 0.8, aspect: 0.5625 },
      },
      pose: undefined,
      personFloor: { F: [0, 0, 0], H: 1.7 },
      feetUV: { u: 0.5, v: 0.1, halfW: 0.1 },
      shadowCfg: { strength: 0.5, softness: 1.6, bias: 0.005 },
      lut: new THREE.Data3DTexture(), lutSize: 32,
      toggles: { shadow: true, grain: false, harmonize: true } as never,
      fade: 1, slides: { update: () => ({}) } as never,
      timeSec: 0, canvasAspect: 1.0,
    })
    expect(updateSpy).not.toHaveBeenCalled()
  })
})
```

**Step 2 — run, expect FAIL.**
Command: `cd /Users/iman/Projects/background_ar && npm test -- compositor.proxy-slot`
Expected FAIL (слот ещё дёргает только v1; `shadowScene3D.update` не вызывается, белого clear-color нет):
```
FAIL  src/lux/compositor.proxy-slot.test.ts
  ✗ proxy3d-путь: 3D-сцена тени рендерится с белым clear, compositeRT финальный канон
    → expected "spy" to be called once, but it was called 0 times
Test Files  1 failed
```

**Step 3 — minimal impl.** В слоте тени (`compositor.ts:538-582`), заменить начало ветки `if (opts.shadowData && opts.personFloor) { ... } else { ... }` на трёхпутевое ветвление через `selectShadowPath`. Конкретно, заменить блок:
```ts
      if (opts.shadowData && opts.personFloor) {
        const u = this.roomShadowMat.uniforms
        ...
        this.pass(this.blitMat, this.compositeRT)
      } else {
        const g = this.groundShadowMat.uniforms
        ...
        this.pass(this.groundShadowMat, this.compositeRT)
      }
```
на:
```ts
      const path = selectShadowPath({
        hasPose: opts.pose != null,
        hasShadowData: opts.shadowData != null,
        hasPersonFloor: opts.personFloor != null,
      })
      if (path === 'proxy3d' && opts.shadowData && opts.personFloor && opts.pose) {
        // D1: proxy ALWAYS-ON. 3D proxy-тень → shadowRT (белый clear) → multiply-blit.
        this.shadowScene3D.update(opts.pose, opts.personFloor, opts.shadowData)
        // 1) 3D-рендер тень-фактора в shadowRT с БЕЛЫМ clear.
        const prevColor = new THREE.Color()
        this.renderer.getClearColor(prevColor)
        const prevAlpha = this.renderer.getClearAlpha()
        const prevAuto = this.renderer.autoClear
        this.renderer.autoClear = false
        this.renderer.setRenderTarget(this.shadowRT)
        this.renderer.setClearColor(0xffffff, 1)
        this.renderer.clear()
        this.renderer.render(this.shadowScene3D.scene, this.shadowScene3D.camera)
        this.renderer.setRenderTarget(null)
        this.renderer.setClearColor(prevColor, prevAlpha) // вернуть для FSQ-блитов
        this.renderer.autoClear = prevAuto
        // 2) multiply-blit: compositeRT × shadowRT, cover-fit-кроп тени = плейта.
        const m = this.multiplyBlitMat.uniforms
        m.tBg.value = this.compositeRT.texture
        m.tShadow.value = this.shadowRT.texture
        m.uUvScale.value.copy(this.coverMat.uniforms.uUvScale.value)
        m.uShadowStrength.value = opts.shadowStrength      // per-room мастер (§4.5)
        m.uShadowFloorK.value = LUX_CONFIG.shadow.shadowFloorK
        this.pass(this.multiplyBlitMat, this.shadowRT2)    // temp, не read+write
        this.blitMat.uniforms.tSrc.value = this.shadowRT2.texture
        this.pass(this.blitMat, this.compositeRT)          // compositeRT снова канон
      } else if (path === 'roomV1' && opts.shadowData && opts.personFloor) {
        const u = this.roomShadowMat.uniforms
        u.tBg.value = this.compositeRT.texture
        u.tWorld.value = opts.shadowData.worldPos
        u.tVideo.value = opts.person
        u.uUvScale.value.copy(this.coverMat.uniforms.uUvScale.value)
        u.uVideoAspect.value = opts.personAspect ?? 0.5625
        u.uF.value.set(opts.personFloor.F[0], opts.personFloor.F[1], opts.personFloor.F[2])
        u.uH.value = opts.personFloor.H
        u.uCamPos.value.set(opts.shadowData.camera.pos[0], opts.shadowData.camera.pos[1], opts.shadowData.camera.pos[2])
        const lamps = opts.shadowData.lamps
        u.uNLamps.value = Math.min(3, lamps.length)
        if (lamps[0]) u.uLamp0.value.set(lamps[0].pos[0], lamps[0].pos[1], lamps[0].pos[2])
        if (lamps[1]) u.uLamp1.value.set(lamps[1].pos[0], lamps[1].pos[1], lamps[1].pos[2])
        if (lamps[2]) u.uLamp2.value.set(lamps[2].pos[0], lamps[2].pos[1], lamps[2].pos[2])
        u.uW.value.set(lamps[0]?.weight ?? 0, lamps[1]?.weight ?? 0, lamps[2]?.weight ?? 0)
        u.uStrength.value = opts.shadowCfg.strength
        u.uBias.value = opts.shadowCfg.bias
        u.uSoft.value = opts.shadowCfg.softness
        u.uOpacity.value = opts.mirrorOpacity
        this.pass(this.roomShadowMat, this.shadowRT)
        this.blitMat.uniforms.tSrc.value = this.shadowRT.texture
        this.pass(this.blitMat, this.compositeRT)
      } else {
        const g = this.groundShadowMat.uniforms
        g.tVideo.value = opts.person
        g.uUvScale.value.set(sx, sy)
        g.uOpacity.value = opts.shadowStrength * opts.mirrorOpacity
        g.uLightX.value = opts.lightDirX * 0.015
        this.pass(this.groundShadowMat, this.compositeRT)
      }
```

(`THREE`, `LUX_CONFIG` уже импортированы в `compositor.ts`. `LUX_CONFIG.shadow.shadowFloorK` добавлен канон-контрактом в `config.ts` — если ещё нет к этому моменту, добавить `shadowFloorK: 0.7` в `LUX_CONFIG.shadow`; в каноне это поле обязано существовать. Если порядок фаз привёл сюда раньше, чем `config.ts` обновлён — добавить поле в этой же задаче.)

**Step 4 — run, expect PASS.**
Command: `cd /Users/iman/Projects/background_ar && npm test -- compositor.proxy-slot`
Expected:
```
✓ src/lux/compositor.proxy-slot.test.ts (2 tests)
  ✓ proxy3d-путь: 3D-сцена тени рендерится с белым clear, compositeRT финальный канон
  ✓ без pose → НЕ дёргает shadowScene3D.update (v1-ветка)
Test Files  1 passed
```

**Step 5 — commit.**
```
git add src/lux/compositor.ts src/lux/compositor.proxy-slot.test.ts
git commit -m "$(cat <<'EOF'
feat(shadow) D1.7: proxy shadow slot — 3D render -> multiplyBlit round-trip into compositeRT (always-on)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D1.8 — Полный прогон + typecheck (регрессия ≥92 + новые D1-тесты)

Убедиться, что весь сьют зелёный и не сломан ни один из существующих 92 тестов после контракт-смены.

**Files:**
- Test: весь сьют (`src/**/*.test.ts`)

**Step 1 — run полный сьют + typecheck.**
Command: `cd /Users/iman/Projects/background_ar && npm test && npx tsc --noEmit`
Expected (число тестов поднялось на новые D1-кейсы; контракт-смена не уронила legacy):
```
✓ src/lux/compositor.shadowdata-contract.test.ts (1)
✓ src/main.shadow-forward.test.ts (2)
✓ src/lux/multiplyBlitMat.test.ts (2)
✓ src/lux/shadowRT2.test.ts (2)
✓ src/lux/compositor.pose-opt.test.ts (1)
✓ src/lux/selectShadowPath.test.ts (5)
✓ src/lux/compositor.proxy-slot.test.ts (2)
... (все прежние ≥92)
Test Files  24 passed (24)
     Tests  107 passed (107)
# tsc: без ошибок (нет вывода, exit 0)
```

**Step 2 — commit (если правились мелочи под typecheck; иначе пропустить).**
```
git add -A
git commit -m "$(cat <<'EOF'
test(shadow) D1.8: full suite + tsc green after shadowData.camera contract change

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Exit criterion (из spec §10, фаза D1)

> **D1 — Compositor integration.** *Exit:* proxy-тень **стабильно композитится**, `compositeRT` **остаётся каноном перед `personMat`/зерном**; зелёные тесты.

**Verifiable (юнит, без GPU — покрыто D1.1–D1.8):**
- Контракт `opts.shadowData.camera: ShadowCamera` действует на обоих концах (`main.ts` форвардит полный `camera`, `compositor.ts` его принимает; `cameraPos` удалён) — D1.1, D1.2.
- `multiplyBlitMat` существует (GLSL1, точные uniforms `tBg/tShadow/uUvScale/uShadowFloorK/uShadowStrength`, потолок черноты в шейдере) — D1.3.
- `shadowRT2` создан и ресайзится в `setSize` вместе с `shadowRT` — D1.4.
- `opts.pose?` доходит до слота; `selectShadowPath` корректно выбирает proxy3d/roomV1/groundV1/none (always-on, без ладдера) — D1.5, D1.6.
- Слот: `proxy3d` → `shadowScene3D.update` + 3D-рендер с белым clear + multiply-blit через `shadowRT2` + блит обратно в `compositeRT` (канон). Без `pose` → v1-ветки, `update` не дёргается — D1.7.
- Весь сьют ≥92 + новые D1-кейсы + `tsc --noEmit` зелёные — D1.8.

**Live/visual check (GPU — НЕ юнит-тестируется, проверка глазами):**
1. Запустить рендерер с capture-потоком, в кадре человек, мир с `shadowData` (living). Под фигурой видна **3D proxy-тень** (не v1 screen-space силуэт). Поднять руку → тень руки поднимается (артикуляция; работает уверенно).
2. **`compositeRT` — канон перед `personMat`:** фигура (`personMat`, `compositor.ts:585`) рисуется **поверх** тени; зерно (`grainMat`, `:603`) ложится на весь кадр после слота тени. Тень видна вокруг силуэта, не перекрывает фигуру, и несёт то же финальное зерно.
3. **Cover-fit-выравнивание на НЕ-совпадающем canvas-аспекте** (ресайзнуть окно в landscape/квадрат): тень proxy не «съезжает» относительно плейта — `multiplyBlitMat.uUvScale` совпадает с `coverMat.uUvScale` (crop-путь упражнён вживую, как и требует §4.4).
4. **Стабильность композита:** нет миганий чёрным/белым на границе пассов (правильное восстановление clear-color/render-target после 3D-пасса — §4.0), нет протечки `depthTest`-состояния в FSQ-блиты (фон/фигура/зерно рисуются как раньше).
5. **Resize не бьёт тень:** после изменения размера окна тень остаётся выровненной (`shadowRT2` ресайзнут).

> **Вне D1 (ожидаемо в этой фазе):** crossfade/гистерезис при потере позы, per-room `meta.shadowStrength` во ВСЕХ компонентах, перетюн blob, отключение `roomShadowMat` в proxy-режиме, мягкость кромки — это D2. В D1 при `pose=undefined` (пока `telemetry.ts` не парсит `pose` независимо — D2) слот штатно падает на v1-ветку; proxy-путь проверяется с замоканным/ранним `pose`-полем или после того, как D2 включит парсинг. D1-цель — доказать, что **сам слот и multiply-blit round-trip композитятся стабильно и канон сохраняется**.

---

## Phase D2 — Деградация + единое сглаживание (crossfade/hysteresis/per-room/«не наклейка»)

**Предусловие.** D1 завершён: `compositor.ts` уже умеет рендерить proxy-тень always-on через `shadowScene3D` + `multiplyBlitMat` + `shadowRT2` round-trip, `opts.pose` и `opts.shadowData.camera: ShadowCamera` проброшены из `main.ts`, `shadowRT2` ресайзится. D2 НЕ добавляет рендер-пути — он добавляет **независимый парсинг pose**, **лестницу деградации с crossfade+гистерезисом**, **per-room `meta.shadowStrength` ко всем компонентам**, **потолок черноты `shadowFloorK`**, **перетюн blob**, **мягкость кромки**, **отключение `roomShadowMat` в proxy-режиме** и завершается live-приёмкой «тень не наклейка».

Канон-константы D2 (фиксируются в `LUX_CONFIG`/модулях, см. контракты): `POSE_ENTER = 0.7`, `POSE_DROP = 0.5`, `Z_THR = 0.15`, `LUX_CONFIG.shadow.blobRatio = 0.5`, `LUX_CONFIG.shadow.shadowFloorK = 0.7`.

Тесты рендерера — `vitest run` (TS, без WebGL: чистая математика/парсинг/массивы). Тесты capture — `pytest tests/ -v`. Каждая задача: failing-тест → запуск (FAIL) → минимальная реализация (полный код) → запуск (PASS) → коммит.

---

### D2.1 — `Telemetry.pose` парсится НЕЗАВИСИМО (битый pose ⇒ `undefined`, остальное живо)

Контракт: `Telemetry` получает `pose?: { world: number[][]; norm: number[][]; healthy: number }`; `parseTelemetry` НЕ возвращает `null` из-за плохого `pose` — `present/bbox/distanceCm` всё равно парсятся.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/telemetry.ts` (interface `:4-11`, `parseTelemetry` `:17-38`)
- Test: `/Users/iman/Projects/background_ar/src/lux/telemetry.test.ts` (создать или дополнить, если уже есть — добавить блок `describe('pose', …)`)

**Failing-тест.** Создать/дополнить `/Users/iman/Projects/background_ar/src/lux/telemetry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseTelemetry } from './telemetry'

const base = { type: 'presence', present: true, distanceCm: 180, coverage: 0.4, bbox: [0.1, 0.2, 0.6, 0.9], errors: 0, fps: 30 }

describe('parseTelemetry pose (D2.1)', () => {
  it('парсит валидный pose в поле pose', () => {
    const world = Array.from({ length: 33 }, (_, i) => [i, i + 1, i + 2, 0.9])
    const norm = Array.from({ length: 33 }, (_, i) => [i / 33, i / 33, 0, 0.9])
    const t = parseTelemetry({ ...base, pose: { world, norm, healthy: 0.8 } })
    expect(t).not.toBeNull()
    expect(t!.pose).toBeDefined()
    expect(t!.pose!.healthy).toBe(0.8)
    expect(t!.pose!.world.length).toBe(33)
    expect(t!.pose!.world[5]).toEqual([5, 6, 7, 0.9])
    expect(t!.pose!.norm.length).toBe(33)
  })

  it('отсутствующий pose ⇒ pose === undefined, остальное парсится', () => {
    const t = parseTelemetry(base)
    expect(t).not.toBeNull()
    expect(t!.pose).toBeUndefined()
    expect(t!.present).toBe(true)
    expect(t!.bbox).toEqual([0.1, 0.2, 0.6, 0.9])
    expect(t!.distanceCm).toBe(180)
  })

  it('битый pose (не объект) ⇒ pose undefined, parseTelemetry НЕ null, presence жив', () => {
    const t = parseTelemetry({ ...base, pose: 'garbage' })
    expect(t).not.toBeNull()
    expect(t!.pose).toBeUndefined()
    expect(t!.bbox).toEqual([0.1, 0.2, 0.6, 0.9])
  })

  it('битый pose (healthy не число / world не массив) ⇒ pose undefined, presence жив', () => {
    const t1 = parseTelemetry({ ...base, pose: { world: 'x', norm: [], healthy: 0.5 } })
    expect(t1).not.toBeNull()
    expect(t1!.pose).toBeUndefined()
    const t2 = parseTelemetry({ ...base, pose: { world: [], norm: [], healthy: 'nan' } })
    expect(t2).not.toBeNull()
    expect(t2!.pose).toBeUndefined()
  })

  it('pose с не-32-длиной массива всё равно толерантен (берём как есть, presence жив)', () => {
    const t = parseTelemetry({ ...base, pose: { world: [[1, 2, 3, 0.5]], norm: [[0, 0, 0, 0.5]], healthy: 0.3 } })
    expect(t).not.toBeNull()
    // короткий, но структурно валидный pose принимается; presence в любом случае жив
    expect(t!.present).toBe(true)
  })
})
```

**Запуск (ожидается FAIL):**
```
cd /Users/iman/Projects/background_ar && npx vitest run src/lux/telemetry.test.ts
```
Ожидаемый вывод (FAIL): `TS2339: Property 'pose' does not exist on type 'Telemetry'` при типчеке + рантайм `expect(t!.pose).toBeDefined()` падает (`received: undefined`), т.к. `parseTelemetry` ещё не читает `pose`.

**Минимальная реализация.** В `/Users/iman/Projects/background_ar/src/lux/telemetry.ts`:

1. Расширить интерфейс (после `fps: number`):
```ts
export interface Telemetry {
  present: boolean
  distanceCm: number | null
  coverage: number
  bbox: [number, number, number, number] | null
  errors: number
  fps: number
  pose?: { world: number[][]; norm: number[][]; healthy: number }
}
```

2. Добавить хелпер независимого парсинга pose (перед `parseTelemetry`):
```ts
function parsePose(raw: unknown): Telemetry['pose'] {
  // НЕЗАВИСИМЫЙ парсинг: любой сбой ⇒ undefined, presence-пакет не страдает (спека §7).
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const p = raw as Record<string, unknown>
  if (typeof p.healthy !== 'number' || !isFinite(p.healthy)) return undefined
  const okRows = (a: unknown): a is number[][] =>
    Array.isArray(a) && a.every((r) => Array.isArray(r) && r.every((n) => typeof n === 'number' && isFinite(n)))
  if (!okRows(p.world) || !okRows(p.norm)) return undefined
  return { world: p.world as number[][], norm: p.norm as number[][], healthy: p.healthy }
}
```

3. В возвращаемом объекте `parseTelemetry` добавить последним полем:
```ts
  return {
    present: j.present,
    distanceCm: finiteOrNull(j.distanceCm),
    coverage: finiteOrNull(j.coverage) ?? 0,
    bbox,
    errors: finiteOrNull(j.errors) ?? 0,
    fps: finiteOrNull(j.fps) ?? 0,
    pose: parsePose(j.pose),
  }
```

**Запуск (ожидается PASS):**
```
cd /Users/iman/Projects/background_ar && npx vitest run src/lux/telemetry.test.ts
```
Ожидаемый вывод: `5 passed`.

**Коммит:**
```
git add src/lux/telemetry.ts src/lux/telemetry.test.ts
git commit -m "feat(shadow) D2: Telemetry.pose независимый парсинг (битый pose ⇒ undefined, presence жив)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### D2.2 — `LUX_CONFIG.shadow` получает `blobRatio` и `shadowFloorK`

Контракт: `LUX_CONFIG.shadow` gains: `blobRatio: 0.5`, `shadowFloorK: 0.7` (existing: `strength`, `softness`, `bias`).

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/config.ts` (`:17`)
- Test: `/Users/iman/Projects/background_ar/src/lux/config.test.ts` (создать или дополнить)

**Failing-тест.** Создать/дополнить `/Users/iman/Projects/background_ar/src/lux/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { LUX_CONFIG } from './config'

describe('LUX_CONFIG.shadow D2 ручки', () => {
  it('blobRatio = 0.5 (blob — доля per-room силы, светлее тела)', () => {
    expect(LUX_CONFIG.shadow.blobRatio).toBe(0.5)
  })
  it('shadowFloorK = 0.7 (потолок черноты §4.5)', () => {
    expect(LUX_CONFIG.shadow.shadowFloorK).toBe(0.7)
  })
  it('существующие ручки сохранены', () => {
    expect(LUX_CONFIG.shadow.strength).toBe(0.5)
    expect(LUX_CONFIG.shadow.softness).toBe(1.6)
    expect(LUX_CONFIG.shadow.bias).toBe(0.005)
  })
})
```

**Запуск (ожидается FAIL):**
```
cd /Users/iman/Projects/background_ar && npx vitest run src/lux/config.test.ts
```
Ожидаемый вывод (FAIL): `expect(LUX_CONFIG.shadow.blobRatio).toBe(0.5)` → `received: undefined`; типчек: `Property 'blobRatio' does not exist`.

**Минимальная реализация.** В `/Users/iman/Projects/background_ar/src/lux/config.ts` заменить строку `:17`:

```ts
  shadow: { strength: 0.5, softness: 1.6, bias: 0.005, blobRatio: 0.5, shadowFloorK: 0.7 }, // мягкая серая тень, контакт у ног; blobRatio = blob как доля per-room силы; shadowFloorK = потолок черноты (§4.5)
```

**Запуск (ожидается PASS):**
```
cd /Users/iman/Projects/background_ar && npx vitest run src/lux/config.test.ts
```
Ожидаемый вывод: `3 passed`.

**Коммит:**
```
git add src/lux/config.ts src/lux/config.test.ts
git commit -m "feat(shadow) D2: LUX_CONFIG.shadow += blobRatio(0.5), shadowFloorK(0.7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### D2.3 — Чистая функция `shadowLadder`: гистерезис + crossfade-вес из `healthy` и F-gate

Контракт §6: лестница `proxy / crossfade / room / силуэт`. Crossfade `w = smoothstep(POSE_DROP, POSE_ENTER, healthy)`. Гистерезис: вход в proxy при `healthy ≥ POSE_ENTER`, выпадение в room при `healthy < POSE_DROP`, между порогами держим текущее состояние. F sanity-gate: `abs(F.z - floorZ) > Z_THR` ⇒ отвергаем F ⇒ fallback v1 этот кадр.

Это чистая, тестируемая без WebGL математика — выносим в `shadowGeom.ts`, чтобы compositor только применял веса.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts` (добавить экспорт `shadowLadder` + константы)
- Test: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts` (создать или дополнить — блок `describe('shadowLadder', …)`)

**Failing-тест.** Дополнить `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { shadowLadder, POSE_ENTER, POSE_DROP, Z_THR } from './shadowGeom'

describe('shadowLadder — гистерезис + crossfade + F-gate (D2.3)', () => {
  it('пороги канона', () => {
    expect(POSE_ENTER).toBe(0.7)
    expect(POSE_DROP).toBe(0.5)
    expect(Z_THR).toBe(0.15)
  })

  it('нет pose ⇒ room c wProxy=0', () => {
    const r = shadowLadder({ healthy: null, fz: 0, floorZ: 0, prevProxy: false })
    expect(r.mode).toBe('room')
    expect(r.wProxy).toBe(0)
    expect(r.proxyActive).toBe(false)
  })

  it('healthy ≥ ENTER и F в полу ⇒ proxy, wProxy=1', () => {
    const r = shadowLadder({ healthy: 0.9, fz: 0.05, floorZ: 0, prevProxy: false })
    expect(r.mode).toBe('proxy')
    expect(r.wProxy).toBe(1)
    expect(r.proxyActive).toBe(true)
  })

  it('healthy < DROP ⇒ room, wProxy=0 (даже если раньше был proxy)', () => {
    const r = shadowLadder({ healthy: 0.4, fz: 0, floorZ: 0, prevProxy: true })
    expect(r.mode).toBe('room')
    expect(r.wProxy).toBe(0)
    expect(r.proxyActive).toBe(false)
  })

  it('между порогами + был proxy ⇒ остаёмся proxy с crossfade-весом (гистерезис)', () => {
    const r = shadowLadder({ healthy: 0.6, fz: 0, floorZ: 0, prevProxy: true })
    expect(r.mode).toBe('crossfade')
    expect(r.proxyActive).toBe(true)
    // smoothstep(0.5, 0.7, 0.6) = 0.5
    expect(r.wProxy).toBeCloseTo(0.5, 5)
  })

  it('между порогами + НЕ был proxy ⇒ остаёмся room, wProxy=0 (гистерезис не пускает вверх)', () => {
    const r = shadowLadder({ healthy: 0.6, fz: 0, floorZ: 0, prevProxy: false })
    expect(r.mode).toBe('room')
    expect(r.wProxy).toBe(0)
    expect(r.proxyActive).toBe(false)
  })

  it('F sanity-gate: |F.z-floorZ| > Z_THR ⇒ room даже при healthy=1', () => {
    const r = shadowLadder({ healthy: 1.0, fz: 0.5, floorZ: 0, prevProxy: true })
    expect(r.mode).toBe('room')
    expect(r.wProxy).toBe(0)
    expect(r.proxyActive).toBe(false)
  })

  it('F sanity-gate ровно на пороге (0.15) проходит, чуть выше — отвергается', () => {
    expect(shadowLadder({ healthy: 1, fz: 0.15, floorZ: 0, prevProxy: true }).mode).toBe('proxy')
    expect(shadowLadder({ healthy: 1, fz: 0.151, floorZ: 0, prevProxy: true }).mode).toBe('room')
  })

  it('smoothstep монотонно растёт в окне', () => {
    const a = shadowLadder({ healthy: 0.55, fz: 0, floorZ: 0, prevProxy: true }).wProxy
    const b = shadowLadder({ healthy: 0.65, fz: 0, floorZ: 0, prevProxy: true }).wProxy
    expect(b).toBeGreaterThan(a)
  })
})
```

**Запуск (ожидается FAIL):**
```
cd /Users/iman/Projects/background_ar && npx vitest run src/lux/shadowGeom.test.ts
```
Ожидаемый вывод (FAIL): `TS2305: Module './shadowGeom' has no exported member 'shadowLadder'` (и `POSE_ENTER`/`POSE_DROP`/`Z_THR`).

**Минимальная реализация.** В `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts` добавить в конец файла:

```ts
// --- D2: лестница деградации (гистерезис + crossfade + F sanity-gate, спека §5/§6) ---
export const POSE_ENTER = 0.7   // healthy ≥ — входим в proxy
export const POSE_DROP = 0.5    // healthy < — сваливаемся в room
export const Z_THR = 0.15       // |F.z-floorZ| > — F отвергнут, fallback v1

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

export type ShadowMode = 'proxy' | 'crossfade' | 'room'

export interface LadderResult {
  mode: ShadowMode      // proxy: только 3D; crossfade: 3D(wProxy)+room(1-wProxy); room: только v1
  wProxy: number        // вес proxy-тени 0..1 (room-вес = 1-wProxy)
  proxyActive: boolean  // нужно ли рендерить/обновлять 3D-сцену (mode != room)
}

// Решение лестницы. healthy=null ⇒ pose отсутствует/отвергнут вызывающим.
// prevProxy — был ли proxy активен в прошлом кадре (для гистерезиса между порогами).
export function shadowLadder(args: {
  healthy: number | null
  fz: number           // F.z (мировая Z ступней) — у вызывающего из sampleWorldXYZ
  floorZ: number
  prevProxy: boolean
}): LadderResult {
  const { healthy, fz, floorZ, prevProxy } = args
  // F sanity-gate: ступни не на полу ⇒ proxy некогерентен ⇒ room
  if (healthy === null || Math.abs(fz - floorZ) > Z_THR) {
    return { mode: 'room', wProxy: 0, proxyActive: false }
  }
  if (healthy >= POSE_ENTER) {
    return { mode: 'proxy', wProxy: 1, proxyActive: true }
  }
  if (healthy < POSE_DROP) {
    return { mode: 'room', wProxy: 0, proxyActive: false }
  }
  // зона перехлёста [DROP, ENTER): держим прошлое состояние (гистерезис)
  if (prevProxy) {
    return { mode: 'crossfade', wProxy: smoothstep(POSE_DROP, POSE_ENTER, healthy), proxyActive: true }
  }
  return { mode: 'room', wProxy: 0, proxyActive: false }
}
```

**Запуск (ожидается PASS):**
```
cd /Users/iman/Projects/background_ar && npx vitest run src/lux/shadowGeom.test.ts
```
Ожидаемый вывод: блок `shadowLadder` — `9 passed` (плюс ранее существовавшие тесты файла зелёные).

**Коммит:**
```
git add src/lux/shadowGeom.ts src/lux/shadowGeom.test.ts
git commit -m "feat(shadow) D2: shadowLadder — гистерезис + crossfade-вес + F sanity-gate (чистая ф-я)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### D2.4 — `multiplyBlitMat` получает потолок черноты `uShadowFloorK`/`uShadowStrength`

Контракт: `multiplyBlitMat` uniforms = `tBg, tShadow, uUvScale, uShadowFloorK, uShadowStrength`; `shadowTerm = 1.0 - texture(tShadow, uv).r`; `m = mix(1.0, 1.0 - uShadowStrength*uShadowFloorK, shadowTerm)`; `out = vec4(texture(tBg, coverUv).rgb * m, 1.0)`; GLSL1 ok. В D1 материал создан; D2 добавляет потолок черноты в шейдер и проводку. Тестируем не-GPU: проверяем, что uniform-объект несёт нужные ключи и числовые дефолты (структурный тест материала без рендера).

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/compositor.ts` (`multiplyBlitMat` определение из D1; uniforms + fragment shader; проводка в слоте тени `:538-582`)
- Test: `/Users/iman/Projects/background_ar/src/lux/multiplyBlit.test.ts` (создать — структурный + чистый расчёт множителя)

**Примечание по изоляции теста.** `LuxCompositor` требует `THREE.WebGLRenderer` (нет в jsdom). Поэтому фрагмент-математику выносим в чистый экспорт `shadowMultiplier(shadowTerm, strength, floorK)` рядом с шейдером и юнит-тестируем именно его (GPU-путь — на live-приёмку). Сам шейдер использует эту же формулу.

**Failing-тест.** Создать `/Users/iman/Projects/background_ar/src/lux/multiplyBlit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { shadowMultiplier } from './shadowMath'

describe('shadowMultiplier — потолок черноты (D2.4, §4.5)', () => {
  it('вне тени (shadowTerm=0) ⇒ m=1.0 (кадр не темнеет)', () => {
    expect(shadowMultiplier(0, 0.6, 0.7)).toBeCloseTo(1.0, 6)
  })
  it('самая плотная точка (shadowTerm=1) при strength=0.6, floorK=0.7 ⇒ m≈0.58', () => {
    // m = mix(1, 1 - 0.6*0.7, 1) = 1 - 0.42 = 0.58
    expect(shadowMultiplier(1, 0.6, 0.7)).toBeCloseTo(0.58, 6)
  })
  it('середина тени линейно интерполируется', () => {
    // mix(1, 0.58, 0.5) = 0.79
    expect(shadowMultiplier(0.5, 0.6, 0.7)).toBeCloseTo(0.79, 6)
  })
  it('никогда не уходит в 0 при floorK<1 (тень не чернее объектов)', () => {
    expect(shadowMultiplier(1, 1.0, 0.7)).toBeCloseTo(0.3, 6) // 1 - 1*0.7
    expect(shadowMultiplier(1, 1.0, 0.7)).toBeGreaterThan(0)
  })
})
```

**Запуск (ожидается FAIL):**
```
cd /Users/iman/Projects/background_ar && npx vitest run src/lux/multiplyBlit.test.ts
```
Ожидаемый вывод (FAIL): `Cannot find module './shadowMath'` — модуль ещё не создан.

**Минимальная реализация.**

1. Создать `/Users/iman/Projects/background_ar/src/lux/shadowMath.ts`:
```ts
// Множитель тени для multiply-blit (§4.4/§4.5). Идентичен GLSL в multiplyBlitMat.
// shadowTerm ∈ [0,1]: 0 = вне тени, 1 = самая плотная.
// m = mix(1, 1 - strength*floorK, shadowTerm). Вне тени m=1 (нейтрально),
// в плотной точке упирается в потолок (не уходит в чёрный при floorK<1).
export function shadowMultiplier(shadowTerm: number, strength: number, floorK: number): number {
  const floor = 1 - strength * floorK
  return floor + (1 - floor) * (1 - shadowTerm) // == mix(1, floor, shadowTerm)
}
```

2. В `/Users/iman/Projects/background_ar/src/lux/compositor.ts` обновить определение `multiplyBlitMat` (созданного в D1) — uniforms должны включать `uShadowFloorK` и `uShadowStrength`, фрагмент-шейдер реализует потолок черноты:
```ts
    this.multiplyBlitMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL1,
      uniforms: {
        tBg: { value: null }, tShadow: { value: null },
        uUvScale: { value: new THREE.Vector2(1, 1) },
        uShadowFloorK: { value: 0.7 }, uShadowStrength: { value: 0.5 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tBg, tShadow;
        uniform vec2 uUvScale; uniform float uShadowFloorK, uShadowStrength;
        void main() {
          vec2 coverUv = (vUv - 0.5) * uUvScale + 0.5;       // cover-fit crop тени = crop плейта
          float shadowTerm = 1.0 - texture2D(tShadow, coverUv).r; // белый clear ⇒ вне тени term=0
          float floorM = 1.0 - uShadowStrength * uShadowFloorK;    // потолок черноты
          float m = mix(1.0, floorM, shadowTerm);
          gl_FragColor = vec4(texture2D(tBg, vUv).rgb * m, 1.0);
        }
      `,
      depthTest: false,
    })
```

3. В слоте тени (`compositor.ts:538-582`) перед `this.pass(this.multiplyBlitMat, this.shadowRT2)` проставить силу/потолок из per-room (per-room `shadowStrength` приходит из `opts` — провязывается в D2.5; пока используем `opts.shadowCfg`-совместимое поле, замена в D2.5):
```ts
  m.uShadowStrength.value = opts.shadowStrength
  m.uShadowFloorK.value = opts.shadowCfg.shadowFloorK ?? 0.7
```

**Запуск (ожидается PASS):**
```
cd /Users/iman/Projects/background_ar && npx vitest run src/lux/multiplyBlit.test.ts
```
Ожидаемый вывод: `4 passed`.

**Коммит:**
```
git add src/lux/shadowMath.ts src/lux/multiplyBlit.test.ts src/lux/compositor.ts
git commit -m "feat(shadow) D2: multiplyBlit потолок черноты (shadowMultiplier + uShadowFloorK/uShadowStrength)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### D2.5 — Per-room `meta.shadowStrength` → ВСЕ компоненты (proxy ShadowMaterial.opacity, blob, groundShadow)

Контракт: `meta.shadowStrength` — PER-ROOM master; v2 wires к `ShadowMaterial.opacity` (proxy body) И `blob uOpacity = shadowStrength*blobRatio*mirrorOpacity` И existing `groundShadowMat`. Сейчас v1 `roomShadowMat` ошибочно берёт глобальный `shadowCfg.strength` — фиксим. `ShadowScene3D.update` должен принять `shadowStrength` и проставить его в receiver-`ShadowMaterial.opacity`.

Тестируем без WebGL чистую формулу blob-opacity (`blobOpacity`) и тот факт, что `meta.shadowStrength` прокидывается в opts. GPU-применение (`ShadowMaterial.opacity`) — на live.

**Files:**
- Create: `/Users/iman/Projects/background_ar/src/lux/shadowMath.ts` (дополнить — `blobOpacity`)
- Modify: `/Users/iman/Projects/background_ar/src/lux/compositor.ts` (blob-ветка `:572-577` → `b.uOpacity.value = blobOpacity(opts.shadowStrength, LUX_CONFIG.shadow.blobRatio, opts.mirrorOpacity)`; proxy-ветка передаёт `opts.shadowStrength` в `shadowScene3D.update`)
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` (`update` принимает `shadowStrength`, ставит `receiver ShadowMaterial.opacity`)
- Test: `/Users/iman/Projects/background_ar/src/lux/multiplyBlit.test.ts` (дополнить блоком `blobOpacity`)

**Failing-тест.** Дополнить `/Users/iman/Projects/background_ar/src/lux/multiplyBlit.test.ts`:

```ts
import { blobOpacity } from './shadowMath'

describe('blobOpacity — blob как доля per-room силы (D2.5, §6)', () => {
  it('гостиная: shadowStrength=0.6, blobRatio=0.5, mirror=1 ⇒ 0.30 (светлее тела)', () => {
    expect(blobOpacity(0.6, 0.5, 1)).toBeCloseTo(0.30, 6)
  })
  it('масштабируется mirrorOpacity (фейд зеркала)', () => {
    expect(blobOpacity(0.6, 0.5, 0.5)).toBeCloseTo(0.15, 6)
  })
  it('blob всегда легче тела: при равном mirror blobOpacity < shadowStrength', () => {
    const ss = 0.8
    expect(blobOpacity(ss, 0.5, 1)).toBeLessThan(ss)
  })
})
```

**Запуск (ожидается FAIL):**
```
cd /Users/iman/Projects/background_ar && npx vitest run src/lux/multiplyBlit.test.ts
```
Ожидаемый вывод (FAIL): `'blobOpacity' is not exported by 'src/lux/shadowMath.ts'`.

**Минимальная реализация.**

1. Дополнить `/Users/iman/Projects/background_ar/src/lux/shadowMath.ts`:
```ts
// Прозрачность blob-контакта: доля per-room силы, масштаб фейдом зеркала (§6).
// blobRatio < 1 ⇒ blob всегда легче тела-прокси.
export function blobOpacity(shadowStrength: number, blobRatio: number, mirrorOpacity: number): number {
  return shadowStrength * blobRatio * mirrorOpacity
}
```

2. В `/Users/iman/Projects/background_ar/src/lux/compositor.ts`, blob-ветка (`:572-577`), заменить хардкод `uOpacity`:
```ts
        b.uOpacity.value = blobOpacity(opts.shadowStrength, LUX_CONFIG.shadow.blobRatio, opts.mirrorOpacity)
```
(импорт `import { blobOpacity, shadowMultiplier } from './shadowMath'` и `import { LUX_CONFIG } from './config'` — добавить в шапку, если ещё не импортированы; `shadowMultiplier` сам в шейдере не нужен, но импорт `LUX_CONFIG` обязателен.)

3. В proxy-ветке (D1 `shadowScene3D.update(...)`) передать силу:
```ts
        this.shadowScene3D.update(opts.pose, opts.personFloor, opts.shadowData, opts.shadowStrength)
```

4. В `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` сигнатуру `update` расширить и проставить opacity приёмника (receiver `ShadowMaterial`):
```ts
  update(
    pose: { world: number[][]; norm: number[][]; healthy: number },
    personFloor: { F: THREE.Vector3; H: number },
    shadowData: BuiltWorld['shadowData'],
    shadowStrength: number,
  ): void {
    // per-room мастер-ручка ⇒ ShadowMaterial.opacity приёмника (§4.1/§4.5)
    for (const recv of this._receiverMeshes) {
      const mat = (recv as THREE.Mesh).material as THREE.ShadowMaterial
      mat.opacity = shadowStrength
    }
    this.proxyRig.update(pose.world, personFloor.F, personFloor.H)
  }
```
(`this._receiverMeshes: THREE.Object3D[]` — список, который держит `setReceiver`; завести поле, если ещё нет.)

**Запуск (ожидается PASS):**
```
cd /Users/iman/Projects/background_ar && npx vitest run src/lux/multiplyBlit.test.ts
```
Ожидаемый вывод: `7 passed` (4 из D2.4 + 3 новых).

**Коммит:**
```
git add src/lux/shadowMath.ts src/lux/multiplyBlit.test.ts src/lux/compositor.ts src/lux/shadowScene3D.ts
git commit -m "feat(shadow) D2: per-room meta.shadowStrength ко всем компонентам (proxy opacity + blob + ground)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### D2.6 — Перетюн blob: `rx*1.05`, `ry = rx*0.25`, `smoothstep(0.6, 1.0, r)`

Контракт/§6-таблица: `rx = (halfW/sx)*1.05` (было `*1.5`); `uRadius.y = rx*0.25` (было `*0.4`); шейдерный край `smoothstep(0.6, 1.0, r)` (было `0.35`). Цель — blob мягче/меньше, не наклейка.

Тестируем чистую функцию `blobRadii(halfW, sx)` (выносим расчёт радиусов), GPU-форму blob — на live.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowMath.ts` (добавить `blobRadii`)
- Modify: `/Users/iman/Projects/background_ar/src/lux/compositor.ts` (blob-ветка `:575-576` → `blobRadii`; blob-шейдер `:409` smoothstep `0.35`→`0.6`)
- Test: `/Users/iman/Projects/background_ar/src/lux/multiplyBlit.test.ts` (дополнить блоком `blobRadii`)

**Failing-тест.** Дополнить `/Users/iman/Projects/background_ar/src/lux/multiplyBlit.test.ts`:

```ts
import { blobRadii } from './shadowMath'

describe('blobRadii — перетюн blob мягче/меньше (D2.6, §6)', () => {
  it('rx = (halfW/sx)*1.05 (было *1.5)', () => {
    const { rx } = blobRadii(0.2, 1.0)
    expect(rx).toBeCloseTo(0.2 * 1.05, 6)
  })
  it('ry = rx*0.25 (было *0.4)', () => {
    const { rx, ry } = blobRadii(0.2, 1.0)
    expect(ry).toBeCloseTo(rx * 0.25, 6)
  })
  it('учитывает sx (cover-fit scale по X)', () => {
    const { rx } = blobRadii(0.2, 2.0)
    expect(rx).toBeCloseTo((0.2 / 2.0) * 1.05, 6)
  })
})
```

**Запуск (ожидается FAIL):**
```
cd /Users/iman/Projects/background_ar && npx vitest run src/lux/multiplyBlit.test.ts
```
Ожидаемый вывод (FAIL): `'blobRadii' is not exported by 'src/lux/shadowMath.ts'`.

**Минимальная реализация.**

1. Дополнить `/Users/iman/Projects/background_ar/src/lux/shadowMath.ts`:
```ts
// Радиусы blob-эллипса в UV композита (§6, перетюн v2: компактнее/площе).
export function blobRadii(halfW: number, sx: number): { rx: number; ry: number } {
  const rx = (halfW / sx) * 1.05
  return { rx, ry: rx * 0.25 }
}
```

2. В `/Users/iman/Projects/background_ar/src/lux/compositor.ts`, blob-ветка (`:575-576`), заменить:
```ts
        const { rx, ry } = blobRadii(opts.feetUV.halfW, sx)
        b.uRadius.value.set(rx, ry)
```
(импорт `blobRadii` добавить к существующему импорту из `./shadowMath`.)

3. В blob-шейдере (`compositor.ts:409`) заменить край:
```ts
          float a = (1.0 - smoothstep(0.6, 1.0, r)) * uOpacity; // плотнее в центре, очень мягкий край (v2)
```

**Запуск (ожидается PASS):**
```
cd /Users/iman/Projects/background_ar && npx vitest run src/lux/multiplyBlit.test.ts
```
Ожидаемый вывод: `10 passed` (7 + 3 новых).

**Коммит:**
```
git add src/lux/shadowMath.ts src/lux/multiplyBlit.test.ts src/lux/compositor.ts
git commit -m "feat(shadow) D2: blob перетюн rx*1.05/ry*0.25/smoothstep(0.6) — мягче/меньше

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### D2.7 — Связать `shadowLadder` со слотом тени: crossfade + отключение `roomShadowMat` в proxy-режиме

Контракт §6/§4.4: в proxy-режиме `roomShadowMat` НЕ вызывается; в crossfade — обе тени с весами `w` (proxy) и `1-w` (room); в room/силуэте — v1. `shadowScene3D` обновляется/рендерится только при `proxyActive`. `prevProxy` хранится между кадрами в `compositor` (поле `this._prevProxy`). `healthy` для лестницы — из `opts.pose?.healthy ?? null`; `fz` — из `opts.personFloor?.F[2] ?? floorZ` (при отсутствии personFloor лестница и так уйдёт в room через `healthy===null`).

GPU-композит на live; здесь юнит-тест проверяет, что **выбор ветки + веса** в чистой обёртке `selectShadowBranch` соответствует лестнице (compositor вызывает её, никакой WebGL).

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts` (добавить `selectShadowBranch` — тонкая обёртка над `shadowLadder`, нормализует входы из opts)
- Modify: `/Users/iman/Projects/background_ar/src/lux/compositor.ts` (слот тени `:538-582`: ветвление по `selectShadowBranch`, поле `this._prevProxy`, проводка весов в `multiplyBlitMat`/`roomShadowMat.uOpacity`)
- Test: `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts` (дополнить — блок `selectShadowBranch`)

**Failing-тест.** Дополнить `/Users/iman/Projects/background_ar/src/lux/shadowGeom.test.ts`:

```ts
import { selectShadowBranch } from './shadowGeom'

describe('selectShadowBranch — нормализация opts → лестница (D2.7)', () => {
  const floorZ = 0
  it('нет pose ⇒ room, roomShadowMat активен, proxy выкл', () => {
    const r = selectShadowBranch({ pose: undefined, fz: 0, floorZ, prevProxy: false })
    expect(r.mode).toBe('room')
    expect(r.drawProxy).toBe(false)
    expect(r.drawRoom).toBe(true)
    expect(r.wProxy).toBe(0)
  })
  it('healthy высок + F в полу ⇒ proxy, room ВЫКЛ (§4.4)', () => {
    const r = selectShadowBranch({ pose: { world: [], norm: [], healthy: 0.9 }, fz: 0.02, floorZ, prevProxy: true })
    expect(r.mode).toBe('proxy')
    expect(r.drawProxy).toBe(true)
    expect(r.drawRoom).toBe(false)
    expect(r.wProxy).toBe(1)
  })
  it('crossfade ⇒ рисуем ОБЕ с весами w / 1-w', () => {
    const r = selectShadowBranch({ pose: { world: [], norm: [], healthy: 0.6 }, fz: 0, floorZ, prevProxy: true })
    expect(r.mode).toBe('crossfade')
    expect(r.drawProxy).toBe(true)
    expect(r.drawRoom).toBe(true)
    expect(r.wProxy).toBeCloseTo(0.5, 5)
    expect(r.wRoom).toBeCloseTo(0.5, 5)
  })
  it('F вне пола ⇒ room (F-gate), proxy выкл даже при healthy=1', () => {
    const r = selectShadowBranch({ pose: { world: [], norm: [], healthy: 1 }, fz: 0.4, floorZ, prevProxy: true })
    expect(r.mode).toBe('room')
    expect(r.drawProxy).toBe(false)
  })
})
```

**Запуск (ожидается FAIL):**
```
cd /Users/iman/Projects/background_ar && npx vitest run src/lux/shadowGeom.test.ts
```
Ожидаемый вывод (FAIL): `'selectShadowBranch' is not exported by 'src/lux/shadowGeom.ts'`.

**Минимальная реализация.**

1. В `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts` добавить:
```ts
export interface BranchResult {
  mode: ShadowMode
  drawProxy: boolean   // рендерить 3D proxy-тень
  drawRoom: boolean    // рендерить v1 roomShadowMat (в proxy-режиме false — §4.4)
  wProxy: number
  wRoom: number        // == 1 - wProxy
}

// Обёртка: нормализует opts-вход (pose?.healthy, F.z) и раскладывает лестницу
// в флаги ветвления слота тени. proxy-режим ⇒ roomShadowMat не вызывается.
export function selectShadowBranch(args: {
  pose: { world: number[][]; norm: number[][]; healthy: number } | undefined
  fz: number
  floorZ: number
  prevProxy: boolean
}): BranchResult {
  const healthy = args.pose ? args.pose.healthy : null
  const l = shadowLadder({ healthy, fz: args.fz, floorZ: args.floorZ, prevProxy: args.prevProxy })
  return {
    mode: l.mode,
    drawProxy: l.proxyActive,
    drawRoom: l.mode !== 'proxy', // proxy: room ВЫКЛ; crossfade: обе; room: только room
    wProxy: l.wProxy,
    wRoom: 1 - l.wProxy,
  }
}
```

2. В `/Users/iman/Projects/background_ar/src/lux/compositor.ts`:
   - Завести поле в классе (рядом с другими private): `private _prevProxy = false`
   - В слоте тени (`:538-582`) заменить условие `if (opts.shadowData && opts.personFloor)` на разбор ветки:
```ts
      const branch = selectShadowBranch({
        pose: opts.pose,
        fz: opts.personFloor ? opts.personFloor.F[2] : opts.shadowData?.floorZ ?? 0,
        floorZ: opts.shadowData?.floorZ ?? 0,
        prevProxy: this._prevProxy,
      })
      this._prevProxy = branch.drawProxy
      if (opts.shadowData && opts.personFloor && branch.drawProxy) {
        // 3D proxy-тень (вес branch.wProxy в crossfade)
        this.shadowScene3D.update(opts.pose!, opts.personFloor, opts.shadowData, opts.shadowStrength)
        this.renderer.setRenderTarget(this.shadowRT)
        this.renderer.setClearColor(0xffffff, 1); this.renderer.clear()
        this.renderer.render(this.shadowScene3D.scene, this.shadowScene3D.camera)
        this.renderer.setRenderTarget(null)
        this.renderer.setClearColor(0x000000, 1) // восстановить для FSQ-блитов
        const m = this.multiplyBlitMat.uniforms
        m.tBg.value = this.compositeRT.texture
        m.tShadow.value = this.shadowRT.texture
        m.uUvScale.value.copy(this.coverMat.uniforms.uUvScale.value)
        m.uShadowStrength.value = opts.shadowStrength * branch.wProxy // crossfade-вес
        m.uShadowFloorK.value = LUX_CONFIG.shadow.shadowFloorK
        this.pass(this.multiplyBlitMat, this.shadowRT2)
        this.blitMat.uniforms.tSrc.value = this.shadowRT2.texture
        this.pass(this.blitMat, this.compositeRT)
      }
      if (opts.shadowData && opts.personFloor && branch.drawRoom) {
        // FALLBACK/crossfade v1: roomShadowMat (вес branch.wRoom)
        const u = this.roomShadowMat.uniforms
        // ... существующая проводка roomShadowMat (compositor.ts:540-558),
        //     .cameraPos → opts.shadowData.camera.pos (контракт D1) ...
        u.uOpacity.value = opts.mirrorOpacity * branch.wRoom
        this.pass(this.roomShadowMat, this.shadowRT)
        this.blitMat.uniforms.tSrc.value = this.shadowRT.texture
        this.pass(this.blitMat, this.compositeRT)
      } else if (!opts.shadowData || !opts.personFloor) {
        // FALLBACK силуэт groundShadowMat (compositor.ts:563-568, уже на opts.shadowStrength)
        const g = this.groundShadowMat.uniforms
        g.tVideo.value = opts.person
        g.uUvScale.value.set(sx, sy)
        g.uOpacity.value = opts.shadowStrength * opts.mirrorOpacity
        g.uLightX.value = opts.lightDirX * 0.015
        this.pass(this.groundShadowMat, this.compositeRT)
      }
      // 4б. blob — ВСЕГДА (D2.5/D2.6)
```
   - Импорт: `import { selectShadowBranch } from './shadowGeom'` в шапке.

**Запуск (ожидается PASS):**
```
cd /Users/iman/Projects/background_ar && npx vitest run src/lux/shadowGeom.test.ts
```
Ожидаемый вывод: блок `selectShadowBranch` — `4 passed` (плюс блок `shadowLadder` из D2.3 зелёный).

**Коммит:**
```
git add src/lux/shadowGeom.ts src/lux/shadowGeom.test.ts src/lux/compositor.ts
git commit -m "feat(shadow) D2: crossfade-ветвление слота тени + roomShadowMat off в proxy-режиме

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### D2.8 — Мягкость кромки под сцену: `key.shadow.radius` из `LUX_CONFIG.shadow.softness`

Контракт §4.5: кромку тени сглаживаем под общую мягкость плейта через `key.shadow.radius` (PCFSoft). `ShadowScene3D` уже создаёт Key-PointLight с `castShadow`; D2 проставляет `key.shadow.radius` из `LUX_CONFIG.shadow.softness`, чтобы переход свет→тень читался мягко (критерий «не наклейка»). Чистый тест: фабрика радиуса `keyShadowRadius(softness)` (масштаб texel-space) — применение к `light.shadow.radius` на live.

**Files:**
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowMath.ts` (добавить `keyShadowRadius`)
- Modify: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` (в конструкторе Key-лампы: `key.shadow.radius = keyShadowRadius(LUX_CONFIG.shadow.softness)`)
- Test: `/Users/iman/Projects/background_ar/src/lux/multiplyBlit.test.ts` (дополнить — блок `keyShadowRadius`)

**Failing-тест.** Дополнить `/Users/iman/Projects/background_ar/src/lux/multiplyBlit.test.ts`:

```ts
import { keyShadowRadius } from './shadowMath'

describe('keyShadowRadius — мягкость кромки PCFSoft (D2.8, §4.5)', () => {
  it('softness масштабируется в texel-space radius (softness=1.6 ⇒ 6.4)', () => {
    expect(keyShadowRadius(1.6)).toBeCloseTo(6.4, 6) // 1.6*4
  })
  it('монотонно растёт с softness', () => {
    expect(keyShadowRadius(2.0)).toBeGreaterThan(keyShadowRadius(1.0))
  })
  it('никогда < 1 (PCFSoft требует радиус ≥ 1 texel)', () => {
    expect(keyShadowRadius(0)).toBeGreaterThanOrEqual(1)
  })
})
```

**Запуск (ожидается FAIL):**
```
cd /Users/iman/Projects/background_ar && npx vitest run src/lux/multiplyBlit.test.ts
```
Ожидаемый вывод (FAIL): `'keyShadowRadius' is not exported by 'src/lux/shadowMath.ts'`.

**Минимальная реализация.**

1. Дополнить `/Users/iman/Projects/background_ar/src/lux/shadowMath.ts`:
```ts
// PCFSoft radius в texel-space из общей мягкости плейта (§4.5).
// softness=1.6 (LUX_CONFIG) ⇒ 6.4 texels — мягкий, «несрезанный» край.
export function keyShadowRadius(softness: number): number {
  return Math.max(1, softness * 4)
}
```

2. В `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts`, при создании Key-PointLight (где уже `key.castShadow = true`, `key.shadow.mapSize.set(2048, 2048)`, `bias`, `normalBias`):
```ts
    key.shadow.radius = keyShadowRadius(LUX_CONFIG.shadow.softness)
```
(импорт `import { keyShadowRadius } from './shadowMath'` и `import { LUX_CONFIG } from './config'` в шапку модуля, если ещё не импортированы.)

**Запуск (ожидается PASS):**
```
cd /Users/iman/Projects/background_ar && npx vitest run src/lux/multiplyBlit.test.ts
```
Ожидаемый вывод: `13 passed` (10 + 3 новых).

**Коммит:**
```
git add src/lux/shadowMath.ts src/lux/multiplyBlit.test.ts src/lux/shadowScene3D.ts
git commit -m "feat(shadow) D2: key.shadow.radius из softness — мягкая кромка под сцену (не срезанная)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### D2.9 — Регрессия всего набора тестов + typecheck зелёные

Контракт §10: держать **≥92 теста** + typecheck зелёными, плюс новые pose/proxy/receiver/ladder-тесты.

**Files:**
- Test: весь набор (`src/**/*.test.ts`)

**Запуск:**
```
cd /Users/iman/Projects/background_ar && npx vitest run
```
Ожидаемый вывод: все файлы `passed`, суммарно ≥ 92 прежних + новые из D2.1–D2.8 (telemetry pose ×5, config ×3, shadowLadder ×9, selectShadowBranch ×4, multiplyBlit/shadowMath ×13). Ни одного `failed`.

Typecheck (если в package.json есть скрипт `typecheck` = `tsc --noEmit`):
```
cd /Users/iman/Projects/background_ar && npx tsc --noEmit
```
Ожидаемый вывод: пустой (нет ошибок) — все новые экспорты (`Telemetry.pose`, `shadowLadder`, `selectShadowBranch`, `shadowMath.*`, `LUX_CONFIG.shadow.blobRatio/shadowFloorK`, `ShadowScene3D.update(...,shadowStrength)`) типизированы.

Если что-то красное — чинить минимально и повторять (TDD-цикл), затем:

**Коммит (если правки потребовались):**
```
git add -A
git commit -m "test(shadow) D2: весь набор + typecheck зелёные (≥92 + D2 тесты)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### D2.10 — Live-приёмка с заказчиком («тень не наклейка» + плавный откат) и Exit-criterion фазы

Это ручная приёмка (GPU/реальная камера), НЕ автотест. Не выполняется автором плана — выполняется на стенде с заказчиком. Запуск стенда (как обычно): capture-сервис из терминала пользователя (камера S24/Iriun = index 0), затем `npm run dev` рендерера, открыть `/viewer`.

Чек-лист приёмки (спека §10, Live-приёмка):
1. **Поднять руку → тень руки поднимается.** Ожидается: уверенно работает (артикуляция из `pose.world`).
2. **Наклон вбок / поворот корпуса → тень повторяет** (ориентация из landmarks, без force-face-camera).
3. **Шаг к мебели → тень взбирается на мебель/стену.** Оговорка проговаривается заказчику: «взбирание» — заслуга геометрии приёмника (B2 EXR-mesh), наклон **к/от камеры** меняет тень **слабо** (монокулярный z, §5/§8) — сознательное ограничение.
4. **Плавный откат без морганий:** потеря позы / спина к камере (`healthy < POSE_DROP`) / F вне пола (`|F.z-floorZ| > Z_THR`) → crossfade на v1 `roomShadowMat` БЕЗ скачка. Проверить туда-обратно несколько раз: гистерезис (`POSE_ENTER=0.7` / `POSE_DROP=0.5`) не даёт chatter на границе.
5. **Тень садится точно под ступнями** на плоском плейте (бейк камеры + cover-fit; уже доказано в B1 на не-совпадающем аспекте).
6. **ГЛАВНЫЙ критерий «тень — не отдельная наклейка» (§4.5):**
   - тень живёт под тем же зерном (`grainMat` поверх всего, инвариант) и той же мягкостью, что фон и фигура;
   - не чернее объектов сцены (потолок `shadowFloorK=0.7` — самый тёмный множитель ≈ 0.58 при `shadowStrength=0.6`);
   - `meta.shadowStrength` подобран под яркость локации (гостиная=0.6; где светлее — меньше); крутится одна цифра в `meta.json`, все тени (proxy/blob/ground) двигаются согласованно;
   - визуальная проверка по краю силуэта и по плотности: НЕТ ощущения «фон-текстура + наклеенная тень».
7. Параллельно подкрутить live-knob'и, если нужно: `meta.shadowStrength` (per-room), `LUX_CONFIG.shadow.softness`/`key.shadow.radius` (мягкость), `LUX_CONFIG.shadow.blobRatio` (лёгкость blob), `LUX_CONFIG.shadow.shadowFloorK` (потолок черноты).

**Exit-criterion фазы D2 (спека §10):**
> Плавный откат без морганий (crossfade+гистерезис, проверено вживую туда-обратно) **+** тень не читается отдельным слоем (единое зерно/мягкость/потолок черноты, подтверждено глазами заказчика по краю силуэта и плотности) **+** подпись заказчика на live-review.

После подписи — финальный коммит подкрученных live-значений (если менялись `meta.json`/`config.ts`):
```
git add public/assets/worlds/living/meta.json src/lux/config.ts
git commit -m "tune(shadow) D2: live-приёмка — per-room shadowStrength/softness/blobRatio под локацию

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
