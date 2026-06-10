import { describe, it, expect } from 'vitest'
import { offAxisFrustum } from './offAxis'

// Экран 30×19 см (MacBook), near = 1 см
const W = 30, H = 19, NEAR = 1

describe('offAxisFrustum', () => {
  it('глаз по центру → симметричный фрустум', () => {
    const f = offAxisFrustum({ x: 0, y: 0, z: 60 }, W, H, NEAR)
    expect(f.right).toBeCloseTo(-f.left, 6)
    expect(f.top).toBeCloseTo(-f.bottom, 6)
    expect(f.right).toBeCloseTo((W / 2) * (NEAR / 60), 6)
  })

  it('глаз вправо → фрустум скашивается влево', () => {
    const f = offAxisFrustum({ x: 10, y: 0, z: 60 }, W, H, NEAR)
    expect(f.left).toBeCloseTo((-W / 2 - 10) * (NEAR / 60), 6)
    expect(f.right).toBeCloseTo((W / 2 - 10) * (NEAR / 60), 6)
    expect(Math.abs(f.left)).toBeGreaterThan(Math.abs(f.right))
  })

  it('глаз вдвое дальше → фрустум вдвое уже', () => {
    const near60 = offAxisFrustum({ x: 0, y: 0, z: 60 }, W, H, NEAR)
    const near120 = offAxisFrustum({ x: 0, y: 0, z: 120 }, W, H, NEAR)
    expect(near120.right).toBeCloseTo(near60.right / 2, 6)
  })

  it('z <= 0 — ошибка (зритель за экраном невозможен)', () => {
    expect(() => offAxisFrustum({ x: 0, y: 0, z: 0 }, W, H, NEAR)).toThrow()
  })
})
