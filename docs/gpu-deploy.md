# Запуск capture на GPU (Windows) + бенчмарк

Включает матт (RVM) на видеокарте. Делать **механически, по порядку**. Везде команды для
PowerShell в папке репозитория.

> Почему нельзя «просто включить»: GPU-сборка onnxruntime (`onnxruntime-directml` /
> `onnxruntime-gpu`) ставится **только под Windows+GPU**, поэтому её нельзя зашить в общие
> зависимости (сломает мак/Linux). Отсюда один ручной шаг — подмена пакета. Это нормально.

## 0. Предпосылки
- Установлен **uv** (`powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`).
- Репозиторий склонирован.

## 1. Обновить код
```powershell
git pull
```

## 2. Модели на месте
В `capture/models/` должны лежать (скопируй с мака, если их нет):
`rvm_resnet50_fp32.onnx`, `pose_landmarker_full.task`.
(Файл `rvm_resnet50_fp32_u8.onnx` НЕ копируем — сгенерим в шаге 5.)

## 3. Подменить onnxruntime на GPU-сборку (одна строка)
Открой **`capture/pyproject.toml`**, в секции `dependencies` замени строку:
```
  "onnxruntime>=1.18",
```
на одну из:
```
  "onnxruntime-directml>=1.18",   # любой GPU на Windows (NVIDIA/AMD/Intel) — проще всего
  "onnxruntime-gpu>=1.18",        # только NVIDIA (CUDA) — быстрее, но нужны CUDA/cuDNN
```
(Так `uv` будет держать в окружении GPU-сборку и не «откатит» её при следующих `uv run`.)

## 4. Поставить зависимости
```powershell
cd capture
uv sync
```

## 5. Сгенерировать uint8-модель (ускорение по PCIe)
```powershell
uv run --with onnx python scripts/optimize-rvm-model.py
```
Создаст `models/rvm_resnet50_fp32_u8.onnx`. Без этого шага всё работает, но без uint8-выигрыша.

## 6. Проверить, что GPU виден
```powershell
uv run python -c "import onnxruntime as ort; print(ort.get_available_providers())"
```
Ждём `DmlExecutionProvider` (или `CUDAExecutionProvider`) в списке. Если только `CPU…` —
GPU-сборка не встала (см. шаг 3, версия/пакет).

## 7. Бенчмарк
```powershell
uv run python tests/bench_rvm_pose_serial.py
```
Печатает `RVM` / `Pose` median+p95 (мс) и оценку fps. **Скинь эти числа.**
> Реальный fps с нашим параллелизмом ≈ `1000 / max(RVM, Pose)`, а не по серийной сумме.

## 8. Живой запуск (с профайлом)
```powershell
uv run capture --source webcam --engine rvm --model resnet50 --ratio 0.4 --camera-index 0 --profile
```
Раз в ~3 сек в stderr: `[capture] perf fps=.. matte=..ms pose=..ms pack=..ms`.

## Что НЕ должно пугать (fail-safe — движок не падает)
- `[rvm] *_u8.onnx не пошёл на провайдере → fp32-путь` — u8-граф не поддержан этим GPU;
  движок честно перешёл на обычную fp32-модель. Работает, просто без uint8-ускорения.
- `[rvm] io-binding отключён (ошибка) → sess.run` — io-binding не зашёл на этом GPU; откат
  на обычный прогон. Работает.
Оба случая безопасны: качество матта то же, просто без соответствующего микро-ускорения.

## Гарантии (capture)
- Альфа (край матта) НЕ квантуется — качество не страдает (north star).
- На CPU поведение байт-в-байт прежнее (GPU-ветки гейтнуты).
- Любой сбой GPU-пути → безопасный откат, а не краш.

---

# Запуск ВСЕГО приложения (capture + рендерер + браузер)

«Всё» = **два процесса** + браузер. Стек кросс-платформенный (Python/aiortc + Vite/WebGL +
WebRTC по localhost), так что на Windows работает; просто больше частей, чем у бенча.

## Доп. предпосылки
- **Node.js (LTS)** — для рендерера: `winget install OpenJS.NodeJS.LTS` (или с nodejs.org).
- **Интернет на ПЕРВЫЙ запуск**: рендерер тянет WASM + MediaPipe-модели с CDN
  (jsdelivr/googleapis), дальше кэшируется браузером. Без сети в первый раз не стартует.

## Шаги
1. Рендерер (один раз, в корне репо): `npm install`
2. **Сначала проверь РЕНДЕРЕР без камеры** (де-риск): `npm run dev` → открой
   **http://localhost:5173/?noTracker=1** в Chrome/Edge. Должна отрендериться комната
   БЕЗ человека. Видно интерьер и плавно → рендерер на винде жив.
3. **Терминал 1 — capture** (камера + GPU по инструкции выше):
   ```powershell
   cd capture
   uv run capture --list-cameras        # найти индекс (Iriun/телефон тоже ок)
   uv run capture --source webcam --engine rvm --model resnet50 --ratio 0.4 --camera-index 0
   ```
4. **Терминал 2 — рендерер**: `npm run dev` → **http://localhost:5173** → разрешить камеру.
5. Сценарий: IDLE-слайдшоу → подойти ~2.5 м (или клавиша **F5**) → проявление → ты в интерьере.
   **D** — панель FPS/задержки, **F1–F4** — слои (LUT/wrap/тень/зерно), **1–9/W/M** — выбор мира.

## Windows-специфика (на что смотреть)
- **Камера**: Параметры → Конфиденциальность → Камера → разрешить классическим приложениям.
- **Файрвол**: при старте capture Windows может спросить доступ Python к сети — разрешить (localhost).
- **Калибровка**: дефолты сняты с MacBook 14". Под монитор винды нажми **C**, введи ширину/высоту
  видимой области (см) + смещение камеры — иначе масштаб фигуры неточный (но работать будет).

## Честно про «получится ли»
- Архитектурно ничто не мешает — стек кросс-платформенный, GPU ускоряет и матт (capture), и
  WebGL (браузер сам).
- Полный апп на Windows **не тестировался** (разрабатывался на маке) — возможны мелкие
  Windows-измы в рендерере. Поэтому шаг 2 (`?noTracker=1`) — первый и главный чек: если комната
  рисуется, всё остальное (capture/камера/композит) подключается поверх.
