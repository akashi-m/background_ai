export interface Calibration {
  screenWcm: number      // ширина видимой области экрана, см
  screenHcm: number      // высота, см
  camOffsetXcm: number   // смещение камеры от центра экрана, см (вправо +)
  camOffsetYcm: number   // (вверх +; вебка над экраном ≈ +screenHcm/2 + 1)
  webcamHfovDeg: number  // горизонтальный угол обзора вебки, градусы
}

// Дефолты сняты с реальной машины разработчика: MacBook Pro 14"
// (Liquid Retina XDR 3024×1964, видимая область 30.41×19.74 см).
// Камера в чёлке — ВНУТРИ области экрана у верхней кромки, поэтому
// смещение по Y чуть МЕНЬШЕ половины высоты (центр чёлки ≈ 4 мм от кромки).
// Для внешнего экрана (например, Samsung Odyssey G9 49": 119.3×33.6 см)
// значения вводятся через панель калибровки (клавиша C).
export const DEFAULT_CALIBRATION: Calibration = {
  screenWcm: 30.41,
  screenHcm: 19.74,
  camOffsetXcm: 0,
  camOffsetYcm: 9.5,
  webcamHfovDeg: 63,
}

const KEY = 'stellar-mirror.calibration'

type ReadStore = Pick<Storage, 'getItem'>
type WriteStore = Pick<Storage, 'setItem'>

export function loadCalibration(storage: ReadStore = localStorage): Calibration {
  try {
    const raw = storage.getItem(KEY)
    if (!raw) return { ...DEFAULT_CALIBRATION }
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_CALIBRATION }
    }
    const merged = { ...DEFAULT_CALIBRATION, ...parsed }
    const POSITIVE = new Set<keyof Calibration>(['screenWcm', 'screenHcm', 'webcamHfovDeg'])
    // Нечисловые/нефинитные значения полей откатываются к дефолтам;
    // поля, обязанные быть строго положительными, дополнительно проверяются на > 0.
    for (const k of Object.keys(DEFAULT_CALIBRATION) as (keyof Calibration)[]) {
      if (typeof merged[k] !== 'number' || !isFinite(merged[k]) || (POSITIVE.has(k) && merged[k] <= 0)) merged[k] = DEFAULT_CALIBRATION[k]
    }
    return merged as Calibration
  } catch {
    return { ...DEFAULT_CALIBRATION }
  }
}

export function saveCalibration(cal: Calibration, storage: WriteStore = localStorage): void {
  storage.setItem(KEY, JSON.stringify(cal))
}
