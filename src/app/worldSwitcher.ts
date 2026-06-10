export type Phase = 'IDLE' | 'FADE_OUT' | 'FADE_IN'

// Переключение миров через короткую чёрную шторку: FADE_OUT → смена → FADE_IN.
export class WorldSwitcher {
  index = 0
  phase: Phase = 'IDLE'
  fade = 0 // 0 — прозрачно, 1 — чёрный экран
  private target: number | null = null

  constructor(private count: number, private fadeDurationSec = 0.2) {}

  switchTo(index: number): void {
    if (index === this.index || index < 0 || index >= this.count || this.phase !== 'IDLE') return
    this.target = index
    this.phase = 'FADE_OUT'
  }

  next(): void { this.switchTo((this.index + 1) % this.count) }
  prev(): void { this.switchTo((this.index - 1 + this.count) % this.count) }

  update(dt: number): void {
    if (this.phase === 'FADE_OUT') {
      this.fade += dt / this.fadeDurationSec
      if (this.fade >= 1) {
        this.fade = 1
        this.index = this.target!
        this.target = null
        this.phase = 'FADE_IN'
      }
    } else if (this.phase === 'FADE_IN') {
      this.fade -= dt / this.fadeDurationSec
      if (this.fade <= 0) {
        this.fade = 0
        this.phase = 'IDLE'
      }
    }
  }
}
