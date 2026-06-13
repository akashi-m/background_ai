"""HTTP/WS-сервер capture-сервиса: /health, /ws (телеметрия), /viewer, /offer."""

import asyncio
import json
from pathlib import Path
from typing import Protocol

import numpy as np
from aiohttp import WSMsgType, web

from capture.pipeline import PipelineStats

VIEWER_HTML = Path(__file__).resolve().parents[2] / "viewer" / "viewer.html"


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
            try:
                await ws.send_str(_telemetry_json(pipeline.stats()))
            except (ConnectionResetError, ConnectionError):
                break  # клиент (вкладка) закрылся между тиками — выходим тихо
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


def _parse_feather(raw: str | None) -> tuple[float, float] | None:
    """'lo,hi' → (lo, hi); мусор → None (дев-параметр, не валидируем строго)."""
    if not raw:
        return None
    try:
        lo, hi = (float(x) for x in raw.split(","))
        return lo, hi
    except (ValueError, TypeError):
        return None


async def _frame_png(request: web.Request) -> web.Response:
    """Lossless-снимок последнего SBS-кадра — оценка матта мимо WebRTC-кодека.

    ?feather=lo,hi — превью поджатия края (та же smoothstep, что в рендерере);
    хранимая альфа не меняется.
    """
    import cv2

    from capture.compose import shape_alpha

    pipeline: PipelineLike = request.app["pipeline"]
    sbs = pipeline.latest_sbs()
    if sbs is None:
        return web.Response(status=503, text="кадра ещё нет")

    window = _parse_feather(request.query.get("feather"))
    if window is not None:
        w = sbs.shape[1] // 2
        a = sbs[:, w:, 0].astype(np.float32) / 255.0
        a8 = (shape_alpha(a, *window) * 255.0 + 0.5).clip(0, 255).astype(np.uint8)
        sbs = sbs.copy()
        sbs[:, w:, 0] = sbs[:, w:, 1] = sbs[:, w:, 2] = a8

    ok, png = cv2.imencode(".png", cv2.cvtColor(sbs, cv2.COLOR_RGB2BGR))
    if not ok:
        return web.Response(status=500, text="PNG не закодировался")
    return web.Response(body=png.tobytes(), content_type="image/png")


async def _offer(request: web.Request) -> web.Response:
    from capture.webrtc import handle_offer

    pipeline: PipelineLike = request.app["pipeline"]
    pcs = request.app["pcs"]
    body = await request.json()
    local = await handle_offer(pipeline, body["sdp"], body["type"], pcs)
    return web.json_response({"sdp": local.sdp, "type": local.type})


@web.middleware
async def _cors(request: web.Request, handler: object) -> web.StreamResponse:
    """CORS для loopback: рендерер (vite :5173) → capture (:8765) — разные origin.

    Сервер слушает только 127.0.0.1, поэтому `*` безопасен. OPTIONS-preflight
    (его шлёт браузер перед POST /offer с JSON) замыкаем сразу, не доводя до
    роутера (иначе 405). WebSocket-ответ не трогаем — заголовки уже отправлены.
    """
    if request.method == "OPTIONS":
        resp: web.StreamResponse = web.Response(status=200)
    else:
        resp = await handler(request)  # type: ignore[operator]
        if isinstance(resp, web.WebSocketResponse):
            return resp
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


async def _on_shutdown(app: web.Application) -> None:
    for pc in set(app["pcs"]):
        await pc.close()
    app["pcs"].clear()


def build_app(pipeline: PipelineLike, telemetry_hz: int = 15) -> web.Application:
    app = web.Application(middlewares=[_cors])
    app["pipeline"] = pipeline
    app["telemetry_hz"] = telemetry_hz
    app["pcs"] = set()
    app.router.add_get("/health", _health)
    app.router.add_get("/ws", _ws)
    app.router.add_get("/viewer", _viewer)
    app.router.add_get("/frame.png", _frame_png)
    app.router.add_post("/offer", _offer)
    app.on_shutdown.append(_on_shutdown)
    return app
