from capture.config import CaptureConfig, parse_args


def test_defaults() -> None:
    cfg = CaptureConfig()
    assert cfg.source == "webcam"
    assert cfg.engine == "mediapipe"
    assert cfg.port == 8765
    assert cfg.width == 1280
    assert cfg.height == 720


def test_parse_args_file_source() -> None:
    cfg = parse_args(["--source", "file:clip.mp4", "--engine", "rvm", "--port", "9000"])
    assert cfg.source == "file"
    assert cfg.file_path == "clip.mp4"
    assert cfg.engine == "rvm"
    assert cfg.port == 9000


def test_parse_args_zed() -> None:
    cfg = parse_args(["--source", "zed"])
    assert cfg.source == "zed"


def test_parse_args_bad_source() -> None:
    import pytest

    with pytest.raises(SystemExit):
        parse_args(["--source", "hologram"])
