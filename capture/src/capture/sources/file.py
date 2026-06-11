"""Источник из видеофайла: детерминированные тесты и golden-прогоны."""

import os
import time

import cv2

from capture.frames import Frame


class FileSource:
    def __init__(self, path: str, loop: bool = True) -> None:
        if not os.path.exists(path):
            raise FileNotFoundError(path)
        self._path = path
        self._loop = loop
        self._cap = cv2.VideoCapture(path)
        self._t0 = time.monotonic()

    def read(self) -> Frame | None:
        ok, bgr = self._cap.read()
        if not ok:
            if not self._loop:
                return None
            self._cap.release()
            self._cap = cv2.VideoCapture(self._path)
            ok, bgr = self._cap.read()
            if not ok:
                return None
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        return Frame(rgb=rgb, t_ms=(time.monotonic() - self._t0) * 1000.0)

    def close(self) -> None:
        self._cap.release()
