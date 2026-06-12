import { describe, it, expect } from 'vitest'
import { parseWorldMeta } from './worldMeta'

const VALID_SPLAT = {
  title: 'Спальня',
  format: 'splat',
  file: 'world.spz',
}

const VALID_PHOTO = {
  title: 'Балкон',
  format: 'photo25d',
  file: 'photo.png',
  depthFile: 'depth.png',
  aspect: 2.357,
}

describe('parseWorldMeta', () => {
  it('валидный splat-мир: дефолты подставляются', () => {
    const m = parseWorldMeta(VALID_SPLAT, 'bedroom')
    expect(m.format).toBe('splat')
    expect(m.transform).toEqual({ position: [0, 0, 0], rotationYDeg: 0, scale: 1 })
    expect(m.dollyMaxCm).toBe(150)
  })

  it('валидный photo25d-мир с aspect', () => {
    const m = parseWorldMeta(VALID_PHOTO, 'balcony')
    expect(m.format).toBe('photo25d')
    expect(m.aspect).toBeCloseTo(2.357)
  })

  it('кастомный transform сохраняется', () => {
    const m = parseWorldMeta(
      { ...VALID_SPLAT, transform: { position: [1, 2, 3], rotationYDeg: 90, scale: 2.5 } },
      'bedroom',
    )
    expect(m.transform.scale).toBe(2.5)
    expect(m.transform.position).toEqual([1, 2, 3])
  })

  it('неизвестный format → ошибка с именем мира', () => {
    expect(() => parseWorldMeta({ ...VALID_SPLAT, format: 'mesh' }, 'bedroom'))
      .toThrow(/bedroom/)
  })

  it('photo25d без depthFile или aspect → ошибка', () => {
    expect(() => parseWorldMeta({ ...VALID_PHOTO, depthFile: undefined }, 'balcony')).toThrow(/balcony/)
    expect(() => parseWorldMeta({ ...VALID_PHOTO, aspect: undefined }, 'balcony')).toThrow(/balcony/)
  })

  it('не-объект → ошибка', () => {
    expect(() => parseWorldMeta(null, 'x')).toThrow(/x/)
    expect(() => parseWorldMeta('hello', 'x')).toThrow(/x/)
  })

  it('кривой transform.scale (0, NaN) → ошибка', () => {
    expect(() => parseWorldMeta({ ...VALID_SPLAT, transform: { position: [0,0,0], rotationYDeg: 0, scale: 0 } }, 'b')).toThrow(/b/)
  })

  it('transform: null → структурная ошибка, не TypeError', () => {
    expect(() => parseWorldMeta({ ...VALID_SPLAT, transform: null }, 'b')).toThrow(/Битый meta.json мира «b»/)
  })

  it('depthAmountCm: валидный сохраняется, кривой — ошибка', () => {
    expect(parseWorldMeta({ ...VALID_PHOTO, depthAmountCm: 70 }, 'b').depthAmountCm).toBe(70)
    expect(parseWorldMeta(VALID_PHOTO, 'b').depthAmountCm).toBeUndefined()
    expect(() => parseWorldMeta({ ...VALID_PHOTO, depthAmountCm: -1 }, 'b')).toThrow(/b/)
  })

  it('lux-поля: lut и shadowStrength валидируются и опциональны', () => {
    const m = parseWorldMeta({ ...VALID_PHOTO, lut: 'interior.cube', shadowStrength: 0.7 }, 'b')
    expect(m.lut).toBe('interior.cube')
    expect(m.shadowStrength).toBeCloseTo(0.7)
    const d = parseWorldMeta(VALID_PHOTO, 'b')
    expect(d.lut).toBeUndefined()
    expect(d.shadowStrength).toBe(0.5)
    expect(() => parseWorldMeta({ ...VALID_PHOTO, shadowStrength: 2 }, 'b')).toThrow(/b/)
    expect(() => parseWorldMeta({ ...VALID_PHOTO, lut: 7 }, 'b')).toThrow(/b/)
  })
})
