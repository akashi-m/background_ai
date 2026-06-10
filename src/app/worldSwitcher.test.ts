import { describe, it, expect } from 'vitest'
import { WorldSwitcher } from './worldSwitcher'

describe('WorldSwitcher', () => {
  it('старт: мир 0, фейда нет', () => {
    const s = new WorldSwitcher(3, 0.2)
    expect(s.index).toBe(0)
    expect(s.fade).toBe(0)
    expect(s.phase).toBe('IDLE')
  })

  it('переключение: фейд в чёрное, смена мира под шторкой, фейд обратно', () => {
    const s = new WorldSwitcher(3, 0.2)
    s.switchTo(2)
    s.update(0.1)
    expect(s.fade).toBeCloseTo(0.5, 5)
    expect(s.index).toBe(0) // ещё старый
    s.update(0.1)
    expect(s.index).toBe(2) // сменился под шторкой
    s.update(0.2)
    expect(s.fade).toBe(0)
    expect(s.phase).toBe('IDLE')
  })

  it('полный цикл < 0.5 с', () => {
    const s = new WorldSwitcher(2, 0.2)
    s.switchTo(1)
    let t = 0
    while (s.phase !== 'IDLE' && t < 1) { s.update(1 / 60); t += 1 / 60 }
    expect(t).toBeLessThan(0.5)
  })

  it('switchTo в тот же мир / мимо диапазона / во время фейда — игнор', () => {
    const s = new WorldSwitcher(2, 0.2)
    s.switchTo(0)
    expect(s.phase).toBe('IDLE')
    s.switchTo(5)
    expect(s.phase).toBe('IDLE')
    s.switchTo(1)
    s.update(0.1)
    s.switchTo(0) // во время фейда
    s.update(0.1)
    expect(s.index).toBe(1)
  })

  it('next/prev ходят по кругу', () => {
    const s = new WorldSwitcher(3, 0.001)
    const settle = () => { for (let i = 0; i < 10; i++) s.update(0.01) }
    s.next(); settle()
    expect(s.index).toBe(1)
    s.next(); settle()
    s.next(); settle()
    expect(s.index).toBe(0) // 2 → wrap → 0
    s.prev(); settle()
    expect(s.index).toBe(2)
  })
})
