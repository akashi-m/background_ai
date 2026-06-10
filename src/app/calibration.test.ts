import { describe, it, expect } from 'vitest'
import { loadCalibration, saveCalibration, DEFAULT_CALIBRATION } from './calibration'

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => { data[k] = v },
    data,
  }
}

describe('calibration', () => {
  it('пустое хранилище → дефолты', () => {
    expect(loadCalibration(fakeStorage())).toEqual(DEFAULT_CALIBRATION)
  })

  it('сохранение → загрузка возвращает то же', () => {
    const s = fakeStorage()
    const cal = { ...DEFAULT_CALIBRATION, screenWcm: 120 }
    saveCalibration(cal, s)
    expect(loadCalibration(s)).toEqual(cal)
  })

  it('битый JSON → дефолты, без исключений', () => {
    const s = fakeStorage({ 'stellar-mirror.calibration': '{oops' })
    expect(loadCalibration(s)).toEqual(DEFAULT_CALIBRATION)
  })

  it('частичные данные дополняются дефолтами', () => {
    const s = fakeStorage({ 'stellar-mirror.calibration': '{"screenWcm": 99}' })
    const cal = loadCalibration(s)
    expect(cal.screenWcm).toBe(99)
    expect(cal.screenHcm).toBe(DEFAULT_CALIBRATION.screenHcm)
  })
})
