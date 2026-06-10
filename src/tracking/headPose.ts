import type { EyeCm } from '../render/offAxis'
import type { Calibration } from '../app/calibration'

// Среднее межзрачковое расстояние взрослого человека, см. Точность ±10% достаточна.
export const IPD_CM = 6.3

// Точка между глазами в кадре видео (пиксели) + размер IPD в пикселях.
export interface FaceInVideo {
  cx: number
  cy: number
  ipdPx: number
  videoW: number
  videoH: number
}

export function focalLengthPx(videoW: number, hfovDeg: number): number {
  return videoW / 2 / Math.tan(((hfovDeg * Math.PI) / 180) / 2)
}

// Пинхол-модель: z из размера IPD, x/y из смещения от центра кадра.
// Знаки: видео НЕ зеркальное — зритель двигается вправо → в кадре влево (cx падает),
// поэтому минус. Ось y видео направлена вниз — тоже минус.
export function eyePositionCm(face: FaceInVideo, cal: Calibration): EyeCm {
  const f = focalLengthPx(face.videoW, cal.webcamHfovDeg)
  const z = (IPD_CM * f) / face.ipdPx
  const x = -(((face.cx - face.videoW / 2) * z) / f) + cal.camOffsetXcm
  const y = -(((face.cy - face.videoH / 2) * z) / f) + cal.camOffsetYcm
  return { x, y, z }
}
