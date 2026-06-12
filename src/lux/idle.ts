// Слайдшоу IDLE: кроссфейд бэкплейтов активных миров (спека §3 модуль idle).

import * as THREE from 'three'

import type { SlideState } from './compositor'

export class IdleSlides {
  private textures: THREE.Texture[] = []
  private index = 0
  private t = 0

  constructor(private slideSec: number) {}

  async load(urls: string[]): Promise<void> {
    const loader = new THREE.TextureLoader()
    const loaded = await Promise.allSettled(urls.map((u) => loader.loadAsync(u)))
    this.textures = loaded
      .filter((r): r is PromiseFulfilledResult<THREE.Texture> => r.status === 'fulfilled')
      .map((r) => {
        // colorSpace НЕ задаём: миры грузят те же фото как raw sRGB (см. depthPhoto) — иначе кроссфейд «хлопает» яркостью
        return r.value
      })
    if (this.textures.length === 0) console.warn('слайдшоу: ни один бэкплейт не загрузился')
  }

  update(dt: number, visible: number): SlideState {
    if (this.textures.length === 0) return { a: null, b: null, mix: 0, visible }
    this.t += dt
    const period = this.slideSec
    if (this.t >= period) {
      this.t -= period
      this.index = (this.index + 1) % this.textures.length
    }
    const next = (this.index + 1) % this.textures.length
    // последние 25% периода — кроссфейд к следующему
    const fadePart = 0.25
    const mix = Math.max(0, (this.t / period - (1 - fadePart)) / fadePart)
    return {
      a: this.textures[this.index],
      b: this.textures[next],
      mix,
      visible,
    }
  }
}
