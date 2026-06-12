import { describe, it, expect } from 'vitest'
import { nextBackoffMs } from './backoff'

describe('nextBackoffMs', () => {
  it('экспонента 1с → 4с с потолком', () => {
    expect(nextBackoffMs(0)).toBe(1000)
    expect(nextBackoffMs(1)).toBe(2000)
    expect(nextBackoffMs(2)).toBe(4000)
    expect(nextBackoffMs(3)).toBe(4000)
    expect(nextBackoffMs(10)).toBe(4000) // бесконечные ретраи, потолок 4с
  })

  it('отрицательная попытка → как нулевая', () => {
    expect(nextBackoffMs(-1)).toBe(1000)
  })
})
