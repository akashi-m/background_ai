"""Вход capture-сервиса: собрать пайплайн по конфигу и поднять сервер."""

import sys

from aiohttp import web

from capture.config import parse_args
from capture.matting import make_engine
from capture.pipeline import Pipeline
from capture.pose_engine import make_pose_engine
from capture.presence import PresenceConfig
from capture.server import build_app
from capture.sources import make_source


def list_cameras() -> None:
    """Перечислить доступные камеры (индексы 0..5) — для выбора S24/Continuity."""
    import cv2

    for i in range(6):
        cap = cv2.VideoCapture(i)
        if cap.isOpened():
            w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            print(f"  индекс {i}: {w}x{h}")
            cap.release()
    print("запуск: uv run capture --source webcam --camera-index <N>")


def main(argv: list[str] | None = None) -> None:
    if argv is None and "--list-cameras" in sys.argv or argv and "--list-cameras" in argv:
        list_cameras()
        return
    cfg = parse_args(argv)
    try:
        source = make_source(cfg)
    except (RuntimeError, FileNotFoundError) as e:
        print(f"источник: {e}", file=sys.stderr)
        raise SystemExit(2) from e
    engine = make_engine(cfg)
    pose = make_pose_engine(cfg)

    from capture.webrtc import configure_bitrate

    configure_bitrate(cfg.bitrate_mbps)  # до первого offer: энкодер читает глобалы

    pipeline = Pipeline(
        source, engine, PresenceConfig(), pose=pose,
        parallel_pose=cfg.parallel_pose, pose_every=cfg.pose_every, profile=cfg.profile,
    )
    pipeline.start()

    app = build_app(pipeline)

    async def _cleanup(_: web.Application) -> None:
        pipeline.stop()

    app.on_cleanup.append(_cleanup)
    print(f"capture: источник={cfg.source} движок={cfg.engine} битрейт={cfg.bitrate_mbps}Мбит/с")
    print(f"viewer:  http://localhost:{cfg.port}/viewer")
    web.run_app(app, host="127.0.0.1", port=cfg.port)


if __name__ == "__main__":
    main()
