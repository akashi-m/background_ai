import { describe, it, expect } from 'vitest'
import { eyePositionCm, focalLengthPx } from './headPose'
import { DEFAULT_CALIBRATION } from '../app/calibration'

// Камера 1280×720, hfov 63° → focal ≈ 1043 px
const CAL = { ...DEFAULT_CALIBRATION, camOffsetXcm: 0, camOffsetYcm: 0, webcamHfovDeg: 63 }

describe('eyePositionCm', () => {
  it('фокус из FOV: 1280 px, 63° → ~1044 px', () => {
    expect(focalLengthPx(1280, 63)).toBeCloseTo(1044.4, 0)
  })

  it('лицо в центре кадра → x=0, y=0, z по размеру IPD', () => {
    const f = focalLengthPx(1280, 63)
    // IPD 6.3 см на расстоянии 60 см → ipdPx = 6.3 * f / 60
    const ipdPx = (6.3 * f) / 60
    const eye = eyePositionCm({ cx: 640, cy: 360, ipdPx, videoW: 1280, videoH: 720 }, CAL)
    expect(eye.x).toBeCloseTo(0, 4)
    expect(eye.y).toBeCloseTo(0, 4)
    expect(eye.z).toBeCloseTo(60, 1)
  })

  it('зритель сдвинулся вправо (в кадре — влево) → x растёт', () => {
    const f = focalLengthPx(1280, 63)
    const ipdPx = (6.3 * f) / 60
    const eye = eyePositionCm({ cx: 500, cy: 360, ipdPx, videoW: 1280, videoH: 720 }, CAL)
    expect(eye.x).toBeGreaterThan(0)
  })

  it('зритель выше (в кадре — выше, cy меньше) → y растёт', () => {
    const f = focalLengthPx(1280, 63)
    const ipdPx = (6.3 * f) / 60
    const eye = eyePositionCm({ cx: 640, cy: 200, ipdPx, videoW: 1280, videoH: 720 }, CAL)
    expect(eye.y).toBeGreaterThan(0)
  })

  it('смещение камеры прибавляется', () => {
    const f = focalLengthPx(1280, 63)
    const ipdPx = (6.3 * f) / 60
    const cal = { ...CAL, camOffsetYcm: 10 }
    const eye = eyePositionCm({ cx: 640, cy: 360, ipdPx, videoW: 1280, videoH: 720 }, cal)
    expect(eye.y).toBeCloseTo(10, 4)
  })
})
