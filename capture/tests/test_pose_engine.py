import dataclasses

from capture.pose_engine import POSE_VIS_THRESH, PosePacket, healthy_fraction


def test_pose_packet_is_frozen_dataclass() -> None:
    pkt = PosePacket(world=[[0.0, 0.0, 0.0, 1.0]], norm=[[0.5, 0.5, 0.0, 1.0]], healthy=1.0)
    assert dataclasses.is_dataclass(pkt)
    params = getattr(PosePacket, "__dataclass_params__")
    assert params.frozen is True
    assert pkt.world == [[0.0, 0.0, 0.0, 1.0]]
    assert pkt.norm == [[0.5, 0.5, 0.0, 1.0]]
    assert pkt.healthy == 1.0


def test_pose_packet_fields_shape() -> None:
    names = {f.name for f in dataclasses.fields(PosePacket)}
    assert names == {"world", "norm", "healthy"}


def test_vis_threshold_default() -> None:
    assert POSE_VIS_THRESH == 0.5


def test_healthy_fraction_all_visible() -> None:
    vis = [1.0] * 33
    assert healthy_fraction(vis) == 1.0


def test_healthy_fraction_half_below_threshold() -> None:
    vis = [0.9] * 11 + [0.3] * 22
    assert abs(healthy_fraction(vis) - (11 / 33)) < 1e-9


def test_healthy_fraction_boundary_is_inclusive() -> None:
    assert healthy_fraction([0.5, 0.5]) == 1.0
