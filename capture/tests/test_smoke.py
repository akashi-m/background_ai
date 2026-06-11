import capture


def test_package_importable() -> None:
    assert capture.__version__
