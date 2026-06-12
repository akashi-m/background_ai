# capture — захват и маттинг (Stellar Mirror Lux)

Источник кадров → нейроматтинг → side-by-side RGB|A → WebRTC + WS-телеметрия.
Подпроект №1 мастер-спеки `../docs/superpowers/specs/2026-06-11-stellar-mirror-lux-design.md`.

## Установка

    uv sync
    scripts/get-models.sh        # модели маттинга (~15 МБ, в .gitignore)

## Запуск (dev на Маке)

Телефон как камера (заметно лучше встроенной вебки — рекомендуется для «теста люкса»):
- **Samsung S24/S23 (One UI 6+)**: подключи USB-C → в шторке уведомление USB →
  «Веб-камера». Телефон становится стандартной UVC-камерой. План Б: Iriun Webcam.
- **iPhone**: Continuity Camera (рядом, тот же Apple ID).
Найти индекс камеры: `uv run capture --list-cameras`, затем `--camera-index <N>`.

    uv run capture --source webcam --engine mediapipe   # быстрый dev, ~30 fps
    uv run capture --source webcam --engine rvm         # качественные края, ~15–19 fps на M4 (CPU)
    uv run capture --source file:клип.mp4 --engine rvm  # детерминированный прогон

Проверка: http://localhost:8765/viewer — ты на шахматном фоне.
Шахматка проверяет альфу: дыры/бахрома видны сразу.
На проде RVM уйдёт на CUDA/TensorRT (RTX 5090) — там 60 fps с запасом.

## Контракты (спека §3.1)

- Видео: WebRTC, кадр двойной ширины [RGB | A], альфа в люме.
- Телеметрия: WS `/ws`, JSON 15 Гц: present, distanceCm, coverage, bbox, errors, fps.
- `/health` — ok/frames/fps/errors/lastError; `/offer` — WebRTC-сигналинг.

## Прод (после приезда железа)

`--source zed` (ZED SDK), TensorRT-провайдер для RVM, NVENC — подпроект Ops.

## Тесты

    uv run pytest        # юниты + контракты + WebRTC-loopback
    uv run mypy src
    uv run ruff check .

## Ручная приёмка (спека §10.1)

- [ ] `uv run capture --source webcam --engine rvm` → /viewer
- [ ] Ты на шахматке, края волос аккуратные, без «дыхания»
- [ ] viewer fps ≥ 30 (mediapipe) / ≥ 15 (rvm) на M4, 720p
- [ ] Отойти из кадра → присутствие: нет (через ~5 кадров), вернуться → да
- [ ] Закрыть камеру рукой → сервис жив, /health отвечает, ошибки видны
