"""MediaPipe Pose-движок (v2-тень): 33 landmark'а на тот же frame.rgb, что и матте."""

from collections.abc import Sequence
from dataclasses import dataclass

# Порог видимости joint'а для healthy-метрики (spec §3.3, контракт POSE_VIS_THRESH).
POSE_VIS_THRESH = 0.5


@dataclass(frozen=True)
class PosePacket:
    world: list[list[float]]   # 33 × [x,y,z,v], метры, hip-origin
    norm: list[list[float]]    # 33 × [x,y,z,v], [0,1] по кадру
    healthy: float             # доля joints с visibility ≥ POSE_VIS_THRESH


def healthy_fraction(visibilities: Sequence[float]) -> float:
    """Доля landmark'ов с visibility ≥ POSE_VIS_THRESH (0.0..1.0)."""
    n = len(visibilities)
    if n == 0:
        return 0.0
    return sum(1 for v in visibilities if v >= POSE_VIS_THRESH) / n
