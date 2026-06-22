"""Smoke-test: main() строит pose через make_pose_engine и инжектит его в Pipeline.

Адаптации относительно черновика в плане:
- configure_bitrate импортируется лениво внутри main() → патчим capture.webrtc,
  а НЕ main_mod.configure_bitrate (его там нет как атрибута модуля).
- web.run_app вызывается как web.run_app(app, host=..., port=...) — патчим main_mod.web.
- build_app(pipeline) → app; затем app.on_cleanup.append(_cleanup) — _StubApp нужен с
  поддержкой .on_cleanup.append.
- main() может вызвать SystemExit(2) если make_source бросит — заглушка возвращает object().
"""

import capture.main as main_mod
import capture.webrtc as webrtc_mod


def test_main_forwards_pose_to_pipeline(monkeypatch) -> None:
    """main() строит pose через make_pose_engine и инжектит его в Pipeline."""
    sentinel_pose = object()
    captured: dict[str, object] = {}

    monkeypatch.setattr(main_mod, "make_source", lambda cfg: object())
    monkeypatch.setattr(main_mod, "make_engine", lambda cfg: object())
    monkeypatch.setattr(main_mod, "make_pose_engine", lambda cfg: sentinel_pose)

    class _FakePipeline:
        def __init__(self, source, engine, presence_cfg, pose=None, **kwargs) -> None:
            captured["pose"] = pose
            captured["kwargs"] = kwargs  # parallel_pose/pose_every/profile форвардятся из cfg

        def start(self) -> None: ...

    monkeypatch.setattr(main_mod, "Pipeline", _FakePipeline)

    # configure_bitrate импортируется лениво внутри main() — патчим на модуле webrtc
    monkeypatch.setattr(webrtc_mod, "configure_bitrate", lambda mbps: None)

    monkeypatch.setattr(main_mod, "build_app", lambda pipeline: _StubApp())
    monkeypatch.setattr(main_mod.web, "run_app", lambda app, host, port: None)

    main_mod.main(["--source", "webcam"])
    assert captured["pose"] is sentinel_pose


class _StubApp:
    """Минимальная заглушка web.Application: только on_cleanup.append."""

    class _Sig:
        def append(self, _fn) -> None: ...

    on_cleanup = _Sig()
