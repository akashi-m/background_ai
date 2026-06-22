#!/usr/bin/env python3
"""Сделать из RVM-ONNX вариант с UINT8-входом (Cast+Div(255)+Transpose в графе).

Зачем: по PCIe в GPU летит uint8 NHWC прямо из камеры — в 4× меньше байт, чем
float32, и БЕЗ CPU-каста/транспонирования (их делает граф на устройстве). Точность
не страдает: Cast(uint8→float32) + Div(255.0) даёт бит-в-бит тот же float, что и
`astype(float32)/255.0` на CPU (одно и то же IEEE-754 деление), а Transpose — чистое
перемещение данных. pha/fgr/recurrent НЕ трогаем.

Граф:
    src_u8 [B,H,W,3] uint8  ->  Transpose(0,3,1,2)  ->  Cast(float32)  ->  Div(255)  ->  src
(имя выхода 'src' сохраняем, поэтому ВСЕ исходные потребители 'src' работают как было).

Запуск:
    cd capture && uv run --with onnx python scripts/optimize-rvm-model.py
По умолчанию берёт models/rvm_resnet50_fp32.onnx и пишет models/rvm_resnet50_fp32_u8.onnx.
Движок (RvmEngine) сам подхватит *_u8.onnx, если файл есть рядом с fp32-моделью.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def build_u8_model(src_path: Path, dst_path: Path) -> None:
    model = onnx.load(str(src_path))
    graph = model.graph

    src_in = next((i for i in graph.input if i.name == "src"), None)
    if src_in is None:
        raise SystemExit(f"в графе {src_path} нет входа 'src' — это точно RVM-модель?")
    if src_in.type.tensor_type.elem_type != TensorProto.FLOAT:
        raise SystemExit("вход 'src' не FLOAT — модель уже изменена?")

    dims = src_in.type.tensor_type.shape.dim
    # [B, 3, H, W] → uint8-вход в NHWC [B, H, W, 3]
    b = dims[0].dim_param or dims[0].dim_value
    h = dims[2].dim_param or dims[2].dim_value
    w = dims[3].dim_param or dims[3].dim_value

    # 'src' перестаёт быть входом графа, но остаётся внутренним тензором (его пишет Div).
    graph.input.remove(src_in)

    const255 = numpy_helper.from_array(np.array(255.0, dtype=np.float32), name="rvm_u8_const255")
    graph.initializer.append(const255)

    u8_in = helper.make_tensor_value_info("src_u8", TensorProto.UINT8, [b, h, w, 3])
    graph.input.insert(0, u8_in)

    nodes = [
        helper.make_node(
            "Transpose", ["src_u8"], ["rvm_u8_nchw"], perm=[0, 3, 1, 2], name="rvm_u8_transpose"
        ),
        helper.make_node(
            "Cast", ["rvm_u8_nchw"], ["rvm_u8_f32"], to=TensorProto.FLOAT, name="rvm_u8_cast"
        ),
        helper.make_node("Div", ["rvm_u8_f32", "rvm_u8_const255"], ["src"], name="rvm_u8_div255"),
    ]
    # новые узлы должны идти ПЕРЕД потребителями 'src' → вставляем в начало.
    for node in reversed(nodes):
        graph.node.insert(0, node)

    onnx.checker.check_model(model)
    onnx.save(model, str(dst_path))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--src",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "models" / "rvm_resnet50_fp32.onnx",
        help="исходная fp32-модель RVM",
    )
    parser.add_argument(
        "--dst",
        type=Path,
        default=None,
        help="куда писать (по умолчанию <src без .onnx>_u8.onnx)",
    )
    args = parser.parse_args()

    src_path: Path = args.src
    dst_path: Path = args.dst or src_path.with_name(src_path.stem + "_u8.onnx")
    if not src_path.exists():
        raise SystemExit(f"нет файла модели: {src_path}")

    build_u8_model(src_path, dst_path)
    print(f"готово: {dst_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
