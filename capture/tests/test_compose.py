import numpy as np

from capture.compose import pack_sbs, rotate_frame, shape_alpha, unpack_sbs


def test_rotate_frame_90_swaps_dims_clockwise() -> None:
    img = np.zeros((4, 6, 3), dtype=np.uint8)
    img[0, 0] = (255, 0, 0)              # маркер: верх-лево
    r = rotate_frame(img, 90)            # по часовой
    assert r.shape == (6, 4, 3)          # H↔W поменялись
    assert tuple(r[0, -1]) == (255, 0, 0)  # верх-лево → верх-право при CW 90


def test_rotate_frame_0_identity_and_180_involution() -> None:
    img = np.arange(4 * 6 * 3, dtype=np.uint8).reshape(4, 6, 3)
    assert np.array_equal(rotate_frame(img, 0), img)
    assert rotate_frame(img, 180).shape == (4, 6, 3)
    assert np.array_equal(rotate_frame(rotate_frame(img, 180), 180), img)


def test_rotate_frame_270_is_inverse_of_90() -> None:
    img = np.arange(4 * 6 * 3, dtype=np.uint8).reshape(4, 6, 3)
    assert np.array_equal(rotate_frame(rotate_frame(img, 90), 270), img)


def test_rotate_frame_bad_deg() -> None:
    import pytest

    with pytest.raises(ValueError):
        rotate_frame(np.zeros((2, 2, 3), np.uint8), 45)


def test_shape_alpha_endpoints_and_monotonic() -> None:
    a = np.linspace(0, 1, 11, dtype=np.float32)
    out = shape_alpha(a, 0.35, 0.80)
    assert out.dtype == np.float32
    assert out[0] == 0.0 and out[-1] == 1.0          # ниже lo → 0, выше hi → 1
    assert np.all(np.diff(out) >= 0)                  # монотонно не убывает
    assert (a[1:-1] < 0.35).sum() and out[a < 0.35].max() == 0.0  # хвост обнулён


def test_shape_alpha_tightens_band() -> None:
    """Поджатие сужает полупрозрачную полосу относительно сырой альфы."""
    a = np.linspace(0, 1, 1000, dtype=np.float32)
    raw_band = ((a > 0.1) & (a < 0.9)).mean()
    tight = shape_alpha(a, 0.35, 0.80)
    tight_band = ((tight > 0.1) & (tight < 0.9)).mean()
    assert tight_band < raw_band


def test_shape_alpha_invalid_window_returns_raw() -> None:
    a = np.linspace(0, 1, 5, dtype=np.float32)
    assert np.array_equal(shape_alpha(a, 0.8, 0.3), a)   # lo>=hi → сырая
    assert np.array_equal(shape_alpha(a, 0.5, 0.5), a)


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
