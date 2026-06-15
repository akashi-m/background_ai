import dataclasses

import numpy as np

import capture.pose_engine as pe_mod
from capture.pose_engine import (
    POSE_VIS_THRESH,
    PoseEngine,
    PosePacket,
    healthy_fraction,
)


def test_pose_packet_is_frozen_dataclass() -> None:
    pkt = PosePacket(world=[[0.0, 0.0, 0.0, 1.0]], norm=[[0.5, 0.5, 0.0, 1.0]], healthy=1.0)
    assert dataclasses.is_dataclass(pkt)
    params = PosePacket.__dataclass_params__
    assert params.frozen is True
    assert pkt.world == [[0.0, 0.0, 0.0, 1.0]]
    assert pkt.norm == [[0.5, 0.5, 0.0, 1.0]]
    assert pkt.healthy == 1.0


def test_pose_packet_fields_shape() -> None:
    names = {f.name for f in dataclasses.fields(PosePacket)}
    assert names == {"world", "norm", "healthy"}


def test_vis_threshold_default() -> None:
    assert POSE_VIS_THRESH == 0.5


def test_healthy_fraction_all_visible() -> None:
    vis = [1.0] * 33
    assert healthy_fraction(vis) == 1.0


def test_healthy_fraction_half_below_threshold() -> None:
    vis = [0.9] * 11 + [0.3] * 22
    assert abs(healthy_fraction(vis) - (11 / 33)) < 1e-9


def test_healthy_fraction_boundary_is_inclusive() -> None:
    assert healthy_fraction([0.5, 0.5]) == 1.0


class _FakeLandmark:
    def __init__(self, x: float, y: float, z: float, v: float) -> None:
        self.x, self.y, self.z, self.visibility = x, y, z, v


class _FakeResult:
    """Имитирует PoseLandmarkerResult: один человек, 33 joint'а."""

    def __init__(self, world_v: list[float], norm_v: list[float]) -> None:
        self.pose_world_landmarks = [
            [_FakeLandmark(0.1, 0.2, 0.3, v) for v in world_v]
        ]
        self.pose_landmarks = [
            [_FakeLandmark(0.5, 0.6, 0.0, v) for v in norm_v]
        ]


class _FakeDetector:
    """Записывает все вызовы detect_for_video и возвращает фиксированный результат."""

    def __init__(self, result: _FakeResult) -> None:
        self._result = result
        self.calls: list[tuple[object, int]] = []

    def detect_for_video(self, image: object, ts: int) -> _FakeResult:
        self.calls.append((image, ts))
        return self._result


def _make_engine(result: _FakeResult) -> tuple[PoseEngine, _FakeDetector]:
    """Строим PoseEngine в обход реального create_from_options (нет модели в CI)."""
    eng = object.__new__(PoseEngine)
    detector = _FakeDetector(result)
    eng._detector = detector       # type: ignore[attr-defined]
    eng._last_ts = -1              # type: ignore[attr-defined]
    return eng, detector


def test_process_feeds_rgb_without_cvtcolor(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class _FakeImage:
        def __init__(self, image_format: object, data: np.ndarray) -> None:
            captured["format"] = image_format
            captured["data"] = data

    monkeypatch.setattr(pe_mod.mp, "Image", _FakeImage)
    rgb = np.zeros((48, 64, 3), dtype=np.uint8)
    rgb[:, :, 0] = 200
    eng, _ = _make_engine(_FakeResult([1.0] * 33, [1.0] * 33))
    eng.process(rgb, 0.0)
    assert captured["format"] is pe_mod.mp.ImageFormat.SRGB
    assert captured["data"] is rgb


def test_process_timestamp_monotonic_guard(monkeypatch) -> None:
    monkeypatch.setattr(pe_mod.mp, "Image", lambda image_format, data: object())
    rgb = np.zeros((8, 8, 3), dtype=np.uint8)
    eng, detector = _make_engine(_FakeResult([1.0] * 33, [1.0] * 33))
    eng.process(rgb, 10.7)
    eng.process(rgb, 10.7)
    eng.process(rgb, 5.0)
    eng.process(rgb, 100.0)
    sent = [ts for _, ts in detector.calls]
    assert sent == [10, 11, 12, 100]
    assert all(isinstance(ts, int) for ts in sent)


def test_process_packs_world_norm_and_healthy() -> None:
    rgb = np.zeros((8, 8, 3), dtype=np.uint8)
    world_v = [0.8] * 22 + [0.1] * 11
    eng, _ = _make_engine(_FakeResult(world_v, [1.0] * 33))
    eng._mk_image = lambda rgb: object()  # type: ignore[attr-defined]
    pkt = eng.process(rgb, 0.0)
    assert pkt is not None
    assert len(pkt.world) == 33 and len(pkt.norm) == 33
    assert pkt.world[0] == [0.1, 0.2, 0.3, 0.8]
    assert pkt.norm[0] == [0.5, 0.6, 0.0, 1.0]
    assert abs(pkt.healthy - (22 / 33)) < 1e-9


def test_process_returns_none_when_no_pose(monkeypatch) -> None:
    monkeypatch.setattr(pe_mod.mp, "Image", lambda image_format, data: object())
    rgb = np.zeros((8, 8, 3), dtype=np.uint8)

    class _Empty:
        pose_world_landmarks: list = []
        pose_landmarks: list = []

    eng, detector = _make_engine(_FakeResult([1.0] * 33, [1.0] * 33))
    detector._result = _Empty()  # type: ignore[assignment]
    assert eng.process(rgb, 0.0) is None
