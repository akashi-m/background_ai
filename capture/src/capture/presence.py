"""Присутствие посетителя: гистерезис + дебаунс по статистике маски.

Дистанция (dev): bbox человека ростом ~170 см занимает долю кадра
обратно пропорциональную расстоянию → distance_cm ≈ k / bbox_height_ratio.
k калибруется по месту (дефолт 110 ≈ вебка Mac на столе).
На проде источником дистанции станет глубина ZED — тот же интерфейс state.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class PresenceConfig:
    enter_coverage: float = 0.06   # доля кадра с альфой>0.5, чтобы «войти»
    exit_coverage: float = 0.03    # ниже — кандидат на «выход» (гистерезис)
    enter_frames: int = 3          # подряд кадров для входа (дебаунс)
    exit_frames: int = 5           # подряд кадров для выхода
    distance_k_cm: float = 110.0   # коэффициент дистанции по высоте bbox


@dataclass(frozen=True)
class PresenceState:
    present: bool
    distance_cm: float | None
    coverage: float


class PresenceTracker:
    def __init__(self, cfg: PresenceConfig | None = None) -> None:
        self.cfg = cfg or PresenceConfig()
        self._present = False
        self._enter_run = 0
        self._exit_run = 0
        self._last = PresenceState(False, None, 0.0)

    @property
    def state(self) -> PresenceState:
        return self._last

    def update(self, coverage: float, bbox_height_ratio: float) -> PresenceState:
        c = self.cfg
        if not self._present:
            if coverage >= c.enter_coverage:
                self._enter_run += 1
                if self._enter_run >= c.enter_frames:
                    self._present = True
                    self._exit_run = 0
            else:
                self._enter_run = 0
        else:
            if coverage < c.exit_coverage:
                self._exit_run += 1
                if self._exit_run >= c.exit_frames:
                    self._present = False
                    self._enter_run = 0
            else:
                self._exit_run = 0

        distance: float | None = None
        if self._present and bbox_height_ratio > 1e-3:
            distance = c.distance_k_cm / bbox_height_ratio
        self._last = PresenceState(self._present, distance, coverage)
        return self._last
