import { ImageSegmenter, FilesetResolver } from '@mediapipe/tasks-vision'
import * as THREE from 'three'

// ВАЖНО: версия WASM должна совпадать с версией пакета в package.json
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite'

// Маска фигуры: float 0..1, обновляется на частоте камеры, отдаётся как THREE-текстура.
export class PersonSegmenter {
  private segmenter!: ImageSegmenter
  private lastVideoTimeMs = -1
  texture: THREE.DataTexture | null = null
  fps = 0
  private frames = 0
  private fpsWindowStart = 0

  constructor(private video: HTMLVideoElement) {}

  async init(): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL)
    this.segmenter = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    })
  }

  update(nowMs: number): void {
    if (this.video.currentTime * 1000 === this.lastVideoTimeMs) return
    this.lastVideoTimeMs = this.video.currentTime * 1000

    this.segmenter.segmentForVideo(this.video, nowMs, (result) => {
      const mask = result.confidenceMasks?.[0]
      if (!mask) return
      // PERF: 8 бит хватает для smoothstep-краёв; линейная фильтрация байтовых текстур —
      // core WebGL2 (float32 требует OES_texture_float_linear); GPU→CPU readback и мусор
      // в 4 раза меньше.
      // PERF: для продакшна — оставить маску на GPU (canvas MPMask → texImage2D)
      const data = mask.getAsUint8Array()
      if (!this.texture || this.texture.image.width !== mask.width || this.texture.image.height !== mask.height) {
        this.texture?.dispose()
        this.texture = new THREE.DataTexture(
          data.slice(), mask.width, mask.height,
          THREE.RedFormat, THREE.UnsignedByteType
        )
        this.texture.minFilter = THREE.LinearFilter
        this.texture.magFilter = THREE.LinearFilter
      }
      ;(this.texture.image.data as Uint8Array).set(data)
      this.texture.needsUpdate = true
      mask.close()

      this.frames++
      if (this.fpsWindowStart === 0) this.fpsWindowStart = nowMs
      if (nowMs - this.fpsWindowStart > 1000) {
        this.fps = this.frames
        this.frames = 0
        this.fpsWindowStart = nowMs
      }
    })
  }
}
