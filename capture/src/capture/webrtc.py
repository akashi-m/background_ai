"""WebRTC-выдача SBS-кадров (aiortc). Один трек на соединение."""

import numpy as np
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import VideoStreamTrack
from av import VideoFrame

from capture.server import PipelineLike


class SbsTrack(VideoStreamTrack):
    """Отдаёт последний SBS-кадр пайплайна; нет кадра — чёрный (рендерер в IDLE)."""

    def __init__(self, pipeline: PipelineLike, fps: int = 30) -> None:
        super().__init__()
        self._pipeline = pipeline
        self._fps = fps
        self._black = np.zeros((720, 2560, 3), dtype=np.uint8)

    async def recv(self) -> VideoFrame:
        pts, time_base = await self.next_timestamp()
        sbs = self._pipeline.latest_sbs()
        frame = VideoFrame.from_ndarray(sbs if sbs is not None else self._black, format="rgb24")
        frame.pts = pts
        frame.time_base = time_base
        return frame


async def handle_offer(
    pipeline: PipelineLike, offer_sdp: str, offer_type: str, pcs: set[RTCPeerConnection]
) -> RTCSessionDescription:
    pc = RTCPeerConnection()
    pcs.add(pc)

    @pc.on("connectionstatechange")
    async def _on_state() -> None:
        if pc.connectionState in ("failed", "closed"):
            await pc.close()
            pcs.discard(pc)

    pc.addTrack(SbsTrack(pipeline))
    await pc.setRemoteDescription(RTCSessionDescription(sdp=offer_sdp, type=offer_type))
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    assert pc.localDescription is not None
    return pc.localDescription
