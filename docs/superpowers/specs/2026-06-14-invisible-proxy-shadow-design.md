# Design Spec: v2 «Invisible Proxy + Shadow Caster» — поза-зависимая объёмная тень

**Дата:** 2026-06-14
**Проект:** «Stellar Mirror Lux» — AR magic-mirror kiosk. Человек стоит перед портретным экраном; вебкамера снимает его, RVM выматывает силуэт, и он фотореалистично композитится в Blender-рендер люксовой гостиной (квартира B2-10), показанной как плоский 2D-бэкплейт (`meta.flat`) через фуллскрин cover-fit-блит. v1-тень (закоммичена) = blob-контактная тень у ступней + screen-space PCSS-подобная тень тела (`roomShadowMat`). v2 добавляет **настоящую объёмную тень, повторяющую позу**.

> Девиз: «качество > fps, железо докупим». Не холтурим: один план реализации, только proxy-тень.

**Что такое v1-`roomShadowMat` (точная формулировка, intro-поправка).** Это **не** runtime-рендер Cycles-ламп. Для каждого пикселя комнаты шейдер читает его запечённую мировую позицию из worldPos-EXR, кастует луч к каждой **позиции** лампы из `lights.json` (просто координаты + вес, без оценки света Cycles в рантайме) и тестирует пересечение луча с плоским силуэт-билбордом (SBS-альфа фигуры) в точке ступней **F**, высотой **H**, лицом к камере (`compositor.ts:319-393`). Это PCSS-подобная screen-space-аппроксимация, а не физический пасс. v2 заменяет её настоящей теневой картой от 3D-прокси.

---

## 1. Цель и не-цели

### Цель
Заменить screen-space-аппроксимацию тела (`roomShadowMat`) на **физически рендеренную тень от невидимого 3D-прокси**, управляемого позой человека (33 landmark’а MediaPipe Pose). Тень должна:
- повторять артикуляцию конечностей (поднял руку → тень поднимает руку);
- «взбираться» на мебель и стены, а не лежать плоско на полу (явное требование заказчика) — при этом «взбирание» обеспечивает **геометрия приёмника**, а не глубина тела (см. §5, §8);
- садиться ровно на плоский 2D-плейт, потому что 3D-сцена тени рендерится **той же камерой, что и Blender-плейт** (`lights.json.camera`), **с тем же cover-fit-кропом**, что и плейт.

### Не-цели (scope guard)
- **НЕ** делаем скиннинг / IK / ретаргет на риг. Прокси — это капсулы между суставами, перестраиваемые каждый кадр. Прокси невидим, важна только его тень.
- **НЕ** трогаем матинг (RVM), цвет-матч, light-wrap, зерно, дистанцию/presence-логику.
- **НЕ** удаляем v1: `roomShadowMat` остаётся как fallback, blob остаётся как якорь пола (но перетюнен мягче/меньше).
- **НЕ** добавляем второй человек (`num_poses=1`).
- **НЕ** включаем сегментацию MediaPipe Pose (`output_segmentation_masks=False`).
- **НЕ** тащим VSM / внешний PCSS-инжект (см. §4.3 — out-of-scope-for-now с явным триггером).

---

## 2. Архитектура (две подсистемы + поток данных)

Система разделена на **capture** (Python, отдельный процесс) и **renderer** (three.js, браузер). Телеметрия идёт по существующему WebSocket-каналу `/ws` на 15 Гц.

**Важно про транспорт (не-инвариант, осознанный):** `/ws` (`server.py:_ws`) шлёт **снапшот** `pipeline.stats()` по таймеру `1/hz` (`server.py:59-69`), а не пер-кадровые данные. На проводе **нет** frame-id/timestamp (`telemetry.ts` не несёт `t_ms`). Видеоматте идёт отдельным WebRTC-потоком. Значит **pose-телеметрия (WS-снапшот @15 Гц) и композитимый силуэт (WebRTC) НЕ frame-locked** — proxy-тень может опережать/отставать от видимого тела на ~1 матте-кадр. Это реальный источник рассинхрона, маскируется сглаживанием F/H/позы (§5), см. риск в §8.

```
┌─────────────────────────── CAPTURE (Python) ────────────────────────────┐
│  FrameSource.read() → frame.rgb (УЖЕ RGB, webcam.py:27), frame.t_ms       │
│        │                                                                   │
│        ├─► MattingEngine.process(frame.rgb) → fg, alpha (pipeline.py:100)  │
│        │        └─► _mask_stats() → coverage, bbox (pipeline.py:101)       │
│        │                                                                   │
│        └─► PoseEngine.process(frame.rgb, frame.t_ms)  ◄── НОВОЕ            │
│                 (gate: self._pose is not None)                            │
│                 → pose_landmarks (norm), pose_world_landmarks (метры)      │
│                 → PosePacket{world, norm, healthy}                        │
│                       │ (внутри self._lock, pipeline.py:106-109)          │
│                       ▼                                                    │
│           PipelineStats.landmarks ──► _telemetry_json() (server.py:23)    │
│                                              │ JSON @15 Гц /ws (server.py:61)
└──────────────────────────────────────────────┼───────────────────────────┘
                                                ▼  WS (snapshot, не frame-sync)
┌─────────────────────────── RENDERER (three.js) ─────────────────────────┐
│  parseTelemetry(json) (telemetry.ts:17) → Telemetry{ …, pose? }           │
│        │                                                                   │
│        ▼ main.ts (render loop)                                            │
│  active.shadowData = lamps[] + camera{pos,target,fovY,aspect} + floorZ    │
│                      + worldPos (EXR Texture) + worldPosData (CPU)         │
│        │                                                                   │
│        ├─ personFloor{F,H} (v1, main.ts:184-211 + sampleWorldXYZ:31)      │
│        │   └─ F sanity-gate: |F.z-floorZ|<thr (§5) → иначе fallback v1    │
│        └─ pose landmarks → ProxyRig                                        │
│                                                                            │
│  renderer.shadowMap.enabled = true; .type = PCFSoftShadowMap (main.ts:59) │
│                                                                            │
│  ShadowScene3D (НОВЫЙ модуль):                                            │
│    • Receiver  ← плоскость пола + box-прокси (B1) / worldPos-EXR (B2)      │
│    • ProxyRig  ← pose_world_landmarks (invisible caster, colorWrite=false)│
│    • Lamps     ← lights.json.lamps (PointLight; castShadow ТОЛЬКО Key)    │
│    • Camera    ← lights.json.camera (pos/target/fovY/aspect, baked)       │
│        │                                                                   │
│        ▼  compositor.render() слот тени (compositor.ts:538-582)           │
│   render(ShadowScene3D) → shadowRT (white clear, cover-fit)               │
│        → multiply-blit на compositeRT (через shadowRT round-trip, как v1) │
│        └─ затем фигура поверх (personMat, compositor.ts:585)              │
└────────────────────────────────────────────────────────────────────────┘
```

**Ключевой инвариант альянса плейта и тени:** плейт `roomworld.exr` и `lights.json.camera` запечены из одной Blender-камеры. Если 3D-сцену тени рендерить ровно этой камерой **и применить тот же cover-fit-кроп, что и к плейту** (§4.4), тень от прокси проецируется в те же экранные пиксели, что и геометрия на плоском плейте.

---

## 3. Capture-подсистема (Python)

