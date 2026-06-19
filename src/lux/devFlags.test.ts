import { describe, it, expect } from 'vitest'
import { parseDevFlags } from './devFlags'

describe('parseDevFlags', () => {
  it('пустая строка → всё выключено', () => {
    expect(parseDevFlags('')).toEqual({ noTracker: false, forcePhase: null, golden: false })
  })

  it('?noTracker включает работу без камеры', () => {
    expect(parseDevFlags('?noTracker').noTracker).toBe(true)
  })

  it('?forcePhase=MIRROR парсится, мусор — нет', () => {
    expect(parseDevFlags('?forcePhase=MIRROR').forcePhase).toBe('MIRROR')
    expect(parseDevFlags('?forcePhase=APPROACH').forcePhase).toBe('APPROACH')
    expect(parseDevFlags('?forcePhase=banana').forcePhase).toBeNull()
  })

  it('комбинация', () => {
    const f = parseDevFlags('?noTracker&forcePhase=MIRROR')
    expect(f).toEqual({ noTracker: true, forcePhase: 'MIRROR', golden: false })
  })
})
