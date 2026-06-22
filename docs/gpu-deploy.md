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

## Гарантии
- Альфа (край матта) НЕ квантуется — качество не страдает (north star).
- На CPU поведение байт-в-байт прежнее (GPU-ветки гейтнуты).
- Любой сбой GPU-пути → безопасный откат, а не краш.
