"""Кроп головы из SBS-кадра /frame.png для A/B-сравнения матта.

Использование: uv run python scripts/crop-matte.py <sbs.png> <префикс-вывода>
Находит bbox по альфе, режет верх фигуры (волосы), сохраняет:
<префикс>-alpha.png (альфа как есть) и <префикс>-comp.png (композит на шахматке).
"""

import sys

import cv2
import numpy as np


def main() -> None:
    sbs_path, prefix = sys.argv[1], sys.argv[2]
    sbs = cv2.imread(sbs_path)
    h, w = sbs.shape[:2]
    rgb = sbs[:, : w // 2]
    alpha = cv2.cvtColor(sbs[:, w // 2 :], cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0

    binary = alpha > 0.5
    rows = np.flatnonzero(binary.any(axis=1))
    cols = np.flatnonzero(binary.any(axis=0))
    if rows.size == 0:
        sys.exit("фигуры в кадре нет")
    y0, y1, x0, x1 = rows[0], rows[-1], cols[0], cols[-1]

    # верх фигуры (голова/волосы) + поля
    head_h = max((y1 - y0) // 3, 120)
    pad = 60
    cy0, cy1 = max(0, y0 - pad), min(h, y0 + head_h)
    cx0, cx1 = max(0, x0 - pad), min(w // 2, x1 + pad)

    a = alpha[cy0:cy1, cx0:cx1]
    c = rgb[cy0:cy1, cx0:cx1].astype(np.float32)

    # шахматка как в viewer — дыры и кайма видны сразу
    yy, xx = np.mgrid[0 : a.shape[0], 0 : a.shape[1]]
    checker = np.where((xx // 16 + yy // 16) % 2 == 0, 89, 140).astype(np.float32)
    comp = c * a[..., None] + checker[..., None] * (1 - a[..., None])

    scale = max(1, 900 // a.shape[1])
    size = (a.shape[1] * scale, a.shape[0] * scale)
    cv2.imwrite(f"{prefix}-alpha.png", cv2.resize((a * 255).astype(np.uint8), size,
                interpolation=cv2.INTER_NEAREST))
    cv2.imwrite(f"{prefix}-comp.png", cv2.resize(comp.astype(np.uint8), size,
                interpolation=cv2.INTER_NEAREST))
    print(f"bbox y={y0}..{y1} x={x0}..{x1}, кроп {a.shape[1]}x{a.shape[0]}, x{scale}")


if __name__ == "__main__":
    main()
