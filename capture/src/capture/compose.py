"""Упаковка кадра в side-by-side RGB|A (контракт с рендерером, спека §3.1)."""

import numpy as np


def pack_sbs(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """[H,W,3] uint8 + [H,W] float32 0..1 → [H,2W,3] uint8: слева RGB, справа альфа."""
    if rgb.ndim != 3 or rgb.shape[2] != 3 or alpha.shape != rgb.shape[:2]:
        raise ValueError(f"несовместимые формы: rgb {rgb.shape}, alpha {alpha.shape}")
    h, w, _ = rgb.shape
    out = np.empty((h, w * 2, 3), dtype=np.uint8)
    out[:, :w] = rgb
    a8 = (alpha * 255.0 + 0.5).clip(0, 255).astype(np.uint8)
    right = out[:, w:]
    right[:, :, 0] = a8
    right[:, :, 1] = a8
    right[:, :, 2] = a8
    return out


def unpack_sbs(sbs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Обратная распаковка (эталон для тестов; в проде распаковывает шейдер)."""
    h, w2, _ = sbs.shape
    w = w2 // 2
    rgb = sbs[:, :w].copy()
    alpha = sbs[:, w:, 0].astype(np.float32) / 255.0
    return rgb, alpha
