import { describe, expect, it } from 'vitest'
import { personFloorWorld, sampleWorldXYZ, type ShadowCamera } from './shadowGeom'

// камера у балконной двери смотрит на восток (как плейт гостиной)
const CAM: ShadowCamera = {
  pos: [1.35, 2.2, 1.62], target: [8.0, 1.5, 1.05], fovY: 1.05, aspect: 1080 / 1920,
}

describe('personFloorWorld', () => {
  it('дальше дистанция → точка F дальше от камеры по оси взгляда', () => {
    const near = personFloorWorld({ distanceCm: 120, bboxCx: 0.5, bboxH: 0.8 }, CAM, 0)
    const far = personFloorWorld({ distanceCm: 250, bboxCx: 0.5, bboxH: 0.5 }, CAM, 0)
    const dNear = Math.hypot(near.F[0] - 1.35, near.F[1] - 2.2)
    const dFar = Math.hypot(far.F[0] - 1.35, far.F[1] - 2.2)
    expect(dFar).toBeGreaterThan(dNear)
    expect(near.F[2]).toBeCloseTo(0, 5) // на полу
  })

  it('смещение bbox вправо → F смещается вбок (Y меняется)', () => {
    const c = personFloorWorld({ distanceCm: 200, bboxCx: 0.5, bboxH: 0.6 }, CAM, 0)
    const r = personFloorWorld({ distanceCm: 200, bboxCx: 0.8, bboxH: 0.6 }, CAM, 0)
    expect(Math.abs(r.F[1] - c.F[1])).toBeGreaterThan(0.1)
  })

  it('рост из bbox+дистанции в диапазоне [1.4, 2.0]', () => {
    const p = personFloorWorld({ distanceCm: 200, bboxCx: 0.5, bboxH: 0.9 }, CAM, 0)
    expect(p.H).toBeGreaterThanOrEqual(1.4)
    expect(p.H).toBeLessThanOrEqual(2.0)
  })
})

describe('sampleWorldXYZ', () => {
  const data = new Float32Array([
    0, 0, 7, 1,   1, 0, 7, 1,   // row 0: (0,0) (1,0)
    0, 1, 7, 1,   1, 1, 7, 1,   // row 1: (0,1) (1,1)
  ])
  const wp = { data, width: 2, height: 2 }

  it('сэмплит верхний-левый при u=0,v=0 (flipY=false → py=0)', () => {
    expect(sampleWorldXYZ(wp, 0, 0)).toEqual([0, 0, 7])
  })
  it('сэмплит нижний-правый при u=1,v=1', () => {
    expect(sampleWorldXYZ(wp, 1, 1)).toEqual([1, 1, 7])
  })
  it('округляет: u=0.6,v=0.4 → px=round(0.6)=1, py=round(0.4)=0', () => {
    expect(sampleWorldXYZ(wp, 0.6, 0.4)).toEqual([1, 0, 7])
  })
  it('клампит u/v за пределами [0,1] в крайние тексели', () => {
    expect(sampleWorldXYZ(wp, -5, 5)).toEqual([0, 1, 7])
  })
})
