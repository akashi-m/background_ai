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
