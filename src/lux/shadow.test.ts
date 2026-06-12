import { describe, it, expect } from 'vitest'
import { shadowFromBbox, SmoothedShadow } from './shadow'

describe('shadowFromBbox', () => {
  it('эллипс у ног, по центру bbox, зеркально отражён по x', () => {
    // bbox: x 0.2..0.6 (центр 0.4), низ y=0.9
    const s = shadowFromBbox([0.2, 0.1, 0.6, 0.9])!
    expect(s.cx).toBeCloseTo(1 - 0.4) // зеркальный флип как у фигуры
    expect(s.cy).toBeCloseTo(0.9)
    expect(s.rx).toBeCloseTo(((0.6 - 0.2) / 2) * 1.15) // чуть шире ступней
    expect(s.ry).toBeCloseTo(s.rx * 0.22)              // плоский эллипс
  })

  it('bbox null → null', () => {
    expect(shadowFromBbox(null)).toBeNull()
  })
})

describe('SmoothedShadow', () => {
  it('плавно тянется к цели, исчезает при null', () => {
    const sm = new SmoothedShadow()
    const a = sm.update(shadowFromBbox([0.2, 0.1, 0.6, 0.9]), 0.016)!
    expect(a.opacity).toBeGreaterThan(0)
    // много кадров — сходится к цели
    let cur = a
    for (let i = 0; i < 200; i++) cur = sm.update(shadowFromBbox([0.2, 0.1, 0.6, 0.9]), 0.016)!
    expect(cur.cx).toBeCloseTo(0.6, 1)
    expect(cur.opacity).toBeCloseTo(1, 1)
    // цель пропала — затухает, потом null
    let faded = sm.update(null, 0.016)
    for (let i = 0; i < 300 && faded !== null; i++) faded = sm.update(null, 0.016)
    expect(faded).toBeNull()
  })
})
