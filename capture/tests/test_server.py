import json

import numpy as np
import pytest
from aiohttp.test_utils import TestClient, TestServer

from capture.pipeline import PipelineStats
from capture.presence import PresenceState
from capture.server import build_app


class FakePipeline:
    """Подменяет Pipeline в тестах сервера — без камер и моделей."""

    def latest_sbs(self) -> np.ndarray | None:
        return np.zeros((8, 16, 3), dtype=np.uint8)

    def stats(self) -> PipelineStats:
        return PipelineStats(
            frames=42, fps=30.0,
            presence=PresenceState(present=True, distance_cm=150.0, coverage=0.2),
            bbox=(0.1, 0.2, 0.6, 1.0),
            errors=3, last_error="RuntimeError: boom",
        )


@pytest.fixture
async def client():
    app = build_app(FakePipeline(), telemetry_hz=50)
    c = TestClient(TestServer(app))
    await c.start_server()
    yield c
    await c.close()


async def test_health(client) -> None:
    resp = await client.get("/health")
    assert resp.status == 200
    data = await resp.json()
    assert data["fps"] == 30.0
    assert data["frames"] == 42
    assert data["errors"] == 3
    assert data["lastError"] == "RuntimeError: boom"


async def test_ws_telemetry_stream(client) -> None:
    ws = await client.ws_connect("/ws")
    msg = json.loads((await ws.receive(timeout=2)).data)
    assert msg["type"] == "presence"
    assert msg["present"] is True
    assert msg["distanceCm"] == 150.0
    assert msg["bbox"] == [0.1, 0.2, 0.6, 1.0]
    assert msg["errors"] == 3
    msg2 = json.loads((await ws.receive(timeout=2)).data)  # поток, не одно сообщение
    assert msg2["type"] == "presence"
    await ws.close()


async def test_viewer_served(client) -> None:
    resp = await client.get("/viewer")
    assert resp.status == 200
    assert "text/html" in resp.headers["Content-Type"]
