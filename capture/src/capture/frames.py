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
