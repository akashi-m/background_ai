"""Вход capture-сервиса: собрать пайплайн по конфигу и поднять сервер."""

import sys

from aiohttp import web

from capture.config import parse_args
from capture.matting import make_engine
from capture.pipeline import Pipeline
from capture.presence import PresenceConfig
from capture.server import build_app
from capture.sources import make_source


def main(argv: list[str] | None = None) -> None:
    cfg = parse_args(argv)
    try:
        source = make_source(cfg)
    except (RuntimeError, FileNotFoundError) as e:
        print(f"источник: {e}", file=sys.stderr)
        raise SystemExit(2) from e
    engine = make_engine(cfg)
    pipeline = Pipeline(source, engine, PresenceConfig())
    pipeline.start()

    app = build_app(pipeline)

    async def _cleanup(_: web.Application) -> None:
        pipeline.stop()

    app.on_cleanup.append(_cleanup)
    print(f"capture: источник={cfg.source} движок={cfg.engine}")
    print(f"viewer:  http://localhost:{cfg.port}/viewer")
    web.run_app(app, host="127.0.0.1", port=cfg.port)


if __name__ == "__main__":
    main()
