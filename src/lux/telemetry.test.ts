import { describe, it, expect } from 'vitest'
import { parseTelemetry } from './telemetry'

const VALID = {
  type: 'presence', present: true, distanceCm: 150.5, coverage: 0.21,
  bbox: [0.1, 0.2, 0.6, 1.0], errors: 0, fps: 29.7,
}

describe('parseTelemetry', () => {
  it('валидное сообщение разбирается', () => {
    const t = parseTelemetry(VALID)!
    expect(t.present).toBe(true)
    expect(t.distanceCm).toBeCloseTo(150.5)
    expect(t.bbox).toEqual([0.1, 0.2, 0.6, 1.0])
    expect(t.errors).toBe(0)
  })

  it('чужой type → null', () => {
    expect(parseTelemetry({ ...VALID, type: 'joints' })).toBeNull()
  })

  it('не-объект и мусор → null', () => {
    expect(parseTelemetry(null)).toBeNull()
    expect(parseTelemetry('hi')).toBeNull()
    expect(parseTelemetry({ type: 'presence' })).toBeNull() // нет present
  })

  it('distanceCm null/NaN → null-дистанция, сообщение валидно', () => {
    expect(parseTelemetry({ ...VALID, distanceCm: null })!.distanceCm).toBeNull()
    expect(parseTelemetry({ ...VALID, distanceCm: NaN })!.distanceCm).toBeNull()
  })

  it('кривой bbox → bbox null, сообщение валидно', () => {
    expect(parseTelemetry({ ...VALID, bbox: [1, 2] })!.bbox).toBeNull()
    expect(parseTelemetry({ ...VALID, bbox: null })!.bbox).toBeNull()
    expect(parseTelemetry({ ...VALID, bbox: [0, 0, 'x', 1] })!.bbox).toBeNull()
  })

  it('лишние ключи игнорируются (вперёд-совместимость)', () => {
    expect(parseTelemetry({ ...VALID, joints: [1, 2, 3] })).not.toBeNull()
  })
})
