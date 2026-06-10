// One-Euro фильтр (Casiez et al. 2012): мало лага при движении, мало дрожи в покое.
export interface OneEuroConfig {
  minCutoff: number // Гц; ниже — плавнее в покое
  beta: number      // чувствительность к скорости; выше — меньше лаг при движении
  dCutoff: number   // Гц; сглаживание производной
}

export class OneEuroFilter {
  private xPrev: number | null = null
  private dxPrev = 0

  constructor(private cfg: OneEuroConfig = { minCutoff: 1.0, beta: 0.05, dCutoff: 1.0 }) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / dt)
  }

  filter(x: number, dt: number): number {
    // Нефинитный x не сохраняем: возвращаем последнее корректное значение (или сам x при первом вызове)
    if (!Number.isFinite(x)) return this.xPrev ?? x
    if (this.xPrev === null) {
      this.xPrev = x
      return x
    }
    // dt <= 0 или NaN делает dx бесконечным/NaN — отбрасываем кадр, возвращаем последнее значение
    if (!(dt > 0)) return this.xPrev
    // Производная вычисляется от предыдущего *фильтрованного* значения (намеренное отличие от эталонной
    // реализации: чуть более отзывчиво при отставании)
    const dx = (x - this.xPrev) / dt
    const aD = this.alpha(this.cfg.dCutoff, dt)
    this.dxPrev = aD * dx + (1 - aD) * this.dxPrev
    const cutoff = this.cfg.minCutoff + this.cfg.beta * Math.abs(this.dxPrev)
    const a = this.alpha(cutoff, dt)
    this.xPrev = a * x + (1 - a) * this.xPrev
    return this.xPrev
  }

  reset(): void {
    this.xPrev = null
    this.dxPrev = 0
  }
}

// Тройка фильтров для точки (x, y, z)
export class OneEuroPoint {
  private fx = new OneEuroFilter()
  private fy = new OneEuroFilter()
  private fz = new OneEuroFilter({ minCutoff: 0.5, beta: 0.02, dCutoff: 1.0 }) // z шумнее — глушим сильнее

  filter(p: { x: number; y: number; z: number }, dt: number) {
    return { x: this.fx.filter(p.x, dt), y: this.fy.filter(p.y, dt), z: this.fz.filter(p.z, dt) }
  }

  reset(): void {
    this.fx.reset(); this.fy.reset(); this.fz.reset()
  }
}
