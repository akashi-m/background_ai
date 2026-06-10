export interface Calibration {
  screenWcm: number      // ширина видимой области экрана, см
  screenHcm: number      // высота, см
  camOffsetXcm: number   // смещение камеры от центра экрана, см (вправо +)
  camOffsetYcm: number   // (вверх +; вебка над экраном ≈ +screenHcm/2 + 1)
  webcamHfovDeg: number  // горизонтальный угол обзора вебки, градусы
}

// Дефолты под MacBook Pro 14": экран ~30×19.5 см, камера в верхней кромке.
export const DEFAULT_CALIBRATION: Calibration = {
  screenWcm: 30.4,
  screenHcm: 19.5,
  camOffsetXcm: 0,
  camOffsetYcm: 10.3,
  webcamHfovDeg: 63,
}

const KEY = 'stellar-mirror.calibration'

type ReadStore = Pick<Storage, 'getItem'>
type WriteStore = Pick<Storage, 'setItem'>

export function loadCalibration(storage: ReadStore = localStorage): Calibration {
  try {
    const raw = storage.getItem(KEY)
    if (!raw) return { ...DEFAULT_CALIBRATION }
    return { ...DEFAULT_CALIBRATION, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_CALIBRATION }
  }
}

export function saveCalibration(cal: Calibration, storage: WriteStore = localStorage): void {
  storage.setItem(KEY, JSON.stringify(cal))
}
