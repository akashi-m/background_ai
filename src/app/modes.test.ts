import { describe, it, expect } from 'vitest'
import { ModeMachine } from './modes'

describe('ModeMachine', () => {
  it('старт: режим ЗЕРКАЛО, фейда нет', () => {
    const m = new ModeMachine(0.2)
    expect(m.mode).toBe('MIRROR')
    expect(m.fade).toBe(0)
  })

  it('переключение: фейд в чёрное, смена режима, фейд обратно', () => {
    const m = new ModeMachine(0.2)
    m.switchTo('WINDOW')
    m.update(0.1) // середина затемнения
    expect(m.fade).toBeCloseTo(0.5, 5)
    expect(m.mode).toBe('MIRROR') // ещё старый режим
    m.update(0.1) // дошли до чёрного
    expect(m.mode).toBe('WINDOW') // режим сменился под шторкой
    m.update(0.2) // рассвело
    expect(m.fade).toBe(0)
    expect(m.phase).toBe('IDLE')
  })

  it('полный цикл укладывается в 0.5 с (требование спеки)', () => {
    const m = new ModeMachine(0.2)
    m.switchTo('WINDOW')
    let t = 0
    while (m.phase !== 'IDLE' && t < 1) { m.update(1 / 60); t += 1 / 60 }
    expect(t).toBeLessThan(0.5)
  })

  it('повторный switchTo в тот же режим игнорируется', () => {
    const m = new ModeMachine(0.2)
    m.switchTo('MIRROR')
    expect(m.phase).toBe('IDLE')
  })

  it('switchTo во время фейда игнорируется (без дёрганья)', () => {
    const m = new ModeMachine(0.2)
    m.switchTo('WINDOW')
    m.update(0.1)
    m.switchTo('MIRROR')
    m.update(0.1)
    expect(m.mode).toBe('WINDOW')
  })
})