### 3.1 Точка интеграции и проводка (wiring)
Pose-инференс встраивается в тот же per-frame цикл `Pipeline._run()` (`capture/src/capture/pipeline.py`), **сразу после матинга** (строка 100, `fg, alpha = self._engine.process(frame.rgb)`), на том же входном кадре, **перед** записью в `self._lock` (строки 106-109).

**Проводка PoseEngine в Pipeline (требуется изменение конструктора).** Сейчас `Pipeline.__init__(self, source, engine, presence_cfg)` (`pipeline.py:45-47`), и `main()` строит `Pipeline(source, engine, PresenceConfig())` (`main.py:45`). Добавляем параметр и инжектим инстанс:

```python
# pipeline.py
def __init__(self, source, engine, presence_cfg, pose: "PoseEngine | None" = None) -> None:
    ...
    self._pose = pose

# pipeline.py, внутри _run(), после fg, alpha = self._engine.process(frame.rgb)
pose_pkt = self._pose.process(frame.rgb, frame.t_ms) if self._pose is not None else None
...
with self._lock:
    self._sbs = sbs
    self._bbox = bbox
    self._landmarks = pose_pkt      # НОВОЕ поле, под тем же локом
    self._frames += 1
    ...
```

```python
# main.py, рядом с engine = make_engine(cfg), до pipeline.start()
pose = make_pose_engine(cfg)        # None, если cfg.pose_enabled = False
pipeline = Pipeline(source, engine, PresenceConfig(), pose=pose)
```

Гейт `self._pose is not None` в hot-loop честно соблюдает `pose_enabled=False`.

