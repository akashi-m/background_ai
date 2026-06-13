import { describe, expect, it } from 'vitest'
import { colorMatchUniforms } from './colorMatch'

const CFG = { cast: 0.25, exposure: 0.15 }

describe('colorMatchUniforms', () => {
  it('нейтральный серый фон → каст ≈ единичный (фигуру не красим)', () => {
    const { castMul } = colorMatchUniforms([0.4, 0.4, 0.4], CFG)
    expect(castMul[0]).toBeCloseTo(1, 5)
    expect(castMul[1]).toBeCloseTo(1, 5)
    expect(castMul[2]).toBeCloseTo(1, 5)
  })

  it('тёплый фон → красный множитель больше синего', () => {
    const { castMul } = colorMatchUniforms([0.6, 0.4, 0.2], CFG)
    expect(castMul[0]).toBeGreaterThan(castMul[2])
  })

  it('холодный фон → синий множитель больше красного', () => {
    const { castMul } = colorMatchUniforms([0.2, 0.4, 0.6], CFG)
    expect(castMul[2]).toBeGreaterThan(castMul[0])
  })

  it('тёмная сцена → экспозиция тушит фигуру (<1), светлая → >1', () => {
    expect(colorMatchUniforms([0.2, 0.2, 0.2], CFG).expMul).toBeLessThan(1)
    expect(colorMatchUniforms([0.8, 0.8, 0.8], CFG).expMul).toBeGreaterThan(1)
  })

  it('сила 0 → множители единичные при любом фоне', () => {
    const { castMul, expMul } = colorMatchUniforms([0.9, 0.1, 0.1], { cast: 0, exposure: 0 })
    expect(castMul).toEqual([1, 1, 1])
    expect(expMul).toBe(1)
  })

  it('чёрный фон не делит на ноль (каст единичный)', () => {
    const { castMul } = colorMatchUniforms([0, 0, 0], CFG)
    expect(castMul[0]).toBeCloseTo(1, 5)
    expect(castMul[1]).toBeCloseTo(1, 5)
    expect(castMul[2]).toBeCloseTo(1, 5)
  })
})
