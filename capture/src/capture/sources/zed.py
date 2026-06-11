"""ZED 2i — прод-источник. Интеграция в подпроекте Ops (мастер-спека §10.5).

Стаб существует, чтобы контракт source=zed был зафиксирован уже сейчас,
а ошибка при случайном запуске была понятной, а не ImportError из глубин.
"""

from capture.frames import Frame


class ZedSource:
    def __init__(self) -> None:
        raise RuntimeError(
            "Источник ZED ещё не интегрирован: требуется ZED SDK + pyzed на прод-машине "
            "(Windows/RTX). Для разработки используй --source webcam или --source file:клип.mp4"
        )

    def read(self) -> Frame | None:  # pragma: no cover — недостижимо
        return None

    def close(self) -> None:  # pragma: no cover
        ...
