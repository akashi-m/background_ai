import asyncio

import numpy as np
import pytest
from aiortc import RTCPeerConnection

from capture.pipeline import PipelineStats
from capture.presence import PresenceState
from capture.webrtc import configure_bitrate, handle_offer


def test_configure_bitrate_pins_vpx_bounds() -> None:
    import aiortc.codecs.vpx as vpx

    saved = (vpx.MIN_BITRATE, vpx.DEFAULT_BITRATE, vpx.MAX_BITRATE)
    try:
        configure_bitrate(8.0)
        assert vpx.MIN_BITRATE == 8_000_000
        assert vpx.DEFAULT_BITRATE == 8_000_000
        assert vpx.MAX_BITRATE == 8_000_000
    finally:
        vpx.MIN_BITRATE, vpx.DEFAULT_BITRATE, vpx.MAX_BITRATE = saved


class FakePipeline:
    def latest_sbs(self) -> np.ndarray | None:
        sbs = np.zeros((48, 128, 3), dtype=np.uint8)
        sbs[:, :64] = 200      # «RGB» слева
        sbs[:, 64:] = 255      # «альфа» справа
        return sbs

    def stats(self) -> PipelineStats:
        return PipelineStats(1, 30.0, PresenceState(True, 100.0, 0.5))


@pytest.mark.asyncio
async def test_offer_answer_and_frames_flow() -> None:
    pcs: set[RTCPeerConnection] = set()
    client = RTCPeerConnection()
    received = asyncio.Event()

    @client.on("track")
    def on_track(track):  # type: ignore[no-untyped-def]
        async def consume() -> None:
            for _ in range(3):
                await track.recv()
            received.set()

        asyncio.ensure_future(consume())

    client.addTransceiver("video", direction="recvonly")
    offer = await client.createOffer()
    await client.setLocalDescription(offer)

    answer = await handle_offer(
        FakePipeline(), client.localDescription.sdp, client.localDescription.type, pcs
    )
    await client.setRemoteDescription(answer)

    await asyncio.wait_for(received.wait(), timeout=10)
    await client.close()
    for pc in pcs:
        await pc.close()
