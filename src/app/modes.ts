export type Mode = 'MIRROR' | 'WINDOW'
export type Phase = 'IDLE' | 'FADE_OUT' | 'FADE_IN'

// Переключение через короткую чёрную шторку: FADE_OUT → смена сцены → FADE_IN.
export class ModeMachine {
  mode: Mode = 'MIRROR'
  phase: Phase = 'IDLE'
  fade = 0 // 0 — прозрачно, 1 — чёрный экран
  private target: Mode | null = null

  constructor(private fadeDurationSec = 0.2) {}

  switchTo(mode: Mode): void {
    if (mode === this.mode || this.phase !== 'IDLE') return
    this.target = mode
    this.phase = 'FADE_OUT'
  }

  update(dt: number): void {
    if (this.phase === 'FADE_OUT') {
      this.fade += dt / this.fadeDurationSec
      if (this.fade >= 1) {
        this.fade = 1
        this.mode = this.target!
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
