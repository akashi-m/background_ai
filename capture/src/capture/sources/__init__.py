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
