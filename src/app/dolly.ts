// «Въезд» в мир: подходишь к экрану → мир плавно едет навстречу.
// Smoothstep вместо линейной кривой: нулевая скорость на обоих краях диапазона,
// поэтому дрожание трекинга у границы зоны не дёргает картинку —
// гистерезис из спеки реализован самой формой кривой.
export interface DollyRange {
  farCm: number  // с этого расстояния начинается въезд
  nearCm: number // на этом расстоянии въезд максимален
}

export const DEFAULT_DOLLY_RANGE: DollyRange = { farCm: 80, nearCm: 30 }

export function dollyFromEyeZ(eyeZcm: number, maxCm: number, r: DollyRange = DEFAULT_DOLLY_RANGE): number {
  if (!(r.farCm > r.nearCm)) return eyeZcm < r.nearCm ? maxCm : 0 // вырожденный диапазон — без NaN
  const t = Math.min(1, Math.max(0, (r.farCm - eyeZcm) / (r.farCm - r.nearCm)))
  const s = t * t * (3 - 2 * t)
  return s * maxCm
}
