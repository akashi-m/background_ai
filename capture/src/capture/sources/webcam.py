"""Источник с вебкамеры (dev-режим на Маке, спека §3.2)."""

import time

import cv2

from capture.compose import rotate_frame
from capture.frames import Frame


class WebcamSource:
    def __init__(
        self, index: int = 0, width: int = 1280, height: int = 720, rotate: int = 0
    ) -> None:
        self._cap = cv2.VideoCapture(index)
        if not self._cap.isOpened():
            raise RuntimeError(f"вебкамера {index} не открылась — проверь доступ к камере")
        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self._rotate = rotate
        self._t0 = time.monotonic()

    def read(self) -> Frame | None:
        ok, bgr = self._cap.read()
        if not ok:
            return None  # временный сбой камеры — пайплайн переживёт
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        if self._rotate:
            rgb = rotate_frame(rgb, self._rotate)
        return Frame(rgb=rgb, t_ms=(time.monotonic() - self._t0) * 1000.0)

    def close(self) -> None:
        self._cap.release()
