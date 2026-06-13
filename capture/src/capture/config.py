"""Конфигурация capture-сервиса: pydantic-модель + разбор CLI."""

import argparse
from typing import Literal

from pydantic import BaseModel


class CaptureConfig(BaseModel):
    source: Literal["webcam", "file", "zed"] = "webcam"
    file_path: str = ""          # для source=file
    camera_index: int = 0        # для source=webcam
    engine: Literal["mediapipe", "rvm"] = "mediapipe"
    model: Literal["mobilenetv3", "resnet50"] = "mobilenetv3"  # вариант RVM
    ratio: float = 0.25          # downsample_ratio RVM: выше = детальнее край, медленнее
    width: int = 1280
    height: int = 720
    rotate: int = 0              # поворот кадра по часовой 0/90/180/270 (Iriun в портрете)
    port: int = 8765             # aiohttp: /offer /ws /viewer /health
    models_dir: str = "models"   # куда скачаны модели (scripts/get-models.sh)
    bitrate_mbps: float = 8.0    # битрейт VP8 (loopback): резкость live-композита


def auto_bitrate_mbps(width: int, height: int) -> float:
    """Щедрый битрейт по разрешению SBS-кадра (2×width).

    Loopback — полоса бесплатна, экономить нечего. ~6 «бит/пиксель»: визуально
    прозрачно при наших fps, с запасом для 4K. Пол — 8 Мбит/с.
    """
    sbs_pixels = 2 * width * height
    return max(8.0, float(round(sbs_pixels * 6 / 1_000_000)))


def parse_args(argv: list[str] | None = None) -> CaptureConfig:
    p = argparse.ArgumentParser(description="Stellar Mirror Lux capture-сервис")
    p.add_argument("--source", default="webcam",
                   help="webcam | file:путь.mp4 | zed")
    p.add_argument("--engine", default="mediapipe", choices=["mediapipe", "rvm"])
    p.add_argument("--model", default="mobilenetv3", choices=["mobilenetv3", "resnet50"],
                   help="вариант RVM: resnet50 — лучше края, медленнее")
    p.add_argument("--ratio", type=float, default=0.25,
                   help="downsample_ratio RVM 0.05..1.0: выше = детальнее край")
    p.add_argument("--camera-index", type=int, default=0)
    p.add_argument("--width", type=int, default=1280)
    p.add_argument("--height", type=int, default=720)
    p.add_argument("--rotate", type=int, default=0, choices=[0, 90, 180, 270],
                   help="поворот кадра по часовой (Iriun/телефон в портрете)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--models-dir", default="models")
    p.add_argument("--bitrate", type=float, default=None,
                   help="битрейт VP8 в Мбит/с (loopback); по умолчанию авто по разрешению")
    a = p.parse_args(argv)

    source, file_path = a.source, ""
    if source.startswith("file:"):
        source, file_path = "file", source[len("file:"):]
    if source not in ("webcam", "file", "zed"):
        p.error(f"неизвестный источник: {a.source}")
    if source == "file" and not file_path:
        p.error("источник file требует путь: --source file:клип.mp4")
    if not 0.05 <= a.ratio <= 1.0:
        p.error(f"--ratio вне диапазона 0.05..1.0: {a.ratio}")

    bitrate = a.bitrate if a.bitrate is not None else auto_bitrate_mbps(a.width, a.height)

    return CaptureConfig(
        source=source, file_path=file_path, camera_index=a.camera_index,
        engine=a.engine, model=a.model, ratio=a.ratio,
        width=a.width, height=a.height, rotate=a.rotate,
        port=a.port, models_dir=a.models_dir, bitrate_mbps=bitrate,
    )
