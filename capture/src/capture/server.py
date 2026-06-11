"""HTTP/WS-сервер capture-сервиса: /health, /ws (телеметрия), /viewer, /offer."""

import asyncio
import json
from pathlib import Path
from typing import Protocol

import numpy as np
from aiohttp import WSMsgType, web

from capture.pipeline import PipelineStats

VIEWER_HTML = Path(__file__).resolve().parents[3] / "viewer" / "viewer.html"


class PipelineLike(Protocol):
    """Контракт пайплайна, нужный серверу (тестам хватает фейка)."""

    def latest_sbs(self) -> np.ndarray | None: ...
    def stats(self) -> PipelineStats: ...


def _telemetry_json(stats: PipelineStats) -> str:
    p = stats.presence
    return json.dumps(
        {
            "type": "presence",
            "present": p.present,
            "distanceCm": p.distance_cm,
            "coverage": round(p.coverage, 4),
            "bbox": stats.bbox,  # нормированный (x0,y0,x1,y1); низ = «ноги» для тени
            "errors": stats.errors,
            "fps": round(stats.fps, 1),
        }
    )


async def _health(request: web.Request) -> web.Response:
    pipeline: PipelineLike = request.app["pipeline"]
    s = pipeline.stats()
    return web.json_response(
        {
            "ok": s.errors == 0 or s.fps > 0,
            "frames": s.frames,
            "fps": s.fps,
            "present": s.presence.present,
            "errors": s.errors,
            "lastError": s.last_error,
        }
    )


async def _ws(request: web.Request) -> web.WebSocketResponse:
    pipeline: PipelineLike = request.app["pipeline"]
    hz: int = request.app["telemetry_hz"]
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    try:
        while not ws.closed:
            await ws.send_str(_telemetry_json(pipeline.stats()))
            try:
                msg = await asyncio.wait_for(ws.receive(), timeout=1.0 / hz)
                if msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.ERROR):
                    break
            except TimeoutError:
                pass  # нет входящих — шлём следующий тик телеметрии
    finally:
        await ws.close()
    return ws


async def _viewer(request: web.Request) -> web.Response:
    return web.Response(text=VIEWER_HTML.read_text(), content_type="text/html")


def build_app(pipeline: PipelineLike, telemetry_hz: int = 15) -> web.Application:
    app = web.Application()
    app["pipeline"] = pipeline
    app["telemetry_hz"] = telemetry_hz
    app.router.add_get("/health", _health)
    app.router.add_get("/ws", _ws)
    app.router.add_get("/viewer", _viewer)
    return app
