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


def test_model_and_ratio_defaults() -> None:
    cfg = CaptureConfig()
    assert cfg.model == "mobilenetv3"
    assert cfg.ratio == 0.25


def test_parse_args_model_resnet50() -> None:
    cfg = parse_args(["--engine", "rvm", "--model", "resnet50", "--ratio", "0.4"])
    assert cfg.model == "resnet50"
    assert cfg.ratio == 0.4


def test_parse_args_bad_model() -> None:
    import pytest

    with pytest.raises(SystemExit):
        parse_args(["--model", "transformer9000"])


def test_bitrate_auto_by_resolution() -> None:
    from capture.config import auto_bitrate_mbps

    assert auto_bitrate_mbps(1920, 1080) == 25     # ~2*1920*1080*6/1e6 ≈ 24.9
    assert auto_bitrate_mbps(1280, 720) >= 8       # минимум-пол
    assert auto_bitrate_mbps(3840, 2160) >= 90     # 4K SBS — щедро, с запасом


def test_bitrate_auto_when_flag_omitted() -> None:
    # без --bitrate: авто по разрешению (1080p → 25)
    assert parse_args(["--width", "1920", "--height", "1080"]).bitrate_mbps == 25.0


def test_bitrate_flag_overrides_auto() -> None:
    assert parse_args(["--bitrate", "50"]).bitrate_mbps == 50.0


def test_parse_args_ratio_out_of_range() -> None:
    import pytest

    with pytest.raises(SystemExit):
        parse_args(["--ratio", "1.5"])
    with pytest.raises(SystemExit):
        parse_args(["--ratio", "0"])


def test_pose_config_defaults() -> None:
    cfg = CaptureConfig()
    assert cfg.pose_enabled is True
    assert cfg.pose_model_path == ""


def test_pose_model_path_override() -> None:
    cfg = CaptureConfig(pose_model_path="/custom/pose.task")
    assert cfg.pose_model_path == "/custom/pose.task"


def test_perf_flags_defaults() -> None:
    cfg = CaptureConfig()
    assert cfg.parallel_pose is True     # по умолч. поза параллельно матту
    assert cfg.pose_every == 1
    assert cfg.profile is False


def test_parse_perf_flags() -> None:
    cfg = parse_args(["--no-parallel-pose", "--pose-every", "2", "--profile"])
    assert cfg.parallel_pose is False
    assert cfg.pose_every == 2
    assert cfg.profile is True


def test_parse_pose_every_bad() -> None:
    import pytest

    with pytest.raises(SystemExit):
        parse_args(["--pose-every", "0"])
