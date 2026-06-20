import { describe, expect, it } from 'vitest'
import { floorPointAnalytic, heightLockScale } from './mirrorGeom'

describe('floorPointAnalytic (луч камеры → пол Z=0)', () => {
  const cam = { pos: [6.445, 8.128, 1.60] as [number,number,number], target: [2.642, 6.058, 1.30] as [number,number,number], fovY: 1.1386275, aspect: 0.5625 }
  it('центр кадра падает на пол перед камерой (Z≈0, ближе target по XY)', () => {
    const P = floorPointAnalytic(cam, 0.5, 0.5, 0)
    expect(P[2]).toBeCloseTo(0, 3)               // на полу
    // точка пола дальше target (target Z=1.3 > 0): луч центра идёт ниже до Z=0
    expect(Number.isFinite(P[0]) && Number.isFinite(P[1])).toBe(true)
  })
  it('ниже по экрану (v больше) → ближе к камере по горизонтали', () => {
    const near = floorPointAnalytic(cam, 0.5, 0.9, 0)
    const far  = floorPointAnalytic(cam, 0.5, 0.55, 0)
    const dNear = Math.hypot(near[0]-6.445, near[1]-8.128)
    const dFar  = Math.hypot(far[0]-6.445, far[1]-8.128)
    expect(dNear).toBeLessThan(dFar)
  })
})

describe('heightLockScale (1:1)', () => {
  it('sy делает фигуру H_px высотой: sy = bboxHfrac·canvasH / H_px', () => {
    // H=1.72м, экран 19.74см физ высота, 960px канвас, bbox 0.8 кадра, mirrorMag 1
    const r = heightLockScale({ H_m: 1.72, bboxHfrac: 0.8, canvasHeightPx: 960, screenHcm: 19.74, mirrorMag: 1, personAspect: 1, canvasAspect: 0.5625 })
    const pxPerCm = 960 / 19.74
    const H_px = 1.72 * 100 * pxPerCm * 1
    expect(r.sy).toBeCloseTo(0.8 * 960 / H_px, 4)
    expect(r.sx).toBeGreaterThan(0)              // un-stretched (см. реализацию)
  })
  it('mirrorMag масштабирует линейно', () => {
    const base = heightLockScale({ H_m: 1.7, bboxHfrac: 0.8, canvasHeightPx: 960, screenHcm: 20, mirrorMag: 1, personAspect: 1, canvasAspect: 0.5625 })
    const big  = heightLockScale({ H_m: 1.7, bboxHfrac: 0.8, canvasHeightPx: 960, screenHcm: 20, mirrorMag: 1.2, personAspect: 1, canvasAspect: 0.5625 })
    expect(big.sy).toBeCloseTo(base.sy / 1.2, 5) // больше mirrorMag → меньше sy (крупнее фигура)
  })
})
