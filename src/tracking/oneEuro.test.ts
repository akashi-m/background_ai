import { describe, it, expect } from 'vitest'
import { OneEuroFilter } from './oneEuro'

const DT = 1 / 30

describe('OneEuroFilter', () => {
  it('первое значение проходит без изменений', () => {
    const f = new OneEuroFilter()
    expect(f.filter(5, DT)).toBe(5)
  })

  it('постоянный сигнал не меняется', () => {
    const f = new OneEuroFilter()
    for (let i = 0; i < 10; i++) f.filter(3, DT)
    expect(f.filter(3, DT)).toBeCloseTo(3, 6)
  })

  it('гасит дрожь: разброс фильтрованного шума меньше сырого', () => {
    const f = new OneEuroFilter()
    const noisy = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5))
    const out = noisy.map(v => f.filter(v, DT))
    const tail = out.slice(50)
    const spread = Math.max(...tail) - Math.min(...tail)
    expect(spread).toBeLessThan(0.2)
  })

  it('быстрое движение догоняется быстро (beta работает)', () => {
    const f = new OneEuroFilter()
    f.filter(0, DT)
    let last = 0
    for (let i = 1; i <= 30; i++) last = f.filter(i * 2, DT) // скачок 2 см/кадр
    expect(last).toBeGreaterThan(50) // не отстаёт больше чем на ~17%
  })

  it('reset забывает историю', () => {
    const f = new OneEuroFilter()
    f.filter(100, DT)
    f.reset()
    expect(f.filter(7, DT)).toBe(7)
  })
})
