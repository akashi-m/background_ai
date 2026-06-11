import numpy as np

from capture.compose import pack_sbs, unpack_sbs


def test_pack_shape_and_layout() -> None:
    rgb = np.full((4, 6, 3), 200, dtype=np.uint8)
    alpha = np.zeros((4, 6), dtype=np.float32)
    alpha[:, :3] = 1.0
    sbs = pack_sbs(rgb, alpha)
    assert sbs.shape == (4, 12, 3)
    assert sbs.dtype == np.uint8
    assert (sbs[:, :6] == 200).all()              # слева RGB как есть
    assert (sbs[:, 6:9] == 255).all()             # альфа=1 → белый
    assert (sbs[:, 9:12] == 0).all()              # альфа=0 → чёрный


def test_roundtrip() -> None:
    rng = np.random.default_rng(7)
    rgb = rng.integers(0, 256, size=(8, 8, 3), dtype=np.uint8)
    alpha = rng.random((8, 8), dtype=np.float32)
    rgb2, alpha2 = unpack_sbs(pack_sbs(rgb, alpha))
    assert (rgb2 == rgb).all()
    assert np.abs(alpha2 - alpha).max() <= 1 / 255 + 1e-6  # квантование байтом


def test_rejects_mismatched_shapes() -> None:
    import pytest

    with pytest.raises(ValueError):
        pack_sbs(np.zeros((4, 6, 3), np.uint8), np.zeros((4, 5), np.float32))
