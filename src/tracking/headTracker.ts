import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { OneEuroPoint } from './oneEuro'
import { eyePositionCm, type FaceInVideo } from './headPose'
import type { EyeCm } from '../render/offAxis'
import type { Calibration } from '../app/calibration'

// ВАЖНО: версия WASM должна совпадать с версией пакета в package.json
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

// Индексы центров зрачков в 478-точечной модели FaceLandmarker
const LEFT_IRIS = 468
const RIGHT_IRIS = 473

const NEUTRAL: EyeCm = { x: 0, y: 0, z: 60 } // куда затухаем при потере лица
const LOST_AFTER_MS = 500

export class HeadTracker {
  private landmarker!: FaceLandmarker
  private filter = new OneEuroPoint()
  private current: EyeCm = { ...NEUTRAL }
  private target: EyeCm = { ...NEUTRAL }
  private lastSeenMs = 0
  private lastVideoTimeMs = -1
  faceVisible = false

  constructor(private video: HTMLVideoElement, public calibration: Calibration) {}

  async init(): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL)
    this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 3, // детектим до 3 лиц, берём ближайшее
    })
  }

  // Зовётся каждый кадр рендера. Возвращает сглаженную позицию глаз.
  update(nowMs: number, dt: number): EyeCm {
    if (this.video.currentTime * 1000 !== this.lastVideoTimeMs) {
      this.lastVideoTimeMs = this.video.currentTime * 1000
      const res = this.landmarker.detectForVideo(this.video, nowMs)
      const face = this.pickNearestFace(res.faceLandmarks)
      if (face) {
        const t = eyePositionCm(face, this.calibration)
        if (Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z)) {
          this.target = t
          this.lastSeenMs = nowMs
        }
      }
    }

    this.faceVisible = nowMs - this.lastSeenMs < LOST_AFTER_MS
    const goal = this.faceVisible ? this.target : NEUTRAL

    // Экспоненциальное приближение к цели + One-Euro поверх: плавно и без дрожи
    const k = 1 - Math.exp(-dt * 10)
    this.current = {
      x: this.current.x + (goal.x - this.current.x) * k,
      y: this.current.y + (goal.y - this.current.y) * k,
      z: this.current.z + (goal.z - this.current.z) * k,
    }
    return this.filter.filter(this.current, dt)
  }

  // Ближайшее лицо = самое большое межзрачковое расстояние в пикселях
  private pickNearestFace(faces: { x: number; y: number }[][]): FaceInVideo | null {
    let best: FaceInVideo | null = null
    for (const lm of faces) {
      const li = lm[LEFT_IRIS], ri = lm[RIGHT_IRIS]
      if (!li || !ri) continue
      const w = this.video.videoWidth, h = this.video.videoHeight
      const dx = (li.x - ri.x) * w, dy = (li.y - ri.y) * h
      const ipdPx = Math.hypot(dx, dy)
      if (!best || ipdPx > best.ipdPx) {
        best = { cx: ((li.x + ri.x) / 2) * w, cy: ((li.y + ri.y) / 2) * h, ipdPx, videoW: w, videoH: h }
      }
    }
    return best
  }
}
