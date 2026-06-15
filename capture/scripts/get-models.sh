#!/usr/bin/env bash
# Скачивание моделей маттинга в capture/models/ (папка в .gitignore)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p models

# MediaPipe selfie segmenter (dev-движок), ~244 КБ
[ -f models/selfie_segmenter.tflite ] || curl -L -o models/selfie_segmenter.tflite \
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite"

# RobustVideoMatting mobilenetv3 ONNX (качественный движок), ~15 МБ
[ -f models/rvm_mobilenetv3_fp32.onnx ] || curl -L -o models/rvm_mobilenetv3_fp32.onnx \
  "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx"

# RobustVideoMatting resnet50 ONNX (максимальное качество краёв, медленнее), ~100 МБ
[ -f models/rvm_resnet50_fp32.onnx ] || curl -L -o models/rvm_resnet50_fp32.onnx \
  "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_resnet50_fp32.onnx"

# MediaPipe Pose Landmarker (v2-тень), full-вариант ~6 МБ
[ -f models/pose_landmarker_full.task ] || curl -L -o models/pose_landmarker_full.task \
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task"

ls -la models/
