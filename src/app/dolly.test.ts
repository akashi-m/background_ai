import { describe, it, expect } from 'vitest'
import { dollyFromEyeZ, DEFAULT_DOLLY_RANGE } from './dolly'

const MAX = 150

describe('dollyFromEyeZ', () => {
  it('дальше farCm → проезд 0', () => {
    expect(dollyFromEyeZ(100, MAX)).toBe(0)
    expect(dollyFromEyeZ(DEFAULT_DOLLY_RANGE.farCm, MAX)).toBe(0)
  })

  it('ближе nearCm → полный проезд', () => {
    expect(dollyFromEyeZ(DEFAULT_DOLLY_RANGE.nearCm, MAX)).toBe(MAX)
    expect(dollyFromEyeZ(20, MAX)).toBe(MAX)
  })

  it('середина диапазона → половина проезда (smoothstep симметричен)', () => {
    const mid = (DEFAULT_DOLLY_RANGE.farCm + DEFAULT_DOLLY_RANGE.nearCm) / 2
    expect(dollyFromEyeZ(mid, MAX)).toBeCloseTo(MAX / 2, 6)
  })

  it('монотонно растёт при приближении', () => {
    let prev = -1
    for (let z = DEFAULT_DOLLY_RANGE.farCm; z >= DEFAULT_DOLLY_RANGE.nearCm; z -= 5) {
      const d = dollyFromEyeZ(z, MAX)
      expect(d).toBeGreaterThanOrEqual(prev)
      prev = d
    }
  })

  it('анти-дрожь: у границы зоны скорость ~0 (дрожание z почти не двигает мир)', () => {
    expect(dollyFromEyeZ(DEFAULT_DOLLY_RANGE.farCm - 2, MAX)).toBeLessThan(1)
    expect(dollyFromEyeZ(DEFAULT_DOLLY_RANGE.nearCm + 2, MAX)).toBeGreaterThan(MAX - 1)
  })
})
