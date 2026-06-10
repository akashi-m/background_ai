import { describe, it, expect } from 'vitest'
import { OneEuroFilter, OneEuroPoint } from './oneEuro'

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

  it('быстрое движение догоняется быстро (beta: сравнение с нулевым beta)', () => {
    // Фильтр по умолчанию (beta=0.05) должен заметно опережать фильтр без beta (beta=0)
    const fDefault = new OneEuroFilter()
    const fNoBeta = new OneEuroFilter({ minCutoff: 1.0, beta: 0, dCutoff: 1.0 })
    let lastDefault = 0
    let lastNoBeta = 0
    fDefault.filter(0, DT)
    fNoBeta.filter(0, DT)
    for (let i = 1; i <= 30; i++) {
      lastDefault = fDefault.filter(i * 2, DT)
      lastNoBeta = fNoBeta.filter(i * 2, DT)
    }
    // Фильтр с beta должен быть ближе к истинному значению (60), отставать меньше
    expect(lastDefault).toBeGreaterThan(lastNoBeta + 5)
  })

  it('reset забывает историю', () => {
    const f = new OneEuroFilter()
    f.filter(100, DT)
    f.reset()
    expect(f.filter(7, DT)).toBe(7)
  })

  it('dt=0 не портит фильтр: возвращает последнее значение и следующий вызов корректен', () => {
    const f = new OneEuroFilter()
    f.filter(5, DT)
    // dt=0 должен вернуть последнее корректное значение (5)
    expect(f.filter(6, 0)).toBe(5)
    // последующий вызов с нормальным dt должен вернуть конечное значение > 5
    const next = f.filter(6, DT)
    expect(Number.isFinite(next)).toBe(true)
    expect(next).toBeGreaterThan(5)
  })

  it('NaN на входе не портит фильтр: возвращает последнее значение, следующий вызов корректен', () => {
    const f = new OneEuroFilter()
    f.filter(5, DT)
    // NaN должен вернуть последнее корректное значение (5)
    expect(f.filter(NaN, DT)).toBe(5)
    // последующий вызов с нормальным значением должен вернуть конечное число
    const next = f.filter(7, DT)
    expect(Number.isFinite(next)).toBe(true)
  })
})

describe('OneEuroPoint', () => {
  it('оси независимы: каждая ось отслеживает своё состояние', () => {
    const p = new OneEuroPoint()
    // Первый вызов — значения проходят без изменений
    const first = p.filter({ x: 1, y: 2, z: 3 }, DT)
    expect(first.x).toBe(1)
    expect(first.y).toBe(2)
    expect(first.z).toBe(3)
    // Второй вызов с другими значениями — каждая ось фильтрует независимо
    const second = p.filter({ x: 10, y: 20, z: 30 }, DT)
    // Значения должны находиться между начальным и входным (фильтрация сглаживает)
    expect(second.x).toBeGreaterThan(1)
    expect(second.x).toBeLessThan(10)
    expect(second.y).toBeGreaterThan(2)
    expect(second.y).toBeLessThan(20)
    expect(second.z).toBeGreaterThan(3)
    expect(second.z).toBeLessThan(30)
  })

  it('reset сбрасывает все три оси: первый вызов после reset возвращает вход без изменений', () => {
    const p = new OneEuroPoint()
    p.filter({ x: 100, y: 200, z: 300 }, DT)
    p.reset()
    const afterReset = p.filter({ x: 1, y: 2, z: 3 }, DT)
    expect(afterReset.x).toBe(1)
    expect(afterReset.y).toBe(2)
    expect(afterReset.z).toBe(3)
  })
})
