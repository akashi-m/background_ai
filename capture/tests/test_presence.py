from capture.presence import PresenceConfig, PresenceTracker

CFG = PresenceConfig(enter_coverage=0.06, exit_coverage=0.03,
                     enter_frames=3, exit_frames=5, distance_k_cm=110.0)


def tick(t: PresenceTracker, coverage: float, bbox_h: float, n: int) -> None:
    for _ in range(n):
        t.update(coverage=coverage, bbox_height_ratio=bbox_h)


def test_starts_absent() -> None:
    t = PresenceTracker(CFG)
    assert t.state.present is False


def test_enter_needs_consecutive_frames() -> None:
    t = PresenceTracker(CFG)
    tick(t, 0.10, 0.5, 2)
    assert t.state.present is False      # ещё рано
    tick(t, 0.10, 0.5, 1)
    assert t.state.present is True       # 3-й подряд кадр


def test_flicker_does_not_enter() -> None:
    t = PresenceTracker(CFG)
    tick(t, 0.10, 0.5, 2)
    tick(t, 0.0, 0.0, 1)                 # разрыв сбрасывает счётчик
    tick(t, 0.10, 0.5, 2)
    assert t.state.present is False


def test_exit_hysteresis_and_debounce() -> None:
    t = PresenceTracker(CFG)
    tick(t, 0.10, 0.5, 3)
    assert t.state.present is True
    tick(t, 0.04, 0.4, 10)               # между exit(0.03) и enter(0.06) — держим
    assert t.state.present is True
    tick(t, 0.01, 0.1, 4)
    assert t.state.present is True       # ещё не 5 кадров ниже exit
    tick(t, 0.01, 0.1, 1)
    assert t.state.present is False


def test_distance_from_bbox_height() -> None:
    t = PresenceTracker(CFG)
    tick(t, 0.10, 0.55, 3)
    assert t.state.present is True
    assert abs(t.state.distance_cm - 110.0 / 0.55) < 1e-6


def test_distance_none_when_absent() -> None:
    t = PresenceTracker(CFG)
    assert t.state.distance_cm is None
