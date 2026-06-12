// Контактная тень под ногами: позиция из bbox телеметрии (низ bbox = ступни),
// сглаживание экспоненциальное (дрожь bbox не дёргает тень), исчезновение при
// потере фигуры (спека §3 модуль shadow).

export interface ShadowEllipse {
  cx: number // нормированный экран, 0..1 (уже с зеркальным флипом)
  cy: number
  rx: number
  ry: number
  opacity: number // 0..1, множитель к shadowStrength мира
}

const WIDEN = 1.15  // тень чуть шире ступней
const FLAT = 0.22   // отношение высоты эллипса к ширине

export function shadowFromBbox(
  bbox: [number, number, number, number] | null,
): Omit<ShadowEllipse, 'opacity'> | null {
  if (!bbox) return null
  const [x0, , x1, y1] = bbox
  const rx = ((x1 - x0) / 2) * WIDEN
  return { cx: 1 - (x0 + x1) / 2, cy: y1, rx, ry: rx * FLAT }
}

export class SmoothedShadow {
  private cur: ShadowEllipse | null = null

  update(target: Omit<ShadowEllipse, 'opacity'> | null, dt: number): ShadowEllipse | null {
    const k = 1 - Math.exp(-dt * 10)
    if (target === null) {
      if (this.cur === null) return null
      this.cur = { ...this.cur, opacity: this.cur.opacity - dt / 0.3 }
      if (this.cur.opacity <= 0.01) this.cur = null
      return this.cur
    }
    if (this.cur === null) {
      this.cur = { ...target, opacity: k }
      return this.cur
    }
    this.cur = {
      cx: this.cur.cx + (target.cx - this.cur.cx) * k,
      cy: this.cur.cy + (target.cy - this.cur.cy) * k,
      rx: this.cur.rx + (target.rx - this.cur.rx) * k,
      ry: this.cur.ry + (target.ry - this.cur.ry) * k,
      opacity: Math.min(1, this.cur.opacity + dt / 0.3),
    }
    return this.cur
  }
}
