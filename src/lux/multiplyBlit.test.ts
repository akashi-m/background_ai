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

describe('multiplyShadowTerm (числовое зеркало затемнения multiplyBlitMat)', () => {
  // сигнатура: (shadowSample, edgeDark, centerDark) → dark ∈ [0..centerDark]
  it('вне тени (shadowSample=1.0): dark = 0 (множитель к фону = 1)', () => {
    expect(multiplyShadowTerm(1.0, 0.2, 0.5)).toBeCloseTo(0.0, 6)
  })
  it('плотное ядро (shadowSample=0.0): dark = centerDark (умбра)', () => {
    expect(multiplyShadowTerm(0.0, 0.2, 0.5)).toBeCloseTo(0.5, 6)
  })
  it('монотонность: гуще тень → больше затемнение', () => {
    const light = multiplyShadowTerm(0.7, 0.2, 0.5)  // полутень
    const core = multiplyShadowTerm(0.1, 0.2, 0.5)   // ближе к ядру
    expect(core).toBeGreaterThan(light)
  })
  it('ограничен сверху centerDark → mix(1,tint) никогда не в чёрный', () => {
    expect(multiplyShadowTerm(0.0, 0.2, 0.5)).toBeLessThanOrEqual(0.5)
    expect(multiplyShadowTerm(0.0, 0.2, 0.5)).toBeGreaterThan(0)
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
