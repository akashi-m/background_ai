"""Серийный бенч RVM + Pose в одном потоке против тика 15 Гц (spec §3.5, Фаза A exit).

Не unit-тест: требует реальные модели (scripts/get-models.sh) и измеряет аддитивный
CPU-бюджет RVM + Pose. Запуск вручную:
    cd capture && uv run python tests/bench_rvm_pose_serial.py
"""

import statistics
import time

import numpy as np

from capture.config import CaptureConfig
from capture.matting import make_engine
from capture.pose_engine import make_pose_engine

TICK_MS = 1000.0 / 15.0  # 15 Гц ≈ 66.7 мс
WARMUP = 5
ITERS = 60


def main() -> None:
    # ResNet50 + ratio 0.4 — прод-сетап качества (MEMORY: качество > fps)
    cfg = CaptureConfig(
        engine="rvm", model="resnet50", ratio=0.4,
        width=1280, height=720, pose_enabled=True,
    )
    rvm = make_engine(cfg)
    pose = make_pose_engine(cfg)
    assert pose is not None, "pose_enabled=True должно дать движок"

    rgb = (np.random.default_rng(0).integers(0, 256, (720, 1280, 3))).astype(np.uint8)

    # прогрев (первый вызов синхронно блокирует на инициализации графа)
    for _ in range(WARMUP):
        rvm.process(rgb)
        pose.process(rgb, time.monotonic() * 1000.0)

    rvm_ms: list[float] = []
    pose_ms: list[float] = []
    serial_ms: list[float] = []
    for _ in range(ITERS):
        t0 = time.perf_counter()
        rvm.process(rgb)
        t1 = time.perf_counter()
        pose.process(rgb, time.monotonic() * 1000.0)
        t2 = time.perf_counter()
        rvm_ms.append((t1 - t0) * 1000.0)
        pose_ms.append((t2 - t1) * 1000.0)
        serial_ms.append((t2 - t0) * 1000.0)

    def report(name: str, xs: list[float]) -> None:
        xs_sorted = sorted(xs)
        p95 = xs_sorted[int(0.95 * (len(xs_sorted) - 1))]
        print(f"  {name:12s} median={statistics.median(xs):6.1f}мс  p95={p95:6.1f}мс")

    print(f"тик 15 Гц = {TICK_MS:.1f}мс; модель=resnet50 ratio=0.4 720p; n={ITERS}")
    report("RVM", rvm_ms)
    report("Pose", pose_ms)
    report("RVM+Pose", serial_ms)

    serial_median = statistics.median(serial_ms)
    fps_est = 1000.0 / serial_median
    print(f"оценка fps по серийной сумме: {fps_est:.1f}")
    if serial_median > TICK_MS:
        print(
            f"ВНИМАНИЕ: серийная сумма {serial_median:.1f}мс пробивает тик {TICK_MS:.1f}мс "
            f"→ митигация (spec §3.5): full→lite / Pose через кадр / отдельный поток."
        )
    else:
        print("OK: серийная сумма укладывается в тик 15 Гц.")


if __name__ == "__main__":
    main()
