// UI-оверлей зеркала: слои data-idle / data-mirror кроссфейдятся с mirrorOpacity
// (спека №3 §3). Кнопки — из списка стилей: light=мир lobby; modern/classic/ferre —
// пустышки (мир null) → тусклые и некликабельные.

import type { StyleDef } from '../scenes/config'

// Чистый маппинг стилей в спеки кнопок (без DOM, тестируемо): worldIndex = индекс
// мира в worldNames, либо null = пустышка (мир не задан или ещё не загружен).
export function styleButtonSpecs(
  styles: StyleDef[],
  worldNames: string[],
): { label: string; worldIndex: number | null }[] {
  return styles.map((s) => {
    const i = s.world != null ? worldNames.indexOf(s.world) : -1
    return { label: s.label, worldIndex: i >= 0 ? i : null }
  })
}

export class LuxUI {
  private idleEls: HTMLElement[]
  private mirrorEls: HTMLElement[]
  private buttons: HTMLButtonElement[] = []
  private styleWorld: (string | null)[] = [] // имя мира на кнопку (null = пустышка)
  private titleByWorld: Record<string, string> = {}
  private locationEl: HTMLElement | null

  constructor(private onWorld: (worldIndex: number) => void) {
    this.idleEls = Array.from(document.querySelectorAll<HTMLElement>('[data-idle]'))
    this.mirrorEls = Array.from(document.querySelectorAll<HTMLElement>('[data-mirror]'))
    this.locationEl = document.getElementById('lux-location')
  }

  // styles — кнопки селектора (порядок сохраняется); worlds — загруженные миры
  // (для маппинга имя→индекс и имя→заголовок-локация).
  setStyles(styles: StyleDef[], worlds: { name: string; meta: { title: string } }[]): void {
    worlds.forEach((w) => { this.titleByWorld[w.name] = w.meta.title })
    const specs = styleButtonSpecs(styles, worlds.map((w) => w.name))
    const nav = document.getElementById('lux-interiors')
    if (!nav) return
    nav.innerHTML = ''
    this.styleWorld = styles.map((s) => s.world)
    this.buttons = specs.map((spec) => {
      const b = document.createElement('button')
      b.className = 'lux-btn'
      b.textContent = spec.label
      if (spec.worldIndex == null) {
        b.classList.add('placeholder') // пустышка: контента нет → тусклая, некликабельная
        b.disabled = true
      } else {
        const wi = spec.worldIndex
        b.addEventListener('click', () => this.onWorld(wi))
      }
      nav.appendChild(b)
      return b
    })
  }

  // worldName — имя активного загруженного мира: подсветить его стиль + показать локацию.
  setActive(worldName: string): void {
    this.buttons.forEach((b, i) => b.classList.toggle('active', this.styleWorld[i] === worldName))
    if (this.locationEl) this.locationEl.textContent = this.titleByWorld[worldName] ?? ''
  }

  /** Звать каждый кадр: 0 = IDLE-вид, 1 = MIRROR-вид. */
  update(mirrorOpacity: number): void {
    const mo = String(mirrorOpacity)
    const io = String(1 - mirrorOpacity)
    for (const el of this.mirrorEls) {
      el.style.opacity = mo
      el.style.pointerEvents = mirrorOpacity > 0.5 ? 'auto' : 'none'
    }
    for (const el of this.idleEls) el.style.opacity = io
  }
}