### 3.2 PoseEngine (новый класс, рядом с MattingEngine)
- API: **`mediapipe.tasks.python.vision.PoseLandmarker`**.
- Режим: **`RunningMode.VIDEO`** + `detect_for_video(mp.Image, timestamp_ms)`. Берём VIDEO, **не** LIVE_STREAM: нужен синхронный результат, привязанный к **тому же входному кадру `rgb`, что и RVM-матте внутри capture** (pose и bbox получены из одного `frame.rgb`). LIVE_STREAM/`detect_async` отдаёт результат на другом потоке через callback и дропает кадры под нагрузкой → внутрикадровая пара pose↔bbox рвётся. **Оговорка (см. §9.1):** VIDEO даёт только *внутри-capture* пару pose-с-его-кадром; это **не** end-to-end-синхрон с видимым силуэтом (тот идёт по WebRTC и развязан транспортом, §2).
- **Timestamp (исправление).** `frame.t_ms` типизирован `float` (`frames.py:10`, `(time.monotonic()-t0)*1000.0` в `webcam.py:30`). `detect_for_video` требует **монотонно растущий integer**. Поэтому: приводим `ts = int(frame.t_ms)` и **гарантируем монотонность**: `ts = max(ts, self._last_ts + 1); self._last_ts = ts`. **Поправка факта:** существующий `MediapipeEngine` (segmenter) `frame.t_ms` **не использует вообще** — он держит собственный счётчик `self._t_ms += 33` (`mediapipe_engine.py:22,26). PoseEngine сознательно берёт `int(frame.t_ms)` с guard (а не внутренний +33), чтобы отметка отражала реальное время кадра; это осознанное отличие от segmenter, а не «тот же механизм».
- Делегат: **`BaseOptions.Delegate.CPU`** (XNNPACK). GPU-делегат MediaPipe на macOS нестабилен (краши, memory-swap, отсутствие ускорения — issues #5788/#6223/#6216). **Поправка рационала:** на этом Mac-таргете RVM тоже идёт на **CPU**, а не на GPU: `rvm_engine.py:14-17` намеренно отбрасывает CoreML («CoreML на этой модели МЕДЛЕННЕЕ CPU, граф рвётся на 20 партиций») и использует `CPUExecutionProvider`. Значит RVM и CPU-pose конкурируют за **одни и те же CPU-ядра в одном потоке** `_run()` — контеншн **CPU+CPU, серийный** (а не «GPU-контеншн с RVM»). Бюджет аддитивен: `RVM мс + Pose мс` на тик 15 Гц (см. §3.5).
- Модель: **`pose_landmarker_full.task`** (~6 МБ). **Путь — относительно `cfg.models_dir`** (исправление): `f"{cfg.models_dir}/pose_landmarker_full.task"`, как RVM и selfie-модели (`matting/__init__.py:26,30`; `config.py:20` — «куда скачаны модели, scripts/get-models.sh»). Никаких абсолютных хардкод-путей. Опционально override через `cfg.pose_model_path`. (`lite` — если CPU не тянет; `heavy` — нет, ~4 FPS.)
- Опции: `num_poses=1`, `output_segmentation_masks=False`, `min_pose_detection_confidence`/`min_tracking_confidence` по умолчанию.
- **Цветовой формат (исправление, блокер):** `frame.rgb` **уже RGB** на источнике (`webcam.py:27` делает `cv2.cvtColor(bgr, COLOR_BGR2RGB)`; `Frame.rgb` документирован `[H,W,3] uint8, RGB`, `frames.py:9`). Подаём напрямую: `mp.Image(image_format=mp.ImageFormat.SRGB, data=frame.rgb)` — **зеркально `mediapipe_engine.py:25`, БЕЗ повторного `cvtColor`**. Второй BGR2RGB пере-свопнул бы каналы и молча испортил landmarks.
- Инициализация (`PoseLandmarker.create_from_options()`) — **в `main()` до `pipeline.start()`** (рядом с `make_engine()`), т.к. первый вызов синхронно блокирует на 100+ мс.

Берём **оба** набора из `PoseLandmarkerResult`:
- `pose_world_landmarks[0]` — 33 × `Landmark` в **метрах, origin = середина бёдер** → артикуляция конечностей (инвариант к трансляции камеры).
- `pose_landmarks[0]` — 33 × `NormalizedLandmark` в **[0,1] по кадру** → горизонтальный якорь и ступни на экране (резерв; основной якорь — bbox, §5).

Доступ — **через атрибуты** (`lm.x`, `lm.y`, `lm.z`, `lm.visibility`, `lm.presence`), не dict-ключи.

### 3.3 Тип PosePacket и расширение телеметрии
**Тип `PosePacket` (frozen dataclass, определяем явно):**
```python
@dataclass(frozen=True)
class PosePacket:
    world: list[list[float]]   # 33 × [x,y,z,v], метры, hip-origin
    norm:  list[list[float]]   # 33 × [x,y,z,v], [0,1] по кадру
    healthy: float             # доля joints с visibility ≥ порога
```
В `PipelineStats` (`pipeline.py:15-25` — dataclass заканчивается на строке 25) добавляем поле `landmarks: PosePacket | None = None`, заполняется под `self._lock`.

Текущий пакет (`server.py:23-35`, `_telemetry_json`), тип `"presence"`, 15 Гц (`telemetry_hz`):
```json
{ "type":"presence", "present":bool, "distanceCm":float|null,
  "coverage":float, "bbox":[x0,y0,x1,y1]|null, "errors":int, "fps":float }
```
Добавляем **один ключ `pose`** (не новый тип сообщения — браузерный `parseTelemetry` фильтрует по `type==='presence'`):
```json
"pose": {
  "world":  [[x,y,z,v], … 33 …],
  "norm":   [[x,y,z,v], … 33 …],
  "healthy": 0.0
}
```
- **Единое имя поля во всех слоях — `pose.healthy`** (исправление): wire-ключ `"healthy"`; Python-поле dataclass — `healthy`; TS-поле — `pose.healthy`. §4.4/§6 гейтят строго на `opts.pose?.healthy`. Прежнее prose-имя `poseHealthy` устранено.
- `pose.healthy` = `mean(visibility(lm) ≥ THRESH)` по 33 joints (или ключевому подмножеству торс+конечности). Гейтит деградацию (§6).
- `_telemetry_json(stats)` дописывает `pose` в dict, **только если** `stats.landmarks is not None`.
- 33 × 4 × 2 = 264 числа + 1 `healthy`. При округлении до 4 знаков ≈ **0.4–0.5 КБ/кадр**, при 15 Гц ≈ 6–7 КБ/с. Приемлемо.

### 3.4 Зависимости
**Новых pip-зависимостей нет.** `mediapipe>=0.10.14` уже в `capture/pyproject.toml`. Нужен только `import` и инстанс `PoseLandmarker` из `mediapipe.tasks.python.vision`. Отдельно — скачать `.task`-ассет в `models_dir` (расширить `scripts/get-models.sh`). Опциональные поля в `CaptureConfig` (`config.py:9-21`): `pose_enabled: bool = True`, `pose_model_path: str = ""` (пусто → дефолт `f"{models_dir}/pose_landmarker_full.task"`). Путь резолвится **той же конвенцией, что RVM/selfie** — относительно `models_dir`.

### 3.5 Риски capture
- **CPU-контеншн RVM + Pose (серийный, в одном потоке):** оба CPU-bound, бюджет аддитивен (`RVM мс + Pose мс`). Если сумма пробивает тик 15 Гц (≈67 мс) — падает `pipeline.fps`. **Митигация:** бенч в Фазе A измеряет **серийную сумму** против тика; full→lite; в крайнем случае Pose через кадр или на отдельном потоке.
- **Лок-контеншн:** `PosePacket` пишем под `self._lock`; сериализация массива не должна растягивать тик 15 Гц.
- **Память:** Pose-full (~6 МБ) + RVM (ResNet50 ~35 МБ) ~+40 МБ.

---

## 4. Renderer-подсистема (three.js)

Новый модуль **`shadowScene3D.ts`** (в `src/lux/`) инкапсулирует 3D-сцену тени: receiver, proxy-rig, лампы, камеру и пасс рендера. `compositor.ts` дёргает его в слоте тени.

### 4.0 Глобальная инициализация рендерера (КРИТИЧНО — самый вероятный тихий провал)
PointLight-тени рендерятся shadow pre-pass’ом, который **требует `renderer.shadowMap.enabled = true` глобально**. Сейчас в `main.ts:59-64` рендерер создаётся **без** установки `shadowMap.enabled` (по умолчанию `false`) → `castShadow` молча игнорируется, тень **вообще не появляется**. Обязательно при инициализации (`main.ts`, рядом с `toneMapping`):
```ts
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
```
`shadowRT` остаётся `WebGLRenderTarget` с дефолтным `depthBuffer:true` (нужен 3D-пассу). 3D-пасс должен **восстановить** состояние (clear-color, `depthTest`, render-target) так, чтобы не повредить окружающие FSQ-блиты, у которых `depthTest:false`.

### 4.1 Receiver — невидимый приёмник тени
**Решение по сложности (разнесено по фазам, НЕ YAGNI-отбрасывание).** Заказчик: «нужно качество — если будет не очень, придётся сразу переделывать». Поэтому **целевой production-приёмник — B2 (EXR-mesh), он закоммичен, не опционален.** B1 box-receiver делается первым **не как кандидат в прод**, а как (а) дешёвый alignment-этап — выверить камеру-бейк + cover-fit + `shadowMap.enabled` + multiply-blit на тривиальной геометрии, **до** вложения в сложность mesh'а, и (б) постоянный fallback-пол. Так финальное качество высокое (точный mesh из реальной геометрии), а риск переделки снят (3D-пайплайн доказан на B1 раньше, чем строится B2).

- **B1 (alignment-этап + fallback, НЕ прод-приёмник): box-receiver.** Плоскость пола на `floorZ` + 2–3 axis-aligned box-прокси под мебель/стену (координаты из `lights.json` или выставлены руками по планировке B2-10). Материал — **`THREE.ShadowMaterial`**, `receiveShadow=true`. Без tear-culling / нормалей / Uint32. На этом receiver’е делаются alignment (B1) и drive-proxy (C); затем остаётся как fallback-пол.
- **B2 (целевой production-приёмник, ЗАКОММИЧЕН): EXR-mesh.** Сабсэмпл-сетка ~**128×228** (портрет 9:16) из worldPos-EXR (`shadowData.worldPosData`). Вершина `(gx,gy)` = `sampleWorldXYZ(worldPosData, u, v)`. `BufferGeometry`: `position` (Float32×3), индексы **Uint32**, 2 треугольника/квад. **Tear на разрывах глубины:** для квада — `max|Δ|` мировой позиции по рёбрам; при `|Δ| > k·dist` — треугольник не индексируется (убирает rubber-sheeting между передней мебелью и фоном). `computeVertexNormals()` после сборки.
  - **Известный артефакт tear↔receive (исправление, major):** `ShadowMaterial` затемняет только там, где есть геометрия приёмника. В **разорванных** регионах (tear) геометрии нет → дыра → белый clear → **тень не может лечь поперёк шва**. Тень, «взбирающаяся» с пола на ближнюю кромку мебели, выпадет ровно на стыке двух глубинных слоёв. Решение в B2: **сохранять «мостовые» треугольники в контактных зонах** (пол↔основание мебели) — рвать только дальние фон-разрывы; либо расширить порог `k` так, чтобы контактные зоны оставались связными. Минимум — задокументировать как известный артефакт, не как невидимое допущение. Именно из-за этого взаимодействия B2 — отдельная фаза, а не под-пункт.

**Материал приёмника — `THREE.ShadowMaterial`** (r180): `transparent=true`, `color=black`, принимает тень, всюду прозрачен; `opacity = shadowStrength` — **per-room мастер-ручка** `meta.shadowStrength` (§4.5), а **не** глобальный `shadowCfg.strength`. **Отклонение (см. §9.3):** `ShadowMaterial` рисует тень-терм нативно, но **не связан физически с яркостью фона**. Затемнение — alpha-blend `mix(white, black, α)`, а не `multiply` по реальной картинке плейта. Компенсируем композитингом (§4.4): рендерим в shadowRT с **белым** clear и **мультипликативно** блитим на `compositeRT`. На белом таргете тень-пиксель даёт `(1-α)`-серый, освещённый — белый (1.0) → multiply нейтрален вне тени. Корректно.

### 4.2 ProxyRig — невидимый кастер (rebuild каждый кадр)
- Капсулы (`CapsuleGeometry`) между суставами из `pose.world` (метры, hip-origin): торс (плечи↔бёдра), руки 11→13→15 и 12→14→16, ноги 23→25→27 и 24→26→28, голова — сфера у nose/ear. Радиусы — эвристики (рука ~0.05 м, торс ~0.12 м).
- Корень прокси — в мировую точку **F** (ступни на полу, §5); рост скейлится в **H**.
- **Ориентация (исправление, разрешаем конфликт):** **доверяем landmark-ориентации.** `pose_world_landmarks` уже несут реальную 3D-ориентацию торса (поворот плеч/бёдер) в метрике. Размещаем landmarks прямо в мир: **только** трансляция корня в F + единый скейл к H; **никакого принудительного «лицом к камеру»**. Force-rotate перекрыл бы реальный yaw (человек повернулся боком → тень всё равно фронтальная — противоречие цели артикуляции). Прежний пункт «поворот hip-origin лицом к камере» удалён.
- **Невидимый каст (критично, контринтуитивно):** `mesh.visible = true`, `mesh.castShadow = true`, материал `colorWrite=false`, `depthWrite=false`.
  - По `WebGLShadowMap.js` (r180): `if (object.visible === false) return;` — `visible=false` **выкидывает объект из shadow-pass**. Поэтому прятать через `visible=false` **нельзя**. Depth-материал для shadow map строится внутренне (`getDepthMaterial`) и **не читает** `colorWrite` — тень в карту пишется, цвет в основной пасс — нет.
- Перестройка каждый кадр: держим **пул мешей**, обновляем `position`/`quaternion`/`scale` сегментов — без аллокаций в hot loop.

### 4.3 Лампы и камера из lights.json
`shadowData` содержит распарсенный `lights.json` (`worldScene.ts:112-134`):
```jsonc
{ "lamps":[{ "name", "pos":[x,y,z], "weight" }…],   // weight нормирован к Σ=1
  "camera":{ "pos":[x,y,z], "target":[x,y,z], "fovY":радианы, "aspect":resX/resY },
  "floorZ":0.0 }
```
- **Лампы → `THREE.PointLight`** в мировых `pos`; интенсивности пропорциональны нормированным `weight`.
- **Жёстко зафиксированный стартовый бюджет теней (исправление, ограничиваем knob):**
  - `castShadow = true` **только у одной** доминирующей лампы `Key_Living_Warm` (`weight=1.0`). Остальные (0.6/0.4) — **fill, без castShadow**, вносят вклад только интенсивностью. PointLight-cube-тень — самый дорогой тип в three.js (6 граней); три лампы × 2048² = неоправданно для одного прокси.
  - `key.shadow.mapSize = (2048, 2048)`, `renderer.shadowMap.type = PCFSoftShadowMap`.
  - `light.shadow.radius` действует **только** при PCF/PCFSoft (texel-space). **PCSS в three.js нет нативно.** **VSM и внешний PCSS-инжект — out-of-scope-for-now**, единственный триггер на их рассмотрение: live-review заказчика прямо требует более мягкой variable-blur тени и PCFSoft не вытягивает. До тех пор в Фазу D они не заползают.
  - `mapSize` ставим **до первого рендера**. `bias ≈ -0.0005`, `normalBias ≈ 0.02–0.05` (тонкие капсулы).
- **Камера ← `lights.json.camera`** (`THREE.PerspectiveCamera`):
  - `fov` — вертикальный в градусах: `THREE.MathUtils.radToDeg(camera.fovY)` (в JSON `fovY` **уже в радианах** → конвертация fovX→fovY не нужна). `aspect = camera.aspect`.
  - **Базис Blender Z-up → three Y-up:** оба right-handed, но Blender Z вверх. Для пиксель-точного совпадения **бейкаем мировую матрицу**: `camera.matrixAutoUpdate=false`, собрать матрицу из `pos`/`target` после базис-смены, `camera.matrix.copy(M)`, не полагаться на `lookAt`. После — `camera.updateProjectionMatrix()`.

### 4.4 Слот в compositor.render() — точное место, cover-fit, без compositeRT2

**Изменение интерфейса (исправление, major — НЕ no-op-reuse).** На границе компоситора `opts.shadowData` сейчас несёт только `cameraPos: [number,number,number]` (`compositor.ts:456`), потому что `main.ts:224-229` сужает до `{ lamps, worldPos, floorZ, cameraPos }`, **отбрасывая** `target/fovY/aspect`. `ShadowScene3D` для бейка камеры нужен **полный** `ShadowCamera`. Требуемые правки:
1. Расширить тип `opts.shadowData` в `compositor.render()` (`compositor.ts:456`): заменить `cameraPos` на `camera: ShadowCamera` (pos+target+fovY+aspect). Тип `ShadowCamera` импортировать из `shadowGeom.ts`.
2. В `main.ts:224-229` форвардить `camera: active.shadowData.camera` (полный объект; на `BuiltWorld.shadowData.camera` он уже лежит целиком — `worldScene.ts:126`), а не только `.camera.pos`.
3. v1-ветка `roomShadowMat` читает `opts.shadowData.camera.pos` вместо прежнего `cameraPos` (тривиальная правка `:548`).

**Cover-fit-выравнивание 3D-пасса с плейтом (исправление, блокер).** Плейт рисуется cover-fit: `coverMat` применяет `uUvScale` (`compositor.ts:472-482`), v1-`roomShadowMat` копирует тот же скейл (`u.uUvScale.value.copy(this.coverMat.uniforms.uUvScale.value)`, `:544`). Новый 3D-пасс рендерит камеру `lights.json` **full-frame** в `shadowRT` при `camera.aspect=0.5625`, но `compositeRT` хранит **cover-fit-кропнутый** плейт. При `canvasAspect ≠ 0.5625` тень и плейт **не совпадут**. Решение: **multiply-blit сэмплит `shadowRT` с тем же `uUvScale`, что `coverMat`** (т.е. `multiplyBlitMat` применяет cover-fit-кроп к координате выборки тени), либо `ShadowScene3D` рендерится в 0.5625-RT и затем cover-fit-блитится. Phase-B1 alignment-тест **обязан гоняться на НЕ-совпадающем canvas-аспекте**, иначе crop-путь не проверяется и баг скрыт.

**Композитинг — зеркалим проверенный v1-паттерн, БЕЗ нового `compositeRT2` (исправление, major).** v1 держит `compositeRT` единственным источником истины: рисует тень в `shadowRT`, затем блитит `shadowRT`→`compositeRT` (`:559-561`). Делаем так же — `compositeRT` остаётся каноном **до** `personMat` (`:585`) и зерна (`:603`):

```ts
// compositor.ts, ветка тени (заменяет roomShadowMat-ветку при здоровой позе)
if (opts.pose && opts.pose.healthy >= POSE_ENTER && opts.shadowData && opts.personFloor) {
  // НОВОЕ: 3D proxy-тень (полный crossfade-вес w см. §6)
  this.shadowScene3D.update(opts.pose, opts.personFloor, opts.shadowData) // rig+camera+lamps
  // 1) 3D-рендер тень-фактора в shadowRT с БЕЛЫМ clear
  this.renderer.setRenderTarget(this.shadowRT)
  this.renderer.setClearColor(0xffffff, 1); this.renderer.clear()
  this.renderer.render(this.shadowScene3D.scene, this.shadowScene3D.camera)
  this.renderer.setRenderTarget(null)
  // (восстановить clearColor по умолчанию для последующих FSQ-пассов)
  // 2) multiply-blit: compositeRT(tBg) × shadowRT(tShadow), с cover-fit uUvScale,
  //    результат — в shadowRT2 (temp), затем блит обратно в compositeRT (как v1)
  const m = this.multiplyBlitMat.uniforms
  m.tBg.value = this.compositeRT.texture
  m.tShadow.value = this.shadowRT.texture
  m.uUvScale.value.copy(this.coverMat.uniforms.uUvScale.value) // crop тени = crop плейта
  this.pass(this.multiplyBlitMat, this.shadowRT2)              // temp, не read+write
  this.blitMat.uniforms.tSrc.value = this.shadowRT2.texture
  this.pass(this.blitMat, this.compositeRT)                    // compositeRT снова канон
} else if (opts.shadowData && opts.personFloor) {
  // FALLBACK v1: roomShadowMat (compositor.ts:540-561, только .cameraPos→.camera.pos)
} else {
  // FALLBACK v1: силуэт groundShadowMat (compositor.ts:563-568)
}
// 4б. blob-контактная тень — ВСЕГДА (перетюнена, §6), compositor.ts:571-581
```
- `multiplyBlitMat` читает `tBg`, `tShadow`, `uUvScale`, `uShadowFloorK`, `uShadowStrength`; вычисляет `shadowTerm = 1.0 - sampleShadow.r` (на белом clear: вне тени `term=0`), затем множитель `m = mix(1.0, 1.0 - uShadowStrength·uShadowFloorK, shadowTerm)` и `gl_FragColor = vec4(tBg.rgb · m, 1.0)` — вне тени `m=1.0` (кадр не темнеет), в самой плотной точке `m` упирается в потолок черноты (§4.5, не уходит в 0). **Вместо** CustomBlending пишем результат в **`shadowRT2`** (temp), затем блит обратно в `compositeRT` — точно как round-trip v1 через `shadowRT`. Никакого `compositeRT2`, никакого «swap/blit обратно»-комментария: два именованных пасса.
- **Resize:** `shadowRT` уже ресайзится (`compositor.ts:421-427`, диапазон `:421-427`). Новый **`shadowRT2`** добавить туда же, иначе stale-размер.
- **GLSL-версия:** `roomShadowMat`/`personMat` — GLSL3; blob/blit — GLSL1. `multiplyBlitMat` объявить с явной `glslVersion` (GLSL1 достаточно — простой multiply).
- **Тон-маппинг/output-colorspace** — только на финальном composite (`grainMat`, `:603`), не на промежуточном линейном shadowRT.
- В proxy-режиме `roomShadowMat` **не вызывается**, но остаётся в коде как fallback-ветка.
- **Потолок черноты в шейдере (§4.5):** `multiplyBlitMat` не множит на «голый» тень-терм, а на `mix(1.0, 1.0 - shadowStrength·SHADOW_FLOOR_K, shadowTerm)` — даже в самой плотной точке кадр не уходит в чёрный (прошлая претензия «тени слишком чёрные»).

### 4.5 Единое сглаживание + per-room сила тени («тень — не отдельная наклейка»)

**Главное требование заказчика:** тень НЕ должна читаться как отдельный слой поверх «фон-текстуры». Фон, фигура и тень — **одинаково сглажены** и живут под единым зерном/мягкостью. Средства (большинство уже в архитектуре — фиксируем как инварианты, остальное — knob'и на live-тюнинг):

1. **Единое зерно поверх всего.** `grainMat` — финальный пасс на весь `compositeRT` (`compositor.ts:603-606`), кладётся ПОСЛЕ слота тени → одно плёночное зерно покрывает фон+тень+фигуру. **Инвариант:** слот proxy-тени всегда ДО `personMat`/`grainMat`; зерно/тон-маппинг на промежуточный `shadowRT` НЕ добавлять.
2. **Per-room сила тени = `meta.shadowStrength`** (уже есть: `worldMeta.ts:19,74-80`; 0..1; гостиная=0.6; дефолт 0.5) — **мастер-ручка яркости тени на локацию** (где светлее — ставим меньше). v2 подключает её ко ВСЕМ компонентам:
   - тело-прокси `ShadowMaterial.opacity = shadowStrength` (§4.1) — заменяет глобальный `shadowCfg.strength`, который v1 `roomShadowMat` берёт ошибочно (`:555`);
   - blob `uOpacity = shadowStrength · blobRatio · mirrorOpacity` (§6) — blob светлее тела через относительный `blobRatio≈0.5`, но всё равно масштабируется per-room;
   - fallback `groundShadowMat` уже берёт `shadowStrength` (`:566`) — оставить.
   Итог: **одна цифра в `meta.json` на комнату** двигает все тени согласованно.
3. **Потолок черноты (не переборщить).** Множитель в `multiplyBlitMat` ограничен снизу `SHADOW_FLOOR_K` (§4.4): тень не чернее объектов сцены. При `shadowStrength=0.6`, `SHADOW_FLOOR_K≈0.7` самый тёмный множитель ≈ 0.58, а не 0.
4. **Мягкость — под сцену, не острее.** Кромку тени сглаживаем под общую мягкость плейта: `PCFSoftShadowMap` + `key.shadow.radius` подбираем так, чтобы край был мягким (не «вырезанным»); при необходимости — лёгкий 1-проходный блюр `shadowRT` перед multiply. Критерий приёмки: переход свет→тень читается так же мягко, как мягкие тени самого Cycles-плейта.
5. **Линейность.** Множим в линейном `compositeRT` (тон-маппинг/sRGB — только в `grainMat`), чтобы затемнение было физичным, а не «грязным» в гамме.

Live-knob'и: `meta.shadowStrength` (per-room), `LUX_CONFIG.shadow.softness`/`key.shadow.radius` (мягкость), `LUX_CONFIG.shadow.blobRatio` (легкость blob), `LUX_CONFIG.shadow.shadowFloorK` (потолок черноты).

---

## 5. Якорь / масштаб / глубина (+ обязательный F sanity-gate)

Переиспользуем v1 (`main.ts:184-211`), `sampleWorldXYZ` сейчас в **`main.ts:31-39`** (НЕ в `shadowGeom.ts` — поправка). **Пререквизит:** вынести `sampleWorldXYZ` из `main.ts` в `shadowGeom.ts` (или общий модуль), т.к. `roomMeshFromEXR`/renderer-модули его импортируют. После выноса — обновить импорт в `main.ts`.

- **Горизонтальный якорь / пол.** `feetUV = { u: 1-(bx0+bx1)/2, v: 1-by1, halfW }` (`main.ts:190-191`, mirror-X центра bbox, низ bbox = ноги), затем `F = sampleWorldXYZ(sd.worldPosData, 1-(x0+x1)/2, 1-y1)` (`main.ts:202`). Сглаживание `k = 1-exp(-dt·8)` (`main.ts:203-207`). Корень ProxyRig — в **F**.
- **F sanity-gate (исправление, major — обязателен, тихий провал иначе).** Если `feetUV` попадает на разорванный/не-фоновый пиксель или на дальнюю стену (человек перед стеной, ступни на границе пол/стена), `sampleWorldXYZ` вернёт мировую точку стены → весь прокси и его тень **телепортируются на метры**. Гейт: **отвергаем F**, если `|F.z - floorZ| > Z_THR` (порог ≈ 0.15 м) или сэмплированный пиксель вне room-mask → этот кадр **падает на fallback v1** (а не показывает некогерентную тень). Монокулярный шум без гейта = дёрганые телепорты.
- **Масштаб / рост.** `H = personFloorWorld({distanceCm, bboxCx, bboxH}, camera, floorZ).H` (`shadowGeom.ts:28-43`, клампится 1.4–2.0 м). Скейлим прокси так, чтобы его высота = **H**.
- **Артикуляция.** Из `pose.world` (метры, hip-origin) — landmarks в мире, ориентация из самих landmarks (§4.2).
- **Глубина (ось к/от камеры) — фундаментально слабая (исправление, честный scope).** В монокулярной позе `pose.world.z` оценочный, origin/масштаб откалиброваны лишь грубо относительно бедра. План «демпфировать z сильнее + смузить» **схлопывает прокси к фронто-параллельной пластине**. Почти-плоский кастер под верхним/боковым светом даёт тень, чьё «взбирание» на геометрию определяется **приёмником и позицией лампы, а не реальной глубиной тела**. Следствие, которое надо принять и сообщить заказчику (§10): **«наклон к/от камеры» меняет тень слабо; «поднять руку» работает**. Демпф z + временное сглаживание (exp-smooth, как F/H) — чтобы убрать дрожь, не чтобы добиться точной глубины.

---

## 6. Лестница деградации + связь с v1 (crossfade и гистерезис — ОБЯЗАТЕЛЬНЫ)

| Состояние позы | Тень тела | Контактный якорь |
|---|---|---|
| `pose.healthy` высока **и F прошёл sanity-gate** | **3D proxy-тень** (§4) | лёгкий blob (перетюнен) |
| `pose` потеряна / `healthy` низка / `pose` отсутствует / **F отвергнут gate** | **v1 `roomShadowMat`** (screen-space) | blob (перетюнен) |
| нет `shadowData` вовсе | v1 силуэт `groundShadowMat` | blob |

Эти три состояния отображаются на существующие ветки (`compositor.ts:539` vs `:562` vs `:563`).

**Crossfade (исправление — REQUIRED, не optional; «плавный откат без морганий» — критерий приёмки §10).** Переход proxy↔room **обязан** кросс-фейдиться, иначе мигнёт на границе. Кросс-фейд по непрерывному весу `w` от `pose.healthy` в окне `[POSE_DROP, POSE_ENTER]`: `w = smoothstep(POSE_DROP, POSE_ENTER, healthy)`. Рисуем обе тени с весами `w` (proxy) и `1-w` (room) в зоне перехлёста (или интерполируем `opacity`).

**Гистерезис (исправление — обязателен, иначе chatter на границе):** два порога. Входим в proxy при `healthy ≥ POSE_ENTER` (напр. 0.7), сваливаемся в room при `healthy < POSE_DROP` (напр. 0.5) — числа иллюстративные, тюнятся на live. Между порогами держим текущее состояние (+crossfade-вес выше).

**Blob перетюнить мягче/меньше + привязать к per-room силе (§4.5)** (значения из `compositor.ts:572-577`, дефолты `:399-400`, шейдер `:409`). Заказчик хочет ОДНУ per-room ручку (`meta.shadowStrength`), масштабирующую всю тень, и blob СВЕТЛЕЕ тела. Поэтому blob не получает абсолютный `0.28`, а выражается как доля per-room силы: `uOpacity = shadowStrength · blobRatio · mirrorOpacity`, где **`LUX_CONFIG.shadow.blobRatio ≈ 0.5`** (для гостиной `0.6·0.5 = 0.30` — то самое «светлее/меньше»). Тело-прокси берёт полную `shadowStrength`, blob — половину. Один master-knob per-room, blob всегда легче.

| Параметр | v1 (сейчас) | v2 (цель) | Где |
|---|---|---|---|
| `uOpacity` множитель | `0.5 * mirrorOpacity` (хардкод) | `shadowStrength · blobRatio(≈0.5) · mirrorOpacity` (per-room) | `:577` + `config.ts` |
| `rx` (радиус X) | `(halfW/sx) * 1.5` | `(halfW/sx) * 1.05` | `:575` |
| `uRadius.y` | `rx * 0.4` | `rx * 0.25` | `:576` |
| smoothstep края | `smoothstep(0.35, 1.0, r)` | `smoothstep(0.6, 1.0, r)` | шейдер `:409` |

Blob остаётся **всегда** (proxy- и fallback-режим) как контактный якорь пола / убийца Peter-Pan.

---

## 7. Интерфейсы модулей (design-for-isolation)

**Capture (Python)**
- `PoseEngine` — *in:* `rgb: np.ndarray` (уже RGB), `t_ms: float` (внутри `int`+monotonic-guard); *out:* `PosePacket | None`; *deps:* mediapipe Tasks PoseLandmarker (VIDEO/CPU). Чистый враппер, тест на фикстуре-кадре.
- `make_pose_engine(cfg) -> PoseEngine | None` — фабрика рядом с `make_engine`; `None` при `pose_enabled=False`; путь `f"{cfg.models_dir}/pose_landmarker_full.task"`.
- `Pipeline.__init__(..., pose=None)` — новый параметр; per-frame вызов под `self._pose is not None`.
- `PipelineStats.landmarks: PosePacket | None` — новое поле, пишется под `self._lock`.
- `PosePacket` — frozen dataclass `{world, norm, healthy}` (§3.3).
- `_telemetry_json()` — дописывает `pose`, если `landmarks is not None`; контракт остаётся `type:"presence"`.

**Renderer (TS)**
- `parseTelemetry()` (`telemetry.ts`) — расширить `Telemetry` опциональным `pose?: { world, norm, healthy }`. **Изоляция парсинга (исправление):** `pose` парсится **независимо** — битый/отсутствующий `pose` даёт `pose=undefined`, а `present/bbox/distanceCm` парсятся нормально. Сбой `pose` **не должен** заставить `parseTelemetry` вернуть `null` (иначе умрёт весь presence-пакет → blob/якорь по bbox). Явный unit-тест (§10).
- `sampleWorldXYZ` — **вынести** из `main.ts:31` в `shadowGeom.ts` (пререквизит).
- `boxReceiver(floorZ, boxes)` (B1) — *out:* `THREE.Mesh[]` (плоскость пола + box-прокси, ShadowMaterial, `receiveShadow`). Чистая геометрия.
- `roomMeshFromEXR(worldPosData, opts)` (B2) — *in:* `{data,width,height}` + порог разрыва; *out:* `THREE.Mesh`. Чистая функция, тест без WebGL (вершины + culling индексов + bridge-треугольники в контактных зонах).
- `buildProxyRig(poseWorld, F, H)` — *in:* 33 world-landmarks + якорь/рост; *out:* трансформы капсул (pos/quat/scale), ориентация из landmarks. Чистая математика, тест без рендера.
- `ShadowScene3D` — держит scene, baked camera (из `lights.json.camera`), lamps (PointLight, castShadow только Key), receiver (раз), proxyRig (per-frame `update`); метод `render` пишет в `shadowRT`.
- `multiplyBlitMat` — фуллскрин `tBg.rgb * tShadow.rgb`, читает `uUvScale` (cover-fit), белый clear shadowRT, результат в `shadowRT2`.
- `compositor.render()` — новый вход `opts.pose`; `opts.shadowData.camera: ShadowCamera` (вместо `cameraPos`); ветвление слота тени + crossfade (§4.4, §6).

---

## 8. Открытые риски / допущения

- **Транспортный рассинхрон pose↔силуэт (исправление, новый явный риск):** pose-телеметрия (WS-снапшот @15 Гц, `server.py:59-69`, без `t_ms` на проводе) и композитимый силуэт (WebRTC) **НЕ frame-locked**. Proxy-тень может опережать/отставать от видимого тела на ~1 матте-кадр. Сглаживание F/H/позы (§5) тюнится **в том числе** под маскировку этого лага, а не только под монокулярный z-шум.
- **Монокулярная глубина (фундаментально):** ось к/от камеры в `pose.world` шумная и грубо откалибрована; прокси схлопывается к фронто-параллельной пластине, «взбирание» — заслуга приёмника+лампы (§5). Если артефакты заметны — ZED/стерео (future `joints`-поле — см. ниже).
- **F вне пола (исправление):** sanity-gate `|F.z-floorZ|>Z_THR` → fallback v1 на кадр (§5). Без гейта — телепорты тени.
- **Tear↔receive seam-dropout (B2):** тень не ложится поперёк разорванных швов receiver-mesh (§4.1) → bridge-треугольники в контактных зонах или принять как известный артефакт.
- **PCSS отсутствует в three.js:** старт на `PCFSoftShadowMap`. VSM/внешний PCSS — **out-of-scope-for-now**, триггер: явное требование заказчика на live-review (§4.3).
- **PointLight cube-shadow дорог:** **castShadow только у Key**, fill-лампы без теней (§4.3). Бюджет на тень-рендер/кадр: 1 cube-map 2048² + redraw receiver+proxy.
- **CPU-throughput Pose+RVM (серийный, аддитивный):** не измерен; бенч в Фазе A; запас — lite / через кадр / отдельный поток (§3.5).
- **`ShadowMaterial` не связан с фоном физически** — решено multiply-композитом с белым clear (§4.1, §4.4).
- **Точность бейка Blender→three камеры + cover-fit-кроп** — главная причина возможного сдвига тени; проверяется в Фазе B1 статическим прокси **на НЕ-совпадающем canvas-аспекте**.
- **future `joints` в `PipelineStats` (исправление формулировки):** отдельного типизированного поля **нет** — есть только free-text-комментарий (`pipeline.py:22`: «Полные joints появятся с интеграцией ZED»). Это упоминание в комментарии, не зарезервированное поле; при ZED-интеграции поле ещё предстоит объявить.
- **Z-fighting / render-order** ShadowMaterial (transparent) на receiver — следить за `polygonOffset`/`depthWrite`/`depthTest` 3D-пасса (§4.0), чтобы не текло в FSQ-блиты.

---

## 9. Отклонения от первоначального дизайна

1. **Режим MediaPipe: VIDEO, не LIVE_STREAM.** Для внутри-capture-пары pose↔bbox (один `frame.rgb`) берём синхронный `detect_for_video`. **Понижение претензии (исправление):** это пара pose-с-его-исходным-кадром **внутри capture**, а **не** end-to-end-синхрон с видимым (WebRTC) силуэтом — тот развязан транспортом (§2, §8).
2. **Телеметрия — расширение, не новый пакет.** Реальный пакет `type:"presence"`, 15 Гц; `parseTelemetry` отбрасывает не-`presence`. Добавляем ключ `pose` внутрь. **Берём 33 landmark’а** (не 17 из старого findings — MediaPipe Pose = 33).
3. **«Render only the shadow term» = ShadowMaterial + multiply-композит** с **белым** clear shadowRT (§4.1, §4.4).
4. **Невидимый каст: `colorWrite=false`+`depthWrite=false`, НЕ `visible=false`.** В r180 `visible=false` удаляет каст из shadow-pass.
5. **PCSS невозможен нативно** — `PCFSoftShadowMap`; VSM/внешний PCSS вынесены в out-of-scope-for-now (§4.3).
6. **Камера: `fovY` уже в радианах** → только rad→deg + бейк матрицы (Z-up→Y-up).
7. **Лампы — `PointLight`**, `castShadow` **только у Key** (остальные fill по интенсивности).
8. **RGB не конвертируем (исправление, блокер):** `frame.rgb` уже RGB (`webcam.py:27`); подаём напрямую, как `mediapipe_engine.py:25`.
9. **Timestamp: `int(frame.t_ms)`+monotonic-guard (исправление, блокер):** `frame.t_ms` — float; segmenter его не использует (внутренний `+=33`); PoseEngine осознанно берёт int-каст реального времени кадра.
10. **`sampleWorldXYZ` живёт в `main.ts:31`** (не в `shadowGeom.ts`) → выносится как пререквизит (§5, §7).
11. **Интерфейс компоситора: `shadowData.camera: ShadowCamera`** вместо `cameraPos` — реальное изменение контракта `main.ts`↔`compositor.ts` (§4.4), не reuse.
12. **`renderer.shadowMap.enabled=true`** — обязательная глобальная инициализация, сейчас отсутствует (§4.0).
13. **Receiver: B2 EXR-mesh — целевой прод-приёмник (закоммичен, качество-first по требованию заказчика); B1 box — alignment-этап + fallback, НЕ кандидат в прод** (§4.1). Не YAGNI-отбрасывание: разнесение по фазам, чтобы доказать 3D-пайплайн дёшево до вложения в сложность mesh'а.
14. **Crossfade+гистерезис деградации — обязательны** (§6), не optional.
15. **F sanity-gate** — обязателен (§5).
16. **Контеншн RVM+Pose — CPU+CPU серийный**, не GPU (исправление рационала, §3.2/§3.5).
17. **`blobRatio` — поле config** (не абсолютный хардкод `0.28`): blob = доля per-room силы, чтобы один master-knob двигал всю тень (§6, §4.5).
18. **Per-room сила тени = `meta.shadowStrength` как мастер-ручка** (§4.5, требование заказчика «var силы тени на локацию»): подключена ко ВСЕМ компонентам (тело-прокси `ShadowMaterial.opacity`, blob через `blobRatio`, fallback `groundShadowMat`). v1 `roomShadowMat` ошибочно берёт глобальный `shadowCfg.strength` — в v2 фиксим на per-room. + потолок черноты `shadowFloorK` (тень не чернее объектов) + единое зерно/мягкость на фон+тень+фигуру (тень не читается отдельным слоем).

---

## 10. Тестирование + фазы

### Unit (Vitest, `npm test` = `vitest run`; держать **≥92 теста** + typecheck зелёными, плюс новые pose/proxy/receiver-тесты)
*(в репозитории сейчас 92 case в 17 `.test.ts`; число — пол, новые тесты его поднимут)*
- **Capture:** `PoseEngine` packing — фикстура-кадр → 33 joints, схема `PosePacket` (форма `world`/`norm`/`healthy`, округление, размер ≈0.5 КБ). `healthy` из visibility-порога. **RGB подаётся без конверсии** (тест: `mp.Image` получает `frame.rgb` как есть). **Timestamp: `int`-каст + монотонный guard** (тест: float `t_ms`, два равных/убывающих → строго растущие int). `make_pose_engine(pose_enabled=False) → None`.
- **Renderer (без WebGL):**
  - `boxReceiver` (B1) — плоскость + box’ы, `receiveShadow=true`, ShadowMaterial.
  - `roomMeshFromEXR` (B2) — EXR-семпл → вершины; culling индексов на синтетическом разрыве; **bridge-треугольники сохранены в контактной зоне** (пол↔база мебели).
  - `buildProxyRig` — landmarks → трансформы (поднятая рука меняет quaternion плеча; масштаб = H; **поворот корпуса берётся из landmarks**, не force-face-camera).
  - **F sanity-gate** — `F.z` далеко от `floorZ` → выбор fallback v1.
  - гейт+гистерезис+crossfade: `healthy` выше `POSE_ENTER` / между / ниже `POSE_DROP` → proxy / crossfade-вес / room / силуэт.
  - `parseTelemetry` — `pose` парсится; **битый `pose` → `undefined`, остальные поля живы, возврат НЕ `null`**.
  - cover-fit: `multiplyBlitMat.uUvScale` совпадает с `coverMat.uUvScale`.

### Live-приёмка (с заказчиком, motto «качество>fps») — с честными ожиданиями
- Поднять руку → тень руки поднимается. **(работает уверенно)**
- Наклон вбок / поворот корпуса → тень повторяет (артикуляция из landmarks). **(работает)**
- Шаг к мебели → тень **взбирается** на мебель/стену. **Оговорка:** «взбирание» — заслуга **геометрии приёмника**, не глубины тела; наклон **к/от камеры** меняет тень **слабо** (монокулярный z, §5/§8) — это сознательное ограничение, проговаривается заказчику.
- Потеря позы / спина к камере / F вне пола → **плавный** откат на v1 (crossfade+гистерезис, §6) без морганий.
- Тень садится точно под ступнями на плоском плейте (бейк камеры + cover-fit).
- **Тень — не отдельная наклейка (главный критерий §4.5):** тень живёт под тем же зерном и той же мягкостью, что фон и фигура; не чернее объектов сцены; `meta.shadowStrength` подобран под яркость локации (где светлее — меньше). Проверка: глазами по краю силуэта и по плотности — нет ощущения «фон-текстура + наклеенная тень».

### Фазы (каждая — отдельный проверяемый exit)
- **A — Capture (независима):** `PoseEngine` (VIDEO/CPU/full, RGB-as-is, int-ts-guard), проводка `pose` в `Pipeline.__init__`, `PosePacket`, расширение `PipelineStats`+`_telemetry_json`, фабрика `make_pose_engine`, скачать `.task` в `models_dir`, бенч **серийной суммы** RVM+Pose против тика 15 Гц, unit-тесты. *Exit:* в `/ws` приходит валидный `pose`; `pose_enabled=False` его не шлёт; fps не просел ниже порога.
- **B1 — Alignment (make-or-break, стоит отдельно):** глобальный `renderer.shadowMap.enabled=true`; `ShadowScene3D` с **запечённой камерой** из `lights.json.camera`, **box-receiver** (плоскость пола + box-прокси), Key-лампа castShadow; статический тест-прокси в известной мировой точке; multiply-blit с cover-fit. *Exit:* тень статического прокси **пиксельно совпадает** с плейтом, проверено **на НЕ-совпадающем canvas-аспекте** (crop-путь упражнён).
- **B2 — EXR-receiver (целевой прод-приёмник, ЗАКОММИЧЕН):** `roomMeshFromEXR` (invisible ShadowMaterial, Uint32, tear-culling + bridge-треугольники в контактных зонах). *Exit:* тень корректно взбирается на реальную мебель/стены без rubber-sheet и без seam-dropout в контактной зоне. **Делается всегда** (качество-first, требование заказчика); B1 box остаётся fallback-полом.
- **C — Drive proxy (зависит от B1-alignment):** `buildProxyRig` от телеметрии (landmark-ориентация), якорь F + F sanity-gate, масштаб H, смузинг + демпф z. *Exit:* тень повторяет позу вживую на box-receiver’е.
- **D1 — Compositor integration:** слот в `compositor.render()` — интерфейс `shadowData.camera`, multiply-blit через `shadowRT2`, resize-hook, proxy always-on (без лестницы). *Exit:* proxy-тень стабильно композитится, `compositeRT` остаётся каноном перед `personMat`/зерном; зелёные тесты.
- **D2 — Degradation + sign-off + единое сглаживание (§4.5):** лестница деградации, **crossfade+гистерезис**, перетюн blob (`blobRatio` в config), per-room `meta.shadowStrength` подключён ко всем компонентам, потолок черноты `shadowFloorK`, мягкость кромки под сцену, отключение `roomShadowMat` в proxy-режиме, live-приёмка. *Exit:* плавный откат без морганий + тень не читается отдельным слоем + подпись заказчика.

---

### Релевантные файлы (абсолютные пути)
- `/Users/iman/Projects/background_ar/capture/src/capture/pipeline.py` — слот Pose (`:100`), `Pipeline.__init__` (`:45-47`, +`pose`), `PipelineStats` (`:15-25`), запись под `_lock` (`:106-109`), free-text-коммент про joints (`:22`).
- `/Users/iman/Projects/background_ar/capture/src/capture/server.py` — `_telemetry_json` (`:23-35`), WS-send снапшота (`:59-69`, `:61`).
- `/Users/iman/Projects/background_ar/capture/src/capture/main.py` — построение `Pipeline` (`:45`), инициализация PoseEngine рядом (`:39`).
- `/Users/iman/Projects/background_ar/capture/src/capture/frames.py` — `Frame.rgb` (уже RGB, `:9`), `t_ms: float` (`:10`).
- `/Users/iman/Projects/background_ar/capture/src/capture/sources/webcam.py` — BGR2RGB на источнике (`:27`), `t_ms` (`:30`).
- `/Users/iman/Projects/background_ar/capture/src/capture/matting/mediapipe_engine.py` — `mp.Image` без конверсии (`:25`), внутренний счётчик `+=33` (`:22,26`).
- `/Users/iman/Projects/background_ar/capture/src/capture/matting/rvm_engine.py` — CPU-провайдер (CoreML отброшен, `:14-17`).
- `/Users/iman/Projects/background_ar/capture/src/capture/matting/__init__.py` — резолв модели через `models_dir` (`:26,30`).
- `/Users/iman/Projects/background_ar/capture/src/capture/config.py` — `CaptureConfig` (`:9-21`), `models_dir` (`:20`); +`pose_enabled`/`pose_model_path`.
- `/Users/iman/Projects/background_ar/capture/pyproject.toml` — `mediapipe>=0.10.14` уже есть.
- `/Users/iman/Projects/background_ar/src/main.ts` — `sampleWorldXYZ` (`:31-39`, ВЫНЕСТИ), `personFloor`/`feetUV`/F/H/смузинг (`:184-211`), `shadowData`-форвард (`:224-229`, +`camera`), инициализация рендерера (`:59-64`, +`shadowMap.enabled`).
- `/Users/iman/Projects/background_ar/src/lux/compositor.ts` — слот тени (`:538-582`), v1 round-trip (`:559-561`), `opts.shadowData`-тип (`:456`), `roomShadowMat` cameraPos (`:548`), blob (`:572-577`, `:399-400`, шейдер `:409`), `setSize` (`:421-427`), `pass()` (`:429-443`).
- `/Users/iman/Projects/background_ar/src/lux/config.ts` — `LUX_CONFIG.shadow` (`:17`); +`blobRatio` (≈0.5), +`shadowFloorK` (≈0.7, потолок черноты §4.5).
- `/Users/iman/Projects/background_ar/src/app/worldMeta.ts` — `shadowStrength` per-room (`:19,74-80`, мастер-ручка §4.5); `shadow` блок (`:22,83-87`).
- `/Users/iman/Projects/background_ar/public/assets/worlds/living/meta.json` — `shadowStrength: 0.6` (пример per-room значения).
- `/Users/iman/Projects/background_ar/src/scenes/worldScene.ts` — загрузка `shadowData` из lights.json+EXR (`:112-134`), полный `camera` (`:126`).
- `/Users/iman/Projects/background_ar/src/lux/shadowGeom.ts` — `personFloorWorld` (`:28-43`), `ShadowCamera` (`:7-12`), `sampleWorldXYZ` (ПЕРЕНОС сюда).
- `/Users/iman/Projects/background_ar/src/lux/telemetry.ts` — `Telemetry`+`parseTelemetry` (`:4-38`), расширить полем `pose` (независимый парсинг).
- Новые: `/Users/iman/Projects/background_ar/src/lux/shadowScene3D.ts` (+`boxReceiver`, `roomMeshFromEXR`, `buildProxyRig`, `multiplyBlitMat`); `/Users/iman/Projects/background_ar/capture/src/capture/pose_engine.py`.

