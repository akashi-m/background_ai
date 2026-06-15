import { describe, it, expect } from 'vitest'
import { LUX_CONFIG } from './config'
import { multiplyShadowTerm, coverUv } from './multiplyBlit'

describe('LUX_CONFIG.shadow новые поля', () => {
  it('blobRatio = 0.5, shadowFloorK = 0.7 (spec §4.4/§4.5)', () => {
    expect(LUX_CONFIG.shadow.blobRatio).toBeCloseTo(0.5, 6)
    expect(LUX_CONFIG.shadow.shadowFloorK).toBeCloseTo(0.7, 6)
  })
  it('существующие поля strength/softness/bias сохранены', () => {
    expect(LUX_CONFIG.shadow.strength).toBeCloseTo(0.5, 6)
    expect(LUX_CONFIG.shadow.softness).toBeCloseTo(1.6, 6)
    expect(LUX_CONFIG.shadow.bias).toBeCloseTo(0.005, 6)
  })
})

describe('multiplyShadowTerm (числовое зеркало multiplyBlitMat)', () => {
  it('вне тени (shadowSample=1.0): множитель = 1.0', () => {
    expect(multiplyShadowTerm(1.0, 0.6, 0.7)).toBeCloseTo(1.0, 6)
  })
  it('самая плотная тень (shadowSample=0.0): 1 - strength*floorK', () => {
    expect(multiplyShadowTerm(0.0, 0.6, 0.7)).toBeCloseTo(0.58, 6)
  })
  it('никогда не в чёрный: ограничен снизу потолком', () => {
    expect(multiplyShadowTerm(0.0, 1.0, 0.7)).toBeCloseTo(0.3, 6)
    expect(multiplyShadowTerm(0.0, 1.0, 0.7)).toBeGreaterThan(0)
  })
})

describe('coverUv (cover-fit выборка тени = выборка плейта)', () => {
  it('uUvScale=(1,1): uv не меняется', () => {
    expect(coverUv(0.3, 0.7, 1, 1)).toEqual([0.3, 0.7])
  })
  it('uUvScale кропит вокруг центра 0.5', () => {
    const [u, v] = coverUv(0.3, 0.5, 0.5, 1)
    expect(u).toBeCloseTo(0.4, 6)
    expect(v).toBeCloseTo(0.5, 6)
  })
})
