import { describe, it, expect } from 'vitest'
import { Experience, ExperienceInput } from './experience'

const CFG = { approachCm: 250, approachSec: 1.0, exitSec: 2.0, fadeSec: 0.5, fastFadeSec: 0.1 }

const NEAR: ExperienceInput = { present: true, distanceCm: 150, healthy: true }
const FAR: ExperienceInput = { present: true, distanceCm: 400, healthy: true }
const GONE: ExperienceInput = { present: false, distanceCm: null, healthy: true }
const BROKEN: ExperienceInput = { present: true, distanceCm: 150, healthy: false }

function run(e: Experience, input: ExperienceInput, sec: number, dt = 0.1): void {
  for (let t = 0; t < sec - 1e-9; t += dt) e.update(dt, input)
}

describe('Experience', () => {
  it('старт: IDLE, зеркало прозрачно', () => {
    const e = new Experience(CFG)
    expect(e.phase).toBe('IDLE')
    expect(e.mirrorOpacity).toBe(0)
  })

  it('подошёл близко → APPROACH → MIRROR за approachSec', () => {
    const e = new Experience(CFG)
    e.update(0.1, NEAR)
    expect(e.phase).toBe('APPROACH')
    expect(e.mirrorOpacity).toBeGreaterThan(0)
    run(e, NEAR, 1.0)
    expect(e.phase).toBe('MIRROR')
    expect(e.mirrorOpacity).toBe(1)
  })

  it('далеко (present, но > approachCm) — остаёмся в IDLE', () => {
    const e = new Experience(CFG)
    run(e, FAR, 1.0)
    expect(e.phase).toBe('IDLE')
  })

  it('ушёл из APPROACH → сразу IDLE (без exit-таймера)', () => {
    const e = new Experience(CFG)
    e.update(0.1, NEAR)
    e.update(0.1, GONE)
    expect(e.phase).toBe('IDLE')
  })

  it('ушёл из MIRROR → IDLE только после exitSec, зеркало гаснет за fadeSec', () => {
    const e = new Experience(CFG)
    run(e, NEAR, 1.2)
    expect(e.phase).toBe('MIRROR')
    run(e, GONE, 1.9)
    expect(e.phase).toBe('MIRROR')      // ещё ждём
    run(e, GONE, 0.2)
    expect(e.phase).toBe('IDLE')
    expect(e.mirrorOpacity).toBeGreaterThan(0) // гаснет плавно
    run(e, GONE, 0.6)
    expect(e.mirrorOpacity).toBe(0)
  })

  it('вернулся в MIRROR до exitSec — таймер сбрасывается', () => {
    const e = new Experience(CFG)
    run(e, NEAR, 1.2)
    run(e, GONE, 1.5)
    run(e, NEAR, 0.2)   // вернулся
    run(e, GONE, 1.5)
    expect(e.phase).toBe('MIRROR')      // таймер шёл заново
  })

  it('сбой потока в MIRROR → немедленно IDLE, быстрый фейд', () => {
    const e = new Experience(CFG)
    run(e, NEAR, 1.2)
    e.update(0.05, BROKEN)
    expect(e.phase).toBe('IDLE')
    run(e, BROKEN, 0.1)
    expect(e.mirrorOpacity).toBe(0)     // fastFadeSec=0.1
  })

  it('сбой потока — в APPROACH не входим', () => {
    const e = new Experience(CFG)
    run(e, BROKEN, 0.5)
    expect(e.phase).toBe('IDLE')
  })

  it('forceNext: IDLE→APPROACH→MIRROR→IDLE по кругу (F5)', () => {
    const e = new Experience(CFG)
    e.forceNext()
    expect(e.phase).toBe('APPROACH')
    e.forceNext()
    expect(e.phase).toBe('MIRROR')
    e.forceNext()
    expect(e.phase).toBe('IDLE')
  })
})
