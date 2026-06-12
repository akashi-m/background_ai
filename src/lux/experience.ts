// Стейт-машина опыта (спека §5). Вход каждый кадр: присутствие/дистанция из
// телеметрии + здоровье потока. Выход: фаза + mirrorOpacity (0..1) для рендера.
// Сломанный композит не показывается никогда: !healthy → IDLE с быстрым фейдом.

export type Phase = 'IDLE' | 'APPROACH' | 'MIRROR'

export interface ExperienceInput {
  present: boolean
  distanceCm: number | null
  healthy: boolean // поток live и телеметрия свежа (считает вызывающий)
}

export interface ExperienceConfig {
  approachCm: number
  approachSec: number
  exitSec: number
  fadeSec: number
  fastFadeSec: number
}

export class Experience {
  phase: Phase = 'IDLE'
  mirrorOpacity = 0
  private approachT = 0
  private absentT = 0
  private fastFade = false
  private forced = false

  constructor(private cfg: ExperienceConfig) {}

  /** F5: принудительный цикл фаз для разработки без телеметрии. */
  forceNext(): void {
    this.forced = true
    if (this.phase === 'IDLE') {
      this.phase = 'APPROACH'
      this.approachT = 0
    } else if (this.phase === 'APPROACH') {
      this.phase = 'MIRROR'
    } else {
      this.phase = 'IDLE'
      this.forced = false
    }
    this.fastFade = false
    this.absentT = 0
  }

  update(dt: number, input: ExperienceInput): void {
    const near =
      input.present && input.distanceCm !== null && input.distanceCm < this.cfg.approachCm

    if (!this.forced) {
      if (!input.healthy) {
        if (this.phase !== 'IDLE') this.fastFade = true
        this.phase = 'IDLE'
      } else if (this.phase === 'IDLE') {
        if (near) {
          this.phase = 'APPROACH'
          this.approachT = 0
          this.fastFade = false
        }
      } else if (this.phase === 'APPROACH') {
        if (!near) {
          this.phase = 'IDLE'
        } else {
          this.approachT += dt
          if (this.approachT >= this.cfg.approachSec - 1e-6) this.phase = 'MIRROR'
        }
      } else {
        // MIRROR: уходим только по накопленному отсутствию
        if (input.present) {
          this.absentT = 0
        } else {
          this.absentT += dt
          if (this.absentT >= this.cfg.exitSec) {
            this.phase = 'IDLE'
            this.absentT = 0
          }
        }
      }
    } else if (this.phase === 'APPROACH') {
      this.approachT += dt // в форс-режиме APPROACH не завершается сам
    }

    // mirrorOpacity тянется к цели со скоростью фазы
    const target = this.phase === 'IDLE' ? 0 : 1
    const riseSec = this.cfg.approachSec
    const fallSec = this.fastFade ? this.cfg.fastFadeSec : this.cfg.fadeSec
    const rate = target > this.mirrorOpacity ? dt / riseSec : dt / fallSec
    this.mirrorOpacity =
      target > this.mirrorOpacity
        ? Math.min(target, this.mirrorOpacity + rate)
        : Math.max(target, this.mirrorOpacity - rate)
    if (this.mirrorOpacity === 0) this.fastFade = false
  }
}
